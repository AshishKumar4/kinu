/**
 * Node-side plane for the deploy probe (Cloudflare API, OAuth server, release channel) over HTTP, installed as the probe's
 * `outboundService`: the DO builds its own transport and fetches/verifies the artifact, which a port fake would not exercise.
 * Unmatched host or path throws: a run that reached an unnamed network is a finding, not a pass.
 */
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import * as v from 'valibot';
import type { JsonValue } from '@kinu.run/core';

const ACCOUNT_ID = '0'.repeat(32);

const VERSION = '0.4.0+probe01';

/** Runs settle on `<instance>.<subdomain>.workers.dev`. */
const SUBDOMAIN = 'probe';

export const DEPLOY_FAKE_ACCOUNT = ACCOUNT_ID;

export const DEPLOY_FAKE_VERSION = VERSION;

export const DEPLOY_FAKE_SUBDOMAIN = SUBDOMAIN;

export const DEPLOY_FAKE_CHANNEL = 'https://channel.invalid';

export const DEPLOY_FAKE_CLIENT_ID = 'probe-deploy-client';

export const DEPLOY_FAKE_ACCESS_TOKEN = 'probe-access-token';

export const DEPLOY_FAKE_REFRESH_TOKEN = 'probe-refresh-token';

/** The REFRESH-grant pair; distinct so the update must write back the rotated token. */
export const DEPLOY_FAKE_ROTATED_REFRESH = 'probe-refresh-token-2';

/** Distinct from the first token so a run still presenting the expired one is visible (see `expireGrant`). */
export const DEPLOY_FAKE_REFRESHED_ACCESS_TOKEN = 'probe-access-token-2';

/** The only session the probe deployment's Updates surface answers. */
export const DEPLOY_FAKE_OWNER = 'owner@example.com';

/** A build behind the channel's: the probe deployment's own stamp and record version. */
export const DEPLOY_FAKE_OLDER_BUILD = {
  version: '0.3.9+probe00',
  sha: 'probe00',
  builtAt: '2026-09-01T00:00:00.000Z',
};

export const DEPLOY_FAKE_CHANNEL_BUILD = {
  version: VERSION,
  sha: 'probe01',
  builtAt: '2026-09-18T00:00:00.000Z',
};

/** A binding of the probe worker (`vitest.config.ts`), held here so the test reads the constant it is bound with. */
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

/**
 * A release the size of a published one. Measured 2026-09-18 from `packages/cf-backend/dist`:
 * 120 modules of 29.19 MiB and 421 assets of 78.01 MiB, the largest 21.55 MiB.
 */
export interface DeployFakeWeight {
  readonly modules: number;
  readonly moduleBytes: number;
  readonly assets: number;
  readonly assetBytes: number;
  readonly largestAsset: number;
}

const WeighSchema: v.GenericSchema<DeployFakeWeight> = v.object({
  modules: v.number(),
  moduleBytes: v.number(),
  assets: v.number(),
  assetBytes: v.number(),
  largestAsset: v.number(),
});

/** Half of every 64 KiB is random hex, half a repeated block, so it gzips near the real 0.25 ratio (27.35 MiB of 107.99 MiB, 2026-09-18).
 *  A one-character body would gzip to nothing and measure a download nobody has. */
const BLOCK_CHARS = 32 * 1024;

const FILLER = 'k'.repeat(BLOCK_CHARS);

function releaseBody(size: number): string {
  const pieces: string[] = [];

  for (let made = 0; made < size;) {
    const random = Math.min(BLOCK_CHARS, size - made);

    pieces.push(randomBytes(Math.ceil(random / 2)).toString('hex').slice(0, random));
    made += random;

    if (made >= size) break;

    const flat = Math.min(BLOCK_CHARS, size - made);

    pieces.push(FILLER.slice(0, flat));
    made += flat;
  }

  return pieces.join('');
}

type ReleaseEntry = readonly [path: string, body: string];

/** Made once per weight: a fresh body would hash differently from the downloaded release. */
const weighed = new Map<string, readonly ReleaseEntry[]>();

function files(): readonly ReleaseEntry[] {
  const asked = held.weigh;

  if (asked === null) return Object.entries(FILES);

  const key = JSON.stringify(asked);
  const made = weighed.get(key);

  if (made !== undefined) return made;

  const built: ReleaseEntry[] = Object.entries(FILES);
  const each = Math.floor(asked.moduleBytes / Math.max(asked.modules, 1));
  const rest = Math.floor(Math.max(asked.assetBytes - asked.largestAsset, 0) / Math.max(asked.assets - 1, 1));

  for (let index = 0; index < asked.modules; index += 1) {
    built.push([`worker/chunk-${String(index)}.js`, releaseBody(each)]);
  }

  built.push(['client/_assets/heavy.json', releaseBody(asked.largestAsset)]);

  for (let index = 0; index + 1 < asked.assets; index += 1) {
    built.push([`client/_assets/piece-${String(index)}.js`, releaseBody(rest)]);
  }

  weighed.set(key, built);

  return built;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** ustar member: 512-byte header with octal size and checksum, body padded to a block; what `core/src/deploy/artifact.ts` accepts. */
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
      modules: files().filter(([path]) => path.startsWith('worker/')).map(([path]) => path.slice('worker/'.length)),
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
    files: files().map(([path, body]) => ({
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
  /** What the archive unpacks to, not the object's peak (`FACT_UPLOAD_PEAK`); kept so a row can compare the two. */
  readonly unpacked: number;
  /** The bound the peak should respect instead of the whole release. */
  readonly largestMember: number;
}

/** Built per version and cached (keyed by weight too) because a row publishing a second build asks for both again. */
const releases = new Map<string, Release>();

function release(): Release {
  const key = `${held.published.version}:${JSON.stringify(held.weigh)}`;
  const built = releases.get(key);

  if (built !== undefined) return built;
  const text = manifestText(held.published);
  const carried = files();

  // Assets before modules, as `scripts/build-worker-release.ts` writes them: a single-pass installer holds modules to the end.
  const ordered = [
    ...carried.filter(([path]) => !path.startsWith('worker/')),
    ...carried.filter(([path]) => path.startsWith('worker/')),
  ];

  const members = [
    tarMember('release.json', text),
    ...ordered.map(([path, body]) => tarMember(path, body)),
  ];

  const tar = Buffer.concat([...members, Buffer.alloc(1024)]);
  const archive = gzipSync(tar);

  const made: Release = {
    text,
    archive,
    digest: sha256(archive),
    unpacked: tar.length,
    largestMember: Math.max(...carried.map(([, body]) => Buffer.byteLength(body))),
  };

  releases.set(key, made);

  return made;
}

/**
 * What one release cost the DO, measured from this plane. The isolate offers no memory reading (measured 2026-09-18 on
 * `@cloudflare/workerd-linux-64`: `measureUserAgentSpecificMemory` undefined, `memoryUsage()` zeroes); held bytes live on `FACT_UPLOAD_PEAK`.
 */
export interface DeployFakeFootprint {
  readonly served: number;
  readonly unpacked: number;
  readonly largestMember: number;
  readonly assetBody: number;
  readonly assetBatches: number;
  readonly versionBody: number;
}

export interface DeployFakeRefusal {
  readonly path: string;
  readonly status: number;
  readonly code: number;
  readonly message: string;
}

export const DeployFakeStateSchema = v.object({
  servingRelease: v.string(),
  liveRefresh: v.string(),
  namespaces: v.array(v.string()),
  buckets: v.array(v.string()),
  indexes: v.array(v.string()),
  gateways: v.array(v.string()),
  apps: v.array(v.string()),
  secrets: v.record(v.string(), v.string()),
  uploads: v.number(),
  creates: v.array(v.string()),
  refreshes: v.number(),
  expiredCalls: v.number(),
  footprint: v.object({
    served: v.number(),
    unpacked: v.number(),
    largestMember: v.number(),
    assetBody: v.number(),
    assetBatches: v.number(),
    versionBody: v.number(),
  }),
});

export interface DeployFakeState {
  /** The release the version taking the largest share carries: what a request
   *  that names no version override is answered by. Empty when nothing serves. */
  readonly servingRelease: string;
  /** The one refresh token the authorization server still honours. */
  readonly liveRefresh: string;
  readonly namespaces: readonly string[];
  readonly buckets: readonly string[];
  readonly indexes: readonly string[];
  readonly gateways: readonly string[];
  readonly apps: readonly string[];
  /** Values are this plane's fakes: they prove the handover wrote the token and record it was meant to. */
  readonly secrets: Readonly<Record<string, string>>;
  readonly uploads: number;
  readonly creates: readonly string[];
  /** A run whose access token expired mid-plan shows 1 here. */
  readonly refreshes: number;
  /** Calls presenting an already-expired token, each answered 401 as Cloudflare does. */
  readonly expiredCalls: number;
  /** Bytes really served and received for one release (footprint row in `deploy-ledger.test.ts`). */
  readonly footprint: DeployFakeFootprint;
}

/** Served as `kinu-version.json`, which `readBuildStamp` reads and the Updates surface compares to the channel. */
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

/** One entry of a deployment, as the Workers API carries it. */
const DeployedVersionsSchema = v.array(v.object({ version_id: v.string(), percentage: v.number() }));

type DeployedVersion = v.InferOutput<typeof DeployedVersionsSchema>[number];

interface Held {
  published: DeployFakeServedBuild;
  /** Every deployment, oldest first; the last one serves. An update that
   *  uploaded and never moved the traffic leaves the old version serving. */
  deployments: DeployedVersion[][];
  /** Which build each version id carries, in upload order, so `/api/health`
   *  can answer what the Worker actually serves. */
  versions: Map<string, DeployFakeServedBuild>;
  /** Rotated on every refresh grant: the token presented is spent. */
  liveRefresh: string;
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
  /** Null serves the four small files. */
  weigh: DeployFakeWeight | null;
  /** Lifetime of the next auth-code grant; once issued, its access token is answered 401 until the run refreshes.
   *  `null`: the ordinary hour, no strictness. */
  shortGrant: number | null;
  refreshes: number;
  expiredCalls: number;
  /** A call held after doing its work: the window where a DO dies having written without learning it.
   *  Released by the arming row, never by a duration. */
  stallOnce: ArmedStall | null;
  /** The completion token is answered once the arrived hashes cover the wanted ones. */
  assetsWanted: Set<string>;
  assetsUploaded: Set<string>;
  footprint: {
    served: number; unpacked: number; largestMember: number;
    assetBody: number; assetBatches: number; versionBody: number;
  };
}

const held: Held = fresh();

function fresh(): Held {
  return {
    published: DEPLOY_FAKE_CHANNEL_BUILD,
    deployments: [],
    versions: new Map<string, DeployFakeServedBuild>(),
    liveRefresh: DEPLOY_FAKE_REFRESH_TOKEN,
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
    weigh: null,
    shortGrant: null,
    refreshes: 0,
    expiredCalls: 0,
    stallOnce: null,
    assetsWanted: new Set<string>(),
    assetsUploaded: new Set<string>(),
    footprint: { served: 0, unpacked: 0, largestMember: 0, assetBody: 0, assetBatches: 0, versionBody: 0 },
  };
}

function reset(): void {
  const empty = fresh();

  held.published = empty.published;
  held.deployments = [];
  held.versions = new Map<string, DeployFakeServedBuild>();
  held.liveRefresh = empty.liveRefresh;
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
  held.weigh = null;
  held.shortGrant = null;
  held.refreshes = 0;
  held.expiredCalls = 0;
  // Answer a hold the previous row left open: an unresolved promise would keep that activation's fetch alive into the next row.
  held.stallOnce?.answer();
  held.stallOnce = null;
  held.assetsWanted = new Set<string>();
  held.assetsUploaded = new Set<string>();
  held.footprint = { served: 0, unpacked: 0, largestMember: 0, assetBody: 0, assetBatches: 0, versionBody: 0 };
}

function snapshot(): DeployFakeState {
  return {
    servingRelease: held.versions.get(servingVersion())?.version ?? '',
    liveRefresh: held.liveRefresh,
    namespaces: [...held.namespaces],
    buckets: [...held.buckets],
    indexes: [...held.indexes],
    gateways: [...held.gateways],
    apps: [...held.apps],
    secrets: Object.fromEntries(held.secrets),
    uploads: held.uploads,
    creates: [...held.creates],
    refreshes: held.refreshes,
    expiredCalls: held.expiredCalls,
    footprint: { ...held.footprint },
  };
}

/** The version a request that names no override reaches: the largest share of the live deployment. */
function servingVersion(): string {
  const live = held.deployments.at(-1) ?? [];

  return live.reduce((best, entry) => (entry.percentage > best.percentage ? entry : best), { version_id: '', percentage: -1 })
    .version_id;
}

/** The version a request reaches: the one its override names when that one is in the live
 *  deployment (Cloudflare's version-overrides doc), and otherwise the serving one. */
function answeringVersion(request: Request): string {
  const named = /^kinu="(.+)"$/u.exec(request.headers.get('cloudflare-workers-version-overrides') ?? '')?.[1];

  return (held.deployments.at(-1) ?? []).find((entry) => entry.version_id === named)?.version_id ?? servingVersion();
}

const RefusalSchema = v.object({
  path: v.string(),
  status: v.number(),
  code: v.number(),
  message: v.string(),
});

/** Method included because a step looks before it creates and only the write is worth holding. No duration: the window is a signal, not a race. */
export interface DeployFakeStall {
  readonly method: string;
  readonly path: string;
}

const StallSchema = v.object({ method: v.string(), path: v.string() });

/** Deferreds, not events, so a row asking after the call arrived is answered instead of waiting for a second one. */
interface ArmedStall {
  readonly match: DeployFakeStall;
  /** The hold is one call; the arming outlives it so the row can still ask and release. */
  taken: boolean;
  readonly reached: Promise<void>;
  readonly enter: () => void;
  readonly released: Promise<void>;
  readonly answer: () => void;
}

function armStall(match: DeployFakeStall): ArmedStall {
  const entered = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<void>();

  return {
    match,
    taken: false,
    reached: entered.promise,
    enter: entered.resolve,
    released: answered.promise,
    answer: answered.resolve,
  };
}

const ExpireSchema = v.object({ expiresIn: v.number() });

/** Anything else is a caller's typo and is refused. */
const CONTROL_PATHS: readonly string[] = [
  '/reset', '/refuse', '/serve', '/publish', '/state', '/stall', '/stall/reached',
  '/stall/release', '/weigh', '/expire', '/existing',
];

function envelope(result: JsonValue, status = 200): Response {
  return Response.json({ success: true, errors: [], result }, { status });
}

function refusal(status: number, code: number, message: string): Response {
  return Response.json({ success: false, errors: [{ code, message }], result: null }, { status });
}

function bearerOf(request: Request): string {
  const authorization = request.headers.get('authorization') ?? '';

  return /^bearer /iu.test(authorization) ? authorization.slice('bearer '.length).trim() : '';
}

/**
 * Entered after the matched call has done its work: the row aborts the object, then releases, and the redelivered alarm
 * must look before it creates. A duration-bounded hold would race the machine.
 */
async function stalled(method: string, path: string, answer: Response): Promise<Response> {
  const armed = held.stallOnce;

  if (armed === null || armed.taken) return answer;

  if (method !== armed.match.method || !path.startsWith(armed.match.path)) return answer;
  armed.taken = true;
  armed.enter();
  await armed.released;

  return answer;
}

/** `creates` is appended only by a POST that really made something: proof a resumed run creates nothing twice. */
async function api(url: URL, request: Request): Promise<Response> {
  const path = `${url.pathname.replace('/client/v4', '')}${url.search}`;
  const armed = held.refuseOnce;

  if (armed !== null && path.startsWith(armed.path)) {
    held.refuseOnce = null;

    return refusal(armed.status, armed.code, armed.message);
  }

  // Expired token answered as Cloudflare does: the run renews it or every later step fails.
  if (held.shortGrant !== null && bearerOf(request) === DEPLOY_FAKE_ACCESS_TOKEN) {
    held.expiredCalls += 1;

    return refusal(401, 10_000, 'Authentication error');
  }

  const body = request.method === 'GET' || request.body === null
    ? {}
    : v.parse(v.record(v.string(), v.unknown()), await request.json());

  const named = (key: string): string => v.parse(v.string(), body[key] ?? '');

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

  const scripted = workerScriptApi(path, request, named, () => v.parse(DeployedVersionsSchema, body.versions));

  if (scripted !== undefined) return scripted;

  throw new Error(`the deploy fake has no answer for ${request.method} ${path}`);
}

/** The Worker script's own routes: versions deployed, secrets, settings and the asset session. */
function workerScriptApi(
  path: string, request: Request, named: (key: string) => string,
  deployed: () => v.InferOutput<typeof DeployedVersionsSchema>,
): Response | undefined {
  if (path.endsWith('/deployments') && request.method === 'GET') {
    // Newest first: the reference lists the deployment serving traffic first.
    return envelope({ deployments: [...held.deployments].reverse().map((versions) => ({ versions: versions.map((entry) => ({ ...entry })) })) });
  }

  if (path.endsWith('/deployments')) {
    const versions = deployed();
    const unknown = versions.find((entry) => !held.versions.has(entry.version_id));

    // The reference types `version_id` as the id of a version the Worker holds.
    if (unknown !== undefined) return refusal(400, 10_000, `no version ${unknown.version_id}`);
    held.deployments.push(versions);

    return envelope({ id: `deployment-${String(held.deployments.length)}` });
  }

  if (path.endsWith('/secrets')) {
    const latest = [...held.versions.keys()].at(-1);
    const live = held.deployments.at(-1) ?? [];

    // A secret edit deploys a copy of the latest version, so it is refused while
    // that version is not the one deployment serving all traffic (code 10215 in
    // wrangler 4.129.0's `secret put`; cloudflare/workers-sdk#10585).
    if (latest !== undefined && !(live.length === 1 && live[0]?.version_id === latest)) {
      return refusal(400, 10_215, 'Secret edit failed. The latest version of your Worker isn\'t currently deployed.');
    }

    held.secrets.set(named('name'), named('text'));

    return envelope({ name: named('name') });
  }

  if (path.endsWith('/settings')) {
    return held.scriptExists
      ? envelope({ logpush: false })
      : refusal(404, 10_007, 'workers.api.error.script_not_found');
  }

  if (path.endsWith('/assets-upload-session')) {
    // One bucket (Cloudflare's advised shape); completion is answered once every manifest file has arrived, however batched.
    const wanted = files()
      .filter(([name]) => name.startsWith('client/'))
      .map(([, content]) => sha256(content).slice(0, 32));

    held.assetsWanted = new Set(wanted);
    held.assetsUploaded = new Set<string>();

    return envelope({ jwt: 'session-token', buckets: [wanted] });
  }

  return undefined;
}

/** Version uploads are counted: "the run uploaded twice" is the failure a resumed run must not have. */
async function multipart(url: URL, request: Request): Promise<Response> {
  const path = url.pathname.replace('/client/v4', '');
  const armed = held.refuseOnce;

  if (armed !== null && path.startsWith(armed.path)) {
    held.refuseOnce = null;

    return refusal(armed.status, armed.code, armed.message);
  }

  const raw = await request.arrayBuffer();
  const sent = raw.byteLength;

  if (path.includes('/workers/assets/upload')) {
    const form = await new Response(raw, {
      headers: { 'content-type': request.headers.get('content-type') ?? '' },
    }).formData();

    for (const name of form.keys()) held.assetsUploaded.add(name);

    held.footprint.assetBody = Math.max(held.footprint.assetBody, sent);
    held.footprint.assetBatches += 1;

    const missing = [...held.assetsWanted].filter((hash) => !held.assetsUploaded.has(hash));

    return missing.length === 0
      ? envelope({ jwt: 'completion-token' }, 201)
      : envelope({ uploaded: held.assetsUploaded.size }, 202);
  }

  held.footprint.versionBody = Math.max(held.footprint.versionBody, sent);
  held.scriptExists = true;
  held.uploads += 1;
  held.creates.push('version');
  const id = `version-${String(held.uploads)}`;

  held.versions.set(id, held.published);

  if (request.method === 'POST') return envelope({ id });

  // A script upload deploys what it carried at once and answers with the
  // script, whose id is its name (the reference's `Upload Worker Module`).
  held.deployments.push([{ version_id: id, percentage: 100 }]);

  return envelope({ id: path.split('/').at(-1) ?? '' });
}

/**
 * Token endpoint for both grants. The refresh grant (a self-update) presents no verifier and gets a rotated pair,
 * so a deployment that re-binds its old token fails here.
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
    // Rotated on every grant: the token presented is spent, so a deployment
    // that lost the one it was handed cannot update again.
    if (form.get('refresh_token') !== held.liveRefresh) {
      return Response.json({ error: 'invalid_grant', error_description: 'that refresh token is spent or was never issued' }, { status: 400 });
    }

    held.refreshes += 1;
    held.liveRefresh = `probe-refresh-token-${String(held.refreshes + 1)}`;

    return Response.json({
      // A different access token, so calls still carrying the expired one are visible.
      access_token: DEPLOY_FAKE_REFRESHED_ACCESS_TOKEN,
      refresh_token: held.liveRefresh,
      expires_in: 3600,
      token_type: 'bearer',
    });
  }

  // PKCE checked, not assumed: a public client with no verifier is what this leg refuses.
  if ((form.get('code_verifier') ?? '').length < 43) {
    return Response.json({ error: 'invalid_grant', error_description: 'the code_verifier is missing or too short' }, { status: 400 });
  }

  if (form.get('code') !== 'probe-code') {
    return Response.json({ error: 'invalid_grant', error_description: 'that authorization code is not one this server issued' }, { status: 400 });
  }

  held.liveRefresh = DEPLOY_FAKE_REFRESH_TOKEN;

  return Response.json({
    access_token: DEPLOY_FAKE_ACCESS_TOKEN,
    refresh_token: DEPLOY_FAKE_REFRESH_TOKEN,
    // A lifetime already inside the renewal floor reaches expiry without waiting an hour.
    expires_in: held.shortGrant ?? 3600,
    token_type: 'bearer',
  });
}

async function control(url: URL, request: Request): Promise<Response> {
  if (url.pathname === '/reset') reset();

  if (url.pathname === '/refuse') held.refuseOnce = v.parse(RefusalSchema, await request.json());

  if (url.pathname === '/serve') held.served = v.parse(ServedBuildSchema, await request.json());

  if (url.pathname === '/publish') held.published = v.parse(ServedBuildSchema, await request.json());

  if (url.pathname === '/stall') held.stallOnce = armStall(v.parse(StallSchema, await request.json()));

  // Both halves are answered on the hold, not a clock; an unarmed plane answers both at once.
  if (url.pathname === '/stall/reached') await held.stallOnce?.reached;

  if (url.pathname === '/stall/release') held.stallOnce?.answer();

  if (url.pathname === '/weigh') held.weigh = v.parse(WeighSchema, await request.json());

  if (url.pathname === '/expire') held.shortGrant = v.parse(ExpireSchema, await request.json()).expiresIn;

  // What a self-update runs against: a Worker a previous run left serving the older build.
  if (url.pathname === '/existing') {
    held.scriptExists = true;
    held.versions.set('version-0', DEPLOY_FAKE_OLDER_BUILD);
    held.deployments.push([{ version_id: 'version-0', percentage: 100 }]);
  }

  if (!CONTROL_PATHS.includes(url.pathname)) {
    throw new Error(`the deploy fake has no control surface at ${url.pathname}`);
  }

  return Response.json(snapshot());
}

/**
 * `env.ASSETS`: serves only the build stamp `readBuildStamp` reads. Path spelled out rather than imported from `CLI_VERSION_PATH`
 * because this loads under raw Node, where core's extensionless imports fail; any other path throws.
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
    const path = url.pathname.replace('/client/v4', '');

    const answer = request.headers.get('content-type')?.includes('multipart/form-data') === true
      ? await multipart(url, request)
      : await api(url, request);

    return stalled(request.method, path, answer);
  }

  if (url.origin === DEPLOY_FAKE_CHANNEL) {
    const published = release();
    const artifact = `/downloads/kinu-worker-${held.published.version}.tar.gz`;

    if (url.pathname === '/downloads/release.json') {
      return new Response(published.text, { headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname === artifact) {
      held.footprint.served = published.archive.length;
      held.footprint.unpacked = published.unpacked;
      held.footprint.largestMember = published.largestMember;

      return new Response(published.archive, { headers: { 'content-type': 'application/gzip' } });
    }

    if (url.pathname === `${artifact}.sha256`) {
      return new Response(`${published.digest}  kinu-worker-${held.published.version}.tar.gz\n`);
    }
  }

  // The deployment's own smoke check, answered as the Worker would: by the
  // version the request's override names when that one is deployed, and by
  // the serving version otherwise.
  if (url.pathname === '/api/health' && url.host.endsWith('.workers.dev')) {
    const armed = held.refuseOnce;

    if (armed !== null && armed.path === '/api/health') {
      held.refuseOnce = null;

      return new Response('the new Worker is not answering yet', { status: armed.status });
    }

    const version = answeringVersion(request);
    const build = held.versions.get(version);

    if (build === undefined) return new Response('no Worker serves this address', { status: 404 });

    // The product's own body: the stamp under `build`, beside the version that
    // answered (core/src/http/health-route.ts).
    return Response.json({ ok: true, build, versionId: version });
  }

  throw new Error(`the deploy probe reached an unnamed network: ${request.method} ${request.url}`);
}
