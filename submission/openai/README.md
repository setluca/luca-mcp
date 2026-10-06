# OpenAI plugin submission

`luca-mcp/` is the source for an OpenAI portal upload of Luca's remote MCP
server. The ZIP should contain that directory as its single root. The icon is
the current public Luca wordmark, downloaded from the server card's PNG URL.
From this directory, rebuild the archive with
`zip -r luca-mcp-0.1.0.zip luca-mcp` before changing the saved draft.

This package is a draft for connecting and verifying the MCP endpoint. It is
not ready for public review until secure reviewer access instructions, an actual
demo recording URL, country targeting, and the portal's required declarations
are complete. The five positive and three negative review cases are drafted
from the tool catalog but have not been run against reviewer data. The listing
category is left to the portal because its current supported values have not
been verified.

The business publisher displayed by OpenAI on October 6, 2026 was
`SetLuca, LLC` with status `Approved`. No credentials or challenge token belong
in this package. The saved portal draft imported version `0.1.0`, and OpenAI
verified `mcp.setluca.com` after the production Worker served the challenge
token. The dedicated reviewer granted `luca:read` and `luca:draft` to ChatGPT
on October 6, 2026. The portal shows Authorized. MCP `0.3.2` is live and its
authenticated portal scan discovered all 203 tools. Eight findings remain:
server instructions and two tools need manual review; two tools have external
access hints to correct; and three tool names need clearer context. Version
`0.3.3` prepares corrections for those two external access hints and two
adjacent booking availability reads that also query connected calendars or
providers. Tool names remain stable. Rescan after release and review findings
that remain.

The portal's private reviewer form has the dedicated sign-in instructions and
credentials saved. The password stays in Infisical and the portal, never in
this package. The five positive and three negative review cases still need
to be run with reviewer data; a demo recording URL is still needed.

The dedicated production account `openai-reviewer@setluca.com` owns **OpenAI
Review Workspace**. It has synthetic lead, conversation, pending review draft,
campaign, broadcast, and past booking fixtures; its sample Instagram channel
account is disconnected and holds no credentials. A second sign-in check passed
on October 6, 2026. Its password and workspace ID are in Infisical's production
environment at `/operations/openai-review` under `OPENAI_REVIEWER_PASSWORD` and
`OPENAI_REVIEWER_WORKSPACE_ID`. Use this account for the portal's OAuth consent
and secure reviewer access fields. Do not put its password in the ZIP or a ticket.
