# Examples

Use these sequences to call Luca from an MCP client. Use a test workspace for
exploratory writes. Every tool named here appears in `tools.md`.

## Discover capabilities

1. Read `luca://operations` to inspect groups, tool names, scopes, and
   idempotency requirements.
2. Call `luca_capabilities_get` to confirm the public API boundary and available
   capabilities for the configured key.

## Read a lead

1. Call `luca_leads_list` with a narrow query:

```json
{
  "query": {
    "limit": 10,
    "q": "alex"
  }
}
```

2. Call `luca_leads_get` with the selected lead id:

```json
{
  "id": "00000000-0000-0000-0000-000000000000"
}
```

## Create a lead

`luca_leads_create` takes a channel and an external user id. Pass a stable
`idempotencyKey` so a retry of the same intent does not create a second lead:

```json
{
  "idempotencyKey": "lead-telegram-u-123",
  "body": {
    "channel": "telegram",
    "externalUserId": "u_123",
    "displayName": "Alex Rivera",
    "tags": ["mcp"]
  }
}
```

## List campaigns and analytics

1. Call `luca_campaigns_list` with a small page size.
2. Call `luca_campaigns_get` for the selected campaign id.
3. Call `luca_campaigns_analytics` when the API key includes
   `analytics:read`.

## Inspect webhook deliveries

1. Call `luca_webhooks_deliveries_list` with a narrow query.
2. Use `luca_webhooks_signature_guide` to verify receiver implementation rules.
3. Replay a delivery only on an explicit operator decision, with a stable
   `idempotencyKey`. `luca_webhooks_deliveries_replay` also requires
   `confirm: true`, because a replay fires the subscriber's automation again.

## Override the workspace

Every tool accepts `workspaceId` and `workspaceSlug`. Tool arguments override
environment defaults for that call:

```json
{
  "workspaceSlug": "demo",
  "query": {
    "limit": 5
  }
}
```

## Common errors

- Missing key: configure `LUCA_API_KEY` or `LUCA_API_TOKEN`.
- Scope errors: rotate or recreate the Luca developer key with the required
  scope listed in the tool description.
- Write retries: reuse the same `idempotencyKey` for the same user intent.
- Workspace errors: pass `workspaceId` or `workspaceSlug` when the key has
  access to multiple workspaces.
