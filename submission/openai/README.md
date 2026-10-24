# OpenAI plugin submission

`luca-mcp/` is the source for the OpenAI portal upload of SetLuca's remote MCP
server. The ZIP holds that directory as its single root. From this directory,
build it with `zip -r luca-mcp-0.1.4.zip luca-mcp`. The icon is the public
SetLuca wordmark, the same file as `setluca.com/android-chrome-512x512.png`.
No credentials or challenge token belong in the package. `mcp.json` declares
OAuth with a client ID metadata document (`extensions["com.openai"].auth`),
because the portal reads a server's authentication only from that file.

`chatgpt-app-submission.json` fills the review form, in the import format
OpenAI publishes
(`developers.openai.com/plugins/schemas/chatgpt-app-submission.v1.json`): the
listing text, the five positive and three negative test cases, and for every
tool its three hints with one justification each (`read_only_justification`,
`open_world_justification`, `destructive_justification`). A destructive
justification says what cannot be undone and when, and every confirm-gated
tool's ends with "Refuses to run without confirm: true."
`test/openai-submission.test.ts` fails when a tool is missing, a hint no longer
matches `tools/list`, a gate is named on the wrong tool, or the test cases
drift from `plugin.json`, so change the justification in the same commit as
the hint.

## Status

OpenAI accepted package `0.1.3` for review on October 6, 2026 and rejected it
on October 22: every tool's annotations must be explicit booleans with a
justification that matches the tool's behavior. MCP server `0.5.1` fixed the
hints (LUC-408). `0.5.2` marks the two voice-note transcription retries
open-world, since they send audio to OpenRouter, and does the same for the two
on-demand drafting tools, which send the conversation to OpenRouter's model and
replace the lead's earlier unapproved draft, so they are destructive too. It
also asks for `offline_access`, so a ChatGPT connection gets a refresh token
instead of lapsing after an hour. Package `0.1.4` is the resubmission. Beyond
the version, it:

- names the listing SetLuca, the product, with Luca as its AI;
- declares that the plugin does not sell anything (`commerce: false`);
- accepts an empty morning report, because the reviewer fixtures are older
  than the report's 24-hour window;
- expects the per-campaign analytics that `0.5.2` now returns.

`0.6.0` drops `luca_knowledge_approve_suggestion`, so the JSON lists 223 tools.
Luca v0.4.0 made approving a profile suggestion session-only, and the tool
could only get 403 from then on.

Package `0.1.4` went into review on October 24, 2026 against MCP server
`0.6.0` (submission `appsub_6adc60f672408191ba38e8949499f3a4`; the portal
labels the release 1.0.0). One finding stays open and the portal marks it
non-blocking: the MCP scan reports `authorization_required`. The connection
itself works: Workers logs show OpenAI's discovery, token exchange, and
`tools/list` all answering 200. The scan runs never reach `mcp.setluca.com` or
`api.setluca.com`; each ends within seconds. Declaring OAuth in `mcp.json`,
signing in again, and moving `0.1.4` into review did not clear it, so it is
OpenAI's to explain. If review raises it, give OpenAI support the app ID
`asdk_app_6ac4983d2bd08191a746893a52c91ef9` and the failed run IDs on LUC-319.

OpenAI verified `mcp.setluca.com` on October 6, 2026. The business publisher is
`SetLuca, LLC`, status Approved.

## Reviewer account

The dedicated production account `openai-reviewer@setluca.com` owns **OpenAI
Review Workspace**. It holds synthetic leads, conversations, a pending draft, a
draft campaign and broadcast, and a past booking; its sample Instagram account
is disconnected and holds no credentials. Its email, password, and workspace ID
are in Infisical's production environment at `/operations/openai-review`. Enter
them only in the portal's **Review details**, never in the ZIP or a ticket.

Since Luca v0.4.0 (October 23, 2026), an account must accept the current Terms
and Privacy Policy before business requests succeed, and its OAuth tokens and
API keys inherit that. After each new legal edition, sign in as the reviewer
and accept at `app.setluca.com/agreements`, or every tool call returns 403
`terms_acceptance_required`.

On October 22, 2026 the account still signed in with no MFA or email code. A
ChatGPT-style OAuth run with it passed end to end: dynamic registration with
the `chatgpt.com` callback, PKCE, consent, an `iss` that matches the issuer, a
token for the `mcp.setluca.com/mcp` audience, and a refresh. ChatGPT itself
signs in with a client ID metadata document, and its October 6 connection was
consented for `luca:read luca:draft` only, with no refresh token. From `0.5.2`
the consent screen offers every permission, with read and draft ticked; a
reviewer who keeps those defaults sees lead names and draft text redacted, and
the test cases allow for either.

## Resubmit

1. Deploy the MCP release that `chatgpt-app-submission.json` matches, and
   check `/.well-known/mcp/server-card.json` reports it.
2. Build the ZIP above and upload it. The portal shows the package version.
3. Under **MCPs**, run **Scan Tools** (or **Rescan**) and confirm it finds
   every tool with the hints in the JSON.
4. Import `chatgpt-app-submission.json` if the form offers it. Otherwise enter
   each tool's three justifications from it.
5. In **Review details**, confirm the reviewer credentials from Infisical.
6. Confirm the attestations and submit.
