# OpenAI plugin submission

`luca-mcp/` is the source for an OpenAI portal upload of Luca's remote MCP
server. The ZIP should contain that directory as its single root. The icon is
the current public Luca wordmark, downloaded from the server card's PNG URL.
From this directory, rebuild the archive with
`zip -r luca-mcp-0.1.0.zip luca-mcp` before changing the saved draft.

This package is a draft for connecting and verifying the MCP endpoint. It is
not ready for public review until a seeded reviewer workspace, secure reviewer
access instructions, an actual demo recording URL, country targeting, and
the portal's required declarations are complete. The five positive and three
negative review cases are drafted from the tool catalog but have not been run
against reviewer data. The listing category is left to the portal because its
current supported values have not been verified.

The business publisher displayed by OpenAI on October 6, 2026 was
`SetLuca, LLC` with status `Approved`. No credentials or challenge token belong
in this package. The saved portal draft imported version `0.1.0`, and OpenAI
verified `mcp.setluca.com` after the production Worker served the challenge
token. OAuth connection and tool discovery await a Luca workspace consent.
