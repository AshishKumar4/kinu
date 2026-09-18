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
import { createHash, randomBytes } from 'node:crypto';
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

/** The access token a REFRESH grant hands back. Distinct from the first one so
 *  this plane can tell a run that renewed an expiring token from one still
 *  presenting the dead one — see `expireGrant`. */
export const DEPLOY_FAKE_REFRESHED_ACCESS_TOKEN = 'probe-access-token-2';

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

/**
 * A release the size and shape of a published one.
 *
 * The four files above are bytes; a row that measures what one release costs
 * the installing object needs the real thing. Measured 2026-09-18 from
 * `packages/cf-backend/dist` (built 2026-09-16 in the primary checkout, maps
 * and `wrangler.json` excluded): 120 modules of 29.19 MiB and 421 assets of
 * 78.01 MiB, the largest of them 21.55 MiB.
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

/** Half of every 64 KiB is fresh random hex and half is a block the release
 *  repeats. Deflate's window is 32 KiB, so the repeated half all but vanishes
 *  and the random half halves: the artifact lands near the 0.25 ratio the
 *  real one has (27.35 MiB compressed, 107.99 MiB unpacked, 2026-09-18).
 *  A body of one repeated character would gzip to a thousandth of itself and
 *  the row would measure a download nobody has. */
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

/** One file of the release: its archive path and its bytes. */
type ReleaseEntry = readonly [path: string, body: string];

/** The release's files, at the weight a row asked for. Made once per weight:
 *  a fresh body would hash differently from the release the run already
 *  downloaded, and the upload would ask the artifact for a file it does not
 *  carry. */
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
  /** What the archive unpacks to. NOT what the object holds any more: the
   *  reader walks it a member at a time, and what the run held at its peak is
   *  the fact the upload step records (`FACT_UPLOAD_PEAK`). This is here so a
   *  row can hold that peak against the size of the release it installed. */
  readonly unpacked: number;
  /** The largest single member, which is what the peak is supposed to be
   *  bounded by instead of the release. */
  readonly largestMember: number;
}

/** The channel's two objects for one version: the manifest and the tarball that
 *  carries it plus every file it names. Built per version and kept, because a
 *  row that publishes a second build asks for both again — and keyed by the
 *  weight too, because a weighed release is a different artifact. */
const releases = new Map<string, Release>();

function release(): Release {
  const key = `${held.published.version}:${JSON.stringify(held.weigh)}`;
  const built = releases.get(key);

  if (built !== undefined) return built;
  const text = manifestText(held.published);
  const carried = files();

  // Assets before modules, the order `scripts/build-worker-release.ts` writes
  // them in: a single-pass installer holds the module set to the end, so the
  // archive puts it last.
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
 * What one release cost the Durable Object, measured by the plane it talked to
 * rather than computed from the code.
 *
 * `served` is the compressed artifact this channel handed over; `unpacked` is
 * what that archive expands to and `largestMember` is its biggest single
 * file; `assetBody` and `versionBody` are the largest multipart bodies the
 * object built and sent, and `assetBatches` is how many asset requests it
 * took. The isolate offers no memory reading at all (measured 2026-09-18 on
 * `@cloudflare/workerd-linux-64` through `vitest-pool-workers`:
 * `performance.measureUserAgentSpecificMemory` is undefined and
 * `process.memoryUsage()` answers zeroes), so these are the footprint that
 * can be measured from outside; what the object HELD is its own count, kept
 * on the upload step's ledger row (`FACT_UPLOAD_PEAK`).
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
  deployments: v.array(v.string()),
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
  /** How many REFRESH grants this authorization server issued. A guided run
   *  whose access token expired mid-plan shows up here as 1. */
  readonly refreshes: number;
  /** Calls that presented an access token this server had already expired.
   *  Every one of them was answered 401, the way Cloudflare answers. */
  readonly expiredCalls: number;
  /** What one release cost the object, in bytes this plane really served and
   *  really received (§ the footprint row in `deploy-ledger.test.ts`). */
  readonly footprint: DeployFakeFootprint;
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
  /** The shape of the release the channel serves, or null for the four small
   *  files. Set by a row that measures what a published release costs the
   *  object that installs it. */
  weigh: DeployFakeWeight | null;
  /** The lifetime the next authorization-code grant answers with, and — once
   *  it has been issued — the first access token is dead: every call bearing
   *  it is answered 401 until the run refreshes. `null` is the ordinary hour,
   *  and the strictness is off. */
  shortGrant: number | null;
  refreshes: number;
  expiredCalls: number;
  /** One call this plane HOLDS after doing its work: the window in which a
   *  Durable Object dies having written to somebody's account without learning
   *  that it did. Held until the row that armed it says so, never for a
   *  duration — the row is what observes the abort and then releases. */
  stallOnce: ArmedStall | null;
  /** Which asset hashes the open upload session still wants, and which have
   *  arrived: the completion token is answered when the second covers the
   *  first, the way the reference describes it. */
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
  held.weigh = null;
  held.shortGrant = null;
  held.refreshes = 0;
  held.expiredCalls = 0;
  // A hold the previous row left open is answered rather than dropped: the call
  // waiting on it belongs to an object that is gone, and a promise nobody
  // resolves would keep that activation's fetch alive into the next row.
  held.stallOnce?.answer();
  held.stallOnce = null;
  held.assetsWanted = new Set<string>();
  held.assetsUploaded = new Set<string>();
  held.footprint = { served: 0, unpacked: 0, largestMember: 0, assetBody: 0, assetBatches: 0, versionBody: 0 };
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
    refreshes: held.refreshes,
    expiredCalls: held.expiredCalls,
    footprint: { ...held.footprint },
  };
}

const RefusalSchema = v.object({
  path: v.string(),
  status: v.number(),
  code: v.number(),
  message: v.string(),
});

/** One call held open: the method and path it matches. The method is part of
 *  it because a step LOOKS before it creates, and the call worth holding is the
 *  one that wrote. No duration — the row that armed it decides when it is
 *  answered, so the window is a signal and not a race with the machine. */
export interface DeployFakeStall {
  readonly method: string;
  readonly path: string;
}

const StallSchema = v.object({ method: v.string(), path: v.string() });

/** An armed stall and its two signals: `reached` settles when the matched call
 *  has done its work and is being held, and `answer` is what the row calls to
 *  let that call return. Deferreds rather than events, so a row that asks after
 *  the call arrived is answered instead of waiting for a second one. */
interface ArmedStall {
  readonly match: DeployFakeStall;
  /** Whether the matched call has already been taken: the hold is one call,
   *  and the arming outlives it so the row can still ask and release. */
  taken: boolean;
  readonly reached: Promise<void>;
  readonly enter: () => void;
  readonly released: Promise<void>;
  readonly answer: () => void;
}

function armStall(match: DeployFakeStall): ArmedStall {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  return {
    match,
    taken: false,
    reached: entered.promise,
    enter: entered.resolve,
    released: release.promise,
    answer: release.resolve,
  };
}

const ExpireSchema = v.object({ expiresIn: v.number() });

/** The control surface, named once: anything else is a caller's typo and this
 *  plane refuses it rather than answering a state nobody asked to change. */
const CONTROL_PATHS: readonly string[] = [
  '/reset', '/refuse', '/serve', '/publish', '/state', '/stall', '/stall/reached',
  '/stall/release', '/weigh', '/expire',
];

function envelope(result: JsonValue, status = 200): Response {
  return Response.json({ success: true, errors: [], result }, { status });
}

function refusal(status: number, code: number, message: string): Response {
  return Response.json({ success: false, errors: [{ code, message }], result: null }, { status });
}

/** The bearer a call presented, or ''. */
function bearerOf(request: Request): string {
  const held = request.headers.get('authorization') ?? '';

  return /^bearer /iu.test(held) ? held.slice('bearer '.length).trim() : '';
}

/**
 * The armed hold, entered AFTER the call it matched has already done its work.
 *
 * The window a deployment cannot avoid: the account was written to and the
 * object has not learned it yet. The row that armed the hold is told when this
 * call reached it (`/stall/reached`), aborts the object, and then releases it;
 * what must happen next is that the redelivered alarm looks before it creates
 * rather than creating a second one. A hold bounded by a duration instead would
 * end on whichever of the two the machine got to first.
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

  // An access token this server has expired, answered the way Cloudflare
  // answers one: the run either renews it or fails every step from here.
  if (held.shortGrant !== null && bearerOf(request) === DEPLOY_FAKE_ACCESS_TOKEN) {
    held.expiredCalls += 1;

    return refusal(401, 10_000, 'Authentication error');
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
    // One bucket holding every asset hash, which is Cloudflare's own advice
    // shape ("how to optimally batch upload your files"). The installer is
    // free to send it in several requests, and this plane answers the
    // completion token the way the reference describes: once every file in
    // the manifest has arrived, not once a bucket has.
    const wanted = files()
      .filter(([name]) => name.startsWith('client/'))
      .map(([, body]) => sha256(body).slice(0, 32));

    held.assetsWanted = new Set(wanted);
    held.assetsUploaded = new Set<string>();

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

  // The body this object built and sent, measured: base64 of every asset in
  // the batch, in one multipart envelope. What the footprint row is about.
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

    held.refreshes += 1;

    return Response.json({
      // A DIFFERENT access token, so a call that still carries the expired one
      // is visible here as a call this server refuses.
      access_token: DEPLOY_FAKE_REFRESHED_ACCESS_TOKEN,
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
    // The lifetime a row asked for, when one did: a grant that is already
    // inside the run's renewal floor is how an expired authorization is
    // reached without waiting an hour for one.
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

  // The two halves of the hold, both answered on the hold itself rather than on
  // a clock: `reached` settles once the matched call has written and is being
  // held, and `release` lets it answer. An unarmed plane answers both at once —
  // a row that did not arm one is not waiting for one.
  if (url.pathname === '/stall/reached') await held.stallOnce?.reached;

  if (url.pathname === '/stall/release') held.stallOnce?.answer();

  if (url.pathname === '/weigh') held.weigh = v.parse(WeighSchema, await request.json());

  if (url.pathname === '/expire') held.shortGrant = v.parse(ExpireSchema, await request.json()).expiresIn;

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
