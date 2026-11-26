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
    // For HubSpot it asks Composio to start the connection.
    openWorld: true,
    description:
      "Create a CRM provider OAuth URL and store its one-time state. For HubSpot, Luca asks Composio to start the connection and returns Composio's sign-in link; a failure there answers 502 crm_oauth_failed.",
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
    description:
      "Create or update a workspace-scoped CRM connection. Luca checks the supplied credentials before storing them, so a malformed key fails here, without calling the CRM. HubSpot connects only through OAuth (luca_integrations_crm_oauth_url), so raw HubSpot credentials answer 400 crm_oauth_required. A coach with another CRM already connected gets 409 crm_family_taken.",
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
    description:
      "Discover CRM provider schema: the objects and fields the connected CRM exposes, which field mapping works from. A connection that must be reconnected answers 409 crm_reauth_required, and a disconnected one answers 409 crm_connection_disabled.",
  }),
  op({
    id: "integrations.crm.connections.health",
    title: "Check a CRM connection's health",
    // An expired OAuth token can be refreshed with the CRM.
    openWorld: true,
    description:
      "Check a CRM connection's stored credentials and scopes and record the result. An expired token may be refreshed with the CRM; a provider outage is not detected.",
  }),
  op({
    id: "integrations.crm.connections.webhooksSetup",
    title: "Save a CRM connection's webhook settings",
    confirm: "always",
    mutatesExisting: true,
    description:
      "Save a CRM connection's webhook target and secret as pending. Nothing is registered in the CRM yet.",
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
      "Record a dry-run preview of the changes a CRM sync would make, as a new sync run. Nothing is written to the CRM: body.mode live answers 400 crm_live_sync_unavailable, because a live sync applies a dry-run preview: pass this run's id to luca_integrations_crm_sync_runs_apply. When this CRM is the post-call target, resend lists the failed post-call summaries and deal-stage moves a sync would send again, up to 25 of each.",
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
    // A HubSpot connection's Composio account is deleted.
    openWorld: true,
    description:
      "Disable a CRM connection and clear the credentials Luca holds, which stops every sync with that CRM until the coach connects it again. Saved mappings and event history stay. For HubSpot, Luca also deletes the Composio account that held its access, at once or by a later cleanup job. Other CRMs keep the access they granted on their own side.",
  }),
  op({
    id: "integrations.catalog",
    title: "List integrations the coach can connect",
    description:
      "List every integration the coach can connect, grouped by family: CRM, booking and calendars, channels, knowledge, automation, and developer. Each entry says how it connects and which page manages it. Connecting happens in the SetLuca app.",
  }),
  op({
    id: "integrations.connections.list",
    title: "List integration statuses",
    description:
      "List every integration's status: connected, needs_attention with the reason and any missing scope, or not_connected. needsAttentionCount is the number the app's sidebar badge shows. Read this to find what the coach has to reconnect.",
  }),
  op({
    id: "integrations.activity.list",
    title: "List a CRM's sync activity",
    description:
      "List a CRM integration's sync activity, newest first: sync runs, post-call summary pushes, and deal-stage moves. Each row says why it failed, whether its outcome is unknown, until when a failed row keeps retrying, and whether its summary can be pushed again. provider is a CRM catalog key, such as hubspot.",
  }),
  op({
    id: "integrations.usage.read",
    title: "Read integration request usage",
    description:
      "Count the requests the coach's integrations sent to providers today and this month (UTC), with their cost, against the daily cap. With query.provider, today and month count that provider only; remainingToday is always the cap left across providers.",
  }),
  op({
    id: "integrations.crm.mappings.read",
    title: "Read saved CRM field mappings",
    description:
      "Read the confirmed field mappings of the coach's CRM connection and the suggestions not confirmed yet. query.provider picks a connection. A coach without a CRM connection gets empty lists.",
  }),
  op({
    id: "integrations.crm.syncRuns.apply",
    title: "Run a CRM sync from its preview",
    mutatesExisting: true,
    idempotent: true,
    // Writes to the coach's CRM.
    openWorld: true,
    confirm: "always",
    // Mutations carry CRM record values: names, emails, notes.
    untrustedContent: true,
    description:
      "Run the sync a dry run previewed (luca_integrations_crm_sync_runs_create): send the failed post-call summaries and deal-stage moves its resend listed to the CRM now, if they are still failed and inside their three-day retry window. It never sends one the preview did not list. Show the coach the preview, and pass confirm: true after they approve. A preview older than an hour or already applied is refused, and one made before the CRM was reconnected answers 409 crm_connection_changed. A connection that must be reconnected answers 409 crm_reauth_required, and a disconnected one 409 crm_connection_disabled.",
  }),
];
