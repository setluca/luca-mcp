# Claude connector submission

What to enter in the Claude directory portal
(`claude.ai/directory/manage` → **Submit new** → **MCP connector**) for
SetLuca's remote MCP server. Unlike the OpenAI portal there is no ZIP: every
field is typed in, and the tools sync from the server. Requirements come from
<https://claude.com/docs/connectors/building/submission> and the review
criteria beside it. No credentials belong in this file.

## Status

Submitted on October 24, 2026 from the owner's personal Claude account, slug
`setluca`, against MCP server `0.6.0`; the portal shows **In review**.
Approval does not publish the listing: someone on that account has to select
**Publish**. Until there is a decision, keep the reviewer login unchanged and
re-run the claude.ai checks after any MCP release or auth change.

## Before submitting

- MCP `0.5.2` or later is deployed. Check
  `https://mcp.setluca.com/.well-known/mcp/server-card.json`. It brings three
  things this submission relies on:
  - its 401 challenge asks for every scope, so Claude's consent screen can
    offer each tier;
  - the challenge also asks for `offline_access`, so the connection gets a
    refresh token;
  - `serverInfo` no longer carries icons, which make claude.ai drop the session
    after `initialize` (anthropics/claude-ai-mcp#474).
- The Luca API no longer caps Claude at read and draft (LUC-401;
  setluca/luca#361, where ADR 0067 supersedes ADR 0065). Until it ships, a
  claude.ai connection holds read and draft only, and every tool past that
  answers 403.
- A real claude.ai connection has been tested (LUC-411): it lists the tools,
  a send-tier tool answers once granted, and it still works after the first
  hour.
- The owner chose both calls that are theirs to make. The listing is submitted
  from the owner's personal Claude account (Max plan), which owns it. Managing
  it needs that account to stay on a paid plan, and moving it to an
  organization later means asking Anthropic. The URL slug is `setluca`; it
  can never change after publishing.
- Whether reviewers should try a send. What a send on the disconnected sample
  account returns has not been checked, and trying it uses up the pending
  draft that the review queue prompts rely on.

## 1. Connection

- URL: `https://mcp.setluca.com/mcp`, Streamable HTTP, universal URL.
- Tools: all of them, the same set as the ChatGPT submission. Claude asks
  before every tool marked `destructiveHint: true`, and 40 tools, including
  every one that sends a message, launches a broadcast, or books, moves, or
  cancels a call, also refuse to run without `confirm: true`.
- `?toolset=claude` is a smaller read and draft set for coaches who want it. It
  is not the submitted URL.

## 2. Listing

- **Server name:** SetLuca
- **One-liner:** Run your DM sales from Claude: triage drafted replies, look up
  leads, prepare for calls, and check campaigns in SetLuca.
- **Description:**

  > SetLuca runs DM sales for coaches, creators, and experts on Telegram,
  > Instagram, and Messenger; WhatsApp is coming soon. Luca, its AI, drafts
  > replies in the coach's voice, and SetLuca tracks leads, conversations,
  > booked calls, campaigns, and broadcasts.
  >
  > Connect your SetLuca workspace to ask Claude what needs your attention,
  > review the drafts waiting for approval, find a lead and read their
  > conversation, prepare for a call, record how a call went, and see how
  > campaigns and broadcasts are performing. Claude can also act for you:
  > draft or approve a reply, book or move a call, pause a lead, or launch a
  > broadcast. Each tool that sends a message, launches a broadcast, or books,
  > moves, or cancels a call asks you to confirm first.
  >
  > The connector works only with the SetLuca account you sign in to, and only
  > with the permissions you grant on the consent screen. Read is always on
  > and draft starts ticked; sending, booking, and account settings are yours
  > to tick. Lead names and message text stay redacted unless you also grant
  > full content.

- **Categories:** Sales and marketing, Communication, Productivity, as the
  portal names them.
- **Documentation URL:** <https://setluca.com/connect>
- **Privacy policy URL:** <https://setluca.com/privacy>
- **Support contact:** support@setluca.com
- **Icon:** `submission/openai/luca-mcp/assets/luca.png`, the 512px SetLuca
  wordmark served at `setluca.com/android-chrome-512x512.png`.
- **URL slug:** `setluca`. It is permanent once published.
- **Screenshots:** none. The server returns no UI.

## 3. Use cases

- Primary uses: triage the review queue, look up leads and conversations,
  prepare for and close out calls, check campaign and broadcast results, and
  act on those (approve and send, book, pause, broadcast) with confirmation.
- Users need a SetLuca account at <https://app.setluca.com>.
- The connector reads and writes data.

## 4. Company

SetLuca, LLC, <https://setluca.com>. Primary contact: the submitting owner,
who receives review email.

## 5. Authentication

OAuth 2.1 with PKCE (S256). The authorization server is
`https://api.setluca.com/api/auth`. It advertises client ID metadata documents
(CIMD) and the `none` token auth method, so Claude identifies itself with its
own CIMD; dynamic client registration stays as the fallback. No
Anthropic-held credentials. Checked live with the Claude reviewer account:

- **claude.ai (October 23):** client ID
  `https://claude.ai/oauth/mcp-oauth-client-metadata` with
  `https://claude.ai/api/mcp/auth_callback` passed the whole flow: sign-in with
  no MFA, a consent screen naming Claude and offering every scope, an `iss`
  that matches the issuer, a token for the `https://mcp.setluca.com/mcp`
  audience, and a refresh token that rotates. The grant came back capped at
  read and draft by LUC-401; Luca v0.4.0, deployed that evening, removes the
  cap (luca#361). Dynamic registration with the same callback passed on
  October 22.
- **claude.ai chat (October 24):** a custom connector added in claude.ai
  detected OAuth and Claude's published identity on its own, signed in,
  loaded all 223 tools, and answered the read prompts in §7 with real tool
  calls. The grant kept `luca:queue_ops`, so the cap is gone in production.
  The transcript is on LUC-83.
- **Claude Code:** its published CIMD (`https://claude.ai/oauth/claude-code-client-metadata`)
  passed with `http://localhost:<port>/callback` and
  `http://127.0.0.1:<port>/callback`, and received every scope it was granted.
- Discovery answered within 2.6 seconds on each of three tries per endpoint,
  inside Claude's 10-second limit. The 401 challenge answered in 0.1 seconds.

## 6. Data handling

First-party API only (`api.setluca.com`). No personal health data: the privacy
policy forbids regulated medical records. No sponsored content.

## 7. Test & launch

Enter these steps with the credentials, which only reviewers see. The
credentials are in Infisical production at `/operations/claude-review`
(`CLAUDE_REVIEWER_EMAIL`, `CLAUDE_REVIEWER_PASSWORD`). Never paste them
anywhere else.

Since Luca v0.4.0 (October 23, 2026), an account must accept the current Terms
and Privacy Policy before business requests succeed, and its OAuth tokens
inherit that. After each new legal edition, sign in as the reviewer and accept
at `app.setluca.com/agreements`, or every tool call returns 403
`terms_acceptance_required`.

1. In Claude, open **Customize → Connectors → Add custom connector** and enter
   `https://mcp.setluca.com/mcp`.
2. Select **Connect**. Sign in at `app.setluca.com` with the credentials above.
   There is no MFA or email code.
3. On the consent screen, tick every permission, including full content. The
   workspace holds synthetic data only, so names and messages can show.
4. Run the example prompts below. Drafts Claude writes appear at
   `app.setluca.com` under the review queue.

The account owns **Claude Review Workspace**: one sample lead, Sam Demo, on a
disconnected sample Instagram account, with one inbound message and a pending
draft reply; a completed call that still needs an outcome; an upcoming call on
December 15; a draft campaign; and a draft broadcast.

### Example prompts

| Prompt                                                         | Tools                                       | Expected                                                                              |
| -------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| What needs my attention in SetLuca today?                      | `luca_morning_report`, `luca_triage_inbox`  | Sam's pending draft. The morning report covers the last 24 hours, so it may be empty. |
| Show my review queue and explain what is waiting.              | `luca_triage_inbox`                         | One pending draft for Sam, with why it is waiting. No approval or send.               |
| Find the sample lead named Sam and summarize the conversation. | `luca_find_leads`, `luca_conversations_get` | Sam Demo on Instagram, asking about online strength coaching.                         |
| Which calls still need an outcome in SetLuca?                  | `luca_post_call_queue`                      | Sam's completed call.                                                                 |
| How are my SetLuca campaigns and broadcasts performing?        | `luca_analytics_rollup`                     | The draft Claude review campaign and broadcast. Neither has sent anything.            |
| Draft a reply to Sam asking which day suits a call.            | `luca_draft_reply`                          | A new draft in the review queue. Nothing is sent.                                     |

Prompts that should not call a SetLuca tool: "What is the weather in Madrid
tomorrow?", "Use SetLuca to charge my credit card for a laptop.", and "Read the
private files on my laptop through SetLuca."

## 8. Compliance acknowledgments

| Acknowledgment               | Why it holds                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| Directory guidelines         | Tools are named per action, titled, and annotated; descriptions say what each does.    |
| First-party API              | Every tool calls `api.setluca.com`, SetLuca's own API.                                 |
| Financial transactions       | No tool moves money, charges, or refunds. Billing is not on the MCP surface.           |
| AI media generation          | No tool generates images, video, or audio.                                             |
| Prompt injection             | Descriptions state behavior only. Lead-authored text is labelled untrusted in results. |
| Conversation data collection | The server never reads Claude's conversation, memory, or files.                        |
| Public documentation         | <https://setluca.com/connect> and the package README.                                  |

## 9. Tool testing

A sweep on October 22, 2026 called each of the 116 read-only tools once
against Claude Review Workspace:

- 100 answered.
- 6 needed an ID the workspace has no record for (a simulation, an enrollment,
  a call event, a sync run, an A/B test, and the import preview's CSV body).
- 6 answered a clear 404 for a record the workspace lacks.
- 3 showed that a required query was not marked required. `0.5.2` fixes them.
- `luca_bookings_availability` without `start` and `end` gets a 400 from the
  API, although its OpenAPI marks both optional. With them it answers. Luca
  v0.4.0 ships the fix (LUC-513): `start` defaults to now and `end` to seven
  days after it.

Write tools were not swept, because they change the reviewer fixtures. The
operation and protocol suites cover them.
