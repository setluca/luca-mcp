# Luca MCP documentation

How the server works, what it is allowed to reach, and how to change it.

| Doc                                                         | Covers                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------- |
| [Architecture](./architecture.md)                           | The two transports, the module layout, and one request end to end |
| [Client setup](./client-setup.md)                           | Running a local build against an MCP client                       |
| [Configuration](./configuration.md)                         | Environment variables, Worker settings, auth headers, toolsets    |
| [Connector directory](./connector-directory.md)             | Listing Luca in the Claude and ChatGPT directories                |
| [Development](./development.md)                             | Scripts, the verify chain, adding a tool                          |
| [Errors](./errors.md)                                       | What a failed tool call looks like and what each code means       |
| [Examples](./examples.md)                                   | Worked tool sequences from a client                               |
| [Integration testing](./integration-testing.md)             | The opt-in live tests                                             |
| [MCP Inspector](./inspector.md)                             | Interactive protocol debugging                                    |
| [Maintenance](./maintenance.md)                             | Drift checks, dependency updates, server identity                 |
| [Pagination and tool count](./pagination-and-tool-count.md) | How paging works and why the count is what it is                  |
| [Prompts and resources](./prompts-and-resources.md)         | Every prompt and resource, generated                              |
| [Registry listing](./registry.md)                           | `server.json` and the official MCP registry                       |
| [Release](./release.md)                                     | Cutting a version and what the tag ships                          |
| [Remote transport](./remote.md)                             | The Worker at `mcp.setluca.com`, bearer auth, OAuth               |
| [Scopes](./scopes.md)                                       | API scopes, OAuth scopes, and which grants which, generated       |
| [Security boundary](./security.md)                          | What the server may reach, untrusted content, confirm gates       |
| [Tool reference](./tools.md)                                | Every tool, generated                                             |

Three of these are generated: `tools.md`, `prompts-and-resources.md`, and
`scopes.md`. Never edit them by hand. Regenerate all three from the catalogs
they read with:

```bash
bun run docs:generate
```

`docs:check`, which `verify` runs, fails when any of them is stale.

The release history is in [CHANGELOG.md](../CHANGELOG.md), one directory up,
because it ships in the npm tarball.
