import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";

import { toolNameFor } from "../src/operations/registry.ts";
import {
  isJsonArray,
  isJsonObject,
  type JsonObject,
  JsonValue,
} from "../src/serialization.ts";
import { isEntryPoint } from "./lib/script.ts";

/**
 * What a contract sync changed for the routes MCP tools call, tool by tool.
 *
 * Generated schemas catch a changed shape, but a route can change what it does
 * while only its description says so: Luca stopped turning on the workspace
 * auto-send switch for API keys, and nothing but one sentence in OpenAPI showed
 * it. So any change to a route's text is listed here for a person to compare
 * with the tool's own hints and text.
 */
const CONTRACTS = resolve(import.meta.dirname, "../contracts");

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(JsonValue));

type Route = { readonly id: string; readonly route: string };

export type ContractChanges = {
  readonly added: readonly Route[];
  readonly removed: readonly Route[];
  readonly access: readonly Route[];
  readonly text: readonly (Route & {
    readonly before: string;
    readonly after: string;
  })[];
  readonly input: readonly Route[];
  readonly output: readonly Route[];
};

type Contract = { readonly openApi: JsonValue; readonly policies: JsonValue };

function child(value: JsonValue | undefined, key: string) {
  return isJsonObject(value) ? value[key] : undefined;
}

/** A schema with every `$ref` swapped for what it points at. */
function resolveRefs(
  document: JsonValue,
  value: JsonValue | undefined,
  seen: ReadonlySet<string> = new Set()
): JsonValue {
  if (isJsonArray(value)) {
    return value.map((item) => resolveRefs(document, item, seen));
  }

  if (!isJsonObject(value)) {
    return value ?? null;
  }

  const ref = value.$ref;

  if (P.isString(ref)) {
    const name = ref.split("/").at(-1) ?? ref;

    return seen.has(name)
      ? { circular: name }
      : resolveRefs(
          document,
          child(child(child(document, "components"), "schemas"), name),
          new Set([...seen, name])
        );
  }

  return Object.fromEntries(
    Object.keys(value).map((key) => [
      key,
      resolveRefs(document, value[key], seen),
    ])
  );
}

function policyEntries(policies: JsonValue): readonly JsonObject[] {
  return isJsonArray(policies) ? policies.filter(isJsonObject) : [];
}

function routeOf(policy: JsonObject): Route {
  return {
    id: String(policy.id),
    route: `${String(policy.method)} ${String(policy.path)}`,
  };
}

function operationOf(contract: Contract, policy: JsonObject) {
  return child(
    child(child(contract.openApi, "paths"), String(policy.path)),
    String(policy.method).toLowerCase()
  );
}

function same(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function inputOf(contract: Contract, policy: JsonObject): JsonValue {
  const operation = operationOf(contract, policy);

  return resolveRefs(contract.openApi, [
    child(operation, "parameters") ?? null,
    child(operation, "requestBody") ?? null,
  ]);
}

function outputOf(contract: Contract, policy: JsonObject): JsonValue {
  return resolveRefs(
    contract.openApi,
    child(operationOf(contract, policy), "responses")
  );
}

function textOf(contract: Contract, policy: JsonObject): string {
  const description = child(operationOf(contract, policy), "description");

  return P.isString(description)
    ? (description.split("\n\n**API key scopes:**")[0] ?? description)
    : "";
}

function accessOf(policy: JsonObject): string {
  return JSON.stringify([
    policy.method,
    policy.path,
    policy.scopes,
    policy.requireIdempotency ?? false,
  ]);
}

/** Only routes in the API-key allowlist have a tool to go stale. */
export function contractChanges(
  before: Contract,
  after: Contract
): ContractChanges {
  const wasById = new Map(
    policyEntries(before.policies).map((policy) => [String(policy.id), policy])
  );

  const nowById = new Map(
    policyEntries(after.policies).map((policy) => [String(policy.id), policy])
  );

  const kept = [...nowById.values()].flatMap((policy) => {
    const was = wasById.get(String(policy.id));

    return was === undefined ? [] : [{ was, now: policy }];
  });

  const keptWhere = (
    differs: (was: JsonObject, now: JsonObject) => boolean
  ): readonly Route[] =>
    kept.flatMap(({ was, now }) => (differs(was, now) ? [routeOf(now)] : []));

  const missingFrom = (
    from: ReadonlyMap<string, JsonObject>,
    other: ReadonlyMap<string, JsonObject>
  ): readonly Route[] =>
    [...from.values()].flatMap((policy) =>
      other.has(String(policy.id)) ? [] : [routeOf(policy)]
    );

  return {
    added: missingFrom(nowById, wasById),
    removed: missingFrom(wasById, nowById),
    access: keptWhere((was, now) => accessOf(was) !== accessOf(now)),
    text: kept.flatMap(({ was, now }) => {
      const textBefore = textOf(before, was);
      const textAfter = textOf(after, now);

      return textBefore === textAfter
        ? []
        : [{ ...routeOf(now), before: textBefore, after: textAfter }];
    }),
    input: keptWhere(
      (was, now) => !same(inputOf(before, was), inputOf(after, now))
    ),
    output: keptWhere(
      (was, now) => !same(outputOf(before, was), outputOf(after, now))
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

function contractFrom(read: (name: string) => string): Contract {
  return {
    openApi: decodeJson(read("openapi.json")),
    policies: decodeJson(read("api-key-policies.json")),
  };
}

function main(argv: readonly string[]): number {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      base: { type: "string", default: "HEAD" },
      "exit-code": { type: "boolean", default: false },
    },
  });

  const before = contractFrom((name) =>
    // fallow-ignore-next-line security-sink -- git is fixed and the ref is an argument, not shell text
    execFileSync("git", ["show", `${values.base}:contracts/${name}`], {
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
    })
  );

  const after = contractFrom((name) =>
    readFileSync(resolve(CONTRACTS, name), "utf-8")
  );

  const changes = contractChanges(before, after);

  console.log(changesReport(changes));

  return values["exit-code"] && hasChanges(changes) ? 2 : 0;
}

if (isEntryPoint(import.meta.filename)) {
  process.exit(main(process.argv.slice(2)));
}
