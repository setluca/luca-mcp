import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const integrationsOperations: readonly LucaOperation[] = [
  op({
    id: "integrations.connectors.list",
    title: "List available connectors",
    description: "List Zapier, Make, and CRM provider capabilities.",
  }),
  op({
    id: "integrations.crm.oauthUrl",
    title: "Start a CRM connection",
    // This GET stores a fresh OAuth state record for the callback.
    readOnly: false,
    description:
      "Create a CRM provider OAuth URL and store its one-time state.",
  }),
  op({
    id: "integrations.crm.connections.list",
    title: "List CRM connections",
    description: "List CRM connections.",
  }),
  op({
    id: "integrations.crm.connections.create",
    title: "Create a CRM connection",
    idempotent: true,
    mutatesExisting: true,
    description: "Create or update a workspace-scoped CRM connection.",
  }),
  op({
    id: "integrations.crm.connections.schema",
    title: "Read a CRM's field schema",
    // Refreshes Luca's cached copy of the CRM schema, the same copy every time.
    readOnly: false,
    idempotent: true,
    openWorld: true,
    // sampleRecords are literal contact and deal rows from the coach's CRM, which leads and other people filled in.
    untrustedContent: true,
    description: "Discover CRM provider schema.",
  }),
  op({
    id: "integrations.crm.connections.health",
    title: "Check a CRM connection's health",
    openWorld: true,
    description: "Probe CRM provider health.",
  }),
  op({
    id: "integrations.crm.connections.webhooksSetup",
    title: "Set up a CRM's webhooks",
    openWorld: true,
    confirm: "always",
    mutatesExisting: true,
    description: "Configure CRM provider webhook status.",
  }),
  op({
    id: "integrations.crm.mappings.suggest",
    title: "Suggest CRM field mappings",
    idempotent: true,
    description: "Suggest CRM field mappings.",
  }),
  op({
    id: "integrations.crm.mappings.confirm",
    title: "Confirm CRM field mappings",
    idempotent: true,
    mutatesExisting: true,
    description: "Confirm CRM field mappings.",
  }),
  op({
    id: "integrations.crm.syncRuns.list",
    title: "List CRM sync runs",
    // Mutations carry CRM record values: names, emails, notes.
    untrustedContent: true,
    description: "List CRM sync history.",
  }),
  op({
    id: "integrations.crm.syncRuns.create",
    title: "Preview a CRM sync",
    // Mutations carry CRM record values: names, emails, notes.
    untrustedContent: true,
    description:
      "Record a dry-run preview of the changes a CRM sync would make, as a new sync run. Nothing is written to the CRM: the API refuses a live sync.",
  }),
  op({
    id: "integrations.events.list",
    title: "List integration events",
    // Each event holds the raw webhook or CRM body, which can carry contact fields verbatim.
    untrustedContent: true,
    description: "List integration event log.",
  }),
  op({
    id: "integrations.crm.connections.disconnect",
    title: "Disconnect a CRM",
    idempotent: true,
    mutatesExisting: true,
    // Stops every sync with that CRM until the coach signs in to it again.
    confirm: "always",
    description:
      "Disable a CRM connection and clear the credentials Luca holds, which stops every sync with that CRM until the coach connects it again. Saved mappings and event history stay. It does not revoke access on the CRM's side.",
  }),
];
