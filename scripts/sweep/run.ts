import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Match from "effect/Match";
import * as Order from "effect/Order";

import { LUCA_OPERATIONS } from "../../src/operations/catalog.ts";
import { LUCA_PROMPTS } from "../../src/prompts.ts";
import { LUCA_RESOURCES } from "../../src/resources.ts";
import {
  isJsonArray,
  isJsonObject,
  type JsonValue,
} from "../../src/serialization.ts";
import { LUCA_TASK_TOOLS } from "../../src/task-tools.ts";
import { isEntryPoint } from "../lib/script.ts";
import {
  CALL_LIMIT_MS,
  INSPECTOR_EXIT,
  type InspectorAuth,
  type InspectorOutcome,
  type InspectorRequest,
  runInspector,
} from "./inspector.ts";
import {
  type ApiBody,
  type Capture,
  CONFIRM_REFUSAL,
  type Expectation,
  type Fixture,
  type Fixtures,
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
Inspector first (see docs/inspector.md); every call reuses that stored token.

  --server-url <url>   MCP server (default https://mcp.setluca.com/mcp)
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
  readonly serverUrl: string;
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
 * Sends requests one at a time. The first call refreshes the stored sign-in,
 * the rest reuse it, and a call refused for auth retries once after a refresh.
 */
function makeCaller(serverUrl: string) {
  let refreshed = false;

  return async (request: InspectorRequest): Promise<InspectorOutcome> => {
    const auth: InspectorAuth = refreshed ? "stored" : "refresh";
    const outcome = await runInspector(serverUrl, request, auth);

    if (!refreshed && outcome.exitCode !== INSPECTOR_EXIT.authRequired) {
      refreshed = true;
    }

    if (auth === "stored" && outcome.exitCode === INSPECTOR_EXIT.authRequired) {
      return runInspector(serverUrl, request, "refresh");
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
  const isWrite = step.phase !== "discover" && step.phase !== "read";

  if (!scopeCheck || !isWrite || expect.kind === "pending") {
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

  if (expect.kind === "pending") {
    return [
      {
        ...base,
        check: "call",
        expected,
        verdict: "pending",
        note: expect.because,
      },
    ];
  }

  const missing = missingNeeds(step.needs, fixtures);

  if (Arr.isReadonlyArrayNonEmpty(missing)) {
    return [
      {
        ...base,
        check: "call",
        expected,
        verdict: options.scopeCheck ? "skipped" : "blocked",
        note: `needs ${missing.join(", ")}`,
      },
    ];
  }

  const args = step.args?.(presentFixtures(fixtures), ctx) ?? {};
  const results: CheckResult[] = [];

  if (step.gated && !options.scopeCheck) {
    results.push(await checkGate(step, call, args, base));
  }

  const callArgs = {
    ...args,
    ...(step.gated ? { confirm: true } : undefined),
    ...(step.repeat
      ? { idempotencyKey: `sweep-${ctx.runId}-${step.tool}` }
      : undefined),
  };

  const outcome = await call({
    method: "tools/call",
    name: step.tool,
    args: callArgs,
  });

  const judgement = judge(outcome, expect);

  results.push({
    ...base,
    check: "call",
    expected,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    ...judgement,
  });

  if (judgement.verdict !== "pass" || options.scopeCheck) {
    return results;
  }

  capture(step, outcome, fixtures);

  if (step.repeat) {
    results.push(await checkRetry(step, call, callArgs, outcome, base));
  }

  return results;
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
    `Server: ${options.serverUrl}${scope}`,
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

  return {
    serverUrl: values["server-url"],
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
        serverUrl: options.serverUrl,
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

  const call = makeCaller(options.serverUrl);
  const fixtures: FoundFixtures = {};
  const results: CheckResult[] = [];

  for (const step of steps) {
    for (const result of await runStep(step, call, fixtures, ctx, options)) {
      results.push(result);
      printResult(result);
    }
  }

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
