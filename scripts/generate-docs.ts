import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { format } from "oxfmt";

import { LUCA_OPERATIONS, operationGroups } from "../src/operations.ts";
import {
  LUCA_API_PLANNER_PROMPT,
  LUCA_PROMPTS,
  type PromptArgs,
} from "../src/prompts.ts";
import {
  LUCA_OPERATION_MANIFEST_RESOURCE,
  LUCA_RESOURCES,
} from "../src/resources.ts";
import {
  CAPABILITY_LADDER,
  capabilityRank,
  lowestCapabilityScopeFor,
  type LucaCapabilityScope,
  NON_TIER_OAUTH_SCOPES,
  OAUTH_CAPABILITY_SCOPES,
  OAUTH_DEFAULT_SCOPE,
  oauthScopeForOperation,
  oauthScopeForTool,
  tierGrants,
  unknownApiScopes,
} from "../src/scopes.ts";
import { LUCA_TASK_TOOLS } from "../src/task-tools.ts";
import { fromTaskTool } from "../src/tool.ts";
import {
  packagePath,
  readCurrent,
  writeGenerated,
} from "./lib/generated-file.ts";
import { exitWith, runScript, scriptMode } from "./lib/script.ts";

/** The catalog cannot be documented as it stands: the message says why. */
class DocsInputError extends Schema.TaggedError<DocsInputError>()(
  "DocsInputError",
  { message: Schema.String }
) {}

/** One generated file: where it lands and the lines that make it up. */
type GeneratedDoc = {
  readonly path: string;
  readonly render: () => readonly string[];
};

function markdownTableCell(value: string) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderGroupRows(groups: ReturnType<typeof operationGroups>) {
  return groups.map((group) =>
    [
      group.title,
      String(group.toolCount),
      group.scopes.map((scope) => `\`${scope}\``).join(", "),
      markdownTableCell(group.description),
    ].join(" | ")
  );
}

function groupTitleFor(
  groups: ReturnType<typeof operationGroups>,
  groupId: string
) {
  return groups.find((group) => group.id === groupId)?.title ?? groupId;
}

function renderOperationRows(
  groups: ReturnType<typeof operationGroups>,
  operations: typeof LUCA_OPERATIONS
) {
  return operations.map((operation) =>
    [
      `\`${operation.toolName}\``,
      groupTitleFor(groups, operation.group),
      operation.method,
      `\`${operation.path}\``,
      operation.scopes.map((scope) => `\`${scope}\``).join(", "),
      operation.idempotencyRequired ? "required" : "not required",
      operation.confirm === undefined ? "—" : "required",
      markdownTableCell(operation.description),
    ].join(" | ")
  );
}

function renderTaskToolRows() {
  return LUCA_TASK_TOOLS.map((tool) =>
    [
      `\`${tool.name}\``,
      tool.composes.map((id) => `\`${id}\``).join(", "),
      fromTaskTool(tool).readOnly ? "read-only" : "write",
      markdownTableCell(firstSentence(tool.description)),
    ].join(" | ")
  );
}

function firstSentence(text: string) {
  const end = text.indexOf(". ");

  return end === -1 ? text : text.slice(0, end + 1);
}

function renderToolsReference(): readonly string[] {
  const groups = operationGroups();

  return [
    "# Tool reference",
    "",
    "This file is generated from the operation groups under `src/operations/` and",
    "the task tools under `src/task-tools/`. Never edit it by hand.",
    "",
    "Run `bun run docs:generate` after changing the operation manifest.",
    "",
    `Total tools: ${LUCA_OPERATIONS.length + LUCA_TASK_TOOLS.length} (${LUCA_OPERATIONS.length} operations + ${LUCA_TASK_TOOLS.length} task tools)`,
    "",
    "A tool whose `outputSchema.result` carries an `x-luca-redacted-fields`",
    "marker may return those fields blanked for a `redacted`-tier API key. See",
    '"Which fields may be stripped" in `docs/security.md`.',
    "",
    "The `Scopes` column names the API scopes a tool needs. To find which OAuth",
    "scope grants them, see `docs/scopes.md`.",
    "",
    "## Groups",
    "",
    "| Group | Tools | Scopes | Description |",
    "|---|---:|---|---|",
    ...renderGroupRows(groups),
    "",
    "## Tools",
    "",
    "| Tool | Group | Method | Path | Scopes | Idempotency | Confirm | Description |",
    "|---|---|---|---|---|---|---|---|",
    ...renderOperationRows(groups, LUCA_OPERATIONS),
    "",
    "## Task tools",
    "",
    "Intent-level tools composed from the operations above. With",
    "`LUCA_TOOLSET=tasks`, these plus `luca_capabilities_get` are the only tools",
    "the server registers.",
    "",
    "| Tool | Composes | Access | Description |",
    "|---|---|---|---|",
    ...renderTaskToolRows(),
  ];
}

function promptArgumentCell(args: PromptArgs) {
  const names = R.keys(args);

  if (Arr.isReadonlyArrayEmpty(names)) {
    return "none";
  }

  return names.map((name) => `\`${name}\``).join(", ");
}

function renderPromptRows() {
  return [LUCA_API_PLANNER_PROMPT, ...LUCA_PROMPTS].map((prompt) =>
    [
      `\`${prompt.name}\``,
      markdownTableCell(prompt.title),
      promptArgumentCell(prompt.args),
      markdownTableCell(prompt.description),
    ].join(" | ")
  );
}

function renderResourceRows() {
  const backed = LUCA_RESOURCES.map((resource) => ({
    name: resource.name,
    title: resource.title,
    uri: "uriTemplate" in resource ? resource.uriTemplate : resource.uri,
    backing: `\`${resource.operationId}\``,
    description: resource.description,
  }));

  const manifest = {
    name: LUCA_OPERATION_MANIFEST_RESOURCE.name,
    title: LUCA_OPERATION_MANIFEST_RESOURCE.title,
    uri: LUCA_OPERATION_MANIFEST_RESOURCE.uri,
    backing: "none (built locally)",
    description: LUCA_OPERATION_MANIFEST_RESOURCE.description,
  };

  return [manifest, ...backed].map((resource) =>
    [
      `\`${resource.name}\``,
      markdownTableCell(resource.title),
      `\`${resource.uri}\``,
      resource.backing,
      markdownTableCell(resource.description),
    ].join(" | ")
  );
}

function renderPromptsAndResources(): readonly string[] {
  const promptCount = LUCA_PROMPTS.length + 1;
  const resourceCount = LUCA_RESOURCES.length + 1;

  return [
    "# Prompt and resource reference",
    "",
    "This file is generated from `src/prompts.ts` and `src/resources.ts`. Never",
    "edit it by hand. Run `bun run docs:generate` after changing either.",
    "",
    `${promptCount} prompts, ${resourceCount} resources.`,
    "",
    "## Prompts",
    "",
    "Prompts are the slash-command workflows a client shows in its prompt",
    "picker. Each one composes tools that already exist, so a coach's agent gets",
    "a known-good starting point instead of re-deriving the chain every session.",
    "Every argument is an optional string, because a slash-command argument",
    "arrives as text or not at all.",
    "",
    "| Prompt | Title | Arguments | Description |",
    "|---|---|---|---|",
    ...renderPromptRows(),
    "",
    "## Resources",
    "",
    "Resources let a client attach context by URI without spending a tool call.",
    "A URI containing `{braces}` is an RFC 6570 template the client fills in;",
    "the rest are fixed.",
    "",
    "Every resource except `luca-public-operations` is backed by a read",
    "operation, so it reuses that operation's request building, scope",
    "requirements, and untrusted-content framing. The MCP resources protocol has",
    "no `outputSchema`, so to learn which fields may arrive blanked for a",
    "`redacted`-tier key, read the backing operation's entry in `tools.md`.",
    "",
    "| Resource | Title | URI | Backed by | Description |",
    "|---|---|---|---|---|",
    ...renderResourceRows(),
  ];
}

const OPERATIONS_BY_ID = R.fromEntries(
  LUCA_OPERATIONS.map((operation) => [operation.id, operation] as const)
);

/** The operations a task tool runs, in the order it declares them. */
function composedOperations(tool: (typeof LUCA_TASK_TOOLS)[number]) {
  return tool.composes.map((id) => {
    const operation = OPERATIONS_BY_ID[id];

    // Skipping an unresolved id would quietly understate what the tool needs,
    // and an under-stated scope table is worse than no table.
    if (!operation) {
      throw new DocsInputError({
        message: `${tool.name} composes ${id}, which is not an operation id.`,
      });
    }

    return operation;
  });
}

/** Every API scope a task tool's operations declare, sorted. */
function taskToolScopes(tool: (typeof LUCA_TASK_TOOLS)[number]) {
  return Arr.sort(
    Arr.dedupe(composedOperations(tool).flatMap((op) => op.scopes)),
    Order.String
  );
}

function taskToolScope(tool: (typeof LUCA_TASK_TOOLS)[number]) {
  return oauthScopeForTool(composedOperations(tool));
}

/**
 * Whether a connection holding `granted` can call a tool that needs
 * `required`. The tiers nest, so comparing ranks is enough. Counting from the
 * same `oauthScopeForOperation` that fills `securitySchemes` keeps this table
 * equal to what a client is told per tool.
 */
function reaches(granted: LucaCapabilityScope, required: LucaCapabilityScope) {
  return capabilityRank(required) <= capabilityRank(granted);
}

function renderCapabilityRows() {
  return CAPABILITY_LADDER.map((scope, index) => {
    const below = CAPABILITY_LADDER[index - 1];

    const added = OAUTH_CAPABILITY_SCOPES[scope].filter(
      (apiScope) => below === undefined || !tierGrants(below, apiScope)
    );

    const operations = LUCA_OPERATIONS.filter((operation) =>
      reaches(scope, oauthScopeForOperation(operation))
    );

    const tasks = LUCA_TASK_TOOLS.filter((tool) =>
      reaches(scope, taskToolScope(tool))
    );

    return [
      `\`${scope}\``,
      String(operations.length),
      String(tasks.length),
      added.map((entry) => `\`${entry}\``).join(", "),
    ].join(" | ");
  });
}

function renderApiScopeRows() {
  const groups = operationGroups();
  const used = Arr.dedupe(LUCA_OPERATIONS.flatMap((op) => op.scopes));

  return Arr.sort(used, Order.String).map((scope) => {
    const tools = LUCA_OPERATIONS.filter((op) => op.scopes.includes(scope));

    const inGroups = Arr.sort(
      Arr.dedupe(tools.map((op) => op.group)),
      Order.String
    ).map((id) => groupTitleFor(groups, id));

    return [
      `\`${scope}\``,
      `\`${lowestCapabilityScopeFor(scope) ?? "none"}\``,
      String(tools.length),
      markdownTableCell(inGroups.join(", ")),
    ].join(" | ");
  });
}

function renderTaskToolScopeRows() {
  return LUCA_TASK_TOOLS.map((tool) =>
    [
      `\`${tool.name}\``,
      `\`${taskToolScope(tool)}\``,
      taskToolScopes(tool)
        .map((scope) => `\`${scope}\``)
        .join(", "),
    ].join(" | ")
  );
}

function renderNonTierRows() {
  return R.toEntries(NON_TIER_OAUTH_SCOPES).map(([scope, description]) =>
    [`\`${scope}\``, markdownTableCell(description)].join(" | ")
  );
}

function renderScopes(): readonly string[] {
  return [
    "# Scope reference",
    "",
    "This file is generated from `src/scopes.ts` and the operation catalog.",
    "Never edit it by hand. Run `bun run docs:generate` after changing either.",
    "",
    "Two scope vocabularies meet in this server. A tool call returns 403 when a",
    "caller uses the wrong one.",
    "",
    "An **API scope** (`leads:read`, `bookings:write`) is what Luca's API checks",
    "on every request. Each tool declares the ones it needs, and `tools.md`",
    "lists them per tool. An API key you create in the Luca dashboard carries",
    "API scopes directly.",
    "",
    "An **OAuth scope** (`luca:draft`) is what a remote client asks for when it",
    "connects through `mcp.setluca.com`. Luca's authorization server vends a key",
    "carrying every API scope that tier covers. A client never names an API",
    "scope itself.",
    "",
    `New connections default to \`${OAUTH_DEFAULT_SCOPE}\`.`,
    "",
    "## What each OAuth scope unlocks",
    "",
    "The tiers nest, so `luca:full` grants everything `luca:queue_ops` does. The",
    "counts are tools reachable with that scope alone, not tools added by it.",
    "Each tool counts at the scope its `_meta.securitySchemes` names: the lowest",
    "tier granting any one of its API scopes, raised to the tool's own capability",
    "tier when that is higher.",
    "",
    "| OAuth scope | Operation tools | Task tools | API scopes added over the tier below |",
    "|---|---:|---:|---|",
    ...renderCapabilityRows(),
    "",
    "Two scopes grant no API scopes at all:",
    "",
    "| OAuth scope | What it does |",
    "|---|---|",
    ...renderNonTierRows(),
    "",
    "## Which OAuth scope covers an API scope",
    "",
    "Read this when a tool returns 403 and you need to know what to ask for.",
    "The middle column is the least-privilege answer.",
    "",
    "| API scope | Lowest OAuth scope granting it | Tools | Groups |",
    "|---|---|---:|---|",
    ...renderApiScopeRows(),
    "",
    "## Task tools",
    "",
    "A task tool composes several operations, so it needs the union of their",
    "scopes and the highest OAuth scope any of them needs.",
    "",
    "| Task tool | Needs at least | API scopes |",
    "|---|---|---|",
    ...renderTaskToolScopeRows(),
  ];
}

const DOCS: readonly GeneratedDoc[] = [
  { path: "docs/tools.md", render: renderToolsReference },
  { path: "docs/prompts-and-resources.md", render: renderPromptsAndResources },
  { path: "docs/scopes.md", render: renderScopes },
];

function renderDoc(doc: GeneratedDoc) {
  return Effect.gen(function* () {
    const target = yield* packagePath(doc.path);
    const rendered = `${[...doc.render(), ""].join("\n")}\n`;

    const formatted = yield* Effect.tryPromise({
      try: () => format(target, rendered, { proseWrap: "preserve" }),
      catch: (cause) =>
        new DocsInputError({
          message: `Oxfmt could not format ${doc.path}: ${String(cause)}`,
        }),
    });

    if (Arr.isReadonlyArrayNonEmpty(formatted.errors)) {
      return yield* exitWith([`Oxfmt could not format ${doc.path}`]);
    }

    return { path: doc.path, content: formatted.code };
  });
}

/**
 * Fails when a tool needs an API scope no OAuth tier grants. That tool would be
 * unreachable for every remote client, and the generated scope table would show
 * a blank where the answer should be, so stop before writing one.
 */
const assertScopeLadderCovers = Effect.suspend(() => {
  const unknown = unknownApiScopes(LUCA_OPERATIONS);

  if (Arr.isReadonlyArrayNonEmpty(unknown)) {
    return exitWith([
      `No OAuth capability scope grants ${unknown.join(", ")}. Update the tier ladder in src/scopes.ts to match apps/api/src/lib/public-route-policy.ts.`,
    ]);
  }

  return Effect.void;
});

function checkDocs(
  rendered: readonly { readonly path: string; readonly content: string }[]
) {
  return Effect.gen(function* () {
    const stale = yield* Effect.filter(
      rendered,
      (doc) =>
        Effect.map(readCurrent(doc.path), (current) => current !== doc.content),
      { concurrency: 1 }
    );

    if (Arr.isReadonlyArrayNonEmpty(stale)) {
      return yield* exitWith([
        `out of date: ${stale.map((doc) => doc.path).join(", ")}. Run \`bun run docs:generate\`.`,
      ]);
    }

    yield* Console.log("docs are in sync");
  });
}

const main = Effect.fn("generate-docs")(function* () {
  const mode = yield* scriptMode("usage: generate-docs.ts --write|--check");

  yield* assertScopeLadderCovers;

  const rendered = yield* Effect.forEach(DOCS, renderDoc, {
    concurrency: "unbounded",
  });

  if (mode === "write") {
    yield* Effect.forEach(
      rendered,
      (doc) => writeGenerated(doc.path, doc.content),
      { concurrency: 1, discard: true }
    );

    return;
  }

  yield* checkDocs(rendered);
});

runScript(main());
