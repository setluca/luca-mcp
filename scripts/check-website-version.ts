/**
 * Fails when setluca.com advertises a different MCP version from the latest on npm.
 * The site bakes in a version at build time, with a fallback in setluca/website, and
 * nothing here can read that private repository. The public page is what coaches
 * copy their install command from anyway.
 */
import * as Schema from "effect/Schema";

import { isEntryPoint } from "./lib/script.ts";

const WEBSITE_PAGE = "https://setluca.com/connect.md";

const NPM_LATEST = "https://registry.npmjs.org/@setluca/mcp/latest";

const NpmManifest = Schema.Struct({ version: Schema.String });

/** Why the site and npm disagree, or undefined when they match. */
export async function websiteVersionDrift(
  fetcher: typeof fetch = fetch
): Promise<string | undefined> {
  const options = { signal: AbortSignal.timeout(15_000) };

  const npm = await fetcher(NPM_LATEST, options);

  if (!npm.ok) {
    throw new Error(`npm answered ${npm.status}`);
  }

  const { version } = Schema.decodeUnknownSync(NpmManifest)(await npm.json());

  const page = await fetcher(WEBSITE_PAGE, options);

  if (!page.ok) {
    throw new Error(`${WEBSITE_PAGE} answered ${page.status}`);
  }

  const advertised = /@setluca\/mcp@(\d+\.\d+\.\d+)/u.exec(
    await page.text()
  )?.[1];

  if (advertised === undefined) {
    return `${WEBSITE_PAGE} no longer names a version of @setluca/mcp`;
  }

  return advertised === version
    ? undefined
    : `${WEBSITE_PAGE} says ${advertised}, and npm's latest is ${version}`;
}

if (isEntryPoint(import.meta.filename)) {
  const drift = await websiteVersionDrift();

  if (drift !== undefined) {
    console.error(drift);
    process.exit(1);
  }

  console.log("setluca.com advertises the latest @setluca/mcp.");
}
