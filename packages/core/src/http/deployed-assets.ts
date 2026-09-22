// Reads files out of the deployed static-asset bundle. SPA fallback serves a missing file as 200 + index.html,
// so the SPA shell is never an acceptable answer for a file asked for by name.
import { tolerateAsync } from '../obs/index';
import * as v from 'valibot';

/** Matches the launcher's `uname` mapping: Darwin/Linux, arm64/x86_64. */
export const CLI_DIST_PLATFORMS = [
  'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64',
] as const;

/** Written into `dist/client/downloads/` by scripts/build-cli-dist.sh; each has a sibling `.sha256`. */
export const CLI_RUNTIME_PATH = '/downloads/kinu-runtime-cpython.tar.gz';

export const CLI_DIST_PATHS: string[] = [
  ...CLI_DIST_PLATFORMS.map((platform) => `/downloads/kinu-cli-${platform}.tar.gz`),
  CLI_RUNTIME_PATH,
];

export const CLI_VERSION_PATH = '/downloads/kinu-version.json';

/** Checksums and signature (`http/release-signing.ts`) are absent on older manifests, which no verifier accepts. */
export interface BuildStamp {
  version: string;
  sha: string;
  builtAt: string;
  checksums?: Record<string, string>;
  signature?: string;
}

const BuildStampSchema = v.object({
  version: v.pipe(v.string(), v.trim(), v.minLength(1)),
  sha: v.pipe(v.string(), v.trim(), v.minLength(1)),
  builtAt: v.pipe(v.string(), v.trim(), v.minLength(1)),
  checksums: v.optional(v.record(v.string(), v.string())),
  signature: v.optional(v.string()),
});

/** Structural: `env.ASSETS` and cli-backend's local fetch both satisfy it. */
export interface AssetFetcher {
  fetch(input: Request): Promise<Response>;
}

/** Null for a non-2xx or an HTML body (the SPA fallback); callers only ask for non-HTML files. */
export async function fetchDeployedAsset(
  env: { readonly ASSETS: AssetFetcher },
  base: string | URL,
  pathname: string,
): Promise<Response | null> {
  const target = new URL(pathname, base).href;
  const res = await env.ASSETS.fetch(new Request(target, { method: 'GET' }));

  if (!res.ok) return null;

  if ((res.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) return null;

  return res;
}

/** Null when the build stamp is missing or malformed. */
export async function readBuildStamp(env: { readonly ASSETS: AssetFetcher }, base: string | URL): Promise<BuildStamp | null> {
  const res = await fetchDeployedAsset(env, base, CLI_VERSION_PATH);

  if (!res) return null;
  const parsed = v.safeParse(BuildStampSchema, await tolerateAsync(() => res.json(), 'malformed-input'));

  return parsed.success ? parsed.output : null;
}
