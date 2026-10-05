# Pagination and tool count

## Auto-pagination guard

Every list tool (`luca_*_list`) auto-paginates server-side. On a call, the
server follows the response `nextCursor` and merges the items array across
pages, up to a bounded guard, then returns one aggregated result.

- **Default guard.** 10 pages per call. Pass `maxPages` to override it, from 1
  to 50.
- **A partial result says so.** When pages remain past the guard, the result
  carries `pagination.truncated: true` and `pagination.nextCursor`, so an agent
  can pick up exactly where the walk stopped:

  ```json
  {
    "leads": [/* merged items across the fetched pages */],
    "pagination": { "pagesFetched": 10, "truncated": true, "nextCursor": "..." }
  }
  ```

  A complete result carries `truncated: false` and `nextCursor: null`.

Ten pages is hundreds of records at the API's default page size, which covers
most calls, and it stops one tool call from running an unbounded loop against
the Luca API. An agent that needs more raises `maxPages` or continues from
`pagination.nextCursor`. `DEFAULT_MAX_PAGES` holds the guard and
`MAX_PAGES_LIMIT` holds the hard cap of 50, both exported from
`src/operations.ts`.

The paginator is shape-driven, not per-tool config. `src/page-contract.ts` reads
each route's cursor field, which `openapi:generate` works out from the route's
query schema, and the route's output schema once, when the catalog is built. It
answers with a page shape or with nothing. A shape names two things: the query field the cursor
goes back in, and the field the records arrive in. A route has one only when its response declares
`nextCursor` alongside an array and its query takes a cursor field to send
back. Thirteen operations qualify today. A route that declares `nextCursor` but
takes no cursor query parameter is not a paging route.

An operation with a page shape is walkable, and the walk reads the page under
the names that shape already decided. A body that carries no cursor, or none of
the array its shape names, is returned untouched, so a page that arrives in an
unexpected form ends the walk instead of being reshaped.

The cursor does not always travel under the name `cursor`.
`GET /api/conversations/{id}/messages` takes `before`, and its records arrive
under `messages` rather than a name derived from the tool. Both come from the
route, so the paginator sends and reads the right ones.

## Tool count: keep the flat, one-tool-per-operation surface

**Keep one tool per operation. Do not consolidate into fewer parameterized
meta-tools.** The current total is on the "Total tools" line at the top of
`tools.md`, which is generated, so it never drifts from the code. This page
explains the reasoning rather than the number.

Three reasons:

- **Per-operation tools are the product.** Each one carries its own input
  schema, generated from that route's OpenAPI definition, plus its own scopes,
  idempotency and confirm semantics, and description. A meta-tool such as
  `luca_leads` with an `action` argument collapses all of that into one loose
  schema, which is the ambiguity MCP tool descriptions exist to remove. An agent
  picks correctly more often from many sharp descriptions than from a handful of
  fuzzy ones.
- **The client-cap concern is unverified and moving.** The original worry was
  that some MCP clients cap usable tools around 40 to 50. Nobody re-verified
  that figure, and hosted clients change their limits on their own schedule. A
  breaking rename against an unverified number pays a real cost for a guess.
- **Consolidation is a breaking change.** Tool names
  (`luca_<id with dots as underscores>`) are part of every existing MCP client
  config. Renaming or collapsing them breaks those configs. If a real client
  cap ever forces the issue, the migration must alias the old names or ship as
  a major version with release notes.

Revisit this if a target hosted client, meaning Claude, ChatGPT, or Cursor, is
confirmed to silently drop tools past a cap. The move then is to group the
lowest-value read tools behind the operation groups that already exist under
`src/operations/groups/`, with aliases for the retired names. That beats a
wholesale collapse.
