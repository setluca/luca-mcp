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
    description: "Create a CRM provider OAuth URL.",
  }),
  op({
    id: "integrations.crm.connections.list",
    title: "List CRM connections",
    description: "List CRM connections.",
  }),
  op({
    id: "integrations.crm.connections.create",
    title: "Create a CRM connection",
    mutatesExisting: true,
    description: "Create or update a workspace-scoped CRM connection.",
  }),
  op({
    id: "integrations.crm.connections.schema",
    title: "Read a CRM's field schema",
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
    description: "Suggest CRM field mappings.",
  }),
  op({
    id: "integrations.crm.mappings.confirm",
    title: "Confirm CRM field mappings",
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
    title: "Start a CRM sync",
    openWorld: true,
    confirm: "always",
    // Mutations carry CRM record values: names, emails, notes.
    untrustedContent: true,
    description: "Create a CRM dry-run or live sync run.",
  }),
  op({
    id: "integrations.events.list",
    title: "List integration events",
    // Each event holds the raw webhook or CRM body, which can carry contact fields verbatim.
    untrustedContent: true,
    description: "List integration event log.",
  }),
];
