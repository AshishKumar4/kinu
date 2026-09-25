/** The self-deploy flow against a fake Cloudflare (docs/SELF-DEPLOY.md): idempotent reruns, refusals, retries, eviction resume, no secret held at the end. */
import { beforeEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  ACCESS_TOKEN_KEY, DEPLOYMENT_RECORD_SECRET, DEPLOYMENT_REFRESH_SECRET, DEPLOY_CLIENT_ID_KEY,
  HeldBytes, LOCAL_PORT, LocalConfigSchema, MINTED_SECRETS, promptedSecrets,
  REFRESH_TOKEN_KEY, deployDoor, deployPlan, factsFrom, localLayout, parseReleaseManifest, releaseDir,
  renderLocalConfig, renderWorkerdConfig, runDeployPlan, unhostedBindings, workerdDirectories,
} from '../src/deploy/index';
import type {
  ArtifactMember, CloudflareCall, CloudflareHttpResponse, CloudflareTransport, DeployContext,
  DeployInputs,
  ArtifactSource, DeployLedger, DeployProgress, DeploySecretVault, DeployStepFailure, DeployStepRow,
  DeployStepSeed, HttpGet,
  MultipartUpload, ReleaseManifest, UpdateBuild,
} from '../src/deploy/index';
import { parseJsonObject, type JsonObject, type JsonValue } from '../src/utils/json';

const MANIFEST: ReleaseManifest = {
  version: '0.4.0+abc1234',
  sha: 'abc1234',
  builtAt: '2026-09-17T10:00:00.000Z',
  channelOrigin: 'https://kinu.run',
  worker: {
    name: 'kinu',
    mainModule: 'index.js',
    compatibilityDate: '2025-12-01',
    compatibilityFlags: ['nodejs_compat'],
    modules: ['index.js', 'chunk.js'],
    modulesPath: 'worker',
    assets: 'client',
    assetsBinding: 'ASSETS',
    crons: ['*/15 * * * *'],
  },
  bindings: [
    { binding: 'AUTH_KV', kind: 'kv', resource: 'kinu-auth-kv', required: true },
    { binding: 'BACKUP_BUCKET', kind: 'r2', resource: 'kinu-backups', required: false },
    { binding: 'MEMORY_VECTORS', kind: 'vectorize', resource: 'kinu-memory', required: false },
    { binding: 'OrchestratorAgent', kind: 'durable-object', resource: 'OrchestratorAgent', required: true },
    { binding: 'Sandbox', kind: 'durable-object', resource: 'KinuSandbox', required: false },
    { binding: 'AGENT_METRICS', kind: 'analytics-engine', resource: 'kinu_agent_metrics', required: false },
    { binding: 'AI', kind: 'ai', resource: '', required: false },
    { binding: 'BROWSER', kind: 'browser', resource: '', required: false },
    { binding: 'ASSETS', kind: 'assets', resource: '', required: true },
    { binding: 'LOADER', kind: 'worker-loader', resource: '', required: true },
  ],
  vectorIndexes: [{ name: 'kinu-memory', dimensions: 384, metric: 'cosine' }],
  migrations: [{ tag: 'v1', newSqliteClasses: ['OrchestratorAgent', 'KinuSandbox'] }],
  secrets: [
    { name: 'CREDENTIAL_ENCRYPTION_KEY', handling: 'prompted', required: true, prompt: '32 random bytes' },
    { name: 'WEBHOOK_ROUTE_SECRET', handling: 'prompted', required: true, prompt: '32 random bytes' },
    { name: 'JWT_SECRET', handling: 'prompted', required: true, prompt: '32 random bytes' },
    { name: 'ANALYTICS_SQL_API_TOKEN', handling: 'optional', required: false, prompt: 'an account analytics token' },
  ],
  vars: [
    { name: 'SANDBOX_TRANSPORT', policy: 'carried', value: 'rpc' },
    { name: 'CLI_PUBLIC_ORIGIN', policy: 'derived' },
    { name: 'DEV_USER_EMAIL', policy: 'ours' },
  ],
  files: [
    { path: 'worker/index.js', sha256: 'a'.repeat(64), size: 12, assetHash: null },
    { path: 'worker/chunk.js', sha256: 'b'.repeat(64), size: 8, assetHash: null },
    { path: 'client/index.html', sha256: 'c'.repeat(64), size: 5, assetHash: '1'.repeat(32) },
    { path: 'client/app.js', sha256: 'd'.repeat(64), size: 7, assetHash: '2'.repeat(32) },
  ],
  seed: null,
};

const INPUTS: DeployInputs = {
  accountId: '0'.repeat(32),
  instanceName: 'kinu',
  address: { kind: 'workers-dev', hostname: '', zoneId: '' },
  ownerEmail: 'owner@example.com',
  accessEmails: ['owner@example.com', 'second@example.com'],
  providerKeyNames: [],
  sandbox: false,
};

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: JsonObject | undefined;
  readonly bearer: string | undefined;
}

/** Remembers what it created, so a second run finds the first run's resources. */
function bodyText(body: JsonObject, key: string): string {
  return v.parse(v.nullish(v.string(), ''), body[key]);
}

/** One deployment as the Workers API carries it: which versions take what share of traffic. */
const DeployedVersionsSchema = v.array(v.object({ version_id: v.string(), percentage: v.number() }));

type DeployedVersions = v.InferOutput<typeof DeployedVersionsSchema>;

/** The prior version a Worker already serves when a run begins, and the build it answers with. */
const PRIOR_VERSION = 'version-0';

const PRIOR_BUILD: UpdateBuild = { version: '0.3.9+old0000', sha: 'old0000', builtAt: '2026-09-10T10:00:00.000Z' };

class FakeCloudflare implements CloudflareTransport {
  readonly calls: Recorded[] = [];

  readonly namespaces: string[] = [];

  readonly buckets: string[] = [];

  readonly indexes: string[] = [];

  readonly gateways: string[] = [];

  readonly apps: string[] = [];

  readonly objects: string[] = [];

  readonly secrets = new Map<string, string>();

  scriptExists = false;

  /** Every version id this account holds. */
  readonly versions: string[] = [];

  /** Oldest first; the last one is the deployment serving traffic. */
  readonly deployments: DeployedVersions[] = [];

  /** The new deployment has not reached the location that answers, so an override is not applied and
   *  the request goes to the serving version (Cloudflare's version-overrides doc). */
  overridesLag = false;

  private uploads = 0;

  refuseOnce: { method?: string; path: string; status: number; code: number; message: string } | null = null;

  /** A Worker a previous run left serving `version`. */
  serveExisting(version: string): void {
    this.scriptExists = true;
    this.versions.push(version);
    this.deployments.push([{ version_id: version, percentage: 100 }]);
  }

  /** The version a request that names no override reaches. */
  serving(): string {
    const live = this.deployments.at(-1) ?? [];

    return live.reduce((best, entry) => (entry.percentage > best.percentage ? entry : best), { version_id: '', percentage: -1 })
      .version_id;
  }

  /** The version a request with these headers reaches: the override's, when it is in the live deployment. */
  answering(headers: Readonly<Record<string, string>> | undefined): string {
    const override = new Headers(headers).get('cloudflare-workers-version-overrides') ?? '';
    const named = /^kinu="(.+)"$/u.exec(override)?.[1];
    const live = this.overridesLag ? [] : this.deployments.at(-1) ?? [];

    return live.find((entry) => entry.version_id === named)?.version_id ?? this.serving();
  }

  async request(call: CloudflareCall): Promise<CloudflareHttpResponse> {
    this.calls.push({ method: call.method, path: call.path, body: call.body, bearer: undefined });

    const refusal = this.refusalFor(call.method, call.path);

    if (refusal !== null) return refusal;

    // How the flow tells a first deployment from an update.
    if (call.path.endsWith('/settings') && !this.scriptExists) {
      return {
        status: 404,
        body: { success: false, errors: [{ code: 10007, message: 'workers.api.error.script_not_found' }], result: null },
      };
    }

    if (call.method === 'HEAD') {
      if (this.objects.includes(call.path)) return { status: 200, body: null };

      return {
        status: 404,
        body: { success: false, errors: [{ code: 10007, message: 'The specified key does not exist.' }], result: null },
      };
    }

    if (call.path.endsWith('/deployments')) return this.deploymentsCall(call);

    return { status: 200, body: { success: true, errors: [], result: this.answer(call) } };
  }

  async upload(upload: MultipartUpload): Promise<CloudflareHttpResponse> {
    const metadata = upload.parts.find((part) => part.name === 'metadata')?.body;

    this.calls.push({
      method: upload.method,
      path: upload.path,
      body: v.is(v.string(), metadata) ? parseJsonObject(metadata) : undefined,
      bearer: upload.bearer,
    });

    const refusal = this.refusalFor(upload.method, upload.path);

    if (refusal !== null) return refusal;

    if (upload.path.includes('/workers/assets/upload')) {
      return { status: 201, body: { success: true, errors: [], result: { jwt: 'completion-token' } } };
    }

    if (upload.path.includes('/r2/buckets/')) {
      this.objects.push(upload.path);

      return { status: 200, body: { success: true, errors: [], result: null } };
    }

    this.scriptExists = true;
    this.uploads += 1;
    const version = `version-${String(this.uploads)}`;

    this.versions.push(version);

    // A first upload deploys what it carried and answers with the script, whose id is its name.
    if (upload.method === 'PUT') {
      this.deployments.push([{ version_id: version, percentage: 100 }]);

      return { status: 200, body: { success: true, errors: [], result: { id: INPUTS.instanceName } } };
    }

    return { status: 200, body: { success: true, errors: [], result: { id: version } } };
  }

  private refusalFor(method: string, path: string): CloudflareHttpResponse | null {
    const refusal = this.refuseOnce;

    if (refusal === null || !path.startsWith(refusal.path) || (refusal.method ?? method) !== method) return null;
    this.refuseOnce = null;

    return {
      status: refusal.status,
      body: { success: false, errors: [{ code: refusal.code, message: refusal.message }], result: null },
    };
  }

  private deploymentsCall(call: CloudflareCall): CloudflareHttpResponse {
    if (call.method === 'GET') {
      // Newest first: the reference lists the deployment serving traffic first.
      const listed = [...this.deployments].reverse().map((versions) => ({ versions: versions.map((entry) => ({ ...entry })) }));

      return { status: 200, body: { success: true, errors: [], result: { deployments: listed } } };
    }

    const versions = v.parse(DeployedVersionsSchema, call.body?.versions);
    // The reference types `version_id` as the id of a version the Worker holds.
    const unknown = versions.find((entry) => !this.versions.includes(entry.version_id));

    if (unknown !== undefined) {
      return {
        status: 400,
        body: { success: false, errors: [{ code: 10_000, message: `no version ${unknown.version_id}` }], result: null },
      };
    }

    this.deployments.push(versions);

    return { status: 200, body: { success: true, errors: [], result: { id: `deployment-${String(this.deployments.length)}` } } };
  }

  private answer(call: CloudflareCall): JsonValue {
    const path = call.path;
    const body = call.body ?? {};

    if (path.endsWith('/storage/kv/namespaces?per_page=100')) {
      return this.namespaces.map((title) => ({ id: `id-${title}`, title }));
    }

    if (path.endsWith('/storage/kv/namespaces')) {
      const title = bodyText(body, 'title');

      this.namespaces.push(title);

      return { id: `id-${title}` };
    }

    if (path.endsWith('/r2/buckets?per_page=100')) return { buckets: this.buckets.map((name) => ({ name })) };

    if (path.endsWith('/r2/buckets')) {
      this.buckets.push(bodyText(body, 'name'));

      return { name: body.name ?? '' };
    }

    if (path.endsWith('/vectorize/v2/indexes') && call.method === 'GET') {
      return this.indexes.map((name) => ({ name }));
    }

    if (path.endsWith('/vectorize/v2/indexes')) {
      this.indexes.push(bodyText(body, 'name'));

      return { name: body.name ?? '' };
    }

    if (path.includes('/ai-gateway/gateways?')) return this.gateways.map((id) => ({ id }));

    if (path.endsWith('/ai-gateway/gateways')) {
      this.gateways.push(bodyText(body, 'id'));

      return { id: body.id ?? '' };
    }

    if (path.endsWith('/access/apps') && call.method === 'GET') {
      return this.apps.map((domain) => ({ id: `app-${domain}`, domain }));
    }

    if (path.endsWith('/access/apps')) {
      const domain = bodyText(body, 'domain');

      this.apps.push(domain);

      return { id: `app-${domain}` };
    }

    if (path.includes('/access/apps/') && path.endsWith('/policies')) return { id: 'policy-1' };

    if (path.endsWith('/workers/subdomain')) return { subdomain: 'acme' };

    if (path.endsWith('/subdomain')) return { enabled: true };

    if (path.endsWith('/secrets')) {
      this.secrets.set(bodyText(body, 'name'), bodyText(body, 'text'));

      return { name: body.name ?? '' };
    }

    if (path.endsWith('/settings')) {
      return this.scriptExists ? { logpush: false } : null;
    }

    if (path.endsWith('/assets-upload-session')) {
      return { jwt: 'session-token', buckets: [['1'.repeat(32), '2'.repeat(32)]] };
    }

    return { id: 'account-1', name: 'Acme' };
  }
}

class ArrayLedger implements DeployLedger {
  private held: DeployStepRow[] = [];

  async rows(): Promise<readonly DeployStepRow[]> {
    return this.held.map((row) => ({ ...row }));
  }

  async seed(steps: readonly DeployStepSeed[]): Promise<void> {
    for (const step of steps) {
      if (this.held.some((row) => row.id === step.id)) continue;
      this.held.push({
        id: step.id,
        seq: step.seq,
        title: step.title,
        state: 'pending',
        attempt: 0,
        detail: '',
        notes: [],
        failure: null,
        facts: {},
      });
    }
  }

  async started(id: string, attempt: number): Promise<void> {
    this.patch(id, { state: 'running', attempt, failure: null });
  }

  noted(id: string, note: string): void {
    const row = this.held.find((held) => held.id === id);

    if (row !== undefined) this.patch(id, { notes: [...row.notes, note] });
  }

  async settled(id: string, detail: string, facts: Readonly<Record<string, string>>): Promise<void> {
    this.patch(id, { state: 'done', detail, facts });
  }

  async failed(id: string, failure: DeployStepFailure): Promise<void> {
    this.patch(id, { state: 'failed', failure });
  }

  /** An eviction: the row says `running` and its activation is gone. */
  markRunning(id: string): void {
    this.patch(id, { state: 'running' });
  }

  private patch(id: string, change: Partial<DeployStepRow>): void {
    this.held = this.held.map((row) => (row.id === id ? { ...row, ...change } : row));
  }
}

class MemoryVault implements DeploySecretVault {
  private readonly held = new Map<string, string>();

  async read(name: string): Promise<string | null> {
    return this.held.get(name) ?? null;
  }

  async write(name: string, value: string): Promise<void> {
    this.held.set(name, value);
  }

  async wipe(): Promise<void> {
    this.held.clear();
  }

  async names(): Promise<readonly string[]> {
    return [...this.held.keys()];
  }
}

/** Members in decompressor pieces, assets before modules, as `scripts/build-worker-release.ts` writes. */
function artifactFor(manifest: ReleaseManifest): ArtifactSource {
  const encoder = new TextEncoder();

  const ordered = [...manifest.files].sort(
    (left, right) => Number(left.path.startsWith('worker/')) - Number(right.path.startsWith('worker/')),
  );

  return {
    held: new HeldBytes(),
    async *members(): AsyncIterable<ArtifactMember> {
      for (const file of ordered) {
        const body = encoder.encode(`bytes of ${file.path}`);

        yield {
          path: file.path,
          size: body.length,
          // Two pieces: a member arrives in whatever pieces the decompressor made.
          async *chunks(): AsyncIterable<Uint8Array> {
            yield body.subarray(0, 3);
            yield body.subarray(3);
          },
          bytes: () => Promise.resolve(body),
        };
      }
    },
  };
}

const UploadedBindingSchema = v.object({
  type: v.string(),
  name: v.string(),
  text: v.optional(v.string()),
  namespace_id: v.optional(v.string()),
  bucket_name: v.optional(v.string()),
  class_name: v.optional(v.string()),
});

function uploadedBindings(call: Recorded | undefined): readonly v.InferOutput<typeof UploadedBindingSchema>[] {
  return v.parse(v.array(UploadedBindingSchema), call?.body?.bindings ?? []);
}

let cloudflare: FakeCloudflare;

let ledger: ArrayLedger;

let vault: MemoryVault;

let progress: DeployProgress[];

/** What an uploaded version answers; the prior version answers 200 with `PRIOR_BUILD`. */
let health: number;

let updating = false;

let served: UpdateBuild;

const healthFetch: HttpGet = async (url, headers) => {
  if (!url.endsWith('/api/health')) throw new Error(`unexpected fetch ${url}`);

  const version = cloudflare.answering(headers);
  const prior = version === PRIOR_VERSION;

  // The stamp under `build`, beside the id of the version that answered (core/src/http/health-route.ts).
  return new Response(JSON.stringify({ ok: true, build: prior ? PRIOR_BUILD : served, versionId: version }), {
    status: prior ? 200 : health,
    headers: { 'content-type': 'application/json' },
  });
};

async function contextFor(): Promise<DeployContext> {
  return {
    manifest: MANIFEST,
    inputs: INPUTS,
    transport: cloudflare,
    artifact: artifactFor(MANIFEST),
    vault,
    facts: factsFrom(await ledger.rows()),
    http: healthFetch,
    update: updating,
    note: () => undefined,
  };
}

async function run(): Promise<DeployStepRow[]> {
  const outcome = await runDeployPlan(
    deployPlan(MANIFEST, INPUTS),
    await contextFor(),
    ledger,
    (event) => progress.push(event),
  );

  return [...outcome.rows];
}

beforeEach(async () => {
  cloudflare = new FakeCloudflare();
  ledger = new ArrayLedger();
  vault = new MemoryVault();
  progress = [];
  health = 200;
  updating = false;
  served = { version: MANIFEST.version, sha: MANIFEST.sha, builtAt: MANIFEST.builtAt };
  await vault.write(ACCESS_TOKEN_KEY, 'access-token-value');
  await vault.write(REFRESH_TOKEN_KEY, 'refresh-token-value');
  await vault.write(DEPLOY_CLIENT_ID_KEY, 'deploy-client-id');
});

describe('a guided run', () => {
  test('reaches a deployment and hands it its own key', async () => {
    const rows = await run();

    expect(rows.every((row) => row.state === 'done')).toBe(true);
    expect(cloudflare.namespaces).toEqual(['kinu-auth-kv']);
    expect(cloudflare.buckets).toEqual(['kinu-backups']);
    expect(cloudflare.indexes).toEqual(['kinu-memory']);
    expect(cloudflare.apps).toEqual(['kinu.acme.workers.dev']);
    expect(cloudflare.secrets.get(DEPLOYMENT_REFRESH_SECRET)).toBe('refresh-token-value');
    expect(JSON.parse(cloudflare.secrets.get(DEPLOYMENT_RECORD_SECRET) ?? '{}')).toMatchObject({
      inputs: { accountId: INPUTS.accountId, instanceName: 'kinu', ownerEmail: INPUTS.ownerEmail },
      address: 'kinu.acme.workers.dev',
      channelOrigin: 'https://kinu.run',
      clientId: 'deploy-client-id',
    });
    expect(progress.at(-1)).toEqual({ kind: 'run-done', address: 'kinu.acme.workers.dev' });
  });

  test('a random secret is minted, never asked of a person', () => {
    expect(promptedSecrets(MANIFEST)).toEqual([]);
  });

  test('holds no secret when it is over', async () => {
    await run();

    expect(await vault.names()).toEqual([]);
    expect(await vault.read(ACCESS_TOKEN_KEY)).toBeNull();
    expect(await vault.read(REFRESH_TOKEN_KEY)).toBeNull();
  });

  test('puts no secret material in a durable row', async () => {
    const rows = await run();
    const written = JSON.stringify(rows);

    for (const secret of ['access-token-value', 'refresh-token-value', ...cloudflare.secrets.values()]) {
      expect(written).not.toContain(secret);
    }
  });

  test('uploads the version with the bindings the release names', async () => {
    await run();

    const upload = cloudflare.calls.find((call) => call.path.endsWith('/workers/scripts/kinu'));
    const bindings = uploadedBindings(upload);
    const named = new Set(bindings.map((binding) => binding.name));

    expect(named).toContain('AUTH_KV');
    expect(named).toContain('ASSETS');
    expect(named).toContain('LOADER');
    // The sandbox needs Workers Paid; unrequested, its class must not be bound.
    expect(named).not.toContain('Sandbox');
    expect(bindings.find((binding) => binding.name === 'AUTH_KV')).toMatchObject({
      type: 'kv_namespace', namespace_id: 'id-kinu-auth-kv',
    });
    // Wrangler's own metadata for a `browser` block; an unknown type fails the whole upload.
    expect(bindings.find((binding) => binding.name === 'BROWSER')).toEqual({ type: 'browser', name: 'BROWSER' });
    expect(upload?.body?.migrations).toEqual({ new_tag: 'v1', new_sqlite_classes: ['OrchestratorAgent', 'KinuSandbox'] });
    expect(upload?.body?.compatibility_date).toBe('2025-12-01');
  });

  test('sends the carried vars and the deployment\'s own, never kinu.run\'s', async () => {
    await run();

    const upload = cloudflare.calls.find((call) => call.path.endsWith('/workers/scripts/kinu'));
    const bindings = uploadedBindings(upload);
    const plain = bindings.filter((binding) => binding.type === 'plain_text');

    expect(plain.find((binding) => binding.name === 'SANDBOX_TRANSPORT')?.text).toBe('rpc');
    expect(plain.map((binding) => binding.name)).not.toContain('DEV_USER_EMAIL');
    expect(bindings.filter((binding) => binding.type === 'secret_text').map((binding) => binding.name).sort())
      .toEqual([...MINTED_SECRETS].sort());
  });

  test('uploads the assets with the session token, not the account token', async () => {
    await run();

    const session = cloudflare.calls.find((call) => call.path.endsWith('/assets-upload-session'));
    const batch = cloudflare.calls.find((call) => call.path.includes('/workers/assets/upload'));
    const upload = cloudflare.calls.find((call) => call.path.endsWith('/workers/scripts/kinu'));

    expect(session?.body?.manifest).toEqual({
      '/index.html': { hash: '1'.repeat(32), size: 5 },
      '/app.js': { hash: '2'.repeat(32), size: 7 },
    });
    expect(batch?.bearer).toBe('session-token');
    expect(upload?.body?.assets).toMatchObject({ jwt: 'completion-token' });
  });
});

describe('a second sitting on the same account', () => {
  test('creates nothing twice', async () => {
    await run();
    cloudflare.calls.length = 0;
    ledger = new ArrayLedger();
    await vault.write(REFRESH_TOKEN_KEY, 'refresh-token-value');
    await vault.write(DEPLOY_CLIENT_ID_KEY, 'deploy-client-id');

    const rows = await run();

    expect(rows.every((row) => row.state === 'done')).toBe(true);
    expect(cloudflare.namespaces).toEqual(['kinu-auth-kv']);
    expect(cloudflare.buckets).toEqual(['kinu-backups']);
    expect(cloudflare.indexes).toEqual(['kinu-memory']);
    expect(cloudflare.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/storage/kv/namespaces')))
      .toEqual([]);
    expect(cloudflare.calls.filter((call) => call.method === 'PUT' && call.path.includes('/r2/buckets/')))
      .toEqual([]);
  });
});

describe('a refusal', () => {
  test('stops the run at the step that refused and keeps Cloudflare\'s words', async () => {
    cloudflare.refuseOnce = {
      path: `/accounts/${INPUTS.accountId}/r2/buckets`,
      status: 403,
      code: 10042,
      message: 'R2 is not enabled for this account. Add a payment method to enable R2.',
    };

    const rows = await run();
    const refused = rows.find((row) => row.id === 'r2');

    expect(refused?.state).toBe('failed');
    expect(refused?.failure).toEqual({
      detail: 'R2 is not enabled for this account. Add a payment method to enable R2.',
      code: 10042,
      status: 403,
    });
    expect(rows.find((row) => row.id === 'upload')?.state).toBe('pending');
    expect(cloudflare.calls.some((call) => call.path.endsWith('/workers/scripts/kinu'))).toBe(false);
  });

  test('is retried by running the plan again: that step, not the ones before it', async () => {
    cloudflare.refuseOnce = {
      path: `/accounts/${INPUTS.accountId}/vectorize/v2/indexes`,
      status: 409,
      code: 10014,
      message: 'vectorize.index.create: index already exists with a different dimension',
    };
    await run();
    cloudflare.calls.length = 0;

    const rows = await run();

    expect(rows.every((row) => row.state === 'done')).toBe(true);
    expect(rows.find((row) => row.id === 'vectorize')?.attempt).toBe(2);
    expect(rows.find((row) => row.id === 'kv')?.attempt).toBe(1);
    expect(cloudflare.calls.some((call) => call.path.endsWith('/storage/kv/namespaces') && call.method === 'POST')).toBe(false);
    expect(cloudflare.indexes).toEqual(['kinu-memory']);
  });

  test('a local failure is reported with no Cloudflare code', async () => {
    health = 503;

    const rows = await run();

    expect(rows.find((row) => row.id === 'smoke')?.failure?.code).toBe(0);
    expect(rows.find((row) => row.id === 'smoke')?.failure?.detail).toContain('503');
    expect(await vault.read(REFRESH_TOKEN_KEY)).toBe('refresh-token-value');
  });
});

describe('an eviction in the middle of a step', () => {
  test('resumes from the ledger and finishes', async () => {
    cloudflare.refuseOnce = {
      path: `/accounts/${INPUTS.accountId}/ai-gateway/gateways`,
      status: 500,
      code: 10000,
      message: 'internal error',
    };
    await run();
    ledger.markRunning('ai-gateway');
    cloudflare.calls.length = 0;

    const rows = await run();

    expect(rows.every((row) => row.state === 'done')).toBe(true);
    expect(cloudflare.gateways).toEqual(['kinu']);
    expect(cloudflare.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/r2/buckets'))).toEqual([]);
  });

  test('facts an earlier activation established survive into the next one', async () => {
    cloudflare.refuseOnce = {
      path: `/accounts/${INPUTS.accountId}/workers/scripts/kinu/subdomain`,
      status: 500,
      code: 10000,
      message: 'internal error',
    };
    await run();

    const carried = factsFrom(await ledger.rows());

    expect(carried.get('kv.AUTH_KV')).toBe('id-kinu-auth-kv');
    expect(carried.get('ai_gateway.url')).toContain('/kinu/workers-ai/v1');

    const rows = await run();

    expect(rows.find((row) => row.id === 'address')?.state).toBe('done');
    expect(cloudflare.namespaces).toEqual(['kinu-auth-kv']);
  });
});

/** The call layer the page and CLI share: the run key rides only the `authorization` header. */
describe('the door client', () => {
  test('carries the run key in a header, never in a URL, and upgrades the socket with the origin', async () => {
    const seen: { url: string; authorization: string }[] = [];

    const answering = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        seen.push({
          url: input instanceof Request ? input.url : String(input),
          authorization: new Headers(init?.headers).get('authorization') ?? '',
        });

        return new Response(init?.method === 'POST' ? '{"held":"OPENAI_API_KEY"}' : '[]', {
          headers: { 'content-type': 'application/json' },
        });
      },
      { preconnect: fetch.preconnect },
    ) satisfies typeof fetch;

    const key = 'k-ey_1';
    const door = deployDoor({ origin: 'https://kinu.run', runId: 'run-1', runKey: key }, answering);

    expect(await door.accounts()).toEqual([]);
    expect(await door.holdProviderKey('OPENAI_API_KEY', 'a-provider-key')).toBe('OPENAI_API_KEY');

    expect(seen.map((call) => call.url))
      .toEqual(['https://kinu.run/api/deploy/runs/run-1/accounts', 'https://kinu.run/api/deploy/runs/run-1/keys']);
    expect(seen.map((call) => call.authorization)).toEqual([`Bearer ${key}`, `Bearer ${key}`]);

    const urls = [...seen.map((call) => call.url), door.socketUrl()];

    expect(urls.filter((url) => url.includes(key))).toEqual([]);
    expect(door.socketUrl()).toBe('wss://kinu.run/api/deploy/runs/run-1/socket');
    expect(door.socketProtocols()).toEqual(['kinu.deploy.run-key', key]);
    expect(deployDoor({ origin: 'http://127.0.0.1:8787', runId: 'run-1', runKey: 'k' }).socketUrl())
      .toBe('ws://127.0.0.1:8787/api/deploy/runs/run-1/socket');
  });

  test('a refusal reads as the door wrote it, and a body that is not JSON names the URL', async () => {
    const refusing = deployDoor({ origin: 'https://kinu.run', runId: 'run-1', runKey: 'wrong' }, Object.assign(
      async (): Promise<Response> =>
        new Response(JSON.stringify({ error: 'that key does not open this run' }), { status: 403 }),
      { preconnect: fetch.preconnect },
    ) satisfies typeof fetch);

    await expect(refusing.snapshot()).rejects.toThrow('that key does not open this run');

    const misrouted = deployDoor({ origin: 'https://kinu.run', runId: 'run-1', runKey: 'k' }, Object.assign(
      async (): Promise<Response> => new Response('<!doctype html>', { status: 200 }),
      { preconnect: fetch.preconnect },
    ) satisfies typeof fetch);

    await expect(misrouted.snapshot()).rejects.toThrow('/api/deploy/runs/run-1 did not answer JSON');
  });
});

/** Manifest paths and versions become host file writes via `install()`, and the channel is caller-chosen. */
describe('a release manifest a channel publishes', () => {
  const manifestWith = (over: JsonObject): string =>
    JSON.stringify({ ...parseJsonObject(JSON.stringify(MANIFEST)), ...over });

  test('refuses a file path that leaves the release directory', () => {
    const escaping = [
      'worker/../../escape.js',
      '/etc/cron.d/escape',
      'worker\\..\\escape.js',
      './worker/index.js',
      'worker//index.js',
      '..',
    ];

    for (const path of escaping) {
      const files = [{ path, sha256: 'a'.repeat(64), size: 1, assetHash: null }];

      expect(() => parseReleaseManifest(manifestWith({ files })))
        .toThrow('a release file path must stay inside its release');
    }

    expect(parseReleaseManifest(manifestWith({})).files.map((file) => file.path))
      .toEqual(['worker/index.js', 'worker/chunk.js', 'client/index.html', 'client/app.js']);
  });

  test('refuses a version that is not a path segment, and a module that escapes', () => {
    expect(() => parseReleaseManifest(manifestWith({ version: '../../0.4.0' }))).toThrow();
    expect(() => parseReleaseManifest(manifestWith({ version: '0.4.0/etc' }))).toThrow();
    expect(() => parseReleaseManifest(manifestWith({
      worker: { ...parseJsonObject(JSON.stringify(MANIFEST.worker)), modules: ['../../../etc/passwd'] },
    }))).toThrow('a release file path must stay inside its release');

    expect(parseReleaseManifest(manifestWith({ version: '0.4.0+abc1234' })).version).toBe('0.4.0+abc1234');
  });
});

/** The local door's rendered workerd config. */
describe('the workerd configuration for a local instance', () => {
  test('a compiled member is a WebAssembly module, not JavaScript', () => {
    // Rendered as `esModule`, workerd read the `esbuild-*.wasm` member as JavaScript and exited.
    const manifest = { ...MANIFEST, worker: { ...MANIFEST.worker, modules: [...MANIFEST.worker.modules, 'assets/esbuild-abc.wasm'] } };
    const config = renderWorkerdConfig({ manifest, version: manifest.version, port: 8787 });

    expect(config).toContain('(name = "assets/esbuild-abc.wasm", wasm = embed "releases/0.4.0+abc1234/worker/assets/esbuild-abc.wasm"),');
    expect(config).not.toContain('esModule = embed "releases/0.4.0+abc1234/worker/assets/esbuild-abc.wasm"');
    expect(config).toContain('(name = "index.js", esModule = embed "releases/0.4.0+abc1234/worker/index.js"),');
  });

  test('renders the release, its stores and its objects, and names what a local instance loses', () => {
    const config = renderWorkerdConfig({ manifest: MANIFEST, version: MANIFEST.version, port: 8787 });

    expect(config).toContain('(name = "http", address = "127.0.0.1:8787", http = (), service = "main"),');
    expect(config).toContain('(name = "index.js", esModule = embed "releases/0.4.0+abc1234/worker/index.js"),');
    expect(config).toContain('(name = "chunk.js", esModule = embed "releases/0.4.0+abc1234/worker/chunk.js"),');
    expect(config).toContain('compatibilityDate = "2025-12-01",');
    expect(config).toContain('compatibilityFlags = ["nodejs_compat"],');

    // `kvNamespace` gives a KvNamespace, not a Fetcher.
    expect(config).toContain('(name = "kv-AUTH_KV", disk = (path = "state/kv/kinu-auth-kv", writable = true)),');
    expect(config).toContain('(name = "AUTH_KV", kvNamespace = "kv-AUTH_KV"),');

    // R2 is not hosted: a disk directory does not speak R2's protocol.
    expect(config).not.toContain('BACKUP_BUCKET');
    expect(config).not.toContain('state/r2');

    expect(config).toContain('(name = "assets", disk = (path = "releases/0.4.0+abc1234/client", writable = false)),');
    expect(config).toContain('(name = "ASSETS", service = "assets"),');

    // workerd keys a class's on-disk database by the derived key.
    expect(config).toContain('(className = "OrchestratorAgent", uniqueKey = "kinu-local-OrchestratorAgent", enableSql = true),');
    expect(config).toContain('(className = "KinuSandbox", uniqueKey = "kinu-local-KinuSandbox", enableSql = true),');
    expect(config).toContain('durableObjectStorage = (localDisk = "do-state"),');
    expect(config).toContain('(name = "OrchestratorAgent", durableObjectNamespace = "OrchestratorAgent"),');
    expect(config).toContain('(name = "Sandbox", durableObjectNamespace = "KinuSandbox"),');

    expect(config).toContain('(name = "SANDBOX_TRANSPORT", text = "rpc"),');
    expect(config).not.toContain('CLI_PUBLIC_ORIGIN');
    expect(config).not.toContain('DEV_USER_EMAIL');

    expect(config).not.toContain('MEMORY_VECTORS');
    expect(config).not.toContain('LOADER');
    expect(unhostedBindings(MANIFEST)).toEqual(['BACKUP_BUCKET', 'MEMORY_VECTORS', 'AGENT_METRICS', 'AI', 'BROWSER', 'LOADER']);

    // workerd refuses to start on a disk service whose directory is absent.
    expect(workerdDirectories(MANIFEST)).toEqual(['state/do', 'state/kv/kinu-auth-kv']);
  });

  test('the layout is one tree, and the config records the address it settled on', () => {
    const layout = localLayout('/home/somebody/.kinu');

    expect(layout.root).toBe('/home/somebody/.kinu/local');
    expect(layout.current).toBe('/home/somebody/.kinu/local/current');
    expect(layout.capnp).toBe('/home/somebody/.kinu/local/workerd.capnp');
    expect(releaseDir(layout, MANIFEST.version)).toBe('/home/somebody/.kinu/local/releases/0.4.0+abc1234');

    const config = v.parse(LocalConfigSchema, JSON.parse(renderLocalConfig({
      version: MANIFEST.version,
      port: LOCAL_PORT,
      at: new Date('2026-09-18T00:00:00.000Z'),
    })));

    expect(config).toEqual({
      version: '0.4.0+abc1234',
      port: 8787,
      address: 'http://127.0.0.1:8787',
      renderedAt: '2026-09-18T00:00:00.000Z',
    });
  });
});

describe('what the address and smoke steps check', () => {
  test('a refused deployment pointer fails the address step', async () => {
    cloudflare.refuseOnce = {
      method: 'POST',
      path: `/accounts/${INPUTS.accountId}/workers/scripts/kinu/deployments`,
      status: 403,
      code: 10_026,
      message: 'workers.api.error.deployment_not_permitted',
    };

    const rows = await run();

    expect(rows.find((row) => row.id === 'address')?.state).toBe('failed');
    expect(rows.find((row) => row.id === 'address')?.failure?.code).toBe(10_026);
    expect(rows.find((row) => row.id === 'smoke')?.state).toBe('pending');
  });

  test('a smoke check answered with another build fails', async () => {
    served = { version: '0.3.9+old0000', sha: 'old0000', builtAt: MANIFEST.builtAt };

    const rows = await run();
    const smoke = rows.find((row) => row.id === 'smoke');

    expect(smoke?.state).toBe('failed');
    expect(smoke?.failure?.detail).toContain('0.3.9+old0000');
    expect(smoke?.failure?.detail).toContain(MANIFEST.version);
    expect(await vault.read(REFRESH_TOKEN_KEY)).toBe('refresh-token-value');
  });

  test('an update mints no root secret and keeps the running version\'s', async () => {
    updating = true;
    cloudflare.serveExisting(PRIOR_VERSION);

    const rows = await run();
    const upload = cloudflare.calls.find((call) => call.path.endsWith('/versions'));
    const bindings = uploadedBindings(upload);

    expect(rows.every((row) => row.state === 'done')).toBe(true);
    expect(cloudflare.serving()).toBe('version-1');
    expect(rows.find((row) => row.id === 'secrets')?.detail).toContain('kept from the running version');
    // `keep_bindings` keeps the live keys; a fresh entry here would destroy them.
    expect(await vault.read('CREDENTIAL_ENCRYPTION_KEY')).toBeNull();
    expect(bindings.map((binding) => binding.name)).not.toContain('CREDENTIAL_ENCRYPTION_KEY');
    expect(upload?.body?.keep_bindings).toEqual(['secret_text', 'secret_key']);
    expect(upload?.body?.migrations).toBeUndefined();
  });

  test('a failed smoke leaves the version that was serving in front of all traffic', async () => {
    updating = true;
    cloudflare.serveExisting(PRIOR_VERSION);
    health = 503;

    const rows = await run();

    expect(rows.find((row) => row.id === 'smoke')?.state).toBe('failed');
    expect(cloudflare.serving()).toBe(PRIOR_VERSION);
    expect(cloudflare.secrets.has(DEPLOYMENT_RECORD_SECRET)).toBe(false);
  });

  test('a smoke answered by the serving version fails, though that version carries the same build', async () => {
    await run();
    ledger = new ArrayLedger();
    await vault.write(REFRESH_TOKEN_KEY, 'refresh-token-value');
    await vault.write(DEPLOY_CLIENT_ID_KEY, 'deploy-client-id');
    cloudflare.overridesLag = true;

    const rows = await run();
    const smoke = rows.find((row) => row.id === 'smoke');

    expect(smoke?.state).toBe('failed');
    expect(smoke?.failure?.detail).toContain('version-1');
    expect(cloudflare.serving()).toBe('version-1');
  });
});
