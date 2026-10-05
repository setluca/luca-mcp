# Integration testing

The default test suite never calls Luca's live API. Live integration tests are
opt-in and need a developer API key.

## Read-only smoke tests

```bash
LUCA_INTEGRATION=1 \
LUCA_API_KEY="luca_..." \
bun run test:integration
```

The read-only tests call `luca_capabilities_get` and `luca_leads_list` with
`limit: 1`. The key needs read scope for both.

## Write smoke test

Writes need a second flag, `LUCA_INTEGRATION_WRITE=1`.

```bash
LUCA_INTEGRATION=1 \
LUCA_INTEGRATION_WRITE=1 \
LUCA_API_KEY="luca_..." \
LUCA_INTEGRATION_LEAD_CHANNEL="telegram" \
LUCA_INTEGRATION_LEAD_EXTERNAL_ID="mcp-smoke-001" \
bun run test:integration
```

The write test creates a deterministic test lead under a stable idempotency
key, so re-running it does not pile up records. Use a disposable workspace
anyway.

## Workspace targeting

The same workspace variables as the server:

```bash
LUCA_WORKSPACE_ID="00000000-0000-0000-0000-000000000000"
LUCA_WORKSPACE_SLUG="my-workspace"
```
