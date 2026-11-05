# Audit tool claims against the handlers

Run this before every directory submission, and when a contract sync lists route
text changes. No automatic check can tell whether a hint is true: the tests and
the MCP Inspector compare what we wrote with other things we wrote. This compares
it with what the API does. Comparing all 223 tools for LUC-618 found 37 that said
something the code does not back up.

## Prepare

Have a Luca checkout at the commit production runs, the one `contracts/source.json`
pins. Then dump what a reviewer reads, tool by tool:

```bash
bun run build
bunx mcp-inspector --cli bun dist/index.js --method tools/list --format json > tools.json
```

Pair each tool with its three justifications from
`submission/openai/chatgpt-app-submission.json`. Split the list by operation group
so that several reviewers, people or agents, can work in parallel.

## What each hint means here

- `readOnlyHint` true: the call changes nothing a coach could see. No row in their
  workspace, an audit row included, and nothing outside it.
- `openWorldHint` true: the call can read or change something outside the workspace,
  including through events or outbox work it queues: a lead's inbox, an outside URL,
  a connected calendar or CRM, the coach's webhook subscribers, or OpenRouter.
- `destructiveHint` true: the call overwrites or removes existing state, or has a
  real-world effect behind `confirm: true`. A plain create is false.

These are settled, so don't reopen them:

- A tool that fires the coach's webhooks or sends data to OpenRouter stays
  open-world. Report the opposite: an open-world false tool that does either.
- Internal bookkeeping does not make a read a write: product analytics rows and
  their PostHog events, short-lived edge caches, and OAuth token refreshes. None of
  it changes the coach's workspace data, so it is not disclosed either.

## Compare

For each tool, read its handler in `apps/api/src/routes/v1/`, and follow it into
`packages/db/src/` far enough to know what it writes and what it reaches. A plain
GET that only selects needs a quick check. Useful searches: `emitWebhookEvent`,
`setAudit`, `inngest`, `flushChannelWorkOutboxRow`, `openrouter`, and the provider
adapters.

Then compare the hints and every factual claim in the description and
justifications with the code. Look hardest at absolute claims: "sends nothing",
"nothing is saved", "stays inside", "cannot be undone", "emails the lead", "only
reads". Also check for what a tool cannot do through an API key at all, such as
archiving a campaign.

Every finding needs the exact words and a `path:line`. Read the cited code yourself
before acting on a finding from an agent: some are wrong, and they sound as sure as
the right ones.

## Fix

Change the hint in `src/operations/groups/` and the text in the same commit as its
justification, then run:

```bash
bun run build
bun run surface:generate
bun run verify
```

`tool-surface.json` then shows exactly what a client will see differently. A phrasing
that fooled the audit belongs in `CONTRADICTIONS` in `test/openai-submission.test.ts`,
so the next one fails on its own.
