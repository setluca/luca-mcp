# ADR 0034: Client ID Metadata Documents for MCP clients

## Status

Accepted.

## Context

The MCP authorization spec lets a client name an https URL as its `client_id`
and publish its registration as a JSON document at that URL, a Client ID
Metadata Document (CIMD). The authorization server fetches the document instead
of taking a dynamic client registration request. Hosted MCP clients, Claude
among them, prefer CIMD when the server advertises
`client_id_metadata_document_supported`.

Luca's authorization server is Better Auth's `oauth-provider` plugin inside the
`apps/api` Worker. Better Auth publishes `@better-auth/cimd` at the same version
we run (1.7.3). It validates the document, rejects a `client_id` URL that names
a loopback, private, link-local, or cloud-metadata host, caps the body at 5 KB,
aborts after 5 seconds, requires JSON, caches the result by its Cache-Control
lifetime, rate-limits fetches, and stores the client in `oauth_client`, which
already has the `client_discovery_id` column it needs.

The plugin leaves the network transport to the application. It requires one that
resolves the host once, refuses special-use addresses, pins the checked address
for the connection, and refuses redirects. Its own transport (`./node`) uses
`node:dns` and `node:https`, and a Worker's `fetch` cannot pin an address.

## Decision

Enable CIMD through `@better-auth/cimd`, configured in
`packages/auth/src/client-metadata-documents.ts`:

- The documents follow the MCP 2026-07-28 profile, which requires
  `client_name` and `redirect_uris`.
- Every redirect URI must be https, or http on `127.0.0.1`, `[::1]`, or
  `localhost`. A stored client that breaks the rule resolves to nothing, so
  its authorization and token requests fail. Private-use schemes such as
  `cursor://` are refused, because nothing ties the app that owns the scheme
  to the document's domain. Those clients can still use dynamic client
  registration.
- The transport is the Worker's `fetch` with `redirect: "manual"`. The plugin
  rejects any status other than 200 or 304, so a redirect is never followed.
- In place of address pinning, the transport relies on Cloudflare's egress. A
  Worker's subrequests go out over the public internet. They cannot reach a
  private network unless a VPC or Tunnel binding grants one, and the API
  Worker has none. The plugin's host check covers IP literals and loopback
  names.

## Consequences

- An MCP client can connect without a registration request, and the
  authorization server advertises `client_id_metadata_document_supported`.
- The SSRF guarantee depends on the API Worker having no binding into a private
  network. Adding a VPC or Tunnel binding to `apps/api` requires revisiting
  this decision.
- In local development the API runs under `wrangler dev` on a laptop, where a
  hostname that resolves to a private address is reachable. Local development
  accepts that risk; it holds no production data.
- A client refused by the redirect rule still leaves a row in `oauth_client`.
  The plugin's `resolve` stores the client before Luca's rule runs on its
  result, and the rule only changes what `resolve` returns. The row is inert:
  every lookup goes through the same rule again, so it never authorizes a
  request or issues a token, and it holds only the public metadata the
  document already published. Removing it would mean replacing the plugin's
  storage step, which costs more than a row that can't be used.
- The consent screen shows the document's `client_name`, which the client
  controls, as it already shows a dynamically registered client's name. Beside
  it, the screen shows the `client_id` host, so a coach can see who published
  the document.
