/**
 * Synthetic probes — the deploy's own smoke gate, re-run on a schedule against
 * the live site.
 *
 * These exist because of a real outage: a deploy that skipped `scripts/deploy.sh`
 * shipped a `dist/client` with no `downloads/`, and the SPA fallback answered
 * every missing asset with `200 index.html`. `curl install.sh | bash` and
 * `kinu update` died on a checksum mismatch for days, and the way we found
 * out was by running the install ourselves. Each probe below is one thing a
 * user does that was broken then and would be broken again:
 *
 *   health    — the API answers, and says WHICH build is live (cross-checked
 *               against the build the download assets advertise, so a
 *               half-shipped deploy is one probe away, not one user report).
 *   downloads — the source tarball and its `.sha256` are the real files and
 *               agree with each other. This is the exact check the installer
 *               makes before it will install anything.
 *   login     — the sign-in page renders with at least one working provider
 *               link. An OAuth config that fell out locks everyone out.
 *
 * Probe details are written to be STABLE for a given failure: the incident
 * ledger dedupes on the probe, and a detail that changed every tick would make
 * a re-read of an open incident look like news.
 */

import { sha256Hex } from '../lib/crypto';
import * as v from 'valibot';
import { renderThrownChain } from '@kinu/core/obs';

const BuildStampSchema = v.looseObject({
  sha: v.optional(v.string()),
  buildSha: v.optional(v.string()),
  version: v.optional(v.string()),
  build: v.optional(v.looseObject({
    sha: v.optional(v.string()),
    version: v.optional(v.string()),
  })),
});
const HealthBodySchema = v.looseObject({ ok: v.literal(true) });

export interface ProbeOutcome {
  /** Stable id — the incident ledger's key. */
  probe: string;
  ok: boolean;
  /** One line, stable per failure mode, written for whoever gets the email. */
  detail: string;
}

export interface ProbeDeps {
  origin: string;
  /** Injected so the probes are testable without a network. Structural rather
   *  than `typeof fetch`: this module sends a URL and reads a Response, and
   *  the global it is bound to differs between the worker runtime and the
   *  test runner. */
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

const TIMEOUT_MS = 10_000;

const SOURCE_ARCHIVE = '/downloads/kinu-source.tar.gz';
const SOURCE_CHECKSUM = '/downloads/kinu-source.tar.gz.sha256';
const VERSION_MANIFEST = '/downloads/kinu-version.json';

export async function runSyntheticProbes(deps: ProbeDeps): Promise<ProbeOutcome[]> {
  return [
    await probeHealth(deps),
    await probeDownloads(deps),
    await probeLogin(deps),
  ];
}

async function get(deps: ProbeDeps, path: string): Promise<Response> {
  return deps.fetch(`${deps.origin.replace(/\/+$/, '')}${path}`, {
    // A cached answer would tell us how the site looked, not how it is.
    cache: 'no-store',
    headers: { 'user-agent': 'proteus-synthetic-monitor' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** The build a JSON body claims. Written tolerantly on purpose: the health
 *  endpoint's stamp is another module's shape, and a monitor that hard-codes
 *  one spelling turns a rename into a false alarm. */
function buildStamp<Body>(body: Body): string | null {
  const parsed = v.safeParse(BuildStampSchema, body);
  if (!parsed.success) return null;
  const stamp = parsed.output;
  for (const value of [stamp.sha, stamp.buildSha, stamp.build?.sha, stamp.version, stamp.build?.version]) {
    if (value?.trim()) return value.trim();
  }
  return null;
}

async function probeHealth(deps: ProbeDeps): Promise<ProbeOutcome> {
  const fail = (detail: string): ProbeOutcome => ({ probe: 'health', ok: false, detail });
  let response: Response;
  try {
    response = await get(deps, '/api/health');
  } catch (err) {
    return fail(`GET /api/health did not answer: ${renderThrownChain({ cause: err })}`);
  }
  if (response.status !== 200) return fail(`GET /api/health returned HTTP ${response.status}`);

  let body: object;
  try {
    body = v.parse(v.looseObject({}), await response.json());
  } catch {
    return fail('GET /api/health did not return JSON — the SPA fallback is answering an API route');
  }
  if (!v.is(HealthBodySchema, body)) {
    return fail('GET /api/health reports the worker as not ok');
  }

  const live = buildStamp(body);
  if (!live) {
    return fail('GET /api/health carries no build identifier — the live build cannot be identified');
  }

  let shipped: string;
  try {
    shipped = await shippedBuild(deps);
  } catch (err) {
    return fail(
      `${VERSION_MANIFEST} cannot name the build the download assets came from,`
      + ` so the live build is unverified: ${renderThrownChain({ cause: err })}`,
    );
  }
  if (shipped !== live) {
    return fail(
      `the worker reports build ${live} but ${VERSION_MANIFEST} advertises ${shipped}`
      + ' — worker and assets are from different deploys',
    );
  }
  return { probe: 'health', ok: true, detail: `build ${live}` };
}

/** The build the shipped assets advertise. Throws when the manifest is absent,
 *  is the SPA shell, or names no build: that is the half-shipped deploy this
 *  file exists for, and no other probe reads this manifest. */
async function shippedBuild(deps: ProbeDeps): Promise<string> {
  const response = await get(deps, VERSION_MANIFEST);
  if (response.status !== 200) throw new Error(`it returned HTTP ${response.status}`);
  const stamp = buildStamp(await response.json());
  if (!stamp) throw new Error('it carries no build identifier');
  return stamp;
}

async function probeDownloads(deps: ProbeDeps): Promise<ProbeOutcome> {
  const fail = (detail: string): ProbeOutcome => ({ probe: 'downloads', ok: false, detail });
  let archive: Response;
  let checksum: Response;
  try {
    [archive, checksum] = await Promise.all([get(deps, SOURCE_ARCHIVE), get(deps, SOURCE_CHECKSUM)]);
  } catch (err) {
    return fail(`the CLI source download did not answer: ${renderThrownChain({ cause: err })}`);
  }
  if (archive.status !== 200) return fail(`GET ${SOURCE_ARCHIVE} returned HTTP ${archive.status}`);
  if (checksum.status !== 200) return fail(`GET ${SOURCE_CHECKSUM} returned HTTP ${checksum.status}`);

  const declared = (await checksum.text()).trim().split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{64}$/.test(declared)) {
    return fail(
      `${SOURCE_CHECKSUM} is not a sha256 line — the SPA shell is being served in place of the checksum`,
    );
  }
  const actual = await sha256Hex(await archive.arrayBuffer());
  if (actual !== declared) {
    return fail(
      `${SOURCE_ARCHIVE} hashes to ${actual} but ${SOURCE_CHECKSUM} declares ${declared}`
      + ' — install and update are both refusing this download',
    );
  }
  return { probe: 'downloads', ok: true, detail: `sha256 ${actual}` };
}

async function probeLogin(deps: ProbeDeps): Promise<ProbeOutcome> {
  const fail = (detail: string): ProbeOutcome => ({ probe: 'login', ok: false, detail });
  let response: Response;
  try {
    response = await get(deps, '/login');
  } catch (err) {
    return fail(`GET /login did not answer: ${renderThrownChain({ cause: err })}`);
  }
  if (response.status !== 200) return fail(`GET /login returned HTTP ${response.status}`);
  const body = await response.text();
  if (!body.includes('Sign in to Kinu')) {
    return fail('GET /login did not render the sign-in page');
  }
  if (!body.includes('href="/auth/')) {
    return fail('GET /login offers no sign-in provider — nobody can sign in');
  }
  return { probe: 'login', ok: true, detail: 'sign-in page renders' };
}

