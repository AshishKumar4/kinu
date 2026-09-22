/**
 * Synthetic probes: the deploy smoke gate (health, downloads, login) re-run on a schedule against the live site.
 * Details must be stable per failure: the incident ledger dedupes on them.
 */

import { CLI_DIST_PATHS } from './deployed-assets';
import { sha256Hex } from '../safety/argument-digest';
import * as v from 'valibot';
import { renderThrownChain } from '../obs/index';

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
  /** Stable id; the incident ledger's key. */
  probe: string;
  ok: boolean;
  /** One line, stable per failure mode. */
  detail: string;
}

export interface ProbeDeps {
  origin: string;
  /** Structural rather than `typeof fetch`: the bound global differs between worker runtime and tests. */
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

const TIMEOUT_MS = 10_000;

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
    cache: 'no-store',
    headers: { 'user-agent': 'kinu-synthetic-monitor' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Tolerant of spelling: the health stamp is another module's shape. */
function buildStamp(input: { body: unknown }): string | null {
  const parsed = v.safeParse(BuildStampSchema, input.body);

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
  } catch (error) {
    return fail(`GET /api/health did not return JSON (${renderThrownChain({ cause: error })}) — the SPA fallback is answering an API route`);
  }

  if (!v.is(HealthBodySchema, body)) {
    return fail('GET /api/health reports the worker as not ok');
  }

  const live = buildStamp({ body });

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

/** Throws when the manifest is absent, is the SPA shell, or names no build. */
async function shippedBuild(deps: ProbeDeps): Promise<string> {
  const response = await get(deps, VERSION_MANIFEST);

  if (response.status !== 200) throw new Error(`it returned HTTP ${response.status}`);
  const stamp = buildStamp({ body: await response.json() });

  if (!stamp) throw new Error('it carries no build identifier');

  return stamp;
}

/** Checked sequentially: hashing holds the whole body in memory. */
async function probeDownloads(deps: ProbeDeps): Promise<ProbeOutcome> {
  const fail = (detail: string): ProbeOutcome => ({ probe: 'downloads', ok: false, detail });

  for (const path of CLI_DIST_PATHS) {
    const checksumPath = `${path}.sha256`;
    let archive: Response;
    let checksum: Response;

    try {
      [archive, checksum] = await Promise.all([get(deps, path), get(deps, checksumPath)]);
    } catch (err) {
      return fail(`the CLI download ${path} did not answer: ${renderThrownChain({ cause: err })}`);
    }

    if (archive.status !== 200) return fail(`GET ${path} returned HTTP ${archive.status}`);

    if (checksum.status !== 200) return fail(`GET ${checksumPath} returned HTTP ${checksum.status}`);

    let declared: string;
    let actual: string;

    try {
      declared = ((await checksum.text()).trim().split(/\s+/)[0] ?? '');
      actual = await sha256Hex(new Uint8Array(await archive.arrayBuffer()));
    } catch (err) {
      return fail(`the CLI download ${path} could not be read: ${renderThrownChain({ cause: err })}`);
    }

    if (!/^[0-9a-f]{64}$/.test(declared)) {
      return fail(
        `${checksumPath} is not a sha256 line — the SPA shell is being served in place of the checksum`,
      );
    }

    if (actual !== declared) {
      return fail(
        `${path} hashes to ${actual} but ${checksumPath} declares ${declared}`
        + ' — install and update are both refusing this download',
      );
    }
  }

  return { probe: 'downloads', ok: true, detail: `${CLI_DIST_PATHS.length} artifacts match their checksums` };
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
  let body: string;

  try {
    body = await response.text();
  } catch (err) {
    return fail(`GET /login could not be read: ${renderThrownChain({ cause: err })}`);
  }

  if (!body.includes('Sign in to Kinu')) {
    return fail('GET /login did not render the sign-in page');
  }

  if (!body.includes('href="/auth/')) {
    return fail('GET /login offers no sign-in provider — nobody can sign in');
  }

  return { probe: 'login', ok: true, detail: 'sign-in page renders' };
}

