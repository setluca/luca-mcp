// Views derived from the operation table. Nothing here holds state of its own;
// each function reads `LUCA_OPERATIONS` and reshapes it for one caller: the
// `luca://operations` resource, the docs generator, or the registry check.
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as R from "effect/Record";

import { operationAnnotations } from "../annotations.ts";
import { LUCA_OPERATIONS } from "./catalog.ts";
import { LUCA_OPERATION_GROUPS } from "./registry.ts";
import type { LucaOperationGroup } from "./registry.ts";

export function operationManifest() {
  return LUCA_OPERATIONS.map((operation) => ({
    id: operation.id,
    group: operation.group,
    toolName: operation.toolName,
    method: operation.method,
    path: operation.path,
    scopes: operation.scopes,
    idempotencyRequired: operation.idempotencyRequired,
    confirmRequired: operation.confirm !== undefined,
    paginates: operation.pageContract !== undefined,
    untrustedContent: operation.untrustedContent,
    requiredScope: operation.requiredScope,
    annotations: operationAnnotations(operation),
    description: operation.description,
  }));
}

export function operationGroups() {
  return R.toEntries(LUCA_OPERATION_GROUPS).map(([id, metadata]) => {
    const operations = LUCA_OPERATIONS.filter(
      (operation) => operation.group === id
    );

    return {
      // SAFETY: Object.entries widens the key to `string`; the cast recovers
      // what TypeScript already knows about LUCA_OPERATION_GROUPS's own keys.
      id: id as LucaOperationGroup,
      title: metadata.title,
      description: metadata.description,
      toolCount: operations.length,
      scopes: Arr.sort(
        Arr.dedupe(operations.flatMap((operation) => operation.scopes)),
        Order.String
      ),
      tools: operations.map((operation) => operation.toolName),
    };
  });
}
