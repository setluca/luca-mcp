# OpenAI plugin submission

`luca-mcp/` is the source for the OpenAI portal upload of SetLuca's remote MCP
server. The ZIP holds that directory as its single root. From this directory,
build it with `zip -r luca-mcp-0.1.4.zip luca-mcp`. The icon is the public
SetLuca wordmark, the same file as `setluca.com/android-chrome-512x512.png`.
No credentials or challenge token belong in the package.

`annotation-justifications.json` holds one justification per tool for the
review form: why each tool's `readOnlyHint`, `destructiveHint`, and
`openWorldHint` match what it does. `test/openai-justifications.test.ts` fails
when a tool is missing from it or its hints change, so update the justification
in the same change as the hint.

## Status

OpenAI accepted package `0.1.3` for review on October 6, 2026 and rejected it
on October 22: every tool's annotations must be explicit booleans with a
justification that matches the tool's behavior. MCP server `0.5.1` fixed the
hints (LUC-408), and `0.5.2` marks the two voice-note transcription retries
open-world, since they send audio to OpenRouter. Package `0.1.4` is the
resubmission. Beyond the version, it:

- names the listing SetLuca, the product, with Luca as its AI;
- declares that the plugin does not sell anything (`commerce: false`);
- accepts an empty morning report, because the reviewer fixtures are older
  than the report's 24-hour window;
- expects the per-campaign analytics that `0.5.2` returns again.

OpenAI verified `mcp.setluca.com` on October 6, 2026. The business publisher is
`SetLuca, LLC`, status Approved.

## Reviewer account

The dedicated production account `openai-reviewer@setluca.com` owns **OpenAI
Review Workspace**. It holds synthetic leads, conversations, a pending draft, a
draft campaign and broadcast, and a past booking; its sample Instagram account
is disconnected and holds no credentials. Its email, password, and workspace ID
are in Infisical's production environment at `/operations/openai-review`. Enter
them only in the portal's **Review details**, never in the ZIP or a ticket.

On October 22, 2026 the account still signed in with no MFA or email code. A
ChatGPT-style OAuth run with it passed end to end: dynamic registration with
the `chatgpt.com` callback, PKCE, consent for `luca:read luca:draft`, an `iss`
that matches the issuer, a token for the `mcp.setluca.com/mcp` audience, and a
refresh. The read and draft grant redacts lead names and draft text, and the
test cases expect that. ChatGPT's own connection from October 6 is still
authorized.

## Resubmit

1. Deploy the MCP release that `annotation-justifications.json` matches, and
   check `/.well-known/mcp/server-card.json` reports it.
2. Build the ZIP above and upload it. The portal shows the package version.
3. Under **MCPs**, run **Scan Tools** (or **Rescan**) and confirm it finds
   every tool with the hints in the JSON.
4. Enter each tool's justification from the JSON.
5. In **Review details**, confirm the reviewer credentials from Infisical.
6. Confirm the attestations and submit.
