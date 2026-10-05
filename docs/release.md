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

The [0.3.0 release](https://github.com/setluca/luca-mcp/actions/runs/37316310753)
on October 5, 2026, proved this release path:

- npm's Trusted Publisher for `@setluca/mcp` points to `setluca/luca-mcp`,
  workflow `publish-mcp.yml`, environment `production`, with `npm publish`
  allowed. The old `setluca/luca` publisher connection was removed after the
  release succeeded.
- This repository's GitHub `production` environment has
  `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` secrets. They deployed the
  existing `setluca-mcp` Worker at `mcp.setluca.com` successfully. Configure
  environment reviewers if releases need a second approval beyond the release
  pull request.
- GitHub Actions published `io.github.setluca/luca-mcp` to the MCP registry
  through GitHub OIDC. The registry checked ownership and the npm package's
  `mcpName`.
- The old `Publish MCP` workflow in `setluca/luca` is disabled. Keep it off
  while this repository owns the release.

These settings live outside this repository and may change. Check them before
future releases. The workflow is the final test of publishing and deployment
access; local checks cannot read the GitHub environment secrets.

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
