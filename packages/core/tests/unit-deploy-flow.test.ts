/**
 * The self-deploy flow against a fake Cloudflare (docs/SELF-DEPLOY.md, order of
 * work step 2).
 *
 * What these rows hold, each of which is a way a real run goes wrong:
 * a second sitting on the same account must create nothing twice; a refusal
 * must stop the run at the step that refused and keep Cloudflare's own
 * sentence; a retry must re-run that step and nothing before it; an eviction
 * in the middle of a step must resume from the ledger rather than from the
 * top; and the run must end holding no secret at all.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  ACCESS_TOKEN_KEY, DEPLOYMENT_RECORD_SECRET, DEPLOYMENT_REFRESH_SECRET, DEPLOY_CLIENT_ID_KEY,
  LOCAL_PORT, LocalConfigSchema, MINTED_SECRETS,
  REFRESH_TOKEN_KEY, deployDoor, deployPlan, factsFrom, localLayout, parseReleaseManifest, releaseDir,
  renderLocalConfig, renderWorkerdConfig, runDeployPlan, unhostedBindings, workerdDirectories,
} from '../src/deploy/index';
import type {
  CloudflareCall, CloudflareHttpResponse, CloudflareTransport, DeployContext, DeployInputs,
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
    { binding: 'ASSETS', kind: 'assets', resource: '', required: true },
    { binding: 'LOADER', kind: 'worker-loader', resource: '', required: true },
  ],
  vectorIndexes: [{ name: 'kinu-memory', dimensions: 384, metric: 'cosine' }],
  migrations: [{ tag: 'v1', newSqliteClasses: ['OrchestratorAgent', 'KinuSandbox'] }],
  secrets: [
    { name: 'CREDENTIAL_ENCRYPTION_KEY', handling: 'prompted', required: true, prompt: '32 random bytes' },
    { name: 'WEBHOOK_ROUTE_SECRET', handling: 'prompted', required: true, prompt: '32 random bytes' },
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

/** A Cloudflare that remembers what it was told to create, so a second run
 *  over the same account finds what the first one made. */
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

  refuseOnce: { path: string; status: number; code: number; message: string } | null = null;

  async request(call: CloudflareCall): Promise<CloudflareHttpResponse> {
    this.calls.push({ method: call.method, path: call.path, body: call.body, bearer: undefined });

    const refusal = this.refusalFor(call.path);

    if (refusal !== null) return refusal;

    // What Cloudflare answers for a script nobody has uploaded yet, which is
    // how the flow tells a first deployment from an update.
    if (call.path.endsWith('/settings') && !this.scriptExists) {
      return {
        status: 404,
        body: { success: false, errors: [{ code: 10007, message: 'workers.api.error.script_not_found' }], result: null },
      };
    }

    // An R2 object nobody has put yet. The seed step looks before it uploads,
    // so a second run over a seeded bucket must find its own keys there.
    if (call.method === 'HEAD') {
      if (this.objects.includes(call.path)) return { status: 200, body: null };

      return {
        status: 404,
        body: { success: false, errors: [{ code: 10007, message: 'The specified key does not exist.' }], result: null },
      };
    }

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

    const refusal = this.refusalFor(upload.path);

    if (refusal !== null) return refusal;

    if (upload.path.includes('/workers/assets/upload')) {
      return { status: 201, body: { success: true, errors: [], result: { jwt: 'completion-token' } } };
    }

    if (upload.path.includes('/r2/buckets/')) {
      this.objects.push(upload.path);

      return { status: 200, body: { success: true, errors: [], result: null } };
    }

    this.scriptExists = true;

    return { status: 200, body: { success: true, errors: [], result: { id: 'version-1' } } };
  }

  private refusalFor(path: string): CloudflareHttpResponse | null {
    const refusal = this.refuseOnce;

    if (refusal === null || !path.startsWith(refusal.path)) return null;
    this.refuseOnce = null;

    return {
      status: refusal.status,
      body: { success: false, errors: [{ code: refusal.code, message: refusal.message }], result: null },
    };
  }

  private answer(call: CloudflareCall): JsonValue {
    const path = call.path;
    const body = call.body ?? {};

    if (path.endsWith('/storage/kv/namespaces?per_page=100')) {
      return this.namespaces.map((title) => ({ id: `id-${title}`, title }));
    }

    if (path.endsWith('/storage/kv/namespaces')) {
      const title = String(body.title ?? '');

      this.namespaces.push(title);

      return { id: `id-${title}` };
    }

    if (path.endsWith('/r2/buckets?per_page=100')) return { buckets: this.buckets.map((name) => ({ name })) };

    if (path.endsWith('/r2/buckets')) {
      this.buckets.push(String(body.name ?? ''));

      return { name: body.name ?? '' };
    }

    if (path.endsWith('/vectorize/v2/indexes') && call.method === 'GET') {
      return this.indexes.map((name) => ({ name }));
    }

    if (path.endsWith('/vectorize/v2/indexes')) {
      this.indexes.push(String(body.name ?? ''));

      return { name: body.name ?? '' };
    }

    if (path.includes('/ai-gateway/gateways?')) return this.gateways.map((id) => ({ id }));

    if (path.endsWith('/ai-gateway/gateways')) {
      this.gateways.push(String(body.id ?? ''));

      return { id: body.id ?? '' };
    }

    if (path.endsWith('/access/apps') && call.method === 'GET') {
      return this.apps.map((domain) => ({ id: `app-${domain}`, domain }));
    }

    if (path.endsWith('/access/apps')) {
      const domain = String(body.domain ?? '');

      this.apps.push(domain);

      return { id: `app-${domain}` };
    }

    if (path.includes('/access/apps/') && path.endsWith('/policies')) return { id: 'policy-1' };

    if (path.endsWith('/workers/subdomain')) return { subdomain: 'acme' };

    if (path.endsWith('/subdomain')) return { enabled: true };

    if (path.endsWith('/deployments')) return { id: 'deployment-1' };

    if (path.endsWith('/secrets')) {
      this.secrets.set(String(body.name ?? ''), String(body.text ?? ''));

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

  /** What an eviction looks like from outside: the row says `running` and the
   *  activation that wrote it is gone. */
  markRunning(id: string): void {
    this.patch(id, { state: 'running' });
  }

  private patch(id: string, change: Partial<DeployStepRow>): void {
    this.held = this.held.map((row) => (row.id === id ? { ...row, ...change } : row));
  }
}

class MemoryVault implements DeploySecretVault {
  private held = new Map<string, string>();

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

function artifactFor(manifest: ReleaseManifest): ArtifactSource {
  const bytes = new TextEncoder();

  return {
    async read(path: string): Promise<Uint8Array<ArrayBuffer>> {
      if (!manifest.files.some((file) => file.path === path)) throw new Error(`no ${path} in the artifact`);

      return bytes.encode(`bytes of ${path}`);
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

/** The bindings the upload carried, parsed rather than asserted: the fake
 *  records what the step sent, and a row that reads it must fail when the
 *  shape changes instead of reading a wrong field as undefined. */
function uploadedBindings(call: Recorded | undefined): readonly v.InferOutput<typeof UploadedBindingSchema>[] {
  return v.parse(v.array(UploadedBindingSchema), call?.body?.bindings ?? []);
}

let cloudflare: FakeCloudflare;

let ledger: ArrayLedger;

let vault: MemoryVault;

let progress: DeployProgress[];

let health: number;

/** Whether the run under construction is an update. A first sitting by
 *  default; the rows that are an update say so. */
let updating = false;

/** Which build the new address answers with. The release's own by default; a
 *  row that is measuring the smoke check sets the previous one. */
let served: UpdateBuild;

const healthFetch: HttpGet = async (url) => {
  if (!url.endsWith('/api/health')) throw new Error(`unexpected fetch ${url}`);

  return new Response(JSON.stringify(served), {
    status: health,
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
    // The sandbox is off by default and needs Workers Paid; its class must not
    // be bound into a deployment that did not ask for it.
    expect(named).not.toContain('Sandbox');
    expect(bindings.find((binding) => binding.name === 'AUTH_KV')).toMatchObject({
      type: 'kv_namespace', namespace_id: 'id-kinu-auth-kv',
    });
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
    // What makes a second run an update: the largest thing the flow moves is
    // already in the bucket, so it is looked at and not sent again.
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
    // The activation died with the row still saying `running`, which is what a
    // Durable Object eviction leaves behind.
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

/** The one call layer the page and the CLI share. What a caller of either door
 *  observes: the run key in the `authorization` header of every call and in NO
 *  URL, `wss` on a secure origin, and the door's own sentence when it
 *  refuses. */
describe('the door client', () => {
  test('carries the run key in a header, never in a URL, and upgrades the socket with the origin', async () => {
    const seen: { url: string; authorization: string }[] = [];

    const answering = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        seen.push({
          url: String(input),
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

    // The whole point of the header: the key is in nothing that a browser
    // history, a referrer or an invocation log records.
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

/**
 * The manifest a channel publishes, as the thing that decides where bytes
 * land. `install()` on the local door writes `join(releaseDir(version), path)`
 * for every file the manifest names, so a path or a version the channel chose
 * is a host file write — and a channel is chosen with `--origin`.
 */
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

    // The build stamps a real release carries: `+` and `.` are the two
    // characters a version is allowed to be interesting with.
    expect(parseReleaseManifest(manifestWith({ version: '0.4.0+abc1234' })).version).toBe('0.4.0+abc1234');
  });
});

/**
 * The local door's rendered configuration. What a reader of the capnp must be
 * able to trust: every module is embedded from the release that `current`
 * names, the stores workerd has no implementation of are directories under
 * `state/`, the Durable Object classes are SQL-backed with a key that does not
 * move between renders, and a binding workerd cannot host is named rather than
 * rendered as something else.
 */
describe('the workerd configuration for a local instance', () => {
  test('renders the release, its stores and its objects, and names what a local instance loses', () => {
    const config = renderWorkerdConfig({ manifest: MANIFEST, version: MANIFEST.version, port: 8787 });

    expect(config).toContain('(name = "http", address = "127.0.0.1:8787", http = (), service = "main"),');
    expect(config).toContain('(name = "index.js", esModule = embed "releases/0.4.0+abc1234/worker/index.js"),');
    expect(config).toContain('(name = "chunk.js", esModule = embed "releases/0.4.0+abc1234/worker/chunk.js"),');
    expect(config).toContain('compatibilityDate = "2025-12-01",');
    expect(config).toContain('compatibilityFlags = ["nodejs_compat"],');

    // KV and R2 are directories: workerd has neither, and the doc's "KV and R2
    // on local disk" is this.
    expect(config).toContain('(name = "kv-AUTH_KV", disk = (path = "state/kv/kinu-auth-kv", writable = true)),');
    expect(config).toContain('(name = "r2-BACKUP_BUCKET", disk = (path = "state/r2/kinu-backups", writable = true)),');
    expect(config).toContain('(name = "AUTH_KV", service = "kv-AUTH_KV"),');
    expect(config).toContain('(name = "BACKUP_BUCKET", service = "r2-BACKUP_BUCKET"),');

    // The assets directory is the release's own and is never written to.
    expect(config).toContain('(name = "assets", disk = (path = "releases/0.4.0+abc1234/client", writable = false)),');
    expect(config).toContain('(name = "ASSETS", service = "assets"),');

    // Both classes the migrations declare, SQL-backed, under one storage
    // directory; the key is derived from the class name, because workerd keys a
    // class's on-disk database by it.
    expect(config).toContain('(className = "OrchestratorAgent", uniqueKey = "kinu-local-OrchestratorAgent", enableSql = true),');
    expect(config).toContain('(className = "KinuSandbox", uniqueKey = "kinu-local-KinuSandbox", enableSql = true),');
    expect(config).toContain('durableObjectStorage = (localDisk = "do-state"),');
    expect(config).toContain('(name = "OrchestratorAgent", durableObjectNamespace = "OrchestratorAgent"),');
    expect(config).toContain('(name = "Sandbox", durableObjectNamespace = "KinuSandbox"),');

    // A carried var travels; a derived or `ours` var never reaches a local
    // instance's config.
    expect(config).toContain('(name = "SANDBOX_TRANSPORT", text = "rpc"),');
    expect(config).not.toContain('CLI_PUBLIC_ORIGIN');
    expect(config).not.toContain('DEV_USER_EMAIL');

    // Nothing workerd cannot host is rendered as a binding, and all of it is
    // reported by name.
    expect(config).not.toContain('MEMORY_VECTORS');
    expect(config).not.toContain('LOADER');
    expect(unhostedBindings(MANIFEST)).toEqual(['MEMORY_VECTORS', 'AGENT_METRICS', 'AI', 'LOADER']);

    // Every writable directory the config names, because workerd refuses to
    // start on a disk service whose directory is absent: it answered
    // `Directory named "do-state" not found: state/do` (workerd 2026-09-03,
    // measured 2026-09-18) until the installer created them.
    expect(workerdDirectories(MANIFEST)).toEqual(['state/do', 'state/kv/kinu-auth-kv', 'state/r2/kinu-backups']);
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

/**
 * The two answers a step must read rather than assume: Cloudflare's reply to
 * the pointer move, and which build the new address serves.
 */
describe('what the address and smoke steps check', () => {
  test('a refused deployment pointer fails the address step', async () => {
    cloudflare.refuseOnce = {
      path: `/accounts/${INPUTS.accountId}/workers/scripts/kinu/deployments`,
      status: 403,
      code: 10_026,
      message: 'workers.api.error.deployment_not_permitted',
    };

    const rows = await run();

    expect(rows.find((row) => row.id === 'address')?.state).toBe('failed');
    expect(rows.find((row) => row.id === 'address')?.failure?.code).toBe(10_026);
    // Nothing after it ran, so the run never claims an address it did not bind.
    expect(rows.find((row) => row.id === 'smoke')?.state).toBe('pending');
  });

  test('a smoke check that finds the previous build still serving fails', async () => {
    served = { version: '0.3.9+old0000', sha: 'old0000', builtAt: MANIFEST.builtAt };

    const rows = await run();
    const smoke = rows.find((row) => row.id === 'smoke');

    expect(smoke?.state).toBe('failed');
    expect(smoke?.failure?.detail).toContain('0.3.9+old0000');
    expect(smoke?.failure?.detail).toContain(MANIFEST.version);
    // A failed smoke keeps the run's authorization: this is the case the
    // deployment pointer is rolled back from, by hand or by a retry.
    expect(await vault.read(REFRESH_TOKEN_KEY)).toBe('refresh-token-value');
  });

  test('an update mints no root secret and keeps the running version\'s', async () => {
    // A self-update's vault holds the token pair and nothing else: it reads
    // through to no live binding, so "absent here" is the ordinary state.
    updating = true;
    cloudflare.scriptExists = true;

    const rows = await run();
    const upload = cloudflare.calls.find((call) => call.path.endsWith('/versions'));
    const bindings = uploadedBindings(upload);

    expect(rows.every((row) => row.state === 'done')).toBe(true);
    expect(rows.find((row) => row.id === 'secrets')?.detail).toContain('kept from the running version');
    // Nothing minted, and nothing sent: what keeps the live keys is
    // `keep_bindings`, and what would destroy them is a fresh one in this list.
    expect(await vault.read('CREDENTIAL_ENCRYPTION_KEY')).toBeNull();
    expect(bindings.map((binding) => binding.name)).not.toContain('CREDENTIAL_ENCRYPTION_KEY');
    expect(upload?.body?.keep_bindings).toEqual(['secret_text', 'secret_key']);
    // And no migration is re-declared onto a script that already applied it.
    expect(upload?.body?.migrations).toBeUndefined();
  });
});
