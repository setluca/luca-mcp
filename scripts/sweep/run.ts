import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";

import { LUCA_OPERATIONS } from "../../src/operations/catalog.ts";
import { fieldsWhen } from "../../src/optional-field.ts";
import { LUCA_PROMPTS } from "../../src/prompts.ts";
import { LUCA_RESOURCES } from "../../src/resources.ts";
import {
  isJsonArray,
  isJsonObject,
  type JsonValue,
} from "../../src/serialization.ts";
import { LUCA_TASK_TOOLS } from "../../src/task-tools.ts";
import {
  CALL_LIMIT_MS,
  INSPECTOR_EXIT,
  type InspectorAuth,
  type InspectorConnection,
  type InspectorOutcome,
  type InspectorRequest,
  runInspector,
} from "../lib/inspector.ts";
import { isEntryPoint } from "../lib/script.ts";
import {
  type ApiBody,
  type Capture,
  CONFIRM_REFUSAL,
  type Expectation,
  type Fixture,
  type Fixtures,
  isReadStep,
  SCOPE_REFUSAL,
  SWEEP_PHASES,
  SWEEP_PLAN,
  SWEEP_SURFACES,
  type SurfaceStep,
  type SweepContext,
  type SweepStep,
} from "./plan.ts";

const USAGE = `Usage: bun run sweep -- [options]

Calls every SetLuca MCP tool, resource, and prompt through the MCP Inspector CLI
and reports each against the outcome the plan expects. Sign in once in the web
Inspector first (see docs/inspector.md); every call reuses that stored token. Set
LUCA_SWEEP_API_KEY to sign in with a developer key instead, as CI does.

  --server-url <url>   MCP server (default https://mcp.setluca.com/mcp)
  --stdio              Sweep this checkout's build instead; needs LUCA_SWEEP_API_KEY
  --webhook-url <url>  SetLuca-owned URL webhook steps deliver to
  --only <tools>       Comma-separated tool names; discovery always runs
  --scope-check        Signed in with a read-only grant: every write must be refused
  --dry-run            Print the plan without calling anything
  --report-dir <dir>   Where the report goes (default sweep-reports)`;

type Verdict = "pass" | "fail" | "blocked" | "pending" | "skipped";

/** A verdict and the one line that explains it. */
type Judgement = {
  readonly verdict: Verdict;
  readonly note: string;
};

type CheckResult = Judgement & {
  readonly phase: string;
  readonly target: string;
  readonly check: string;
  readonly expected: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
};

type RunOptions = {
  readonly connection: InspectorConnection;
  readonly webhookUrl: string;
  readonly only: ReadonlySet<string> | undefined;
  readonly scopeCheck: boolean;
  readonly dryRun: boolean;
  readonly reportDir: string;
};

type FoundFixtures = Partial<Record<Fixture, string>>;

function field(
  value: JsonValue | undefined,
  key: string
): JsonValue | undefined {
  return isJsonObject(value) ? value[key] : undefined;
}

/** The API body a tool returned: `structuredContent.result` of the call result. */
function apiBody(outcome: InspectorOutcome): ApiBody {
  return field(
    field(field(outcome.output, "result"), "structuredContent"),
    "result"
  );
}

function describe(expect: Expectation): string {
  return Match.value(expect).pipe(
    Match.discriminatorsExhaustive("kind")({
      ok: () => "succeeds",
      refused: (refused) => `refused (${refused.because})`,
      pending: (pending) => `pending (${pending.because})`,
    })
  );
}

/** The first line of a tool's text, cut short for the report. */
function brief(text: string): string {
  const line = text.split("\n").find((part) => part.trim() !== "") ?? "";

  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function judgeRefusal(outcome: InspectorOutcome, match: RegExp): Judgement {
  if (outcome.exitCode === INSPECTOR_EXIT.ok) {
    return { verdict: "fail", note: "succeeded, but a refusal was expected" };
  }

  const isToolRefusal =
    outcome.exitCode === INSPECTOR_EXIT.toolError && match.test(outcome.text);

  return isToolRefusal
    ? { verdict: "pass", note: brief(outcome.text) }
    : {
        verdict: "fail",
        note: `exit ${outcome.exitCode}, unexpected answer: ${brief(outcome.text)}`,
      };
}

/**
 * Whether an outcome matches what the step expected. A refusal must be the
 * tool's own error (exit 5) with matching text, never a server error.
 */
function judge(outcome: InspectorOutcome, expect: Expectation): Judgement {
  if (outcome.durationMs > CALL_LIMIT_MS) {
    return {
      verdict: "fail",
      note: `took ${outcome.durationMs} ms, over the ${CALL_LIMIT_MS} ms limit`,
    };
  }

  if (/internal server error/i.test(outcome.text)) {
    return { verdict: "fail", note: `server error: ${brief(outcome.text)}` };
  }

  return Match.value(expect).pipe(
    Match.discriminatorsExhaustive("kind")({
      ok: (): Judgement =>
        outcome.exitCode === INSPECTOR_EXIT.ok
          ? { verdict: "pass", note: "" }
          : {
              verdict: "fail",
              note: `exit ${outcome.exitCode}: ${brief(outcome.text)}`,
            },
      refused: (refused) => judgeRefusal(outcome, refused.match),
      pending: (pending): Judgement => ({
        verdict: "pending",
        note: pending.because,
      }),
    })
  );
}

/**
 * How a run reaches the hosted server: with `LUCA_SWEEP_API_KEY` when it is set,
 * and otherwise with the sign-in the web Inspector stored.
 */
export function hostedConnection(
  serverUrl: string,
  apiKey: string | undefined
): InspectorConnection {
  return apiKey === undefined || apiKey === ""
    ? { kind: "oauth", serverUrl, auth: "refresh" }
    : { kind: "bearer", serverUrl, token: apiKey };
}

/** What a report names as the server it swept. */
function sweptTarget(connection: InspectorConnection): string {
  return connection.kind === "stdio"
    ? "this checkout's build"
    : connection.serverUrl;
}

/**
 * Sends requests one at a time. On a stored sign-in the first call refreshes it,
 * the rest reuse it, and a call refused for auth retries once after a refresh.
 */
function makeCaller(connection: InspectorConnection) {
  if (connection.kind !== "oauth") {
    return (request: InspectorRequest): Promise<InspectorOutcome> =>
      runInspector(connection, request);
  }

  const signedIn = (auth: InspectorAuth): InspectorConnection => ({
    ...connection,
    auth,
  });

  let refreshed = false;

  return async (request: InspectorRequest): Promise<InspectorOutcome> => {
    const auth: InspectorAuth = refreshed ? "stored" : "refresh";
    const outcome = await runInspector(signedIn(auth), request);

    if (!refreshed && outcome.exitCode !== INSPECTOR_EXIT.authRequired) {
      refreshed = true;
    }

    if (auth === "stored" && outcome.exitCode === INSPECTOR_EXIT.authRequired) {
      return runInspector(signedIn("refresh"), request);
    }

    return outcome;
  };
}

type Caller = ReturnType<typeof makeCaller>;

function missingNeeds(
  needs: readonly Fixture[] | undefined,
  fixtures: FoundFixtures
): readonly Fixture[] {
  return Arr.filter(needs ?? [], (name) => fixtures[name] === undefined);
}

/**
 * The fixtures as the complete map a step's argument builder reads. Callers
 * check `missingNeeds` first, so every fixture the step names is present.
 */
function presentFixtures(fixtures: FoundFixtures): Fixtures {
  // SAFETY: only called after missingNeeds() found every fixture the step needs.
  return fixtures as Fixtures;
}

function stepLabel(step: SweepStep): string {
  return step.extra === undefined ? step.tool : `${step.tool} (${step.extra})`;
}

/** The expectation a step runs with, after `--scope-check` rewrites writes. */
function effectiveExpectation(
  step: SweepStep,
  scopeCheck: boolean
): Expectation {
  const expect = step.expect ?? { kind: "ok" };

  if (!scopeCheck || isReadStep(step) || expect.kind === "pending") {
    return expect;
  }

  return {
    kind: "refused",
    because: "the grant is read-only, so the write has to be refused",
    match: SCOPE_REFUSAL,
  };
}

/** A step's captures as name and reader pairs. */
function provisions(step: SweepStep): readonly (readonly [Fixture, Capture])[] {
  // SAFETY: `provides` is typed Partial<Record<Fixture, Capture>>, so every key
  // Object.entries returns is a Fixture and every present value a Capture.
  return Object.entries(step.provides ?? {}) as (readonly [Fixture, Capture])[];
}

function capture(
  step: SweepStep,
  outcome: InspectorOutcome,
  fixtures: FoundFixtures
): void {
  const body = apiBody(outcome);

  for (const [name, read] of provisions(step)) {
    const value = read(body);

    if (value !== undefined) {
      fixtures[name] = value;
    }
  }
}

/** The values a call produced, to compare a repeated call with the first. */
function captured(step: SweepStep, outcome: InspectorOutcome): string {
  const body = apiBody(outcome);

  return Arr.map(provisions(step), ([, read]) => read(body) ?? "").join("|");
}

async function checkGate(
  step: SweepStep,
  call: Caller,
  args: JsonValue,
  base: Pick<CheckResult, "phase" | "target">
): Promise<CheckResult> {
  const ungated = await call({ method: "tools/call", name: step.tool, args });

  return {
    ...base,
    check: "refuses without confirm: true",
    expected: "refused until confirmed",
    exitCode: ungated.exitCode,
    durationMs: ungated.durationMs,
    ...judgeRefusal(ungated, CONFIRM_REFUSAL),
  };
}

async function checkRetry(
  step: SweepStep,
  call: Caller,
  args: JsonValue,
  first: InspectorOutcome,
  base: Pick<CheckResult, "phase" | "target">
): Promise<CheckResult> {
  const again = await call({ method: "tools/call", name: step.tool, args });
  const same = captured(step, first) === captured(step, again);

  return {
    ...base,
    check: "retry with the same idempotency key",
    expected: "same record, no second write",
    exitCode: again.exitCode,
    durationMs: again.durationMs,
    verdict: again.exitCode === INSPECTOR_EXIT.ok && same ? "pass" : "fail",
    note: same ? "" : "the retry returned a different record",
  };
}

/** Why a step is not called: it is pending, or a record it needs is missing. */
function reasonNotCalled(
  step: SweepStep,
  expect: Expectation,
  fixtures: FoundFixtures,
  scopeCheck: boolean
): Judgement | undefined {
  if (expect.kind === "pending") {
    return { verdict: "pending", note: expect.because };
  }

  const missing = missingNeeds(step.needs, fixtures);

  return Arr.isReadonlyArrayNonEmpty(missing)
    ? {
        verdict: scopeCheck ? "skipped" : "blocked",
        note: `needs ${missing.join(", ")}`,
      }
    : undefined;
}

async function runStep(
  step: SweepStep,
  call: Caller,
  fixtures: FoundFixtures,
  ctx: SweepContext,
  options: RunOptions
): Promise<readonly CheckResult[]> {
  const expect = effectiveExpectation(step, options.scopeCheck);
  const base = { phase: step.phase, target: stepLabel(step) };
  const expected = describe(expect);
  const notCalled = reasonNotCalled(step, expect, fixtures, options.scopeCheck);

  if (notCalled !== undefined) {
    return [{ ...base, check: "call", expected, ...notCalled }];
  }

  const args = step.args?.(presentFixtures(fixtures), ctx) ?? {};

  const gate =
    step.gated && !options.scopeCheck
      ? [await checkGate(step, call, args, base)]
      : [];

  const callArgs = {
    ...args,
    ...fieldsWhen(step.gated === true, { confirm: true }),
    ...fieldsWhen(step.repeat === true, {
      idempotencyKey: `sweep-${ctx.runId}-${step.tool}`,
    }),
  };

  const outcome = await call({
    method: "tools/call",
    name: step.tool,
    args: callArgs,
  });

  const judgement = judge(outcome, expect);

  const results: readonly CheckResult[] = [
    ...gate,
    {
      ...base,
      check: "call",
      expected,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      ...judgement,
    },
  ];

  if (judgement.verdict !== "pass" || options.scopeCheck) {
    return results;
  }

  capture(step, outcome, fixtures);

  return step.repeat
    ? [...results, await checkRetry(step, call, callArgs, outcome, base)]
    : results;
}

type ListingMethod = Extract<
  SurfaceStep["method"],
  "tools/list" | "resources/list" | "resources/templates/list" | "prompts/list"
>;

/** What each listing should return, counted from the server's own registry. */
const LISTINGS: Readonly<
  Record<ListingMethod, { readonly key: string; readonly count: number }>
> = {
  "tools/list": {
    key: "tools",
    count: LUCA_OPERATIONS.length + LUCA_TASK_TOOLS.length,
  },
  // The planner prompt is registered beside the workflow prompts.
  "prompts/list": { key: "prompts", count: LUCA_PROMPTS.length + 1 },
  // The fixed-URI resources, plus the operation manifest.
  "resources/list": {
    key: "resources",
    count:
      Arr.filter(LUCA_RESOURCES, (resource) => "uri" in resource).length + 1,
  },
  "resources/templates/list": {
    key: "resourceTemplates",
    count: Arr.filter(LUCA_RESOURCES, (resource) => "uriTemplate" in resource)
      .length,
  },
};

async function readSurface(call: Caller, uri: string): Promise<CheckResult> {
  const outcome = await call({ method: "resources/read", uri });

  return {
    phase: "surface",
    target: uri,
    check: "read",
    expected: "answers",
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    ...judge(outcome, { kind: "ok" }),
  };
}

async function getPrompt(call: Caller, name: string): Promise<CheckResult> {
  const outcome = await call({ method: "prompts/get", name });

  return {
    phase: "surface",
    target: name,
    check: "get",
    expected: "answers",
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    ...judge(outcome, { kind: "ok" }),
  };
}

async function countListing(
  call: Caller,
  method: ListingMethod
): Promise<CheckResult> {
  const outcome = await call({ method });
  const listing = LISTINGS[method];
  const listed = field(field(outcome.output, "result"), listing.key);
  const count = isJsonArray(listed) ? listed.length : undefined;
  const judgement = judge(outcome, { kind: "ok" });
  const countMatches = count === listing.count;

  return {
    phase: "surface",
    target: method,
    check: "count",
    expected: `${listing.count} listed`,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    verdict: judgement.verdict === "pass" && countMatches ? "pass" : "fail",
    note: countMatches ? judgement.note : `listed ${count ?? "nothing"}`,
  };
}

function runSurface(
  surface: SurfaceStep,
  call: Caller,
  fixtures: FoundFixtures
): Promise<CheckResult> {
  return Match.value(surface).pipe(
    Match.discriminatorsExhaustive("method")({
      "resources/read": (read) => {
        const missing = missingNeeds(read.needs, fixtures);

        return Arr.isReadonlyArrayNonEmpty(missing)
          ? Promise.resolve<CheckResult>({
              phase: "surface",
              target: "templated resource",
              check: "read",
              expected: "answers",
              verdict: "blocked",
              note: `needs ${missing.join(", ")}`,
            })
          : readSurface(call, read.uri(presentFixtures(fixtures)));
      },
      "prompts/get": (prompt) => getPrompt(call, prompt.name),
      "tools/list": () => countListing(call, "tools/list"),
      "prompts/list": () => countListing(call, "prompts/list"),
      "resources/list": () => countListing(call, "resources/list"),
      "resources/templates/list": () =>
        countListing(call, "resources/templates/list"),
    })
  );
}

function summarize(results: readonly CheckResult[]): Record<Verdict, number> {
  const counts: Record<Verdict, number> = {
    pass: 0,
    fail: 0,
    blocked: 0,
    pending: 0,
    skipped: 0,
  };

  for (const result of results) {
    counts[result.verdict] += 1;
  }

  return counts;
}

function summaryLine(counts: Record<Verdict, number>): string {
  return `Pass ${counts.pass}, fail ${counts.fail}, blocked ${counts.blocked}, pending ${counts.pending}, skipped ${counts.skipped}.`;
}

function markdownRow(result: CheckResult): string {
  const escape = (text: string) => text.replaceAll("|", "\\|");

  return `| ${result.phase} | \`${result.target}\` | ${result.check} | ${escape(result.expected)} | ${result.verdict} | ${result.exitCode ?? ""} | ${result.durationMs ?? ""} | ${escape(result.note)} |`;
}

function markdownReport(
  options: RunOptions,
  ctx: SweepContext,
  results: readonly CheckResult[]
): string {
  const scope = options.scopeCheck ? " (scope check: read-only grant)" : "";

  return [
    `# SetLuca MCP tool sweep, ${DateTime.formatIso(ctx.now)}`,
    "",
    `Server: ${sweptTarget(options.connection)}${scope}`,
    "",
    summaryLine(summarize(results)),
    "",
    "| Phase | Target | Check | Expected | Verdict | Exit | ms | Note |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...Arr.map(results, markdownRow),
    "",
  ].join("\n");
}

function readOptions(argv: readonly string[]): RunOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "server-url": { type: "string", default: "https://mcp.setluca.com/mcp" },
      "webhook-url": {
        type: "string",
        default: "https://mcp.setluca.com/sweep/webhook",
      },
      only: { type: "string" },
      stdio: { type: "boolean", default: false },
      "scope-check": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "report-dir": { type: "string", default: "sweep-reports" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const apiKey = process.env.LUCA_SWEEP_API_KEY;

  if (values.stdio && (apiKey === undefined || apiKey === "")) {
    console.error("--stdio needs a developer key in LUCA_SWEEP_API_KEY");
    process.exit(2);
  }

  return {
    connection: values.stdio
      ? { kind: "stdio", apiKey }
      : hostedConnection(values["server-url"], apiKey),
    webhookUrl: values["webhook-url"],
    only:
      values.only === undefined ? undefined : new Set(values.only.split(",")),
    scopeCheck: values["scope-check"],
    dryRun: values["dry-run"],
    reportDir: values["report-dir"],
  };
}

const byPhase = Order.mapInput(Order.Number, (step: SweepStep) =>
  SWEEP_PHASES.indexOf(step.phase)
);

/** The steps a run executes, in phase order. Discovery always runs. */
function selectedSteps(options: RunOptions): readonly SweepStep[] {
  const wanted = Arr.filter(
    SWEEP_PLAN,
    (step) =>
      options.only === undefined ||
      step.phase === "discover" ||
      options.only.has(step.tool)
  );

  return Arr.sort(wanted, byPhase);
}

function printPlan(steps: readonly SweepStep[], scopeCheck: boolean): void {
  for (const step of steps) {
    const flags = `${step.gated ? " [gated]" : ""}${step.repeat ? " [retry]" : ""}`;

    console.log(
      `${step.phase.padEnd(8)} ${stepLabel(step)}${flags} -> ${describe(effectiveExpectation(step, scopeCheck))}`
    );
  }
}

function printResult(result: CheckResult): void {
  console.log(
    `${result.phase.padEnd(8)} ${result.verdict.toUpperCase().padEnd(7)} ${result.target} [${result.check}] ${result.durationMs ?? ""}ms ${result.note}`
  );
}

function writeReport(
  options: RunOptions,
  ctx: SweepContext,
  fixtures: FoundFixtures,
  results: readonly CheckResult[]
): string {
  mkdirSync(options.reportDir, { recursive: true });

  const stamp = DateTime.formatIso(ctx.now).replaceAll(":", "-");
  const markdownPath = join(options.reportDir, `sweep-${stamp}.md`);

  writeFileSync(
    join(options.reportDir, `sweep-${stamp}.json`),
    JSON.stringify(
      {
        server: sweptTarget(options.connection),
        scopeCheck: options.scopeCheck,
        startedAt: DateTime.formatIso(ctx.now),
        counts: summarize(results),
        fixtures,
        results,
      },
      null,
      2
    )
  );
  writeFileSync(markdownPath, markdownReport(options, ctx, results));

  return markdownPath;
}

/** Luca writes an audit row just after the response, so give it time to land. */
const AUDIT_SETTLE_MS = 3000;

const AuditLogPage = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ id: Schema.String, action: Schema.String })
  ),
});

type AuditRows = (typeof AuditLogPage.Type)["items"];

const decodeAuditLogPage = Schema.decodeUnknownOption(AuditLogPage);

/** The only account a sweep may run on. Luca's seed allows the same one. */
const SWEEP_ACCOUNT = "support@setluca.com";

/**
 * Why this key or sign-in must not be swept, or nothing when it is the sweep
 * account's. A sweep calls every write tool on whichever workspace it reaches, so
 * this keeps a key made on the wrong account away from a coach's data. The message
 * leaves out whose account it is, because CI logs keep it.
 */
export function workspaceRefusal(
  outcome: InspectorOutcome
): string | undefined {
  if (outcome.exitCode !== INSPECTOR_EXIT.ok) {
    return `could not read which account this is, so it may not be ${SWEEP_ACCOUNT}`;
  }

  return field(apiBody(outcome), "email") === SWEEP_ACCOUNT
    ? undefined
    : `this key or sign-in does not belong to ${SWEEP_ACCOUNT}`;
}

/** The rows an audit log read returned, or nothing when it can't be read. */
export function auditRowsOf(outcome: InspectorOutcome): AuditRows | undefined {
  return outcome.exitCode === INSPECTOR_EXIT.ok
    ? Option.getOrUndefined(decodeAuditLogPage(apiBody(outcome)))?.items
    : undefined;
}

/**
 * Only rows an API key wrote, which covers the sweep's own calls. Luca's background
 * jobs write rows too, as `system`, and those say nothing about a tool.
 */
function readNewestAuditRow(call: Caller): Promise<InspectorOutcome> {
  return call({
    method: "tools/call",
    name: "luca_coach_audit_log",
    args: { query: { limit: 1, actorType: "api_key" }, maxPages: 1 },
  });
}

/** Whether the read-only phases left the audit log as they found it. */
export function judgeAuditLog(
  before: AuditRows | undefined,
  after: AuditRows | undefined
): CheckResult {
  const base = {
    phase: "read",
    target: "luca_coach_audit_log",
    check: "read-only tools",
    expected: "no new audit row",
  };

  if (before === undefined || after === undefined) {
    return {
      ...base,
      verdict: "fail",
      note: "could not read the audit log, so the read-only phases went unchecked",
    };
  }

  return before[0]?.id === after[0]?.id
    ? {
        ...base,
        verdict: "pass",
        note: "the newest audit row did not change",
      }
    : {
        ...base,
        verdict: "fail",
        note: `a tool marked read-only changed the audit log: ${after[0]?.action ?? "it is now empty"}`,
      };
}

export async function runSweep(options: RunOptions): Promise<number> {
  const now = DateTime.nowUnsafe();

  const ctx: SweepContext = {
    runId: `s${DateTime.toEpochMillis(now).toString(36)}`,
    webhookUrl: options.webhookUrl,
    now,
  };

  const steps = selectedSteps(options);

  if (options.dryRun) {
    printPlan(steps, options.scopeCheck);

    return 0;
  }

  const call = makeCaller(options.connection);

  const refusal = workspaceRefusal(
    await call({ method: "tools/call", name: "luca_coach_profile", args: {} })
  );

  if (refusal !== undefined) {
    console.error(`Refusing to sweep: ${refusal}.`);

    return 2;
  }

  const fixtures: FoundFixtures = {};
  const results: CheckResult[] = [];

  const runSteps = async (selected: readonly SweepStep[]) => {
    for (const step of selected) {
      for (const result of await runStep(step, call, fixtures, ctx, options)) {
        results.push(result);
        printResult(result);
      }
    }
  };

  const reads = steps.filter(isReadStep);
  const writes = steps.filter((step) => !isReadStep(step));
  const auditBefore = auditRowsOf(await readNewestAuditRow(call));

  await runSteps(reads);

  // Every tool in these phases is marked read-only, and sweep-plan.test.ts holds
  // the plan to that, so a new row here means one of them is not.
  await sleep(AUDIT_SETTLE_MS);

  const auditCheck = judgeAuditLog(
    auditBefore,
    auditRowsOf(await readNewestAuditRow(call))
  );

  results.push(auditCheck);
  printResult(auditCheck);

  await runSteps(writes);

  if (options.only === undefined && !options.scopeCheck) {
    for (const surface of SWEEP_SURFACES) {
      const result = await runSurface(surface, call, fixtures);

      results.push(result);
      printResult(result);
    }
  }

  const reportPath = writeReport(options, ctx, fixtures, results);
  const counts = summarize(results);

  console.log(`\n${summaryLine(counts)}\nReport: ${reportPath}`);

  return counts.fail + counts.blocked > 0 ? 1 : 0;
}

if (isEntryPoint(import.meta.filename)) {
  process.exit(await runSweep(readOptions(process.argv.slice(2))));
}
