const expectedVersion = process.argv[2];

if (!expectedVersion) {
  throw new Error("Usage: bun scripts/check-deployed-worker.ts <version>");
}

const origin = "https://mcp.setluca.com";
const resource = `${origin}/mcp`;
const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;

async function checkDeployment(): Promise<void> {
  const options = {
    cache: "no-store" as const,
    signal: AbortSignal.timeout(10_000),
  };
  const cardResponse = await fetch(`${origin}/.well-known/mcp/server-card.json`, options);
  if (!cardResponse.ok) {
    throw new Error(`Server card returned ${cardResponse.status}`);
  }

  const card = (await cardResponse.json()) as {
    serverInfo?: { version?: string };
    endpoint?: string;
  };
  if (card.serverInfo?.version !== expectedVersion || card.endpoint !== resource) {
    throw new Error(
      `Server card has version ${card.serverInfo?.version ?? "missing"} and endpoint ${card.endpoint ?? "missing"}`,
    );
  }

  const metadataResponse = await fetch(metadataUrl, options);
  if (!metadataResponse.ok) {
    throw new Error(`OAuth metadata returned ${metadataResponse.status}`);
  }

  const metadata = (await metadataResponse.json()) as {
    resource?: string;
    authorization_servers?: string[];
  };
  if (
    metadata.resource !== resource ||
    !metadata.authorization_servers?.includes("https://api.setluca.com/api/auth")
  ) {
    throw new Error("OAuth metadata does not point at the Luca API and MCP resource");
  }

  const unauthenticated = await fetch(resource, options);
  const challenge = unauthenticated.headers.get("www-authenticate");
  if (
    unauthenticated.status !== 401 ||
    !challenge?.includes(`resource_metadata="${metadataUrl}"`)
  ) {
    throw new Error(
      `Unauthenticated MCP request returned ${unauthenticated.status} without the expected challenge`,
    );
  }
}

for (let attempt = 1; attempt <= 12; attempt++) {
  try {
    await checkDeployment();
    console.log(`MCP Worker ${expectedVersion} is live at ${resource}`);
    process.exit(0);
  } catch (error) {
    if (attempt === 12) {
      throw error;
    }
    console.log(`Worker check ${attempt}/12: ${String(error)}; retrying in 5 seconds`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}
