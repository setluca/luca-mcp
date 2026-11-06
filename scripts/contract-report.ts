/**
 * What a contract sync changed for the routes MCP tools call, tool by tool.
 *
 * Generated schemas catch a changed shape, but a route can change what it does
 * while only its description says so: Luca stopped turning on the workspace
 * auto-send switch for API keys, and nothing but one sentence in OpenAPI showed
 * it. So any change to a route's text is listed here for a person to compare
 * with the tool's own hints and text.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { toolNameFor } from "../src/operations/registry.ts";
import {
  type JsonValue,
  type JsonValueInput,
  parseJson,
  toJsonPayload,
} from "../src/serialization.ts";
import {
  findOpenApiOperation,
  type OpenApiOperation,
} from "./lib/openapi-operation.ts";
import { exitWith, isEntryPoint, runScript } from "./lib/script.ts";
import {
  type ApiKeyPolicyEntry,
  loadApiKeyPolicies,
  loadOpenApi,
  parseApiKeyPolicies,
} from "./load-openapi.ts";

/** Luca appends this to a route's description, and scope changes are listed on their own. */
const SCOPES_FOOTER = "\n\n**API key scopes:**";

type Contract = {
  readonly spec: JsonValue;
  readonly policies: readonly ApiKeyPolicyEntry[];
};

type Route = { readonly id: string; readonly route: string };

export type ContractChanges = {
  readonly removed: readonly Route[];
  readonly added: readonly Route[];
  readonly access: readonly Route[];
  readonly text: readonly (Route & {
    readonly before: string;
    readonly after: string;
  })[];
  readonly input: readonly Route[];
  readonly output: readonly Route[];
};

function routeOf(policy: ApiKeyPolicyEntry): Route {
  return { id: policy.id, route: `${policy.method} ${policy.path}` };
}

function byId(policies: readonly ApiKeyPolicyEntry[]) {
  return new Map(policies.map((policy) => [policy.id, policy]));
}

function operationOf(contract: Contract, policy: ApiKeyPolicyEntry) {
  return Option.getOrUndefined(findOpenApiOperation(contract.spec, policy));
}

function textOf(operation: OpenApiOperation | undefined): string {
  return operation?.description?.split(SCOPES_FOOTER)[0] ?? "";
}

function accessOf(policy: ApiKeyPolicyEntry): string {
  return JSON.stringify([policy.scopes, Boolean(policy.requireIdempotency)]);
}

function differ(left: JsonValueInput, right: JsonValueInput): boolean {
  return toJsonPayload(left) !== toJsonPayload(right);
}

/** Only routes in the API-key allowlist have a tool to go stale. */
export function contractChanges(
  before: Contract,
  after: Contract
): ContractChanges {
  const was = byId(before.policies);
  const now = byId(after.policies);

  const kept = after.policies.flatMap((policy) => {
    const previous = was.get(policy.id);

    return previous === undefined
      ? []
      : [
          {
            route: routeOf(policy),
            access: [accessOf(previous), accessOf(policy)] as const,
            old: operationOf(before, previous),
            current: operationOf(after, policy),
          },
        ];
  });

  return {
    removed: before.policies.filter(({ id }) => !now.has(id)).map(routeOf),
    added: after.policies.filter(({ id }) => !was.has(id)).map(routeOf),
    access: kept.flatMap(({ route, access: [left, right] }) =>
      left === right ? [] : [route]
    ),
    text: kept.flatMap(({ route, old, current }) =>
      textOf(old) === textOf(current)
        ? []
        : [{ ...route, before: textOf(old), after: textOf(current) }]
    ),
    input: kept.flatMap(({ route, old, current }) =>
      differ(
        [old?.parameters, old?.requestBody],
        [current?.parameters, current?.requestBody]
      )
        ? [route]
        : []
    ),
    output: kept.flatMap(({ route, old, current }) =>
      differ(old?.responses, current?.responses) ? [route] : []
    ),
  };
}

export function hasChanges(changes: ContractChanges): boolean {
  return Object.values(changes).some((list) => list.length > 0);
}

function routeLine({ id, route }: Route): string {
  return `- \`${toolNameFor(id)}\`: \`${route}\``;
}

function section(
  title: string,
  why: string,
  lines: readonly string[]
): readonly string[] {
  return lines.length === 0 ? [] : [`### ${title}`, "", why, "", ...lines, ""];
}

export function changesReport(changes: ContractChanges): string {
  if (!hasChanges(changes)) {
    return "No route an MCP tool calls changed, so this only moves the pin.\n";
  }

  return [
    ...section(
      "Routes removed",
      "The tool has to go, which is a breaking change.",
      changes.removed.map(routeLine)
    ),
    ...section(
      "Routes added",
      "Each needs a tool or an opt-out in `scripts/check-openapi.ts`.",
      changes.added.map(routeLine)
    ),
    ...section(
      "Scopes or idempotency changed",
      "Check the tool's OAuth tier and its hints.",
      changes.access.map(routeLine)
    ),
    ...section(
      "Route text changed",
      "The route may do something new. Compare it with the tool's hints, description, and justifications.",
      changes.text.flatMap(({ id, route, before, after }) => [
        routeLine({ id, route }),
        `  - Before: ${before}`,
        `  - After: ${after}`,
      ])
    ),
    ...section(
      "Input changed",
      "A tightened input is a breaking change.",
      changes.input.map(routeLine)
    ),
    ...section(
      "Output changed",
      "Usually additive, but check that the tool's text still holds.",
      changes.output.map(routeLine)
    ),
  ].join("\n");
}

function contractFileAt(ref: string, name: string): string {
  // fallow-ignore-next-line security-sink -- git is fixed and the ref is an argument, not shell text
  return execFileSync("git", ["show", `${ref}:contracts/${name}`], {
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

const contractAt = Effect.fn("contractAt")(function* (ref: string) {
  return {
    spec: yield* parseJson(contractFileAt(ref, "openapi.json")),
    policies: yield* parseApiKeyPolicies(
      contractFileAt(ref, "api-key-policies.json")
    ),
  };
});

const program = Effect.fn("contract-report")(function* () {
  const { values } = parseArgs({
    options: {
      base: { type: "string", default: "HEAD" },
      "exit-code": { type: "boolean", default: false },
    },
  });

  const { spec } = yield* loadOpenApi();
  const { policies } = yield* loadApiKeyPolicies();

  const changes = contractChanges(yield* contractAt(values.base), {
    spec,
    policies,
  });

  yield* Console.log(changesReport(changes));

  if (values["exit-code"] && hasChanges(changes)) {
    return yield* exitWith([], 2);
  }
});

if (isEntryPoint(import.meta.filename)) {
  runScript(program());
}
