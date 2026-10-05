# Luca MCP documentation

Start with the page that matches your task. [AGENTS.md](../AGENTS.md) has the
short checklist for agents working in this repository.

## Use the server

| Task                                    | Read                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Connect an MCP client                   | [Client setup](./client-setup.md), [Configuration](./configuration.md)                          |
| Try a tool or debug the protocol        | [Examples](./examples.md), [MCP Inspector](./inspector.md), [Errors](./errors.md)               |
| Find a tool, prompt, resource, or scope | [Tools](./tools.md), [Prompts and resources](./prompts-and-resources.md), [Scopes](./scopes.md) |
| Understand paging and tool counts       | [Pagination and tool count](./pagination-and-tool-count.md)                                     |
| Understand what data is shared          | [Privacy](./privacy.md), [Security boundary](./security.md)                                     |

## Change the server

| Task                                  | Read                                            |
| ------------------------------------- | ----------------------------------------------- |
| Find the code for a request           | [Architecture](./architecture.md)               |
| Add a tool or run checks              | [Development](./development.md)                 |
| Update Luca contracts or dependencies | [Maintenance](./maintenance.md)                 |
| Test against a live Luca workspace    | [Integration testing](./integration-testing.md) |
| Check the trust boundary              | [Security boundary](./security.md)              |

## Ship and operate

| Task                                     | Read                                            |
| ---------------------------------------- | ----------------------------------------------- |
| Release npm and the Worker               | [Release](./release.md)                         |
| Understand the hosted endpoint and OAuth | [Remote transport](./remote.md)                 |
| Update MCP registry metadata             | [Registry listing](./registry.md)               |
| List the connector in a directory        | [Connector directory](./connector-directory.md) |

The decisions behind the current design live in [ADRs](./adr/). Operational
steps live in [runbooks](./runbooks/). The [changelog](../CHANGELOG.md) records
published versions.

`tools.md`, `prompts-and-resources.md`, and `scopes.md` are generated. Update the
catalog, run `bun run docs:generate`, then run `bun run docs:check`.
