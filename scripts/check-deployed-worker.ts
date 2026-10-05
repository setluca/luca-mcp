import * as Schema from "effect/Schema";

import { isEntryPoint } from "./lib/script.ts";

const origin = "https://mcp.setluca.com";

const resource = `${origin}/mcp`;

const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;

const ServerCard = Schema.Struct({
  serverInfo: Schema.Struct({ version: Schema.String }),
  endpoint: Schema.String,
});

const ProtectedResource = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.Array(Schema.String),
});

export async function checkDeployment(
  expectedVersion: string,
  fetcher: typeof fetch = fetch
): Promise<void> {
  const options = {
    cache: "no-store" as const,
    signal: AbortSignal.timeout(10_000),
  };

  await checkServerCard(expectedVersion, fetcher, options);
  await checkOAuthMetadata(fetcher, options);
  await checkChallenge(fetcher, options);
}

async function checkServerCard(
  expectedVersion: string,
  fetcher: typeof fetch,
  options: RequestInit
): Promise<void> {
  const cardResponse = await fetcher(
    `${origin}/.well-known/mcp/server-card.json`,
    options
  );

  if (!cardResponse.ok) {
    throw new Error(`Server card returned ${cardResponse.status}`);
  }

  const card = Schema.decodeUnknownSync(ServerCard)(await cardResponse.json());

  if (
    card.serverInfo.version !== expectedVersion ||
    card.endpoint !== resource
  ) {
    throw new Error(
      `Server card has version ${card.serverInfo.version} and endpoint ${card.endpoint}`
    );
  }
}

async function checkOAuthMetadata(
  fetcher: typeof fetch,
  options: RequestInit
): Promise<void> {
  const metadataResponse = await fetcher(metadataUrl, options);

  if (!metadataResponse.ok) {
    throw new Error(`OAuth metadata returned ${metadataResponse.status}`);
  }

  const metadata = Schema.decodeUnknownSync(ProtectedResource)(
    await metadataResponse.json()
  );

  if (
    metadata.resource !== resource ||
    !metadata.authorization_servers.includes("https://api.setluca.com/api/auth")
  ) {
    throw new Error(
      "OAuth metadata does not point at the Luca API and MCP resource"
    );
  }
}

async function checkChallenge(
  fetcher: typeof fetch,
  options: RequestInit
): Promise<void> {
  const unauthenticated = await fetcher(resource, options);
  const challenge = unauthenticated.headers.get("www-authenticate");

  if (
    unauthenticated.status !== 401 ||
    !challenge?.includes(`resource_metadata="${metadataUrl}"`)
  ) {
    throw new Error(
      `Unauthenticated MCP request returned ${unauthenticated.status} without the expected challenge`
    );
  }
}

if (isEntryPoint(import.meta.filename)) {
  const expectedVersion = process.argv[2];

  if (!expectedVersion) {
    throw new Error("Usage: bun scripts/check-deployed-worker.ts <version>");
  }

  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      await checkDeployment(expectedVersion);
      console.log(`MCP Worker ${expectedVersion} is live at ${resource}`);
      process.exit(0);
    } catch (error) {
      if (attempt === 12) {
        throw error;
      }

      console.log(
        `Worker check ${attempt}/12: ${String(error)}; retrying in 5 seconds`
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 5_000);
      });
    }
  }
}
