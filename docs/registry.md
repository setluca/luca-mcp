# MCP registry listing

The official MCP registry reads `server.json`. Smithery and Glama
mirror the same manifest. `registry:check`, which runs
inside `verify`, keeps its version, tool count, and declared environment
variables matching the code, so the manifest cannot drift silently.

The listing is live as `io.github.setluca/luca-mcp`. The `publish-registry` job
in `.github/workflows/publish-mcp.yml` updates it on every `mcp-v*` tag, so
routine releases need no manual step. [release.md](./release.md) covers how
ownership is proven and what the workflow does.

## What the manifest declares

- The stdio transport, and every environment variable `src/config.ts` and
  `src/index.ts` read. [configuration.md](./configuration.md) explains each one.
- `packages[0].identifier` is `@setluca/mcp`, matching the npm package name.
  `registry:check` enforces that, and the package has to exist on npm before the
  registry accepts the listing.
- `websiteUrl` points at `https://setluca.com/developers`.
- The hosted Worker under `remotes`, as a `streamable-http` transport at
  `https://mcp.setluca.com/mcp`, so a hosted client browsing the registry can
  connect without installing the npm package. `registry:check` rejects a remote
  entry whose transport type or url the registry schema would refuse, because
  that failure would otherwise land at publish time, after npm has already
  shipped.
- `repository` points at `https://github.com/setluca/luca-mcp`, which is public.
  Directories such as Glama and LibHunt read the description from there too, so
  keep the GitHub repo description in the same SetLuca wording as `server.json`.

## Still open

**Smithery and Glama.** Glama lists the server from this manifest as
`io.github.setluca/luca-mcp`. Its health check calls `/mcp` without a token
and gets the 401, so it shows the server as unhealthy until its test profile
holds a read-only key; [remote.md](./remote.md#other-public-routes) explains
why the 401 stays. Smithery has no listing yet. Confirm its manifest
requirements before submitting, since it may want metadata beyond
`server.json`.

**The 0.1.1 listing under the old namespace.** `io.github.leonardomso/luca-mcp`
is still `active` in the registry and still resolves to 0.1.1. Retiring it needs
`mcp-publisher login github` from that personal account, which no workflow can
do. Until then a client that added the server before the namespace move keeps
seeing the old version.

`registry:check` covers the version, the tool count, the environment variables,
and the shape of every `remotes` entry. What it cannot check is whether the url
in one actually answers, so confirm that by hand whenever MCP work changes the
deployed origin.

## The marketing site snapshot

`setluca.com/developers` and `/connect` bake in a snapshot of the npm version,
the npm package name, and the registry name, used when the live npm and
discovery lookups fail at build time. That snapshot lives in the
`setluca/website` repo at `src/lib/mcp-metadata.fallback.json`, so nothing here
can check it. Bump it there in the same release that bumps this package, or
those pages keep advertising the old version whenever the live lookup fails.
