/**
 * Synthetic probes: the deploy smoke gate (health, downloads, login) re-run on a schedule against the live site.
 * Details must be stable per failure: the incident ledger dedupes on them.
 */

import { Effect } from 'effect';
import { settle } from '../obs/effect';
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
  signIn: { readonly declared: readonly string[]; readonly configured: readonly string[] };
}

export function declaredSignInProviders(raw: string): string[] {
  return raw.split(',').map((id) => id.trim()).filter((id) => id !== '');
}

const TIMEOUT_MS = 10_000;

const VERSION_MANIFEST = '/downloads/kinu-version.json';

export function runSyntheticProbes(deps: ProbeDeps): Promise<ProbeOutcome[]> {
  return settle(Effect.all([probe('health', health(deps)), probe('downloads', downloads(deps)), probe('login', login(deps))]));
}

type Checks = Effect.Effect<string, string>;

function probe(name: string, checks: Checks): Effect.Effect<ProbeOutcome> {
  return Effect.match(checks, {
    onSuccess: (detail) => ({ probe: name, ok: true, detail }),
    onFailure: (detail) => ({ probe: name, ok: false, detail }),
  });
}

function step<A>(run: () => Promise<A>, failed: (cause: string) => string): Effect.Effect<A, string> {
  return Effect.tryPromise({ try: run, catch: (cause) => failed(renderThrownChain({ cause })) });
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

function health(deps: ProbeDeps): Checks {
  return Effect.gen(function* () {
    const response = yield* step(() => get(deps, '/api/health'), (cause) => `GET /api/health did not answer: ${cause}`);

    if (response.status !== 200) return yield* Effect.fail(`GET /api/health returned HTTP ${response.status}`);

    const body = yield* step(
      async () => v.parse(v.looseObject({}), await response.json()),
      (cause) => `GET /api/health did not return JSON (${cause}): the SPA fallback is answering an API route`,
    );

    if (!v.is(HealthBodySchema, body)) {
      return yield* Effect.fail('GET /api/health reports the worker as not ok');
    }

    const live = buildStamp({ body });

    if (!live) {
      return yield* Effect.fail('GET /api/health carries no build identifier: the live build cannot be identified');
    }

    const shipped = yield* shippedBuild(deps).pipe(Effect.mapError((cause) =>
      `${VERSION_MANIFEST} cannot name the build the download assets came from,`
      + ` so the live build is unverified: ${cause}`));

    if (shipped !== live) {
      return yield* Effect.fail(
        `the worker reports build ${live} but ${VERSION_MANIFEST} advertises ${shipped}`
        + ': worker and assets are from different deploys',
      );
    }

    return `build ${live}`;
  });
}

/** Fails when the manifest is absent, is the SPA shell, or names no build. */
function shippedBuild(deps: ProbeDeps): Effect.Effect<string, string> {
  return Effect.gen(function* () {
    const response = yield* step(() => get(deps, VERSION_MANIFEST), (cause) => cause);

    if (response.status !== 200) return yield* Effect.fail(`it returned HTTP ${response.status}`);
    const stamp = buildStamp({ body: yield* step(async () => response.json(), (cause) => cause) });

    if (!stamp) return yield* Effect.fail('it carries no build identifier');

    return stamp;
  });
}

/** Checked sequentially: hashing holds the whole body in memory. */
function downloads(deps: ProbeDeps): Checks {
  return Effect.gen(function* () {
    for (const path of CLI_DIST_PATHS) {
      const checksumPath = `${path}.sha256`;

      const [archive, checksum] = yield* step(
        async () => Promise.all([get(deps, path), get(deps, checksumPath)]),
        (cause) => `the CLI download ${path} did not answer: ${cause}`,
      );

      if (archive.status !== 200) return yield* Effect.fail(`GET ${path} returned HTTP ${archive.status}`);

      if (checksum.status !== 200) return yield* Effect.fail(`GET ${checksumPath} returned HTTP ${checksum.status}`);

      const { declared, actual } = yield* step(async () => ({
        declared: ((await checksum.text()).trim().split(/\s+/)[0] ?? ''),
        actual: await sha256Hex(new Uint8Array(await archive.arrayBuffer())),
      }), (cause) => `the CLI download ${path} could not be read: ${cause}`);

      if (!/^[0-9a-f]{64}$/.test(declared)) {
        return yield* Effect.fail(
          `${checksumPath} is not a sha256 line: the SPA shell is being served in place of the checksum`,
        );
      }

      if (actual !== declared) {
        return yield* Effect.fail(
          `${path} hashes to ${actual} but ${checksumPath} declares ${declared}`
          + ': install and update are both refusing this download',
        );
      }
    }

    return `${CLI_DIST_PATHS.length} artifacts match their checksums`;
  });
}

function login(deps: ProbeDeps): Checks {
  return Effect.gen(function* () {
    const response = yield* step(() => get(deps, '/login'), (cause) => `GET /login did not answer: ${cause}`);

    if (response.status !== 200) return yield* Effect.fail(`GET /login returned HTTP ${response.status}`);
    const body = yield* step(async () => response.text(), (cause) => `GET /login could not be read: ${cause}`);

    if (!body.includes('Sign in to Kinu')) {
      return yield* Effect.fail('GET /login did not render the sign-in page');
    }

    const { declared, configured } = deps.signIn;

    if (declared.length === 0) return 'sign-in page renders; this deployment declares no provider';
    const unconfigured = declared.filter((id) => !configured.includes(id));

    if (unconfigured.length > 0) {
      return yield* Effect.fail(`${unconfigured.join(', ')} is declared in SIGN_IN_PROVIDERS but has no client id or secret: nobody can sign in with it`);
    }

    if (!body.includes('href="/auth/')) {
      return yield* Effect.fail('GET /login offers no sign-in provider: nobody can sign in');
    }

    const missing = declared.filter((id) => !body.includes(`href="/auth/${id}/start`));

    if (missing.length > 0) return yield* Effect.fail(`GET /login does not offer ${missing.join(', ')}, which SIGN_IN_PROVIDERS declares`);

    return 'sign-in page renders';
  });
}

