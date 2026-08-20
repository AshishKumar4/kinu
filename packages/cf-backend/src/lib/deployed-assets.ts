// Reading files out of the deployed static-asset bundle.
//
// The bundle is served with `not_found_handling: "single-page-application"`,
// so a file that was never published comes back as 200 + the SPA shell rather
// than a 404. A deploy made without the CLI archive step therefore served the
// index.html body as the CLI tarball, its checksum, and its version JSON —
// every fresh install died on a checksum mismatch and nothing reported it.
// So: one place owns "did this deployment actually publish that file?", and
// the SPA shell is never an acceptable answer for a file we asked for by name.
import { tolerateAsync } from '@kinu/core/obs';
import * as v from 'valibot';

/** CLI source archive + its checksum + the served build stamp. Written into
 *  `dist/client/downloads/` by scripts/build-cli-source-archive.sh. */
export const CLI_SOURCE_TARBALL_PATH = '/downloads/proteus-source.tar.gz';
export const CLI_SOURCE_TARBALL_SHA256_PATH = `${CLI_SOURCE_TARBALL_PATH}.sha256`;
export const CLI_VERSION_PATH = '/downloads/proteus-version.json';

/** Identity of the build that produced the deployed asset bundle. */
export interface BuildStamp {
  version: string;
  sha: string;
  builtAt: string;
}
const BuildStampSchema = v.object({
  version: v.pipe(v.string(), v.trim(), v.minLength(1)),
  sha: v.pipe(v.string(), v.trim(), v.minLength(1)),
  builtAt: v.pipe(v.string(), v.trim(), v.minLength(1)),
});

/**
 * Fetch a published asset, or null when this deployment does not contain it.
 *
 * Null covers every "not really there" case: a non-2xx from the asset worker
 * and the single-page-application fallback (an HTML body under the requested
 * path). Callers ask only for non-HTML files, so HTML is always the impostor.
 */
export async function fetchDeployedAsset(
  env: Env,
  base: string | URL,
  pathname: string,
): Promise<Response | null> {
  const res = await env.ASSETS.fetch(new Request(new URL(pathname, base), { method: 'GET' }));
  if (!res.ok) return null;
  if ((res.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) return null;
  return res;
}

/** The served build's `{version, sha, builtAt}`, or null when the deployment
 *  shipped no (or a malformed) build stamp — which means its asset bundle is
 *  incomplete and its CLI download endpoints are broken. */
export async function readBuildStamp(env: Env, base: string | URL): Promise<BuildStamp | null> {
  const res = await fetchDeployedAsset(env, base, CLI_VERSION_PATH);
  if (!res) return null;
  const parsed = v.safeParse(BuildStampSchema, await tolerateAsync(() => res.json(), 'malformed-input'));
  return parsed.success ? parsed.output : null;
}
