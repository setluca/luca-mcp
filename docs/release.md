# Release

This repository owns both MCP transports. A release starts as a pull request
against `main` with the version, registry metadata, and changelog changes.
The `Verify MCP` check builds and tests both transports and dry-runs the
production Worker bundle. Merge the reviewed pull request, then tag the merge
commit. A `mcp-v*` tag runs
`.github/workflows/publish-mcp.yml` in order: verify and publish the stdio
package to npm, deploy the Cloudflare Worker at `mcp.setluca.com`, publish
`server.json` to the MCP registry, then create a GitHub Release. The workflow
rejects a tag that does not point to a commit on `main`.
The `main release PR` repository ruleset requires a pull request and a passing
`verify` check before merging to `main`.

The existing Cloudflare Worker is named `setluca-mcp`. The production
`wrangler.toml` environment keeps that name and the `mcp.setluca.com` custom
domain, so deploying from this repository updates the same Worker. Alchemy
manages Luca's other services but is not needed for this stateless Worker.

## Repository setup

Before the first tag from `setluca/luca-mcp`:

1. npm has a Trusted Publisher connection for `@setluca/mcp` with GitHub
   organization `setluca`, repository `luca-mcp`, workflow `publish-mcp.yml`,
   environment `production`, and permission to run `npm publish`. This was
   added on October 5, 2026. The old `setluca/luca` connection remains until
   the first release from this repository succeeds. Confirm these settings
   before tagging if they have changed.
2. Keep the `production` environment in this GitHub repository configured with
   `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` environment secrets. The
   token must be able to update the existing `setluca-mcp` Worker and its
   `mcp.setluca.com` route. Configure environment reviewers if releases need a
   second approval beyond the release pull request.
3. Confirm this repo's Actions can publish `io.github.setluca/luca-mcp` through
   GitHub OIDC. `mcp-publisher` proves ownership from the `setluca` repository
   owner, while the registry verifies the published npm package's `mcpName`.
4. Disable the `Publish MCP` workflow in `setluca/luca` after this repository's
   first successful release. A tag in either repo otherwise has a release path.

The GitHub environment and npm settings are external to this repository.
The secret names and npm connection were checked on October 5, 2026. Local
verification cannot check the Cloudflare token's value or prove that the npm
connection can publish. The first release job must establish both.

## Cut a version

1. On a release pull request, update `version` in `package.json`,
   `server.json`, `server.json`'s npm package entry, and `src/version.ts`.
   Move the `Unreleased` entries in
   `CHANGELOG.md` under the new version and date. Use a patch bump for a fix,
   minor for additive tools or fields, and major for a breaking tool contract.
2. Refresh `contracts/` from the Luca commit currently deployed. Run
   `bun run contracts:sync --repo /path/to/luca --deployed --write`,
   then `bun run openapi:generate` and `bun run docs:generate`. Review the
   generated diff. The API allowlist and OpenAPI snapshot must come from the
   same Luca commit. `contracts/source.json` records their hashes, and `verify`
   requires the commit and OpenAPI document to match Luca production.
3. Run `bun run verify`, `bun run deploy:dry-run`, and `npm pack --dry-run`.
   The npm tarball should contain the built `dist/` files, `README.md`,
   `CHANGELOG.md`, `LICENSE`, and `package.json`.
4. Merge the release pull request after `Verify MCP` passes. Tag the resulting
   commit on `main` as `mcp-vX.Y.Z`, matching `package.json`, and push the tag.

The release workflow skips npm publication when that version already exists,
which allows an Actions rerun to finish a partial release. After deploying, it
checks the public server card version, OAuth metadata, and unauthenticated MCP
challenge before publishing to the registry. It does not roll back npm if
Worker deployment or registry publication fails. Check all four jobs before
calling a release complete.

## Verify a release

Start the published stdio server in an MCP client with a Luca developer API
key, call a read tool, and confirm a real response. Without a key, tool listing
should work and the first tool call should explain that `LUCA_API_KEY` is
required. For the remote transport, confirm a hosted client can complete OAuth
and call a read tool through `https://mcp.setluca.com/mcp`.

The older `io.github.leonardomso/luca-mcp` registry listing is owned by the
personal namespace and cannot be retired through this repo's OIDC token. Its
owner must deprecate it separately. The marketing site also keeps a fallback
MCP version in `setluca/website/src/lib/mcp-metadata.fallback.json`; update it
when releasing a new version.
