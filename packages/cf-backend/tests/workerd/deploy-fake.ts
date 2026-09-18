/**
 * The Node-side plane the deploy probe runs against: a Cloudflare API that
 * remembers what it created, an authorization server that issues a token pair
 * for a PKCE exchange, and a release channel that serves a real
 * `release.json` and a real `.tar.gz` whose digest matches the one it
 * publishes.
 *
 * WHY HTTP AND NOT THE CORE FAKE. `packages/core/tests/unit-deploy-flow.test.ts`
 * fakes the `CloudflareTransport` PORT, which is the right level for the step
 * logic. The Durable Object is one level below that: it builds the transport
 * itself, downloads the artifact with the global `fetch`, gunzips it, verifies
 * the published digest, and exchanges an authorization code against
 * `dash.cloudflare.com`. None of that is exercised by a port fake, and all of
 * it is what a real run does first. So this plane speaks HTTP, and the probe
 * worker's `outboundService` is where it is installed.
 *
 * WHAT IT REFUSES. An unmatched host or path throws rather than answering
 * something plausible: a run that reached an unnamed network is a finding, not
 * a pass.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import * as v from 'valibot';
import type { JsonValue } from '@kinu.run/core';

const ACCOUNT_ID = '0'.repeat(32);

const VERSION = '0.4.0+probe01';

/** The account's workers.dev subdomain, and therefore the address a run
 *  settles on: `<instance>.<subdomain>.workers.dev`. */
const SUBDOMAIN = 'probe';

export const DEPLOY_FAKE_ACCOUNT = ACCOUNT_ID;

export const DEPLOY_FAKE_VERSION = VERSION;

export const DEPLOY_FAKE_SUBDOMAIN = SUBDOMAIN;

export const DEPLOY_FAKE_CHANNEL = 'https://channel.invalid';

export const DEPLOY_FAKE_CLIENT_ID = 'probe-deploy-client';

export const DEPLOY_FAKE_ACCESS_TOKEN = 'probe-access-token';

export const DEPLOY_FAKE_REFRESH_TOKEN = 'probe-refresh-token';

/** What the authorization server hands back for a REFRESH grant, which is the
 *  grant a self-update spends. Distinct from the first pair on purpose: the
 *  token the update writes back into the deployment must be the rotated one. */
export const DEPLOY_FAKE_ROTATED_REFRESH = 'probe-refresh-token-2';

/** The address the probe deployment was created for, and therefore the only
 *  session its Updates surface answers. */
export const DEPLOY_FAKE_OWNER = 'owner@example.com';

/** A build behind the channel's: what the probe deployment serves as its own
 *  stamp until a row says otherwise, and the version its record names. */
export const DEPLOY_FAKE_OLDER_BUILD = {
  version: '0.3.9+probe00',
  sha: 'probe00',
  builtAt: '2026-09-01T00:00:00.000Z',
};

/** The build the channel publishes, as `release.json` states it and as the new
 *  Worker's `/api/health` answers it. */
export const DEPLOY_FAKE_CHANNEL_BUILD = {
  version: VERSION,
  sha: 'probe01',
  builtAt: '2026-09-18T00:00:00.000Z',
};

/** The deployment record the probe Worker is bound with: what a first run left
 *  behind, as `handoverStep` writes it. Held here rather than in the test,
 *  because it is a BINDING of the probe worker (`vitest.config.ts`) and the
 *  test reads the same constant it is bound with. */
export const DEPLOY_FAKE_RECORD = JSON.stringify({
  inputs: {
    accountId: ACCOUNT_ID,
    instanceName: 'kinu',
    address: { kind: 'workers-dev', hostname: '', zoneId: '' },
    ownerEmail: DEPLOY_FAKE_OWNER,
    accessEmails: [DEPLOY_FAKE_OWNER],
    providerKeyNames: [],
    sandbox: false,
  },
  address: `kinu.${SUBDOMAIN}.workers.dev`,
  version: DEPLOY_FAKE_OLDER_BUILD.version,
  channelOrigin: DEPLOY_FAKE_CHANNEL,
  clientId: DEPLOY_FAKE_CLIENT_ID,
  deployedAt: DEPLOY_FAKE_OLDER_BUILD.builtAt,
});

const FILES = {
  'worker/index.js': 'export default { fetch: () => new Response("probe") };\n',
  'worker/chunk.js': 'export const chunk = 1;\n',
  'client/index.html': '<!doctype html><title>probe</title>\n',
  'client/app.js': 'console.log("probe");\n',
} satisfies Record<string, string>;

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A ustar member: a 512-byte header with an octal size and a checksum, then
 *  the body padded to a block. The reader under test
 *  (`core/src/deploy/artifact.ts`) accepts exactly this. */
function tarMember(path: string, body: string): Buffer {
  const header = Buffer.alloc(512);
  const bytes = Buffer.from(body, 'utf8');

  header.write(path.padEnd(100, '\0'), 0, 100, 'binary');
  header.write('000644 \0', 100, 8, 'binary');
  header.write('000000 \0', 108, 8, 'binary');
  header.write('000000 \0', 116, 8, 'binary');
  header.write(`${bytes.length.toString(8).padStart(11, '0')} `, 124, 12, 'binary');
  header.write('00000000000 ', 136, 12, 'binary');
  header.write('        ', 148, 8, 'binary');
  header.write('0', 156, 1, 'binary');
  header.write('ustar\0', 257, 6, 'binary');
  header.write('00', 263, 2, 'binary');

  let sum = 0;

  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'binary');

  const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);

  return Buffer.concat([header, bytes, padding]);
}

function manifestText(build: DeployFakeServedBuild): string {
  return JSON.stringify({
    version: build.version,
    sha: build.sha,
    builtAt: build.builtAt,
    channelOrigin: DEPLOY_FAKE_CHANNEL,
    worker: {
      name: 'kinu',
      mainModule: 'index.js',
      compatibilityDate: '2025-12-01',
      compatibilityFlags: ['nodejs_compat'],
      modules: ['index.js', 'chunk.js'],
      modulesPath: 'worker',
      assets: 'client',
      assetsBinding: 'ASSETS',
      crons: [],
    },
    bindings: [
      { binding: 'AUTH_KV', kind: 'kv', resource: 'kinu-auth-kv', required: true },
      { binding: 'BACKUP_BUCKET', kind: 'r2', resource: 'kinu-backups', required: false },
      { binding: 'MEMORY_VECTORS', kind: 'vectorize', resource: 'kinu-memory', required: false },
      { binding: 'OrchestratorAgent', kind: 'durable-object', resource: 'OrchestratorAgent', required: true },
      { binding: 'ASSETS', kind: 'assets', resource: '', required: true },
      { binding: 'LOADER', kind: 'worker-loader', resource: '', required: true },
    ],
    vectorIndexes: [{ name: 'kinu-memory', dimensions: 384, metric: 'cosine' }],
    migrations: [{ tag: 'v1', newSqliteClasses: ['OrchestratorAgent'] }],
    secrets: [
      { name: 'CREDENTIAL_ENCRYPTION_KEY', handling: 'prompted', required: true, prompt: '32 random bytes' },
      { name: 'WEBHOOK_ROUTE_SECRET', handling: 'prompted', required: true, prompt: '32 random bytes' },
    ],
    vars: [{ name: 'SANDBOX_TRANSPORT', policy: 'carried', value: 'rpc' }],
    files: Object.entries(FILES).map(([path, body]) => ({
      path,
      sha256: sha256(body),
      size: Buffer.byteLength(body),
      assetHash: path.startsWith('client/') ? sha256(body).slice(0, 32) : null,
    })),
    seed: null,
  });
}

interface Release {
  readonly text: string;
  readonly archive: Buffer<ArrayBuffer>;
  readonly digest: string;
}

/** The channel's two objects for one version: the manifest and the tarball that
 *  carries it plus every file it names. Built per version and kept, because a
 *  row that publishes a second build asks for both again. */
const releases = new Map<string, Release>();

function release(): Release {
  const version = held.published.version;
  const built = releases.get(version);

  if (built !== undefined) return built;
  const text = manifestText(held.published);

  const members = [
    tarMember('release.json', text),
    ...Object.entries(FILES).map(([path, body]) => tarMember(path, body)),
  ];

  const tar = Buffer.concat([...members, Buffer.alloc(1024)]);
  const archive = gzipSync(tar);
  const made: Release = { text, archive, digest: sha256(archive) };

  releases.set(version, made);

  return made;
}

export interface DeployFakeRefusal {
  readonly path: string;
  readonly status: number;
  readonly code: number;
  readonly message: string;
}

export const DeployFakeStateSchema = v.object({
  deployments: v.array(v.string()),
  namespaces: v.array(v.string()),
  buckets: v.array(v.string()),
  indexes: v.array(v.string()),
  gateways: v.array(v.string()),
  apps: v.array(v.string()),
  secrets: v.record(v.string(), v.string()),
  uploads: v.number(),
  creates: v.array(v.string()),
});

export interface DeployFakeState {
  /** Every version id the deployment pointer was moved to, in order. */
  readonly deployments: readonly string[];
  readonly namespaces: readonly string[];
  readonly buckets: readonly string[];
  readonly indexes: readonly string[];
  readonly gateways: readonly string[];
  readonly apps: readonly string[];
  /** The secrets PUT on the new Worker's script, by name and text. Values are
   *  this plane's own fakes, and they are what proves the handover wrote the
   *  token and the record it was supposed to write. */
  readonly secrets: Readonly<Record<string, string>>;
  readonly uploads: number;
  readonly creates: readonly string[];
}

/** The build this plane serves as the deployment's own `kinu-version.json`,
 *  which is what `readBuildStamp` reads and therefore what the Updates surface
 *  compares the channel against. */
export interface DeployFakeServedBuild {
  readonly version: string;
  readonly sha: string;
  readonly builtAt: string;
}

const ServedBuildSchema = v.object({
  version: v.string(),
  sha: v.string(),
  builtAt: v.string(),
});

interface Held {
  /** What the channel publishes right now. A row that installs two releases in
   *  a row moves this between the two applies. */
  published: DeployFakeServedBuild;
  /** Every version id a deployment pointer was moved to, in order. Two
   *  successive releases must leave two entries: an update that uploaded and
   *  never repointed is the silent no-op this records. */
  deployments: string[];
  /** Which release each uploaded version id carries, so `/api/health` can
   *  answer what the Worker actually serves. */
  versions: Map<string, string>;
  namespaces: string[];
  buckets: string[];
  indexes: string[];
  gateways: string[];
  apps: string[];
  secrets: Map<string, string>;
  uploads: number;
  creates: string[];
  scriptExists: boolean;
  refuseOnce: DeployFakeRefusal | null;
  served: DeployFakeServedBuild | null;
}

const held: Held = fresh();

function fresh(): Held {
  return {
    published: DEPLOY_FAKE_CHANNEL_BUILD,
    deployments: [],
    versions: new Map<string, string>(),
    namespaces: [],
    buckets: [],
    indexes: [],
    gateways: [],
    apps: [],
    secrets: new Map<string, string>(),
    uploads: 0,
    creates: [],
    scriptExists: false,
    refuseOnce: null,
    served: null,
  };
}

function reset(): void {
  const empty = fresh();

  held.published = empty.published;
  held.deployments = [];
  held.versions = new Map<string, string>();
  held.namespaces = empty.namespaces;
  held.buckets = empty.buckets;
  held.indexes = empty.indexes;
  held.gateways = empty.gateways;
  held.apps = empty.apps;
  held.secrets = empty.secrets;
  held.uploads = 0;
  held.creates = empty.creates;
  held.scriptExists = false;
  held.refuseOnce = null;
  held.served = null;
}

function snapshot(): DeployFakeState {
  return {
    deployments: [...held.deployments],
    namespaces: [...held.namespaces],
    buckets: [...held.buckets],
    indexes: [...held.indexes],
    gateways: [...held.gateways],
    apps: [...held.apps],
    secrets: Object.fromEntries(held.secrets),
    uploads: held.uploads,
    creates: [...held.creates],
  };
}

const RefusalSchema = v.object({
  path: v.string(),
  status: v.number(),
  code: v.number(),
  message: v.string(),
});

/** The control surface, named once: anything else is a caller's typo and this
 *  plane refuses it rather than answering a state nobody asked to change. */
const CONTROL_PATHS: readonly string[] = ['/reset', '/refuse', '/serve', '/publish', '/state'];

function envelope(result: JsonValue, status = 200): Response {
  return Response.json({ success: true, errors: [], result }, { status });
}

function refusal(status: number, code: number, message: string): Response {
  return Response.json({ success: false, errors: [{ code, message }], result: null }, { status });
}

/** The API's answer for one call, and the record of what it created. `creates`
 *  is what proves a resumed run creates nothing twice: it is appended to only
 *  by a POST that really made something. */
async function api(url: URL, request: Request): Promise<Response> {
  const path = `${url.pathname.replace('/client/v4', '')}${url.search}`;
  const armed = held.refuseOnce;

  if (armed !== null && path.startsWith(armed.path)) {
    held.refuseOnce = null;

    return refusal(armed.status, armed.code, armed.message);
  }

  const body = request.method === 'GET' || request.body === null
    ? {}
    : v.parse(v.record(v.string(), v.unknown()), await request.json());

  const named = (key: string): string => String(body[key] ?? '');

  if (path.startsWith('/accounts?')) return envelope([{ id: ACCOUNT_ID, name: 'Probe Account' }]);

  if (path.startsWith('/zones?')) return envelope([]);

  if (path === `/accounts/${ACCOUNT_ID}`) return envelope({ id: ACCOUNT_ID, name: 'Probe Account' });

  if (path.endsWith('/storage/kv/namespaces?per_page=100')) {
    return envelope(held.namespaces.map((title) => ({ id: `id-${title}`, title })));
  }

  if (path.endsWith('/storage/kv/namespaces')) {
    held.namespaces.push(named('title'));
    held.creates.push(`kv:${named('title')}`);

    return envelope({ id: `id-${named('title')}` });
  }

  if (path.endsWith('/r2/buckets?per_page=100')) {
    return envelope({ buckets: held.buckets.map((name) => ({ name })) });
  }

  if (path.endsWith('/r2/buckets')) {
    held.buckets.push(named('name'));
    held.creates.push(`r2:${named('name')}`);

    return envelope({ name: named('name') });
  }

  if (path.endsWith('/vectorize/v2/indexes') && request.method === 'GET') {
    return envelope(held.indexes.map((name) => ({ name })));
  }

  if (path.endsWith('/vectorize/v2/indexes')) {
    held.indexes.push(named('name'));
    held.creates.push(`vectorize:${named('name')}`);

    return envelope({ name: named('name') });
  }

  if (path.includes('/ai-gateway/gateways?')) return envelope(held.gateways.map((id) => ({ id })));

  if (path.endsWith('/ai-gateway/gateways')) {
    held.gateways.push(named('id'));
    held.creates.push(`gateway:${named('id')}`);

    return envelope({ id: named('id') });
  }

  if (path.endsWith('/access/apps') && request.method === 'GET') {
    return envelope(held.apps.map((domain) => ({ id: `app-${domain}`, domain })));
  }

  if (path.endsWith('/access/apps')) {
    held.apps.push(named('domain'));
    held.creates.push(`access:${named('domain')}`);

    return envelope({ id: `app-${named('domain')}` });
  }

  if (path.includes('/access/apps/') && path.endsWith('/policies')) return envelope({ id: 'policy-1' });

  if (path.endsWith('/workers/subdomain')) return envelope({ subdomain: SUBDOMAIN });

  if (path.endsWith('/subdomain')) return envelope({ enabled: true });

  if (path.endsWith('/deployments')) {
    // What the pointer now serves. A row asserting "the deployment moved" reads
    // this, and `/api/health` below answers the release it names.
    const versions = v.parse(
      v.object({ versions: v.array(v.object({ version_id: v.string() })) }),
      body,
    ).versions;

    for (const named of versions) held.deployments.push(named.version_id);

    return envelope({ id: `deployment-${String(held.deployments.length)}` });
  }

  if (path.endsWith('/secrets')) {
    held.secrets.set(named('name'), named('text'));

    return envelope({ name: named('name') });
  }

  if (path.endsWith('/settings')) {
    return held.scriptExists
      ? envelope({ logpush: false })
      : refusal(404, 10_007, 'workers.api.error.script_not_found');
  }

  if (path.endsWith('/assets-upload-session')) {
    // One batch holding every asset hash: the upload step reads the batches
    // back and asks the artifact for exactly the files named here.
    const wanted = Object.entries(FILES)
      .filter(([name]) => name.startsWith('client/'))
      .map(([, body]) => sha256(body).slice(0, 32));

    return envelope({ jwt: 'session-token', buckets: [wanted] });
  }

  throw new Error(`the deploy fake has no answer for ${request.method} ${path}`);
}

/** The multipart legs: the asset batch and the version upload. The version
 *  upload is counted, because "the run uploaded twice" is the failure a
 *  resumed run must not have. */
async function multipart(url: URL, request: Request): Promise<Response> {
  const path = url.pathname.replace('/client/v4', '');
  const armed = held.refuseOnce;

  if (armed !== null && path.startsWith(armed.path)) {
    held.refuseOnce = null;

    return refusal(armed.status, armed.code, armed.message);
  }

  await request.arrayBuffer();

  if (path.includes('/workers/assets/upload')) {
    return envelope({ jwt: 'completion-token' }, 201);
  }

  held.scriptExists = true;
  held.uploads += 1;
  held.creates.push('version');
  const id = `version-${String(held.uploads)}`;

  held.versions.set(id, held.published.version);

  return envelope({ id });
}

/**
 * The authorization server's token endpoint, for both grants.
 *
 * The refresh grant is what a self-update spends: it presents no verifier
 * (there is no person at a browser) and it must present the pair's own refresh
 * token. The pair it answers with is ROTATED, so a deployment that re-bound the
 * token it already had rather than the new one is a failure here.
 */
async function token(request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const grant = form.get('grant_type');

  if (grant !== 'authorization_code' && grant !== 'refresh_token') {
    return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
  }

  if (form.get('client_id') !== DEPLOY_FAKE_CLIENT_ID) {
    return Response.json({ error: 'invalid_client' }, { status: 401 });
  }

  if (grant === 'refresh_token') {
    // The seed pair's token, or one this server already rotated to: a
    // deployment that spent a grant and failed mid-update presents the rotated
    // one on its next attempt, and a server that refused it would make the
    // retry path untestable rather than safe.
    const spendable = [DEPLOY_FAKE_REFRESH_TOKEN, DEPLOY_FAKE_ROTATED_REFRESH];

    if (!spendable.includes(form.get('refresh_token') ?? '')) {
      return Response.json({ error: 'invalid_grant', error_description: 'that refresh token is not one this server issued' }, { status: 400 });
    }

    return Response.json({
      access_token: DEPLOY_FAKE_ACCESS_TOKEN,
      refresh_token: DEPLOY_FAKE_ROTATED_REFRESH,
      expires_in: 3600,
      token_type: 'bearer',
    });
  }

  // PKCE, checked rather than assumed: a public client with no verifier is the
  // shape this whole leg exists to refuse.
  if ((form.get('code_verifier') ?? '').length < 43) {
    return Response.json({ error: 'invalid_grant', error_description: 'the code_verifier is missing or too short' }, { status: 400 });
  }

  if (form.get('code') !== 'probe-code') {
    return Response.json({ error: 'invalid_grant', error_description: 'that authorization code is not one this server issued' }, { status: 400 });
  }

  return Response.json({
    access_token: DEPLOY_FAKE_ACCESS_TOKEN,
    refresh_token: DEPLOY_FAKE_REFRESH_TOKEN,
    expires_in: 3600,
    token_type: 'bearer',
  });
}

async function control(url: URL, request: Request): Promise<Response> {
  if (url.pathname === '/reset') reset();

  if (url.pathname === '/refuse') held.refuseOnce = v.parse(RefusalSchema, await request.json());

  if (url.pathname === '/serve') held.served = v.parse(ServedBuildSchema, await request.json());

  if (url.pathname === '/publish') held.published = v.parse(ServedBuildSchema, await request.json());

  if (!CONTROL_PATHS.includes(url.pathname)) {
    throw new Error(`the deploy fake has no control surface at ${url.pathname}`);
  }

  // Every control call answers the same shape — what this plane has created so
  // far — so the caller parses one schema and a reset is observable in its own
  // answer.
  return Response.json(snapshot());
}

/**
 * The deployment's own static assets, as `env.ASSETS` on the probe Worker.
 *
 * One file is served: the build stamp `readBuildStamp` reads, which is how a
 * deployment says what version it is running. A stamp nothing set is absent,
 * which is the state of a Worker whose asset bundle is incomplete.
 *
 * The path is spelled here rather than imported from `CLI_VERSION_PATH`
 * (`packages/core/src/http/deployed-assets.ts`), because this module is loaded
 * by `vitest.config.ts` under raw Node, where core's extensionless imports do
 * not resolve. A rename there is not silent: any other path throws below, so
 * the rows read "the deploy probe's assets hold no …" instead of passing.
 */
const STAMP_PATH = '/downloads/kinu-version.json';

export function assetsOutbound(request: Request): Response {
  const url = new URL(request.url);

  if (url.pathname !== STAMP_PATH) {
    throw new Error(`the deploy probe's assets hold no ${url.pathname}`);
  }

  if (held.served === null) return new Response('no build stamp', { status: 404 });

  return Response.json(held.served);
}

export async function deployOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.host === 'deploy-control.invalid') return control(url, request);

  if (url.host === 'dash.cloudflare.com' && url.pathname === '/oauth2/token') return token(request);

  if (url.host === 'api.cloudflare.com') {
    return request.headers.get('content-type')?.includes('multipart/form-data') === true
      ? multipart(url, request)
      : api(url, request);
  }

  if (url.origin === DEPLOY_FAKE_CHANNEL) {
    const published = release();
    const artifact = `/downloads/kinu-worker-${held.published.version}.tar.gz`;

    if (url.pathname === '/downloads/release.json') {
      return new Response(published.text, { headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname === artifact) {
      return new Response(published.archive, { headers: { 'content-type': 'application/gzip' } });
    }

    if (url.pathname === `${artifact}.sha256`) {
      return new Response(`${published.digest}  kinu-worker-${held.published.version}.tar.gz\n`);
    }
  }

  // The deployment's own smoke check, answered as the new Worker would: the
  // release the LAST deployment pointer named, which is what makes an
  // unchecked pointer move visible to a smoke step that compares versions.
  if (url.pathname === '/api/health' && url.host.endsWith('.workers.dev')) {
    const armed = held.refuseOnce;

    if (armed !== null && armed.path === '/api/health') {
      held.refuseOnce = null;

      return new Response('the new Worker is not answering yet', { status: armed.status });
    }

    const pointed = held.deployments.at(-1) ?? '';
    const serving = held.versions.get(pointed);

    if (serving === undefined) return Response.json(DEPLOY_FAKE_OLDER_BUILD);
    const build = serving === held.published.version ? held.published : DEPLOY_FAKE_OLDER_BUILD;

    return Response.json(build);
  }

  throw new Error(`the deploy probe reached an unnamed network: ${request.method} ${request.url}`);
}
