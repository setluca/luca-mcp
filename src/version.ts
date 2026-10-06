/**
 * The one version literal this package has.
 *
 * It cannot be read from package.json at runtime: the stdio build is plain
 * `tsc` with no bundler to inline a JSON import, and the Worker build has no
 * package.json beside it at all. So the value is written here by hand and
 * `scripts/check-registry.ts` fails CI when it drifts from package.json,
 * server.json, or server.json's package entry.
 *
 * Bump this in the same commit as package.json and server.json.
 */
export const LUCA_MCP_VERSION = "0.3.1";

/** The user-agent every outbound Luca API call identifies itself with. */
export const LUCA_MCP_USER_AGENT = `luca-mcp/${LUCA_MCP_VERSION}`;
