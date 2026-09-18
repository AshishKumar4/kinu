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

function manifestText(): string {
  return JSON.stringify({
    version: VERSION,
    sha: 'probe01',
    builtAt: '2026-09-18T00:00:00.000Z',
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

/** The channel's two objects, built once: the manifest and the tarball that
 *  carries it plus every file it names. */
const RELEASE = (() => {
  const text = manifestText();

  const members = [
    tarMember('release.json', text),
    ...Object.entries(FILES).map(([path, body]) => tarMember(path, body)),
  ];

  const tar = Buffer.concat([...members, Buffer.alloc(1024)]);
  const archive = gzipSync(tar);

  return { text, archive, digest: sha256(archive) };
})();

export interface DeployFakeRefusal {
  readonly path: string;
  readonly status: number;
  readonly code: number;
  readonly message: string;
}

export const DeployFakeStateSchema = v.object({
  namespaces: v.array(v.string()),
  buckets: v.array(v.string()),
  indexes: v.array(v.string()),
  gateways: v.array(v.string()),
  apps: v.array(v.string()),
  secretNames: v.array(v.string()),
  uploads: v.number(),
  creates: v.array(v.string()),
});

export interface DeployFakeState {
  readonly namespaces: readonly string[];
  readonly buckets: readonly string[];
  readonly indexes: readonly string[];
  readonly gateways: readonly string[];
  readonly apps: readonly string[];
  readonly secretNames: readonly string[];
  readonly uploads: number;
  readonly creates: readonly string[];
}

interface Held {
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
}

const held: Held = fresh();

function fresh(): Held {
  return {
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
  };
}

function reset(): void {
  const empty = fresh();

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
}

function snapshot(): DeployFakeState {
  return {
    namespaces: [...held.namespaces],
    buckets: [...held.buckets],
    indexes: [...held.indexes],
    gateways: [...held.gateways],
    apps: [...held.apps],
    secretNames: [...held.secrets.keys()],
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

  if (path.endsWith('/deployments')) return envelope({ id: 'deployment-1' });

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

  return envelope({ id: `version-${String(held.uploads)}` });
}

async function token(request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());

  if (form.get('grant_type') !== 'authorization_code') {
    return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
  }

  if (form.get('client_id') !== DEPLOY_FAKE_CLIENT_ID) {
    return Response.json({ error: 'invalid_client' }, { status: 401 });
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

  if (url.pathname !== '/reset' && url.pathname !== '/refuse' && url.pathname !== '/state') {
    throw new Error(`the deploy fake has no control surface at ${url.pathname}`);
  }

  // Every control call answers the same shape — what this plane has created so
  // far — so the caller parses one schema and a reset is observable in its own
  // answer.
  return Response.json(snapshot());
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
    if (url.pathname === '/downloads/release.json') {
      return new Response(RELEASE.text, { headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname === `/downloads/kinu-worker-${VERSION}.tar.gz`) {
      return new Response(RELEASE.archive, { headers: { 'content-type': 'application/gzip' } });
    }

    if (url.pathname === `/downloads/kinu-worker-${VERSION}.tar.gz.sha256`) {
      return new Response(`${RELEASE.digest}  kinu-worker-${VERSION}.tar.gz\n`);
    }
  }

  // The deployment's own smoke check, answered as the new Worker would.
  if (url.pathname === '/api/health' && url.host.endsWith('.workers.dev')) {
    return Response.json({ version: VERSION, sha: 'probe01', builtAt: '2026-09-18T00:00:00.000Z' });
  }

  throw new Error(`the deploy probe reached an unnamed network: ${request.method} ${request.url}`);
}
