// Public entry point for the operation model. The implementation is split by
// job under `./operations/`: `registry.ts` holds the types and the `op()`
// machinery, `catalog.ts` holds the operation table, and `manifest.ts` holds
// the views derived from it. What a client is told about a tool lives in
// `../annotations.ts` and `../tool.ts`, one level up, because both kinds of
// tool ask for it.
// This file names each export rather than re-exporting with `export *`,
// because a star barrel pulls the whole dependency graph into every importer.
// The lint rule that forbids it is measuring real load cost, not style.

export { LUCA_OPERATIONS, operationById } from "./operations/catalog.ts";

export { operationGroups, operationManifest } from "./operations/manifest.ts";

export type {
  ConfirmGate,
  LucaOperation,
  LucaOperationId,
  LucaRequestContract,
  LucaToolInput,
} from "./operations/registry.ts";

export {
  DEFAULT_MAX_PAGES,
  needsConfirmation,
  outputSchemaFor,
} from "./operations/registry.ts";
