/** The self-deploy flow against a fake Cloudflare (docs/SELF-DEPLOY.md): idempotent reruns, refusals, retries, eviction resume, no secret held at the end. */
import { beforeEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { Effect } from 'effect';
import {
  ACCESS_TOKEN_KEY, DEPLOYMENT_RECORD_SECRET, DEPLOYMENT_REFRESH_SECRET, DEPLOY_CLIENT_ID_KEY,
  CLOUDFLARE_DEPLOY_SCOPES, FIRST_OWNER_LINK_MS, FIRST_OWNER_LINK_SECRET,
  HeldBytes, LOCAL_PORT, LocalConfigSchema, MINTED_SECRETS, promptedSecrets,
  FACT_VERSION_ID, REFRESH_TOKEN_KEY, deployDoor, deployPlan, deployRunView, domainsMatching, factsFrom,
  judgeRefusal, localLayout, mailPreview, parseReleaseManifest, plannedRun, preflight, releaseDir,
  renderLocalConfig, renderWorkerdConfig, runDeployPlan, unhostedBindings, workerdDirectories,
} from '../src/deploy/index';
import type {
  ArtifactMember, CloudflareCall, CloudflareHttpResponse, CloudflareTransport, DeployContext,
  DeployInputs,
  ArtifactSource, DeployLedger, DeployProgress, DeploySecretVault, DeployStepFailure, DeployStepRow,
  DeployStepSeed, HttpGet,
  DeployRunStanding, MultipartUpload, ReleaseManifest, StreamedPut, UpdateBuild,
} from '../src/deploy/index';
import { parseJsonObject, type JsonObject, type JsonValue } from '../src/utils/json';
import { sha256Hex } from '../src/safety/argument-digest';
import { settle } from '../src/obs/index';

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
    crons: ['*/15 * * * *'],
  },
  bindings: [
    { binding: 'AUTH_KV', kind: 'kv', resource: 'kinu-auth-kv', required: true },
    { binding: 'BACKUP_BUCKET', kind: 'r2', resource: 'kinu-backups', required: false },
    { binding: 'MEMORY_VECTORS', kind: 'vectorize', resource: 'kinu-memory', required: false },
    { binding: 'OrchestratorAgent', kind: 'durable-object', resource: 'OrchestratorAgent', required: true },
    { binding: 'KinuDevbox', kind: 'durable-object', resource: 'KinuDevbox', required: false },
    { binding: 'AGENT_METRICS', kind: 'analytics-engine', resource: 'kinu_agent_metrics', required: false },
    { binding: 'AI', kind: 'ai', resource: '', required: false },
    { binding: 'BROWSER', kind: 'browser', resource: '', required: false },
    { binding: 'ASSETS', kind: 'assets', resource: '', required: true },
    { binding: 'LOADER', kind: 'worker-loader', resource: '', required: true },
  ],
  vectorIndexes: [{ name: 'kinu-memory', dimensions: 384, metric: 'cosine' }],
  migrations: [{ tag: 'v1', newSqliteClasses: ['OrchestratorAgent', 'KinuDevbox'] }],
  secrets: [
    { name: 'CREDENTIAL_ENCRYPTION_KEY', handling: 'prompted', required: true, prompt: '32 random bytes' },
    { name: 'WEBHOOK_ROUTE_SECRET', handling: 'prompted', required: true, prompt: '32 random bytes' },
    { name: 'JWT_SECRET', handling: 'prompted', required: true, prompt: '32 random bytes' },
    { name: 'ANALYTICS_SQL_API_TOKEN', handling: 'optional', required: false, prompt: 'an account analytics token' },
  ],
  vars: [
    { name: 'SANDBOX_TRANSPORT', policy: 'carried', value: 'rpc' },
    { name: 'CLI_PUBLIC_ORIGIN', policy: 'derived' },
    { name: 'SIGN_IN_PROVIDERS', policy: 'derived' },
    { name: 'EMAIL_DOMAIN', policy: 'derived' },
    { name: 'MAIL_ACCOUNTS', policy: 'derived' },
    { name: 'CONTROL_PLANE_ADMINS', policy: 'derived' },
    { name: 'DEV_USER_EMAIL', policy: 'ours' },
  ],
  files: [
    { path: 'worker/index.js', sha256: 'a'.repeat(64), size: 12, assetHash: null },
    { path: 'worker/chunk.js', sha256: 'b'.repeat(64), size: 8, assetHash: null },
    { path: 'client/index.html', sha256: 'c'.repeat(64), size: 5, assetHash: '1'.repeat(32) },
    { path: 'client/app.js', sha256: 'd'.repeat(64), size: 7, assetHash: '2'.repeat(32) },
  ],
  seed: null,
  computer: null,
};

const INPUTS: DeployInputs = {
  accountId: '0'.repeat(32),
  instanceName: 'kinu',
  address: { kind: 'workers-dev', hostname: '', zoneId: '' },
  ownerEmail: 'owner@example.com',
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

  /** Each index's shape, as Vectorize reports it. */
  readonly indexConfigs = new Map<string, { dimensions: number; metric: string }>();

  readonly gateways: string[] = [];


  readonly objects: string[] = [];

  /** Bytes each streamed object upload carried, by path. */
  readonly streamed = new Map<string, number>();

  /** Account tokens by name, and each value minted or rolled for one. */
  readonly tokens = new Map<string, string[]>();

  /** Container applications, by the namespace they run on. */
  readonly applications = new Map<string, string>();

  /** The zones the token can read, by name; a mail domain must be one. */
  readonly zones = new Map<string, string>();

  /** Each zone's DNS records, as Cloudflare lists them. */
  /** `locked`: a record Cloudflare manages, which a write to its name is refused for, as Email Routing refuses an MX. */
  readonly dns: { zone: string; type: string; name: string; content: string; priority?: number; locked?: true }[] = [];

  /** What the zone's Email Routing and Sending hold. */
  readonly routing = { enabled: new Set<string>(), catchAll: new Map<string, unknown>(), sending: new Map<string, string>() };

  /** Paths under a zone the token may not touch: Email Routing, Sending or DNS. */
  readonly forbiddenUnder: string[] = [];

  /**
   * Email Sending as the API answered it on staging.kinu.run, 2026-10-20: a sending subdomain is named by its `tag`, and
   * making one twice is refused. Making one writes its bounce records itself, locked; its record list spells an MX host
   * with a trailing dot and a TXT in quotes, and suggests a `_dmarc` of its own.
   */
  private sendingCall(id: string, rest: string, call: CloudflareCall): CloudflareHttpResponse | null {
    const ok = (result: JsonValue): CloudflareHttpResponse => ({ status: 200, body: { success: true, errors: [], result } });
    const name = this.routing.sending.get(id);

    if (rest === 'email/sending/subdomains' && call.method === 'GET') return ok(name === undefined ? [] : [{ tag: `tag-${name}`, name, enabled: true }]);

    if (rest === 'email/sending/subdomains') {
      const asked = bodyText(call.body ?? {}, 'name');

      if (name !== undefined) return { status: 409, body: { success: false, errors: [{ code: 1000, message: 'Sending subdomain already exists' }], result: null } };
      this.routing.sending.set(id, asked);
      // As on kinu.run: the DKIM key is held as two strings, and a _dmarc of Sending's own is written unless one is held.
      this.dns.push(
        { zone: id, type: 'MX', name: `cf-bounce.${asked}`, content: 'route1.mx.cloudflare.net', priority: 32, locked: true },
        { zone: id, type: 'TXT', name: `cf-bounce._domainkey.${asked}`, content: '"v=DKIM1; h=sha256; k=rsa; p=MII" "BIjAN"', locked: true },
        ...this.dns.some((record) => record.zone === id && record.name === `_dmarc.${asked}`) ? [] : [{ zone: id, type: 'TXT', name: `_dmarc.${asked}`, content: '"v=DMARC1; p=reject;"' }],
      );

      return ok({ tag: `tag-${asked}`, name: asked, enabled: true });
    }

    if (rest !== `email/sending/subdomains/tag-${name ?? ''}/dns`) return null;

    return ok([
      { type: 'MX', name: `cf-bounce.${name ?? ''}`, content: 'route1.mx.cloudflare.net.', priority: 32 },
      { type: 'TXT', name: `cf-bounce._domainkey.${name ?? ''}`, content: '"v=DKIM1; h=sha256; k=rsa; p=MIIBIjAN"' },
      { type: 'TXT', name: `_dmarc.${name ?? ''}`, content: '"v=DMARC1; p=reject;"' },
    ]);
  }

  private routingDns(id: string, call: CloudflareCall): CloudflareHttpResponse {
    const named = call.body?.['name'];

    if (typeof named === 'string' && [...this.zones].some(([zone, held]) => held === id && zone === named)) {
      return { status: 422, body: { success: false, errors: [{ code: 1001, message: `Invalid Input: must be a subdomains of ${named}` }], result: null } };
    }

    this.routing.enabled.add(id);

    return { status: 200, body: { success: true, errors: [], result: { enabled: true } } };
  }

  private readonly ok = (result: JsonValue): CloudflareHttpResponse => ({ status: 200, body: { success: true, errors: [], result } });

  /** The zone's DNS records: read by type and name, patched by id, and written unless Cloudflare manages the name. */
  private dnsCall(id: string, rest: string, call: CloudflareCall): CloudflareHttpResponse | null {
    if (rest.startsWith('dns_records?')) {
      const type = /type=([^&]+)/u.exec(rest)?.[1];
      const name = decodeURIComponent(/name=([^&]+)/u.exec(rest)?.[1] ?? '');

      return this.ok(this.dns.flatMap(({ zone: held, locked: _locked, ...record }, at) => (held === id && record.type === type && record.name === name ? [{ id: `record-${String(at)}`, ...record }] : [])));
    }

    const patched = /^dns_records\/record-(\d+)$/u.exec(rest);
    const target = patched === null ? undefined : this.dns[Number(patched[1])];

    if (target !== undefined && call.method === 'PATCH') {
      target.content = bodyText(call.body ?? {}, 'content');

      return this.ok({ id: `record-${patched?.[1] ?? ''}` });
    }

    if (rest === 'dns_records' && call.method === 'POST') {
      const body = call.body ?? {};

      if (this.dns.some((record) => record.zone === id && record.locked === true && record.name === bodyText(body, 'name'))) {
        return { status: 400, body: { success: false, errors: [{ code: 890190, message: 'This zone is managed by Email Routing. Disable Email Routing to add/modify MX records.' }], result: null } };
      }

      this.dns.push({ zone: id, type: bodyText(body, 'type'), name: bodyText(body, 'name'), content: bodyText(body, 'content') });

      return this.ok({ id: `record-${String(this.dns.length)}` });
    }

    return null;
  }

  private zoneCall(call: CloudflareCall): CloudflareHttpResponse | null {
    const zone = /^\/zones\/([^/?]+)\/(.+)$/u.exec(call.path);
    const ok = (result: JsonValue): CloudflareHttpResponse => ({ status: 200, body: { success: true, errors: [], result } });

    if (call.path.startsWith('/zones?name=')) {
      const name = decodeURIComponent(/name=([^&]+)/u.exec(call.path)?.[1] ?? '');
      const id = this.zones.get(name);

      return ok(id === undefined ? [] : [this.zoneOf(name, id)]);
    }

    if (zone === null) return null;
    const [, id = '', rest = ''] = zone;

    if (this.forbiddenUnder.some((prefix) => rest.startsWith(prefix))) {
      return { status: 403, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }], result: null } };
    }

    // Email Routing is enabled through its DNS: `routing/enable` is deprecated and not served here. A `name` is for a
    // subdomain only: the zone's own name is refused, as the API refused kinu.run's (2026-10-20).
    if (rest === 'email/routing/dns' && call.method === 'POST') return this.routingDns(id, call);

    // The records Email Routing needs on the apex, as `GET …/email/routing/dns` lists them.
    if (rest === 'email/routing/dns') {
      const apex = [...this.zones].find(([, held]) => held === id)?.[0] ?? '';

      return ok([
        { type: 'MX', name: apex, content: 'route1.mx.cloudflare.net', priority: 13 },
        { type: 'MX', name: apex, content: 'route2.mx.cloudflare.net', priority: 86 },
        { type: 'TXT', name: apex, content: 'v=spf1 include:_spf.mx.cloudflare.net ~all' },
      ]);
    }

    if (rest === 'email/routing/rules/catch_all') { this.routing.catchAll.set(id, call.body ?? null);

 return ok({ enabled: true }); }

    if (rest.startsWith('email/sending/subdomains')) return this.sendingCall(id, rest, call);

    if (rest.startsWith('dns_records')) return this.dnsCall(id, rest, call);

    return null;
  }

  readonly secrets = new Map<string, string>();

  scriptExists = false;

  /** The bindings the last version carried, as `…/settings` answers them: secrets by name only. */
  private bindings: { type: string; name: string; text?: string; class_name?: string }[] = [];

  /** Each version's `workers/tag`, as `…/versions?deployable=true` lists it. */
  readonly tags = new Map<string, string>();

  /** Other Workers the account runs, beside the one a run uploads. */
  readonly otherScripts: string[] = [];

  /** Null: the account has no workers.dev subdomain yet, which the API answers 404. */
  subdomain: string | null = 'acme';

  /** Zones added by `POST /zones`, not active until their nameservers are set. */
  readonly pendingZones = new Set<string>();

  /** The account, its user and its Workers, as the page reads them. */
  private accountCall(call: CloudflareCall): CloudflareHttpResponse | null {
    const scripts = call.path.endsWith('/workers/scripts');
    const zone = /^\/zones\/([^/?]+)$/u.exec(call.path)?.[1];

    if (call.path === '/user') return this.ok({ id: 'user-1', email: INPUTS.ownerEmail });

    if (scripts) return this.ok([...this.scriptExists ? [INPUTS.instanceName] : [], ...this.otherScripts].map((id) => ({ id })));

    if (call.path.includes('/versions?deployable=true')) return this.ok({ items: this.versions.map((id) => ({ id, annotations: { 'workers/tag': this.tags.get(id) ?? '' } })) });

    if (call.path.endsWith('/workers/subdomain') && call.method === 'PUT') {
      this.subdomain = bodyText(call.body ?? {}, 'subdomain');

      return this.ok({ subdomain: this.subdomain });
    }

    if (call.path.endsWith('/workers/subdomain') && this.subdomain === null) {
      return { status: 404, body: { success: false, errors: [{ code: 10_007, message: 'This account has no workers.dev subdomain.' }], result: null } };
    }

    if (call.path.startsWith('/zones?account.id=')) {
      // Fifty to a page, as Cloudflare pages a listing.
      const page = Number(new URLSearchParams(call.path.slice(call.path.indexOf('?'))).get('page') ?? '1');

      return this.ok([...this.zones].slice((page - 1) * 50, page * 50).map(([name, id]) => this.zoneOf(name, id)));
    }

    if (call.path === '/zones' && call.method === 'POST') {
      const name = bodyText(call.body ?? {}, 'name');
      const id = sha256Hex(name).slice(0, 32);

      this.zones.set(name, id);
      this.pendingZones.add(id);

      return this.ok(this.zoneOf(name, id));
    }

    const named = [...this.zones].find(([, id]) => id === zone);

    return named === undefined ? null : this.ok(this.zoneOf(...named));
  }

  private zoneOf(name: string, id: string): JsonValue {
    return { id, name, status: this.pendingZones.has(id) ? 'pending' : 'active', name_servers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] };
  }

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
    const read = this.accountCall(call);

    if (read !== null) return read;

    // Another Worker of the account: no deployment record among its bindings.
    if (this.otherScripts.some((name) => call.path.endsWith(`/workers/scripts/${name}/settings`))) return this.ok({ bindings: [{ type: 'plain_text', name: 'GREETING', text: 'hi' }] });

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

    const computed = this.computerCall(call);

    if (computed !== null) return computed;

    const zoned = this.zoneCall(call);

    if (zoned !== null) return zoned;

    return { status: 200, body: { success: true, errors: [], result: this.answer(call) } };
  }

  async put(put: StreamedPut): Promise<CloudflareHttpResponse> {
    this.calls.push({ method: 'PUT', path: put.path, body: undefined, bearer: undefined });
    const bytes = (await new Response(put.body).arrayBuffer()).byteLength;

    if (bytes !== put.bytes) return { status: 400, body: { success: false, errors: [{ code: 10_000, message: `declared ${String(put.bytes)}, carried ${String(bytes)}` }], result: null } };
    this.objects.push(put.path);
    this.streamed.set(put.path, bytes);

    return { status: 200, body: { success: true, errors: [], result: {} } };
  }

  /** The computer's account: its tokens, its namespaces, its container applications (`computer.ts`). */
  private computerCall(call: CloudflareCall): CloudflareHttpResponse | null {
    const ok = (result: JsonValue): CloudflareHttpResponse => ({ status: 200, body: { success: true, errors: [], result } });

    if (call.path.includes('/tokens/permission_groups')) return ok([{ id: 'group-containers-write', name: 'Workers Containers Write' }]);

    if (call.path.endsWith('/tokens?per_page=50')) return ok([...this.tokens.keys()].map((name) => ({ id: `token-${name}`, name })));

    const rolled = /\/tokens\/token-(.+)\/value$/u.exec(call.path);

    if (rolled !== null) {
      const value = `rolled-${String(this.tokens.get(rolled[1] ?? '')?.length ?? 0)}`;

      this.tokens.get(rolled[1] ?? '')?.push(value);

      return ok(value);
    }

    if (call.path.endsWith('/tokens') && call.method === 'POST') {
      const name = bodyText(call.body ?? {}, 'name');

      this.tokens.set(name, ['minted-token']);

      return ok({ id: `token-${name}`, value: 'minted-token' });
    }

    if (call.path.includes('/durable_objects/namespaces')) return ok([{ id: 'ns-devbox', script: 'kinu', class: 'KinuDevbox' }, { id: 'ns-other', script: 'other', class: 'KinuDevbox' }]);

    const application = /\/containers\/applications\/(.+)$/u.exec(call.path);

    if (application !== null) {
      const name = this.applications.get(application[1] ?? '');

      return name === undefined ? { status: 404, body: { success: false, errors: [{ code: 1000, message: 'application not found' }], result: null } } : ok({ id: application[1] ?? '', name });
    }

    if (call.path.endsWith('/containers/applications')) {
      const namespace = call.body?.durable_objects;
      const id = v.parse(v.object({ namespace_id: v.string() }), namespace).namespace_id;

      this.applications.set(id, bodyText(call.body ?? {}, 'name'));

      return ok({ id });
    }

    return null;
  }

  async upload(upload: MultipartUpload): Promise<CloudflareHttpResponse> {
    const metadataPart = upload.parts.find((part) => part.name === 'metadata')?.body;

    this.calls.push({
      method: upload.method,
      path: upload.path,
      body: v.is(v.string(), metadataPart) ? parseJsonObject(metadataPart) : undefined,
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
    const metadata = v.is(v.string(), metadataPart) ? parseJsonObject(metadataPart) : {};
    const tag = v.safeParse(v.object({ 'workers/tag': v.string() }), metadata.annotations);

    this.versions.push(version);

    if (tag.success) this.tags.set(version, tag.output['workers/tag']);
    // Settings answer a secret by its name alone.
    this.bindings = uploadedBindings({ method: upload.method, path: upload.path, body: metadata, bearer: undefined })
      .map((binding) => (binding.type === 'secret_text' ? { type: binding.type, name: binding.name } : binding));

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
      return this.indexes.map((name) => ({ name, config: this.indexConfigs.get(name) ?? null }));
    }

    if (path.endsWith('/vectorize/v2/indexes')) {
      this.indexes.push(bodyText(body, 'name'));
      this.indexConfigs.set(bodyText(body, 'name'), v.parse(v.object({ dimensions: v.number(), metric: v.string() }), body.config));

      return { name: body.name ?? '' };
    }

    if (path.includes('/ai-gateway/gateways?')) return this.gateways.map((id) => ({ id }));

    if (path.endsWith('/ai-gateway/gateways')) {
      this.gateways.push(bodyText(body, 'id'));

      return { id: body.id ?? '' };
    }

    if (path.endsWith('/workers/subdomain')) return { subdomain: 'acme' };

    if (path.endsWith('/subdomain')) return { enabled: true };

    if (path.endsWith('/secrets')) {
      this.secrets.set(bodyText(body, 'name'), bodyText(body, 'text'));

      return { name: body.name ?? '' };
    }

    if (path.endsWith('/settings')) {
      const secrets = [...this.secrets.keys()].filter((name) => !this.bindings.some((binding) => binding.name === name));

      return this.scriptExists ? { logpush: false, bindings: [...this.bindings, ...secrets.map((name) => ({ type: 'secret_text', name }))] } : null;
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

/** The setup links the runs held, in order. */
let seats: { link: string; expiresAt: number }[];

let progress: DeployProgress[];

/** What an uploaded version answers; the prior version answers 200 with `PRIOR_BUILD`. */
let health: number;

let updating = false;

/** A change asking for a new setup link: minted though the root keys are kept. */
let freshLink = false;

/** The tag a run sets on its version; a second run has its own. */
let runTag = 'run-tag-1';

let served: UpdateBuild;

/** The computer's tools parts the channel serves: as many bytes as the release names for each. */
const toolsBytes = new Map<string, number>();

const healthFetch: HttpGet = async (url, headers) => {
  const part = /\/downloads\/(devbox-tools\/.+)$/u.exec(url)?.[1];

  if (part !== undefined) return toolsBytes.has(part) ? new Response(new Uint8Array(toolsBytes.get(part) ?? 0)) : new Response('missing', { status: 404 });

  if (!url.endsWith('/api/health')) throw new Error(`unexpected fetch ${url}`);

  const version = cloudflare.answering(headers);
  const prior = version === PRIOR_VERSION;

  // The stamp under `build`, beside the id of the version that answered (core/src/http/health-route.ts).
  return new Response(JSON.stringify({ ok: true, build: prior ? PRIOR_BUILD : served, versionId: version }), {
    status: prior ? 200 : health,
    headers: { 'content-type': 'application/json' },
  });
};

async function contextFor(inputs: DeployInputs = INPUTS, manifest: ReleaseManifest = MANIFEST): Promise<DeployContext> {
  return {
    manifest,
    inputs,
    transport: cloudflare,
    artifact: artifactFor(manifest),
    vault,
    seat: { hold: async (link, expiresAt) => { seats.push({ link, expiresAt }); } },
    facts: factsFrom(await ledger.rows()),
    http: healthFetch,
    update: updating,
    freshSetupLink: freshLink,
    tag: runTag,
    note: () => undefined,
  };
}

async function run(inputs: DeployInputs = INPUTS, manifest: ReleaseManifest = MANIFEST): Promise<DeployStepRow[]> {
  const outcome = await runDeployPlan(
    deployPlan(manifest, inputs),
    await contextFor(inputs, manifest),
    ledger,
    (event) => progress.push(event),
  );

  return [...outcome.rows];
}

beforeEach(async () => {
  cloudflare = new FakeCloudflare();
  ledger = new ArrayLedger();
  vault = new MemoryVault();
  seats = [];
  progress = [];
  health = 200;
  updating = false;
  freshLink = false;
  runTag = 'run-tag-1';
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
    expect(named).not.toContain('KinuDevbox');
    expect(bindings.find((binding) => binding.name === 'AUTH_KV')).toMatchObject({
      type: 'kv_namespace', namespace_id: 'id-kinu-auth-kv',
    });
    // Wrangler's own metadata for a `browser` block; an unknown type fails the whole upload.
    expect(bindings.find((binding) => binding.name === 'BROWSER')).toEqual({ type: 'browser', name: 'BROWSER' });
    expect(upload?.body?.migrations).toEqual({ new_tag: 'v1', new_sqlite_classes: ['OrchestratorAgent', 'KinuDevbox'] });
    expect(upload?.body?.compatibility_date).toBe('2025-12-01');
  });

  test('sends the carried vars and the deployment\'s own, never kinu.run\'s', async () => {
    await run();

    const upload = cloudflare.calls.find((call) => call.path.endsWith('/workers/scripts/kinu'));
    const bindings = uploadedBindings(upload);
    const plain = bindings.filter((binding) => binding.type === 'plain_text');

    expect(plain.find((binding) => binding.name === 'SANDBOX_TRANSPORT')?.text).toBe('rpc');
    // The flow configures no OAuth client (every client id is kinu.run's), so the self-host declares none.
    expect(plain.find((binding) => binding.name === 'SIGN_IN_PROVIDERS')?.text).toBe('');
    expect(plain.map((binding) => binding.name)).not.toContain('DEV_USER_EMAIL');
    expect(bindings.filter((binding) => binding.type === 'secret_text').map((binding) => binding.name).sort())
      .toEqual([...MINTED_SECRETS, FIRST_OWNER_LINK_SECRET].sort());
  });

  /** The mail vars the run uploaded: EMAIL_DOMAIN, then MAIL_ACCOUNTS. */
  const mailVars = async (inputs: DeployInputs): Promise<(string | undefined)[]> => {
    await run(inputs);
    const plain = uploadedBindings(cloudflare.calls.find((call) => call.path.endsWith('/workers/scripts/kinu'))).filter((binding) => binding.type === 'plain_text');

    return ['EMAIL_DOMAIN', 'MAIL_ACCOUNTS'].map((name) => plain.find((binding) => binding.name === name)?.text);
  };

  test('the mail domain is onboarded: routing to the Worker, sending with its records, and DMARC where there was none', async () => {
    cloudflare.zones.set('raman.dev', 'zone-raman');
    const rows = await run({ ...INPUTS, mailDomain: 'raman.dev' });

    expect(rows.find((row) => row.id === 'mail')).toMatchObject({ state: 'done' });
    expect([...cloudflare.routing.enabled]).toEqual(['zone-raman']);
    expect(cloudflare.routing.catchAll.get('zone-raman')).toMatchObject({ matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: ['kinu'] }] });
    // Sending wrote its bounce records and a DMARC of its own; the step leaves the records, and the DMARC is its own,
    // report-only, since the domain had none before.
    expect(cloudflare.dns.map((record) => `${record.type} ${record.name} ${record.content}`)).toEqual([
      'MX cf-bounce.raman.dev route1.mx.cloudflare.net',
      'TXT cf-bounce._domainkey.raman.dev "v=DKIM1; h=sha256; k=rsa; p=MII" "BIjAN"',
      'TXT _dmarc.raman.dev v=DMARC1; p=none; rua=mailto:dmarc@raman.dev',
    ]);
  });

  test('a domain already sending is onboarded again without a second sending domain, its records read by its tag', async () => {
    cloudflare.zones.set('raman.dev', 'zone-raman');
    cloudflare.routing.sending.set('zone-raman', 'raman.dev');
    cloudflare.dns.push(
      { zone: 'zone-raman', type: 'MX', name: 'cf-bounce.raman.dev', content: 'route1.mx.cloudflare.net', priority: 32, locked: true },
      { zone: 'zone-raman', type: 'TXT', name: 'cf-bounce._domainkey.raman.dev', content: '"v=DKIM1; h=sha256; k=rsa; p=MII" "BIjAN"', locked: true },
      { zone: 'zone-raman', type: 'TXT', name: '_dmarc.raman.dev', content: 'v=DMARC1; p=none; rua=mailto:dmarc@raman.dev' },
    );
    const rows = await run({ ...INPUTS, mailDomain: 'raman.dev' });

    expect(rows.find((row) => row.id === 'mail')).toMatchObject({ state: 'done', detail: expect.stringContaining('Mail onboarded on raman.dev') });
    expect(cloudflare.dns.map((record) => `${record.type} ${record.name}`)).toEqual(['MX cf-bounce.raman.dev', 'TXT cf-bounce._domainkey.raman.dev', 'TXT _dmarc.raman.dev']);
  });

  test('a domain\'s own DMARC and the records it already holds are kept, not written again', async () => {
    cloudflare.zones.set('raman.dev', 'zone-raman');
    cloudflare.dns.push(
      { zone: 'zone-raman', type: 'TXT', name: '_dmarc.raman.dev', content: 'v=DMARC1; p=quarantine' },
      { zone: 'zone-raman', type: 'MX', name: 'cf-bounce.raman.dev', content: 'route1.mx.cloudflare.net' },
    );
    await run({ ...INPUTS, mailDomain: 'raman.dev' });

    expect(cloudflare.dns.map((record) => record.content)).toEqual([
      'v=DMARC1; p=quarantine', 'route1.mx.cloudflare.net', 'route1.mx.cloudflare.net', '"v=DKIM1; h=sha256; k=rsa; p=MII" "BIjAN"',
    ]);
  });

  test('what the token may not do is asked of the owner by name, and the deployment goes on', async () => {
    cloudflare.zones.set('raman.dev', 'zone-raman');
    cloudflare.forbiddenUnder.push('email/routing', 'dns_records');
    const rows = await run({ ...INPUTS, mailDomain: 'raman.dev' });
    const asked = progress.flatMap((event) => (event.kind === 'step-note' && event.id === 'mail' ? [event.note] : []));

    expect(rows.find((row) => row.id === 'mail')).toMatchObject({ state: 'done', detail: expect.stringContaining('needs 2 things from you') });
    expect(rows.find((row) => row.id === 'smoke')?.state).toBe('done');
    expect(asked.some((note) => note.includes('catch-all to "Send to a Worker: kinu"'))).toBe(true);
    expect(asked.some((note) => note.includes('TXT _dmarc.raman.dev v=DMARC1; p=none; rua=mailto:dmarc@raman.dev'))).toBe(true);
  });

  test('a mail domain that is not a zone of the account is named, and mail stays off', async () => {
    const rows = await run({ ...INPUTS, mailDomain: 'raman.dev' });

    expect(rows.find((row) => row.id === 'mail')?.detail).toBe('Mail is off: raman.dev is not a zone this token can read.');
    expect(cloudflare.routing.enabled.size).toBe(0);
  });

  test('a deployment whose owner gave no mail answers has no mail domain, and only its operators may claim', async () => {
    expect(await mailVars(INPUTS)).toEqual(['', 'operators']);
  });

  test('the owner\'s mail domain, and opening addresses to everyone, are sent as the deploy\'s answers', async () => {
    expect(await mailVars({ ...INPUTS, mailDomain: 'raman.dev', mailAccounts: 'everyone' })).toEqual(['raman.dev', 'everyone']);
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

describe('what a run asks, makes and hands over', () => {
  /** A release that requires a key only its deployer can supply. */
  const WITH_REQUIRED_KEY: ReleaseManifest = {
    ...MANIFEST,
    secrets: [...MANIFEST.secrets, { name: 'OPENAI_API_KEY', handling: 'prompted', required: true, prompt: 'an OpenAI key' }],
  };

  /** A release whose computer reads the registry token the run mints for it. */
  const WITH_COMPUTER_TOKEN: ReleaseManifest = {
    ...MANIFEST,
    secrets: [...MANIFEST.secrets, { name: 'DEVBOX_REGISTRY_TOKEN', handling: 'prompted', required: true, prompt: 'Containers Edit' }],
  };

  test('asks Cloudflare only for scopes its OAuth catalog names', () => {
    // kinu.run 2026-10-20: the authorize endpoint refused `account:read` with invalid_scope.
    expect(CLOUDFLARE_DEPLOY_SCOPES.filter((scope) => scope.includes(':'))).toEqual([]);
    expect(CLOUDFLARE_DEPLOY_SCOPES).toContain('offline_access');
  });

  test('a run that would stop at a missing secret stops before it makes anything', async () => {
    const rows = await run(INPUTS, WITH_REQUIRED_KEY);

    expect(rows.find((row) => row.state === 'failed')).toMatchObject({ id: 'account', failure: { detail: expect.stringContaining('OPENAI_API_KEY') } });
    expect(cloudflare.namespaces).toEqual([]);
    expect(cloudflare.buckets).toEqual([]);
  });

  test('the computer\'s registry token is never asked of a person', async () => {
    const rows = await run(INPUTS, WITH_COMPUTER_TOKEN);

    expect(rows.every((row) => row.state === 'done')).toBe(true);
  });

  test('makes no Access application: the first owner signs in through a one-time setup link', async () => {
    const before = Date.now();
    const rows = await run();
    const [seat] = seats;
    const token = new URL(seat?.link ?? 'https://absent.invalid').searchParams.get('setup') ?? '';

    const bound = uploadedBindings(cloudflare.calls.find((call) => call.path.endsWith('/workers/scripts/kinu')))
      .find((binding) => binding.name === FIRST_OWNER_LINK_SECRET);

    expect(cloudflare.calls.filter((call) => call.path.includes('/access/'))).toEqual([]);
    expect(seat?.link.startsWith('https://kinu.acme.workers.dev/login?setup=')).toBe(true);
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(seat?.expiresAt ?? 0).toBeGreaterThanOrEqual(before + FIRST_OWNER_LINK_MS);
    // The Worker holds the token's digest, its lapse and the owner's email; never the token.
    expect(bound).toMatchObject({ type: 'secret_text', text: `${sha256Hex(token)}.${String(seat?.expiresAt)}.owner@example.com` });
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(await vault.names()).toEqual([]);
  });
});

describe('the computer', () => {
  const SHA = 'e'.repeat(64);

  /** A release whose computer runs on the managed image and reads two tools parts from the store bucket. */
  const WITH_COMPUTER: ReleaseManifest = {
    ...MANIFEST,
    secrets: [...MANIFEST.secrets, { name: 'DEVBOX_REGISTRY_TOKEN', handling: 'prompted', required: true, prompt: 'Containers Edit' }],
    computer: {
      className: 'KinuDevbox', bucket: 'BACKUP_BUCKET',
      tools: { sha256: SHA, parts: [{ key: `devbox-tools/${SHA}.tgz.0`, bytes: 5 }, { key: `devbox-tools/${SHA}.tgz.1`, bytes: 3 }] },
    },
  };

  const COMPUTER_INPUTS: DeployInputs = { ...INPUTS, sandbox: true };

  const toolPuts = () => cloudflare.calls.filter((call) => call.method === 'PUT' && call.path.includes('/objects/devbox-tools/'));

  const applicationPosts = () => cloudflare.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/containers/applications'));

  beforeEach(() => {
    toolsBytes.clear();

    for (const part of WITH_COMPUTER.computer?.tools.parts ?? []) toolsBytes.set(part.key, part.bytes);
  });

  test('copies its tools, mints its registry token and makes its application on no image', async () => {
    const rows = await run(COMPUTER_INPUTS, WITH_COMPUTER);
    const upload = cloudflare.calls.find((call) => call.path.endsWith('/workers/scripts/kinu'));
    const bindings = uploadedBindings(upload);

    expect(rows.every((row) => row.state === 'done')).toBe(true);
    expect([...cloudflare.streamed]).toEqual([
      [`/accounts/${INPUTS.accountId}/r2/buckets/kinu-backups/objects/devbox-tools/${SHA}.tgz.0`, 5],
      [`/accounts/${INPUTS.accountId}/r2/buckets/kinu-backups/objects/devbox-tools/${SHA}.tgz.1`, 3],
    ]);
    expect([...cloudflare.tokens]).toEqual([['kinu computer (Kinu)', ['minted-token']]]);
    expect(cloudflare.calls.find((call) => call.method === 'POST' && call.path.endsWith('/tokens'))?.body).toEqual({
      name: 'kinu computer (Kinu)',
      policies: [{ effect: 'allow', resources: { [`com.cloudflare.api.account.${INPUTS.accountId}`]: '*' }, permission_groups: [{ id: 'group-containers-write' }] }],
    });
    expect(applicationPosts().map((call) => call.body)).toEqual([
      { name: 'kinu-kinudevbox', scheduling_policy: 'durable_object', durable_objects: { namespace_id: 'ns-devbox' } },
    ]);
    expect(upload?.body?.containers).toEqual([{ class_name: 'KinuDevbox' }]);
    expect(bindings.find((binding) => binding.name === 'KinuDevbox')).toMatchObject({ type: 'durable_object_namespace', class_name: 'KinuDevbox' });
    expect(bindings.find((binding) => binding.name === 'DEVBOX_REGISTRY_TOKEN')).toEqual({ type: 'secret_text', name: 'DEVBOX_REGISTRY_TOKEN', text: 'minted-token' });
  });

  test('a second sitting copies nothing again and makes no second application, and rolls the token it lost', async () => {
    await run(COMPUTER_INPUTS, WITH_COMPUTER);
    ledger = new ArrayLedger();
    await vault.write(REFRESH_TOKEN_KEY, 'refresh-token-value');
    await vault.write(DEPLOY_CLIENT_ID_KEY, 'deploy-client-id');

    const rows = await run(COMPUTER_INPUTS, WITH_COMPUTER);

    expect(rows.every((row) => row.state === 'done')).toBe(true);
    expect(toolPuts()).toHaveLength(2);
    expect(applicationPosts()).toHaveLength(1);
    expect([...cloudflare.tokens]).toEqual([['kinu computer (Kinu)', ['minted-token', 'rolled-1']]]);
  });

  test('a deployment without it runs none of its steps and binds no container', async () => {
    const rows = await run(INPUTS, WITH_COMPUTER);
    const upload = cloudflare.calls.find((call) => call.path.endsWith('/workers/scripts/kinu'));

    expect(rows.every((row) => row.state === 'done')).toBe(true);
    expect(cloudflare.calls.filter((call) => /\/tokens|\/containers\/|devbox-tools/u.test(call.path))).toEqual([]);
    expect(upload?.body?.containers).toBeUndefined();
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
      // The catalog reads a shared code by the path Cloudflare refused.
      endpoint: `/accounts/${INPUTS.accountId}/r2/buckets?per_page=100`,
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

  // core-rest review P1-23: a same-name index of another shape read as ready, and every vector written to it was refused.
  test('an index of another shape under the release\'s name stops the run there, naming both shapes', async () => {
    cloudflare.indexes.push('kinu-memory');
    cloudflare.indexConfigs.set('kinu-memory', { dimensions: 768, metric: 'cosine' });

    const rows = await run();
    const refused = rows.find((row) => row.id === 'vectorize');

    expect(refused?.state).toBe('failed');
    expect(refused?.failure?.detail).toContain('768 dimensions');
    expect(refused?.failure?.detail).toContain('384-dimension');
    expect(cloudflare.calls.some((call) => call.method === 'POST' && call.path.endsWith('/vectorize/v2/indexes'))).toBe(false);
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

  test('one published before the computer could be deployed reads as naming none', () => {
    const { computer: _named, ...older } = parseJsonObject(JSON.stringify(MANIFEST));

    expect(parseReleaseManifest(JSON.stringify(older)).computer).toBeNull();
  });

  test('takes a tools part under the tools prefix and refuses one outside it', () => {
    const part = (key: string) => ({ className: 'KinuDevbox', bucket: 'BACKUP_BUCKET', tools: { sha256: 'e'.repeat(64), parts: [{ key, bytes: 1 }] } });
    const kept = `devbox-tools/${'e'.repeat(64)}.tgz.0`;

    expect(parseReleaseManifest(manifestWith({ computer: part(kept) })).computer?.tools.parts.map((entry) => entry.key)).toEqual([kept]);
    expect(() => parseReleaseManifest(manifestWith({ computer: part('../release.json') }))).toThrow('"../release.json"');
  });

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
    expect(config).toContain('(className = "KinuDevbox", uniqueKey = "kinu-local-KinuDevbox", enableSql = true),');
    expect(config).toContain('durableObjectStorage = (localDisk = "do-state"),');
    expect(config).toContain('(name = "OrchestratorAgent", durableObjectNamespace = "OrchestratorAgent"),');
    expect(config).toContain('(name = "KinuDevbox", durableObjectNamespace = "KinuDevbox"),');

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
    runTag = 'run-tag-2';
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

describe('a replayed upload', () => {
  test('finds the version this run tagged and uploads no other', async () => {
    const first = await run();
    const version = first.find((row) => row.id === 'upload')?.facts[FACT_VERSION_ID];

    // The activation died after Cloudflare took the version and before the row said so.
    ledger.markRunning('upload');
    const again = await run();

    expect({
      versions: cloudflare.versions,
      reused: again.find((row) => row.id === 'upload')?.facts[FACT_VERSION_ID],
      tag: cloudflare.tags.get(version ?? ''),
      done: again.every((row) => row.state === 'done'),
    }).toEqual({ versions: ['version-1'], reused: version, tag: 'run-tag-1', done: true });
  });
});

describe('a change that asks for a new setup link', () => {
  test('mints the link and binds it, keeping the running version\'s root keys', async () => {
    updating = true;
    freshLink = true;
    cloudflare.serveExisting(PRIOR_VERSION);

    const rows = await run();

    const secrets = uploadedBindings(cloudflare.calls.find((call) => call.path.endsWith('/versions')))
      .filter((binding) => binding.type === 'secret_text').map((binding) => binding.name);

    expect({ done: rows.every((row) => row.state === 'done'), seats: seats.map((seat) => new URL(seat.link).pathname), secrets })
      .toEqual({ done: true, seats: ['/login'], secrets: [FIRST_OWNER_LINK_SECRET] });
  });
});

const ACCOUNT = INPUTS.accountId;

const EXAMPLE_ZONE = 'e'.repeat(32);

const R2_OFF = {
  path: `/accounts/${ACCOUNT}/r2/buckets`, status: 403, code: 10_042,
  message: 'R2 is not enabled for this account. Add a payment method to enable R2.',
};

/** The view of a run's ledger as the page reads it; the rest of what the run holds, as given. */
function viewOf(rows: readonly DeployStepRow[], held: Partial<DeployRunStanding> = {}) {
  return deployRunView({
    runId: 'run-1', account: ACCOUNT, rows, state: 'failed', mail: false, paused: null, signedOut: false,
    seat: null, pending: null, note: '', now: 0, ...held,
  });
}

describe('the page\'s view of a run', () => {
  test('a finished run is live at its address with its setup link and CLI line, in six phases without mail', async () => {
    const rows = await run();
    const view = viewOf(rows, { state: 'done', seat: seats[0] ?? null });

    expect(view).toEqual({
      runId: 'run-1', account: ACCOUNT, state: 'live',
      phase: { id: 'live', index: 6, of: 6, words: 'Going live' },
      phases: ['prepare', 'storage', 'upload', 'address', 'check', 'live'].map((id) => expect.objectContaining({ id, state: 'done' })),
      live: {
        url: 'https://kinu.acme.workers.dev', setupLink: seats[0]?.link, setupLinkExpiresAt: seats[0]?.expiresAt,
        cli: 'curl -fsSL https://kinu.acme.workers.dev/install.sh | bash',
      },
    });
  });

  test('R2 not turned on pauses in storage with Cloudflare\'s words and the dashboard page that turns it on', async () => {
    cloudflare.refuseOnce = R2_OFF;
    const view = viewOf(await run());

    expect({ state: view.state, phase: view.phase, storage: view.phases[1]?.state, paused: view.paused }).toEqual({
      state: 'paused',
      phase: { id: 'storage', index: 2, of: 6, words: 'Creating storage' },
      storage: 'running',
      paused: {
        id: 'r2', sentence: expect.stringContaining('R2'),
        action: { label: 'Turn on R2', href: `https://dash.cloudflare.com/${ACCOUNT}/r2/overview` },
        details: { message: R2_OFF.message, code: 10_042, status: 403, endpoint: `/accounts/${ACCOUNT}/r2/buckets?per_page=100` },
      },
    });
  });

  test('a refusal the catalog does not name stops the run with its words and "Retry this step"', async () => {
    cloudflare.refuseOnce = { path: `/accounts/${ACCOUNT}/vectorize/v2/indexes`, status: 400, code: 40_026, message: 'vectorize.index.invalid_config' };
    const view = viewOf(await run());

    expect({ state: view.state, vectorize: view.phases[1]?.state, refused: view.refused }).toEqual({
      state: 'refused', vectorize: 'refused',
      refused: {
        sentence: 'This step did not finish.', action: { label: 'Retry this step' },
        details: { message: 'vectorize.index.invalid_config', code: 40_026, status: 400, endpoint: `/accounts/${ACCOUNT}/vectorize/v2/indexes` },
      },
    });
  });

  test('a run that let go of its grant asks to sign in again, whatever it stopped on', async () => {
    cloudflare.refuseOnce = R2_OFF;
    const view = viewOf(await run(), { state: 'expired', signedOut: true });

    expect({ state: view.state, need: view.paused?.id, action: view.paused?.action }).toEqual({ state: 'paused', need: 'signin-again', action: { label: 'Sign in again' } });
  });

  test('a step the table does not name sits in the phase before it; mail counts only when the deployment has it', () => {
    const row = (id: string, state: DeployStepRow['state']): DeployStepRow => ({ id, seq: 0, title: id, state, attempt: 0, detail: '', notes: [], failure: null, facts: {} });

    const view = viewOf([row('account', 'done'), row('secrets', 'done'), row('upload', 'done'), row('computer-next', 'running'), row('address', 'pending')], {
      state: 'running', mail: true, note: 'kinu was taken by then, so this Kinu is kinu-2.',
    });

    expect({ state: view.state, phase: view.phase, phases: view.phases.map((phase) => [phase.id, phase.state]), note: view.phases[0]?.note }).toEqual({
      state: 'running',
      phase: { id: 'storage', index: 2, of: 7, words: 'Creating storage' },
      phases: [['prepare', 'done'], ['storage', 'waiting'], ['upload', 'running'], ['address', 'waiting'], ['mail', 'waiting'], ['check', 'waiting'], ['live', 'waiting']],
      note: 'kinu was taken by then, so this Kinu is kinu-2.',
    });
  });

  test('the catalog reads a sign-in Cloudflare refuses, and the computer on Workers Free, as needs', () => {
    expect([
      judgeRefusal({ message: 'Authentication error', code: 10_000, status: 401, endpoint: `/accounts/${ACCOUNT}` }, ACCOUNT),
      judgeRefusal({ message: 'not on this plan', status: 403, endpoint: `/accounts/${ACCOUNT}/containers/applications` }, ACCOUNT),
      // A missing permission on the computer's endpoint is a sign-in to repeat, not a plan to buy.
      judgeRefusal({ message: 'Unauthorized to access requested resource', code: 9109, status: 403, endpoint: `/accounts/${ACCOUNT}/containers/applications` }, ACCOUNT),
    ].map((judged) => ('need' in judged ? [judged.need.id, judged.need.action] : judged.refused.sentence))).toEqual([
      ['signin-again', { label: 'Sign in again' }],
      ['plan', { label: 'Upgrade to Workers Paid', href: `https://dash.cloudflare.com/${ACCOUNT}/workers/plans` }],
      ['signin-again', { label: 'Sign in again' }],
    ]);
  });
});

describe('what the page reads of an account', () => {
  test('a Kinu reads back as the answers it was made with, from its settings alone, whichever door ran it', async () => {
    const made: DeployInputs = { ...INPUTS, mailDomain: 'raman.dev', mailAccounts: 'everyone' };

    cloudflare.zones.set('raman.dev', 'zone-raman');
    cloudflare.otherScripts.push('blog');
    await run(made);

    const asked = (name: string) => settle(plannedRun(cloudflare, { id: 'user-1', email: INPUTS.ownerEmail }, { kind: 'update', account: ACCOUNT, name })
      .pipe(Effect.match({ onFailure: (error) => error.code, onSuccess: (plan) => plan.inputs })));

    expect({ kinu: await asked('kinu'), blog: await asked('blog') }).toEqual({ kinu: made, blog: 'missing' });
  });

  test('preflight reads the checklist together and says only what needs the person', async () => {
    cloudflare.subdomain = null;
    cloudflare.serveExisting(PRIOR_VERSION);
    cloudflare.otherScripts.push('kinu-2');
    cloudflare.zones.set('example.com', 'zone-example');
    cloudflare.refuseOnce = R2_OFF;

    expect(await settle(preflight(cloudflare, ACCOUNT, 0))).toEqual({
      workersSubdomain: null, suggestedName: 'kinu-3', r2: 'off', plan: 'unknown',
      zones: [expect.objectContaining({ id: 'zone-example', name: 'example.com', status: 'active' })],
      needs: [expect.objectContaining({ id: 'r2', details: expect.objectContaining({ code: 10_042 }) })],
      checkedAt: '1970-01-01T00:00:00.000Z',
    });
  });

  test('a sign-in Cloudflare refuses is one need, however many reads met it', async () => {
    cloudflare.refuseOnce = { path: `/accounts/${ACCOUNT}/workers/subdomain`, status: 401, code: 10_000, message: 'Authentication error' };

    expect((await settle(preflight(cloudflare, ACCOUNT, 0))).needs.map((need) => need.id)).toEqual(['signin-again']);
  });

  test('every zone past the first page of fifty is read, so the last is offered too', async () => {
    for (let at = 1; at <= 51; at += 1) cloudflare.zones.set(`site-${String(at).padStart(2, '0')}.example`, `zone-${String(at)}`);

    expect((await settle(preflight(cloudflare, ACCOUNT, 0))).zones.map((zone) => zone.name).at(-1)).toBe('site-51.example');
  });

  test('a name is suggested only when the account\'s Workers could be listed', async () => {
    cloudflare.refuseOnce = { path: `/accounts/${ACCOUNT}/workers/scripts`, status: 403, code: 9109, message: 'Unauthorized to access requested resource' };

    expect(await settle(preflight(cloudflare, ACCOUNT, 0))).toMatchObject({ suggestedName: '', needs: [expect.objectContaining({ id: 'signin-again' })] });
  });

  test('a mail preview Cloudflare refuses a read of fails in its words, never as records that are not there', async () => {
    cloudflare.zones.set('raman.dev', 'zone-raman');
    cloudflare.refuseOnce = { path: '/zones/zone-raman/email/routing/dns', status: 403, code: 10_000, message: 'Authentication error' };

    await expect(settle(mailPreview(cloudflare, { id: 'zone-raman', name: 'raman.dev' }))).rejects.toThrow('Authentication error');
  });

  test('a domain search names the account\'s zones, and a domain registered elsewhere as such', async () => {
    cloudflare.zones.set('example.com', 'zone-example');

    expect([
      await settle(domainsMatching(cloudflare, ACCOUNT, 'https://kinu.example.com/')),
      await settle(domainsMatching(cloudflare, ACCOUNT, 'FlourAndHearth.com')),
    ]).toEqual([
      [{ name: 'example.com', state: 'yours', zone: 'zone-example', status: 'active' }],
      [{ name: 'flourandhearth.com', state: 'elsewhere' }],
    ]);
  });

  test('mail is previewed by the step\'s own reads: what it would write, what is there, and an MX elsewhere', async () => {
    cloudflare.zones.set('raman.dev', 'zone-raman');
    cloudflare.routing.sending.set('zone-raman', 'raman.dev');
    cloudflare.dns.push(
      { zone: 'zone-raman', type: 'MX', name: 'raman.dev', content: 'mx.fastmail.com', priority: 10 },
      { zone: 'zone-raman', type: 'TXT', name: 'raman.dev', content: 'v=spf1 include:_spf.mx.cloudflare.net ~all' },
      { zone: 'zone-raman', type: 'TXT', name: '_dmarc.raman.dev', content: '"v=DMARC1; p=quarantine"' },
    );

    const preview = await settle(mailPreview(cloudflare, { id: 'zone-raman', name: 'raman.dev' }));

    expect(preview).toEqual({
      host: 'raman.dev',
      conflict: { mx: 'mx.fastmail.com', suggestion: 'mail.raman.dev' },
      writes: [
        { type: 'MX', name: 'raman.dev', content: 'route1.mx.cloudflare.net', purpose: 'receive' },
        { type: 'MX', name: 'raman.dev', content: 'route2.mx.cloudflare.net', purpose: 'receive' },
        { type: 'MX', name: 'cf-bounce.raman.dev', content: 'route1.mx.cloudflare.net.', purpose: 'send' },
        { type: 'TXT', name: 'cf-bounce._domainkey.raman.dev', content: '"v=DKIM1; h=sha256; k=rsa; p=MIIBIjAN"', purpose: 'sign' },
      ],
      kept: [
        { type: 'TXT', name: 'raman.dev', content: 'v=spf1 include:_spf.mx.cloudflare.net ~all', purpose: 'send' },
        { type: 'TXT', name: '_dmarc.raman.dev', content: 'v=DMARC1; p=quarantine', purpose: 'report' },
      ],
    });
    expect(cloudflare.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });
});

describe('the run a page asks for', () => {
  const user = { id: 'user-1', email: 'person@example.com' };

  test('a new Kinu takes the person\'s Cloudflare email, the next free name, and a workers.dev subdomain made for it', async () => {
    cloudflare.subdomain = null;
    cloudflare.serveExisting(PRIOR_VERSION);

    const planned = await settle(plannedRun(cloudflare, user, {
      kind: 'new', account: ACCOUNT, name: 'kinu', address: { kind: 'workers' }, computer: false, mail: null,
    }));

    expect({ planned, subdomain: String(cloudflare.subdomain) }).toEqual({
      planned: {
        kind: 'new', renamedFrom: 'kinu', freshSetupLink: false, pending: null,
        inputs: { ...INPUTS, instanceName: 'kinu-2', ownerEmail: 'person@example.com', mailDomain: '' },
      },
      subdomain: 'acme',
    });
  });

  test('a domain registered elsewhere is added as a zone, and the run waits on its nameservers on workers.dev', async () => {
    const planned = await settle(plannedRun(cloudflare, user, {
      kind: 'new', account: ACCOUNT, name: 'kinu', address: { kind: 'domain', domain: 'flourandhearth.com', host: 'flourandhearth.com' }, computer: false, mail: null,
    }));

    expect({ address: planned.inputs.address, pending: planned.pending }).toEqual({
      address: { kind: 'workers-dev', hostname: '', zoneId: '' },
      pending: { zoneId: sha256Hex('flourandhearth.com').slice(0, 32), domain: 'flourandhearth.com', host: 'flourandhearth.com', nameservers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] },
    });
  });

  test('a change and an update start from the deployment\'s own answers; a Worker no run made is refused', async () => {
    cloudflare.zones.set('example.com', EXAMPLE_ZONE);
    cloudflare.otherScripts.push('blog');
    await run();

    const change = await settle(plannedRun(cloudflare, user, {
      kind: 'change', account: ACCOUNT, name: 'kinu', address: { kind: 'domain', domain: 'example.com', host: 'kinu.example.com' }, setupLink: true,
    }));

    const update = await settle(plannedRun(cloudflare, user, { kind: 'update', account: ACCOUNT, name: 'kinu' }));

    const refused = await settle(plannedRun(cloudflare, user, { kind: 'update', account: ACCOUNT, name: 'blog' })
      .pipe(Effect.match({ onFailure: (error) => error.code, onSuccess: () => 'planned' })));

    expect({ change, update, refused }).toEqual({
      change: {
        kind: 'change', renamedFrom: '', freshSetupLink: true, pending: null,
        inputs: { ...INPUTS, address: { kind: 'zone', hostname: 'kinu.example.com', zoneId: EXAMPLE_ZONE }, mailDomain: '', mailAccounts: 'operators' },
      },
      update: { kind: 'update', inputs: { ...INPUTS, mailDomain: '', mailAccounts: 'operators' }, renamedFrom: '', freshSetupLink: false, pending: null },
      refused: 'missing',
    });
  });
});
