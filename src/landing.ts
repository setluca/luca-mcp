/**
 * The page a person gets when they open the server in a browser.
 *
 * Links to `https://mcp.setluca.com/mcp` used to answer a browser with the
 * OAuth 401, so crawlers marked every one of them broken. MCP clients never
 * see this page: they POST, ask for `text/event-stream`, or carry a bearer
 * token, and each of those still reaches the MCP handler and its challenge.
 */

/** Where a person learns how to connect an assistant. */
const CONNECT_GUIDE_URL = "https://setluca.com/connect";

/**
 * A browser asking for a page: a GET that accepts HTML, does not ask for an
 * event stream, and carries no credentials. The branch is kept this narrow
 * because handing an HTML 200 to an MCP client would break its connection.
 */
function isBrowserPageRequest(request: Request): boolean {
  if (request.method !== "GET" || request.headers.has("authorization")) {
    return false;
  }

  const accept = request.headers.get("accept") ?? "";

  return accept.includes("text/html") && !accept.includes("text/event-stream");
}

function page(origin: string, mcpPath: string, intro: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>SetLuca MCP server</title>
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 600px;
      margin: 60px auto;
      padding: 0 20px;
      line-height: 1.6;
      color: #1f2937;
      background: #fcfbf9;
    }
    a { color: #1d4ed8; }
    code {
      background: #f3f4f6;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 0.9em;
    }
  </style>
</head>
<body>
  <h1>SetLuca MCP server</h1>
  <p>${intro}</p>
  <p>To connect Claude, ChatGPT, Cursor, or another MCP client, follow the <a href="${CONNECT_GUIDE_URL}">connection guide</a>.</p>
  <ul>
    <li><a href="${CONNECT_GUIDE_URL}">Connect your AI assistant</a></li>
    <li><a href="https://setluca.com">SetLuca</a></li>
    <li><a href="https://github.com/setluca/luca-mcp">Source on GitHub: setluca/luca-mcp</a></li>
    <li><a href="${origin}/.well-known/mcp/server-card.json">MCP server card</a></li>
  </ul>
  <p>MCP endpoint: <code>${origin}${mcpPath}</code></p>
</body>
</html>`;
}

const ROOT_INTRO =
  "This server connects AI assistants to SetLuca over the Model Context Protocol (MCP).";

const MCP_INTRO =
  "This is the Model Context Protocol (MCP) endpoint for SetLuca. It answers MCP clients and AI assistants, not web browsers.";

/** The opening line of the page at `pathname`, absent for any other path. */
function introFor(pathname: string, mcpPath: string): string | undefined {
  if (pathname === "/") {
    return ROOT_INTRO;
  }

  return pathname === mcpPath ? MCP_INTRO : undefined;
}

/**
 * The landing page for a browser opening `/` or the MCP path, or `undefined`
 * for every other request, which the caller routes as before.
 */
export function browserLandingPage(
  request: Request,
  mcpPath: string
): Response | undefined {
  const url = new URL(request.url);
  const intro = introFor(url.pathname, mcpPath);

  if (intro === undefined || !isBrowserPageRequest(request)) {
    return undefined;
  }

  return new Response(page(url.origin, mcpPath, intro), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The same URL answers MCP clients with a 401, so a cache must not hand
      // this page to a request with other headers.
      vary: "Accept, Authorization",
    },
  });
}
