// The deployment as idempotent steps (docs/SELF-DEPLOY.md): each looks before it creates and
// records what it established as a fact, since steps may run in different DO activations.
// API shapes follow Cloudflare's v4 reference. Unmeasured premises: re-declaring migrations on a
// version upload is refused, a version upload drops secrets not named in `keep_bindings`, and a
// deployment takes a 0% version (wrangler 4.129.0 sends one).
import { Effect } from 'effect';
import * as v from 'valibot';
import { KinuError } from '../obs/index';
import { workersPlan } from './account';
import { CloudflareApiError, cloudflareResult, readEnvelope, type CloudflareHttpResponse, type CloudflareTransport, type UploadPart } from './cloudflare';
import {
  FACT_ACCOUNT_NAME, FACT_ADDRESS, FACT_ANALYTICS_OFF, FACT_GATEWAY_URL, FACT_OWNER_EMAIL,
  FACT_UPLOAD_PEAK, FACT_VERSION_ID, FACT_WORKERS_SUBDOMAIN, kvFact, type DeployContext,
} from './context';
import {
  COMPUTER_SECRETS, CREDITS_TOKEN_SECRET, DEPLOYMENT_RECORD_SECRET, MAIL_ROUTING_SECRET, DEPLOYMENT_REFRESH_SECRET, DEPLOY_CLIENT_ID_KEY, FIRST_OWNER_LINK_MS,
  FIRST_OWNER_LINK_SECRET, MINTED_SECRETS, REFRESH_TOKEN_KEY, resourceName,
  type DeployAddress, type DeployInputs, type DeploymentRecord,
} from './inputs';
import { HealthAnswerSchema, type UpdateBuild } from './update';
import type { ArtifactMember, HeldBytes } from './artifact';
import type { JsonObject, JsonValue } from '../utils/json';
import { bytesToBase64 } from '../utils/base64';
import { randomToken } from '../utils/crypto';
import { firstOwnerLinkSecret } from '../identity/builtin-sign-in';
import { releaseModuleKind, type ReleaseBinding, type ReleaseManifest, type ReleaseModules } from './manifest';
import { FRONT_OBJECTS, MAIN_SERVICE_BINDING, frontWorkerName } from './front';
import { mailRoutingRetiredStep, mailRoutingStep, mailStep, mailZoneVar } from './mail';
import { computerStep, computerTokenStep, computerToolsStep } from './computer';
import { creditsTokenStep } from './credits-token';

export interface DeployStep {
  readonly id: string;
  readonly title: string;
  /** The steps it needs done first, each earlier in the plan: what they make, or what they settle, it uses. */
  readonly after: readonly string[];
  run(context: DeployContext): Effect.Effect<string, KinuError>;
}

const NamedSchema = v.object({ id: v.optional(v.string()), name: v.optional(v.string()) });

const IdSchema = v.object({ id: v.string() });

const SubdomainSchema = v.object({ subdomain: v.string() });

const AssetSessionSchema = v.object({
  jwt: v.optional(v.string()),
  buckets: v.optional(v.array(v.array(v.string()))),
});

const VersionSchema = v.object({ id: v.string() });

const DeployedVersionSchema = v.object({ version_id: v.string(), percentage: v.number() });

type DeployedVersion = v.InferOutput<typeof DeployedVersionSchema>;

const DeploymentsSchema = v.object({ deployments: v.array(v.object({ versions: v.array(DeployedVersionSchema) })) });

const VERSION_OVERRIDE_HEADER = 'Cloudflare-Workers-Version-Overrides';

/** A version's own identifier, up to 100 bytes, as `wrangler deploy --tag` sets it. */
const VERSION_TAG = 'workers/tag';

const TaggedVersionsSchema = v.object({
  items: v.optional(v.array(v.object({ id: v.string(), annotations: v.optional(v.object({ [VERSION_TAG]: v.optional(v.string()) })) }))),
});

const ASSET_CONTENT_TYPES = {
  html: 'text/html', js: 'text/javascript', mjs: 'text/javascript',
  css: 'text/css', json: 'application/json', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
  txt: 'text/plain', map: 'application/json', wasm: 'application/wasm',
  sh: 'text/x-shellscript', wgsl: 'text/plain', tar: 'application/x-tar',
  gz: 'application/gzip', webmanifest: 'application/manifest+json',
} satisfies Record<string, string>;

// One Cloudflare bucket can exceed the `do.isolate.transient_alloc_reset` ceiling, so batches
// are bounded by bytes. A larger member travels alone; assets are uploaded whole.
const ASSET_BATCH_BYTES = 8 * 1024 * 1024;

// As bytes, so an asset is encoded straight into its body and never exists as a string.
const BASE64_ALPHABET = new TextEncoder()
  .encode('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');

export function deployPlan(manifest: ReleaseManifest, inputs: DeployInputs): readonly DeployStep[] {
  const { address } = inputs;
  // A workers.dev address belongs to the main Worker's name, so only a deployment on its own domain has a front.
  const front = address.kind === 'zone' ? manifest.front : null;

  return [
    accountStep(manifest),
    computerTokenStep(manifest),
    creditsTokenStep(),
    // Before the upload, which binds what it mints.
    mailRoutingStep(inputs),
    kvStep(manifest),
    bucketStep(manifest),
    vectorizeStep(manifest),
    gatewayStep(),
    seedStep(manifest),
    computerToolsStep(manifest),
    secretsStep(),
    uploadStep(manifest),
    // On the namespace the upload made, before the address sends anyone to it.
    computerStep(manifest),
    addressStep(manifest, inputs),
    // After the address: the catch-all names the Worker the upload made, and a failure here leaves it answering.
    mailStep(inputs),
    smokeStep(),
    promoteStep(),
    ...(front === null ? [] : [frontStep(manifest, front, address)]),
    // Once this version is live: the running one kept its token and rules until now.
    mailRoutingRetiredStep(inputs),
    // Last: it wipes the run's credentials, which a step that fails after it could no longer be retried with.
    handoverStep(manifest, front === null ? ['mail-routing-retired'] : ['mail-routing-retired', 'front']),
  ];
}

function accountStep(manifest: ReleaseManifest): DeployStep {
  return {
    id: 'account',
    title: 'Read the account',
    after: [],
    run(context: DeployContext): Effect.Effect<string, KinuError> {
      return Effect.gen(function* () {
        // Before anything is made: a run that would stop at its secrets must not leave storage behind it.
        const missing = missingSecrets(manifest, context.inputs);

        if (missing.length > 0) {
          return yield* Effect.die(new Error(`this release requires ${missing.join(', ')}, which no answer supplied`));
        }

        const account = yield* Effect.promise(async () => cloudflareResult(
          context.transport,
          { method: 'GET', path: `/accounts/${context.inputs.accountId}` },
          NamedSchema,
        ));

        // Before anything is made too: Kinu needs Workers Paid, which a Free account is told here, not at the upload.
        const { need } = yield* workersPlan(context.transport, context.inputs.accountId);

        // Its own words, so the run pauses on the plan need the page already showed.
        if (need?.details !== undefined) {
          const { status = 0, endpoint = '', message, code = 0 } = need.details;

          return yield* Effect.die(new CloudflareApiError(status, endpoint, message, [{ code, message }]));
        }

        const name = account.name ?? context.inputs.accountId;

        context.facts.set(FACT_ACCOUNT_NAME, name);
        context.facts.set(FACT_OWNER_EMAIL, context.inputs.ownerEmail);

        // Settled first: the first owner's setup link and the Worker's own origin name it.
        if (context.inputs.address.kind === 'zone') {
          context.facts.set(FACT_ADDRESS, context.inputs.address.hostname);

          return `Deploying into ${name}, answering on ${context.inputs.address.hostname}.`;
        }

        const workers = yield* Effect.promise(async () => cloudflareResult(
          context.transport,
          { method: 'GET', path: `/accounts/${context.inputs.accountId}/workers/subdomain` },
          SubdomainSchema,
        ));

        context.facts.set(FACT_WORKERS_SUBDOMAIN, workers.subdomain);
        context.facts.set(FACT_ADDRESS, `${context.inputs.instanceName}.${workers.subdomain}.workers.dev`);

        return `Deploying into ${name}, answering on ${context.inputs.instanceName}.${workers.subdomain}.workers.dev.`;
      });
    },
  };
}

function kvStep(manifest: ReleaseManifest): DeployStep {
  return {
    id: 'kv',
    title: 'Create the session store',
    after: ['account'],
    run(context: DeployContext): Effect.Effect<string, KinuError> {
      return Effect.gen(function* () {
        const wanted = manifest.bindings.filter((binding) => binding.kind === 'kv');
        const base = `/accounts/${context.inputs.accountId}/storage/kv/namespaces`;

        const existing = yield* Effect.promise(async () => cloudflareResult(
          context.transport,
          { method: 'GET', path: `${base}?per_page=100` },
          v.array(v.object({ id: v.string(), title: v.string() })),
        ));

        for (const binding of wanted) {
          const title = resourceName(context.inputs, binding.resource);
          const found = existing.find((row) => row.title === title);

          if (found !== undefined) {
            context.facts.set(kvFact(binding.binding), found.id);
            context.note(`${title} already exists.`);
            continue;
          }

          const created = yield* Effect.promise(async () => cloudflareResult(
            context.transport,
            { method: 'POST', path: base, body: { title } },
            IdSchema,
          ));

          context.facts.set(kvFact(binding.binding), created.id);
          context.note(`${title} created.`);
        }

        return `${wanted.length} KV namespace(s) ready.`;
      });
    },
  };
}

function bucketStep(manifest: ReleaseManifest): DeployStep {
  return {
    id: 'r2',
    title: 'Create the buckets',
    after: ['account'],
    run(context: DeployContext): Effect.Effect<string, KinuError> {
      return Effect.gen(function* () {
        const wanted = manifest.bindings.filter((binding) => binding.kind === 'r2');
        const base = `/accounts/${context.inputs.accountId}/r2/buckets`;

        const existing = yield* Effect.promise(async () => cloudflareResult(
          context.transport,
          { method: 'GET', path: `${base}?per_page=100` },
          v.object({ buckets: v.optional(v.array(v.object({ name: v.string() }))) }),
        ));

        const held = new Set((existing.buckets ?? []).map((bucket) => bucket.name));

        for (const binding of wanted) {
          const name = resourceName(context.inputs, binding.resource);

          if (held.has(name)) {
            context.note(`${name} already exists.`);
            continue;
          }

          yield* Effect.promise(async () => cloudflareResult(
            context.transport,
            { method: 'POST', path: base, body: { name } },
            v.object({ name: v.optional(v.string()) }),
          ));

          context.note(`${name} created.`);
        }

        return `${wanted.length} bucket(s) ready.`;
      });
    },
  };
}

function vectorizeStep(manifest: ReleaseManifest): DeployStep {
  return {
    id: 'vectorize',
    title: 'Create the memory index',
    after: ['account'],
    run(context: DeployContext): Effect.Effect<string, KinuError> {
      return Effect.gen(function* () {
        const base = `/accounts/${context.inputs.accountId}/vectorize/v2/indexes`;

        const existing = yield* Effect.promise(async () => cloudflareResult(
          context.transport,
          { method: 'GET', path: base },
          v.array(v.object({ name: v.string(), config: v.object({ dimensions: v.number(), metric: v.string() }) })),
        ));

        const held = new Map(existing.map((index) => [index.name, index.config]));

        for (const index of manifest.vectorIndexes) {
          const name = resourceName(context.inputs, index.name);
          const config = held.get(name);

          // An index of another shape binds, and refuses every vector this release writes: not ready, and not ours to drop.
          if (config !== undefined && (config.dimensions !== index.dimensions || config.metric !== index.metric)) {
            return yield* new KinuError('bad_input', `${name} already exists at ${String(config.dimensions)} dimensions, `
              + `${config.metric}, and this release writes ${String(index.dimensions)}-dimension ${index.metric} vectors, `
              + `which it would refuse. Delete ${name} in the Cloudflare dashboard (Vectorize), or deploy under another name.`);
          }

          if (config !== undefined) {
            context.note(`${name} already exists.`);
            continue;
          }

          yield* Effect.promise(async () => cloudflareResult(
            context.transport,
            {
              method: 'POST',
              path: base,
              body: { name, config: { dimensions: index.dimensions, metric: index.metric } },
            },
            v.object({ name: v.optional(v.string()) }),
          ));

          context.note(`${name} created at ${index.dimensions} dimensions, ${index.metric}.`);
        }

        return `${manifest.vectorIndexes.length} index(es) ready.`;
      });
    },
  };
}

function gatewayStep(): DeployStep {
  return {
    id: 'ai-gateway',
    title: 'Create the AI gateway',
    after: ['account'],
    run(context: DeployContext): Effect.Effect<string, KinuError> {
      return Effect.gen(function* () {
        const accountId = context.inputs.accountId;
        const id = context.inputs.instanceName;
        const base = `/accounts/${accountId}/ai-gateway/gateways`;

        const existing = yield* Effect.promise(async () => cloudflareResult(
          context.transport,
          { method: 'GET', path: `${base}?per_page=100` },
          v.array(v.object({ id: v.string() })),
        ));

        if (!existing.some((gateway) => gateway.id === id)) {
          yield* Effect.promise(async () => cloudflareResult(
            context.transport,
            {
              method: 'POST',
              path: base,
              // Every field the reference requires: one missing is refused, code 7001 "Required" (f44999, 2026-10-21).
              body: { id, cache_invalidate_on_update: false, cache_ttl: 0, collect_logs: true, rate_limiting_interval: 0, rate_limiting_limit: 0 },
            },
            v.object({ id: v.optional(v.string()) }),
          ));
        }

        const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${id}/workers-ai/v1`;

        context.facts.set(FACT_GATEWAY_URL, url);

        return `Gateway ${id} ready.`;
      });
    },
  };
}

function seedStep(manifest: ReleaseManifest): DeployStep {
  return {
    id: 'seed',
    title: 'Seed the runtime cache',
    after: ['r2'],
    run(context: DeployContext): Effect.Effect<string, KinuError> {
      return Effect.gen(function* () {
        const seed = manifest.seed;

        if (seed === null) {
          return 'This release publishes no runtime cache seed; hosted runtimes stay absent.';
        }

        const index = yield* Effect.promise(async () => context.http(seed.url));

        if (!index.ok) {
          return yield* Effect.die(new Error(`the runtime cache seed at ${seed.url} answered HTTP ${index.status}`));
        }

        const objects = v.parse(
          v.object({ objects: v.array(v.object({ key: v.string(), url: v.pipe(v.string(), v.url()) })) }),
          yield* Effect.promise(async () => index.json()),
        );

        const bucket = resourceName(context.inputs, seed.bucket);
        let uploaded = 0;

        for (const object of objects.objects) {
          const path = `/accounts/${context.inputs.accountId}/r2/buckets/${bucket}/objects/${object.key}`;

          if (yield* Effect.promise(async () => objectExists(context.transport, path))) continue;
          const body = yield* Effect.promise(async () => context.http(object.url));

          if (!body.ok) return yield* Effect.die(new Error(`${object.url} answered HTTP ${body.status}`));

          yield* Effect.promise(async () => context.transport.upload({
            method: 'PUT',
            path,
            parts: [{
              name: 'file',
              contentType: 'application/octet-stream',
              body: new Uint8Array(await body.arrayBuffer()),
            }],
          }));
          uploaded += 1;
        }

        return `${String(uploaded)} of ${String(objects.objects.length)} toolchain object(s) uploaded; the rest were already there.`;
      });
    },
  };
}

function secretsStep(): DeployStep {
  return {
    id: 'secrets',
    title: 'Mint the deployment secrets',
    after: ['account'],
    run(context: DeployContext): Effect.Effect<string, KinuError> {
      return Effect.gen(function* () {
        // Runs before the upload: secrets are bindings of a version.
        // Root keys are minted once; re-minting `CREDENTIAL_ENCRYPTION_KEY` would make stored
        // credentials unreadable. Updates carry them via `keep_bindings`.
        if (context.update && !context.freshSetupLink) {
          return `${MINTED_SECRETS.length} secret(s) kept from the running version.`;
        }

        for (const name of context.update ? [] : MINTED_SECRETS) {
          if ((yield* Effect.promise(async () => context.vault.read(name))) !== null) continue;
          const bytes = new Uint8Array(32);

          crypto.getRandomValues(bytes);
          yield* Effect.promise(async () => context.vault.write(name, bytesToBase64(bytes)));
        }

        const supplied = context.inputs.providerKeyNames.length;
        const address = context.facts.get(FACT_ADDRESS);

        if (address === undefined) return yield* Effect.die(new Error('the account step settled no address for the setup link'));
        yield* Effect.promise(async () => mintFirstOwnerLink(context, address));

        return `${MINTED_SECRETS.length} secret(s) ${context.update ? 'kept' : 'minted'}, ${supplied} supplied, `
          + `and a one-time setup link for ${context.inputs.ownerEmail}.`;
      });
    },
  };
}

/** What the release requires and this run neither mints nor was given: the computer's registry token is the computer's
 *  steps' to mint, and only a deployment with the computer has one. */
function missingSecrets(manifest: ReleaseManifest, inputs: DeployInputs): readonly string[] {
  return manifest.secrets
    .filter((secret) => secret.required && secret.handling === 'prompted')
    .filter((secret) => ![...MINTED_SECRETS, ...COMPUTER_SECRETS].includes(secret.name) && !inputs.providerKeyNames.includes(secret.name))
    .map((secret) => secret.name);
}

/** The first owner's seat (docs/SELF-DEPLOY-FLOW.md § 9): the Worker holds the token's digest, its lapse and the owner's
 *  email; the run keeps the token to show its link, and nothing else holds it. */
async function mintFirstOwnerLink(context: DeployContext, address: string): Promise<void> {
  const token = randomToken(32);
  const expiresAt = Date.now() + FIRST_OWNER_LINK_MS;

  await context.vault.write(FIRST_OWNER_LINK_SECRET, firstOwnerLinkSecret(token, expiresAt, context.inputs.ownerEmail));
  await context.seat.hold(`https://${address}/login?setup=${token}`, expiresAt);
}

/** Asset session first, then one walk: assets go out in bounded batches, modules are kept
 *  because a version is one multipart request. */
function uploadStep(manifest: ReleaseManifest): DeployStep {
  return {
    id: 'upload',
    title: 'Upload the Worker',
    after: ['computer-token', 'credits-token', 'mail-routing', 'kv', 'r2', 'vectorize', 'ai-gateway', 'seed', 'secrets'],
    run(context: DeployContext): Effect.Effect<string, KinuError> {
      return Effect.gen(function* () {
        const accountId = context.inputs.accountId;
        const script = context.inputs.instanceName;
        const exists = yield* Effect.promise(async () => scriptExists(context.transport, accountId, script));
        // Once per run (docs/SELF-DEPLOY-FLOW.md § 7): a replay after the version landed finds it by this run's tag.
        const tagged = exists ? yield* Effect.promise(async () => taggedVersion(context, script)) : undefined;

        if (tagged !== undefined) {
          context.facts.set(FACT_VERSION_ID, tagged);

          return `Version ${tagged} was already uploaded by this run.`;
        }

        const path = exists
          ? `/accounts/${accountId}/workers/scripts/${script}/versions`
          : `/accounts/${accountId}/workers/scripts/${script}`;

        let { response, carried } = yield* uploadVersion(context, manifest, path, exists);

        // An account with Analytics Engine off refuses a version that binds a dataset (10089, the owner's free account,
        // 2026-10-21), and no API turns it on. The datasets are optional: usage analytics are off on such a deployment,
        // and its one writer writes nothing (core obs/analytics/writer.ts). The second upload's assets are already held
        // by Cloudflare, so it carries modules alone.
        if (refusedFor(response, ANALYTICS_ENGINE_OFF) && context.facts.get(FACT_ANALYTICS_OFF) === undefined) {
          context.facts.set(FACT_ANALYTICS_OFF, 'true');
          context.note('Analytics Engine is off on this account, so usage analytics are off.');
          ({ response, carried } = yield* uploadVersion(context, manifest, path, exists));
        }

        const uploaded = readEnvelope(path, response, VersionSchema);
        // A first upload answers the script; its deployment names the version.
        const version = exists ? uploaded.id : servingVersion(yield* Effect.promise(async () => liveDeployment(context)), '');
        const peak = context.artifact.held.peak();

        if (version === undefined) return yield* Effect.die(new Error(`${script} was created, and no deployment names its version`));

        context.facts.set(FACT_VERSION_ID, version);
        context.facts.set(FACT_UPLOAD_PEAK, String(peak));

        return `Version ${version} uploaded with ${carried.modules.length} module(s), `
          + `holding ${mebibytes(peak)} at the peak.`;
      });
    },
  };
}

/** Cloudflare's code for a version bound to a dataset on an account with Analytics Engine off. */
const ANALYTICS_ENGINE_OFF = 10_089;

/** Whether `response` is Cloudflare refusing with `code`. */
function refusedFor(response: CloudflareHttpResponse, code: number): boolean {
  const errors = v.safeParse(v.object({ errors: v.nullish(v.array(v.object({ code: v.number() }))) }), response.body);

  return response.status >= 400 && errors.success && (errors.output.errors ?? []).some((error) => error.code === code);
}

/** The assets, then the modules with the version's metadata, in one upload; its answer as Cloudflare gave it. */
function uploadVersion(
  context: DeployContext, manifest: ReleaseManifest, path: string, exists: boolean,
): Effect.Effect<{ readonly response: CloudflareHttpResponse; readonly carried: CarriedRelease }, KinuError> {
  return Effect.gen(function* () {
    const session = yield* openAssetSession(context, manifest, context.inputs.instanceName);
    const carried = yield* carryArtifact(context, manifest.worker, session);
    const metadata = yield* Effect.promise(async () => versionMetadata(context, manifest, carried.token, exists));

    // The transport copies every part, so the module set is held twice in flight.
    context.artifact.held.hold(carried.bytes);

    const response = yield* Effect.promise(async () => context.transport.upload({
      method: exists ? 'POST' : 'PUT',
      path,
      parts: [
        { name: 'metadata', contentType: 'application/json', body: JSON.stringify(metadata) },
        ...carried.modules,
      ],
    }));

    context.artifact.held.release(carried.bytes * 2);

    return { response, carried };
  });
}

function addressStep(manifest: ReleaseManifest, inputs: DeployInputs): DeployStep {
  return {
    id: 'address',
    title: 'Bind the address',
    after: ['computer'],
    run(context: DeployContext): Effect.Effect<string, KinuError> {
      return Effect.gen(function* () {
        const accountId = context.inputs.accountId;
        const script = context.inputs.instanceName;

        if (inputs.address.kind === 'workers-dev') {
          yield* Effect.promise(async () => cloudflareResult(
            context.transport,
            {
              method: 'POST',
              path: `/accounts/${accountId}/workers/scripts/${script}/subdomain`,
              body: { enabled: true, previews_enabled: false },
            },
            v.object({ enabled: v.optional(v.boolean()) }),
          ));
        } else {
          // The front answers once it exists, and the smoke reaches the version under test through it; on a first run
          // the main Worker answers until the front step puts its front in place.
          const fronted = manifest.front !== null && (yield* frontHeld(context)) === 'ours';
          const front = frontWorkerName(script);

          yield* bindDomain(context, inputs.address, fronted ? front : script, fronted ? [script, front] : [script]);
        }

        const version = context.facts.get(FACT_VERSION_ID);

        if (version !== undefined) {
          const serving = servingVersion(yield* Effect.promise(async () => liveDeployment(context)), version);

          // At 0% only the smoke's override reaches it.
          yield* Effect.promise(async () => deploy(context, serving === undefined
            ? [{ version_id: version, percentage: 100 }]
            : [{ version_id: version, percentage: 0 }, { version_id: serving, percentage: 100 }]));
        }

        return `Answering on ${context.facts.get(FACT_ADDRESS) ?? ''}.`;
      });
    },
  };
}

/** Recheck while a new address or version override is still propagating. */
const SMOKE_INTERVAL_MS = 3_000;

/** One ask of the version under test: its health, `arriving` while the address or the override is still being
 *  carried, or why it failed. */
type SmokeAnswer = { readonly kind: 'answered'; readonly build: UpdateBuild | null } | { readonly kind: 'arriving' | 'failed'; readonly why: string };

function askVersion(context: DeployContext, url: string, version: string): Effect.Effect<SmokeAnswer> {
  return Effect.gen(function* () {
    const response = yield* Effect.promise(async () => context.http(url, { [VERSION_OVERRIDE_HEADER]: `${context.inputs.instanceName}="${version}"` }));

    if (response.status === 404) return { kind: 'arriving', why: `${url} answered HTTP 404` };

    if (!response.ok) return { kind: 'failed', why: `${url} answered HTTP ${response.status}` };

    const { build, versionId } = v.parse(HealthAnswerSchema, yield* Effect.promise(async () => response.json()));

    // An override not yet carried reaches the serving version, which may be this build.
    if (versionId !== version) return { kind: 'arriving', why: `${url} was answered by version ${versionId ?? 'unnamed'}, and the version under test is ${version}` };

    return { kind: 'answered', build };
  });
}

function smokeStep(): DeployStep {
  return {
    id: 'smoke',
    title: 'Check it answers',
    after: ['mail'],
    run(context: DeployContext): Effect.Effect<string, KinuError> {
      return Effect.gen(function* () {
        const address = context.facts.get(FACT_ADDRESS);
        const version = context.facts.get(FACT_VERSION_ID);

        if (address === undefined) return yield* Effect.die(new Error('no address was bound, so nothing can be checked'));

        if (version === undefined) return yield* Effect.die(new Error('no version was uploaded, so nothing can be checked'));

        // L27: lazy evidence reduces startup-linked code from 6,547 to 6,435 KiB (gcp-vm, 2026-10-29).
        const { PLATFORM_CATALOG } = yield* Effect.promise(async () => import('../platform-catalog'));
        // No published routing bound: wait four times the longest observation, then fail in the last answer's words.
        const patience = 4 * Math.max(...PLATFORM_CATALOG['workers_dev.fresh_route_404'].measurements.map((measured) => measured.value));
        const url = `https://${address}/api/health`;
        let answer = yield* askVersion(context, url, version);

        for (let waited = 0; answer.kind === 'arriving' && waited < patience; waited += SMOKE_INTERVAL_MS) {
          yield* Effect.promise(async () => context.wait(SMOKE_INTERVAL_MS));
          answer = yield* askVersion(context, url, version);
        }

        if (answer.kind !== 'answered') return yield* Effect.die(new Error(answer.why));
        const { build } = answer;

        if (build === null || build.version !== context.manifest.version || build.sha !== context.manifest.sha) {
          return yield* Effect.die(new Error(
            `${url} answers ${build?.version ?? 'an unstamped build'}`
            + ` (${build?.sha ?? 'no sha'}), and this release is ${context.manifest.version}`
            + ` (${context.manifest.sha})`,
          ));
        }

        return `Version ${version} answers ${build.version}.`;
      });
    },
  };
}

function promoteStep(): DeployStep {
  return {
    id: 'promote',
    title: 'Send it all traffic',
    after: ['smoke'],
    run(context: DeployContext): Effect.Effect<string, KinuError> {
      return Effect.gen(function* () {
        const version = context.facts.get(FACT_VERSION_ID);

        if (version === undefined) return yield* Effect.die(new Error('no version was uploaded, so nothing can take the traffic'));

        yield* Effect.promise(async () => deploy(context, [{ version_id: version, percentage: 100 }]));

        return `Version ${version} serves all traffic.`;
      });
    },
  };
}

/**
 * The front Worker its own domain is answered from (front.ts), once the main Worker it binds serves all traffic. Until
 * then the address step binds the domain to the main Worker, which answers every route itself, so a new front never
 * stands before an older main Worker. A front holds no secret: it binds the main Worker's objects and the main Worker.
 */
function frontStep(manifest: ReleaseManifest, front: ReleaseModules, address: DeployAddress): DeployStep {
  return {
    id: 'front',
    title: 'Put the front in place',
    after: ['promote'],
    run(context: DeployContext): Effect.Effect<string, KinuError> {
      return Effect.gen(function* () {
        const accountId = context.inputs.accountId;
        const main = context.inputs.instanceName;
        const script = frontWorkerName(main);

        if ((yield* frontHeld(context)) === 'foreign') {
          return yield* new KinuError('denied', `This account has another Worker named ${script}, which is not this deployment's front. Rename or delete it, then retry this step.`);
        }

        const session = yield* openAssetSession(context, manifest, script);
        const carried = yield* carryArtifact(context, front, session);
        const analytics: JsonValue[] = [];

        for (const binding of manifest.bindings) {
          if (binding.kind !== 'analytics-engine') continue;
          const wire = yield* Effect.promise(async () => wireBinding(context, manifest, binding));

          if (wire !== null) analytics.push(wire);
        }

        const metadata: JsonObject = {
          main_module: front.mainModule,
          compatibility_date: manifest.worker.compatibilityDate,
          compatibility_flags: [...manifest.worker.compatibilityFlags],
          bindings: [
            ...FRONT_OBJECTS.map((name) => ({ type: 'durable_object_namespace', name, class_name: name, script_name: main })),
            { type: 'service', name: MAIN_SERVICE_BINDING, service: main },
            { type: 'assets', name: 'ASSETS' },
            { type: 'version_metadata', name: 'CF_VERSION_METADATA' },
            ...analytics,
            ...varBindings(context, manifest),
          ],
          observability: { enabled: true },
          annotations: { [VERSION_TAG]: context.tag },
          ...assetsMetadata(carried.token),
        };

        const path = `/accounts/${accountId}/workers/scripts/${script}`;

        context.artifact.held.hold(carried.bytes);

        const response = yield* Effect.promise(async () => context.transport.upload({
          method: 'PUT',
          path,
          parts: [{ name: 'metadata', contentType: 'application/json', body: JSON.stringify(metadata) }, ...carried.modules],
        }));

        context.artifact.held.release(carried.bytes * 2);
        readEnvelope(path, response, NamedSchema);

        yield* bindDomain(context, address, script, [main, script]);

        return `${script} answers ${address.hostname}.`;
      });
    },
  };
}

/**
 * Whether the account's Worker named as this deployment's front is it: one that binds this deployment's main Worker.
 * Only Cloudflare's 404 says there is none; any other failure to read it fails the step, since a guess could overwrite
 * a Worker that is not this deployment's.
 */
function frontHeld(context: DeployContext): Effect.Effect<'ours' | 'absent' | 'foreign', KinuError> {
  return Effect.gen(function* () {
    const { accountId, instanceName } = context.inputs;
    const path = `/accounts/${accountId}/workers/scripts/${frontWorkerName(instanceName)}/settings`;
    const response = yield* Effect.promise(async () => context.transport.request({ method: 'GET', path }));

    if (response.status === 404) return 'absent';

    const { bindings } = readEnvelope(path, response, v.object({
      bindings: v.array(v.looseObject({ type: v.string(), name: v.string(), service: v.optional(v.string()) })),
    }));

    return bindings.some((binding) => binding.type === 'service' && binding.name === MAIN_SERVICE_BINDING && binding.service === instanceName)
      ? 'ours'
      : 'foreign';
  });
}

/**
 * `address` bound to `service`, as a Workers custom domain, which creates its proxied DNS record itself. A hostname has
 * one Worker, and moves only with `override_existing_origin`, while a bind to the Worker that holds it changes nothing
 * (measured on the account, 2026-10-27). It moves only between the Workers this deployment `owns`; one another Worker of
 * the account holds is refused in Cloudflare's words.
 */
function bindDomain(context: DeployContext, address: DeployAddress, service: string, owns: readonly string[]): Effect.Effect<void, KinuError> {
  return Effect.gen(function* () {
    const accountId = context.inputs.accountId;

    const bound = yield* Effect.promise(async () => cloudflareResult(
      context.transport,
      { method: 'GET', path: `/accounts/${accountId}/workers/domains?hostname=${encodeURIComponent(address.hostname)}` },
      v.array(v.object({ service: v.string() })),
    ));

    const holder = bound[0]?.service;
    const ours = holder !== undefined && holder !== service && owns.includes(holder);

    yield* Effect.promise(async () => cloudflareResult(
      context.transport,
      {
        method: 'PUT',
        path: `/accounts/${accountId}/workers/domains`,
        body: { hostname: address.hostname, zone_id: address.zoneId, service, environment: 'production', ...(ours && { override_existing_origin: true }) },
      },
      v.object({ id: v.optional(v.string()) }),
    ));
  });
}

function handoverStep(manifest: ReleaseManifest, after: readonly string[]): DeployStep {
  return {
    id: 'handover',
    title: 'Hand the deployment its own key',
    after,
    run(context: DeployContext): Effect.Effect<string, KinuError> {
      return Effect.gen(function* () {
        const accountId = context.inputs.accountId;
        const script = context.inputs.instanceName;
        const refresh = yield* Effect.promise(async () => context.vault.read(REFRESH_TOKEN_KEY));
        const clientId = yield* Effect.promise(async () => context.vault.read(DEPLOY_CLIENT_ID_KEY));

        if (refresh === null) {
          return yield* Effect.die(new Error('the run holds no refresh token, so the deployment cannot own its own key'));
        }

        if (clientId === null) {
          return yield* Effect.die(new Error('the run cannot name the OAuth client, so the deployment could never refresh'));
        }

        const record: DeploymentRecord = {
          inputs: context.inputs,
          address: context.facts.get(FACT_ADDRESS) ?? '',
          version: manifest.version,
          channelOrigin: manifest.channelOrigin,
          clientId,
          deployedAt: new Date().toISOString(),
        };

        const base = `/accounts/${accountId}/workers/scripts/${script}/secrets`;

        yield* Effect.promise(async () => cloudflareResult(
          context.transport,
          { method: 'PUT', path: base, body: { name: DEPLOYMENT_REFRESH_SECRET, text: refresh, type: 'secret_text' } },
          v.object({ name: v.optional(v.string()) }),
        ));

        yield* Effect.promise(async () => cloudflareResult(
          context.transport,
          { method: 'PUT', path: base, body: { name: DEPLOYMENT_RECORD_SECRET, text: JSON.stringify(record), type: 'secret_text' } },
          v.object({ name: v.optional(v.string()) }),
        ));

        yield* Effect.promise(async () => context.vault.wipe());

        return `${script} holds its own key; this run holds nothing.`;
      });
    },
  };
}

interface AssetSession {
  readonly token: string;
  readonly wanted: ReadonlySet<string>;
  /** By archive path. */
  readonly hashes: ReadonlyMap<string, string>;
}

/** Empty token: no assets (`keep_assets`). No wanted hashes: the token is already the completion token. */
function openAssetSession(
  context: DeployContext,
  manifest: ReleaseManifest,
  script: string,
): Effect.Effect<AssetSession, KinuError> {
  return Effect.gen(function* () {
    const prefix = `${manifest.worker.assets}/`;
    const hashes = new Map<string, string>();
    const wire: JsonObject = {};

    for (const file of manifest.files) {
      if (!file.path.startsWith(prefix) || file.assetHash === null) continue;

      hashes.set(file.path, file.assetHash);
      wire[`/${file.path.slice(prefix.length)}`] = { hash: file.assetHash, size: file.size };
    }

    if (hashes.size === 0) return { token: '', wanted: new Set(), hashes };

    const sessionPath = `/accounts/${context.inputs.accountId}/workers/scripts/${script}/assets-upload-session`;

    const session = yield* Effect.promise(async () => cloudflareResult(
      context.transport,
      { method: 'POST', path: sessionPath, body: { manifest: wire } },
      AssetSessionSchema,
    ));

    const wanted = new Set((session.buckets ?? []).flat());

    context.note(`${hashes.size} asset(s), ${wanted.size} of them to upload.`);

    return { token: session.jwt ?? '', wanted, hashes };
  });
}

interface CarriedRelease {
  readonly token: string;
  readonly modules: readonly UploadPart[];
  readonly bytes: number;
}

/** `scripts/build-worker-release.ts` orders assets before modules to lower the peak; either order installs. */
function carryArtifact(
  context: DeployContext,
  worker: ReleaseModules,
  session: AssetSession,
): Effect.Effect<CarriedRelease> {
  return Effect.gen(function* () {
    const walked = yield* Effect.promise(() => walkArtifact(context, worker, session));

    if (walked.misencoded !== null) return yield* Effect.die(new Error(walked.misencoded));

    if (walked.uploaded !== session.wanted.size) {
      return yield* Effect.die(new Error(`Cloudflare asked for ${String(session.wanted.size)} asset(s) and the release artifact carries ${String(walked.uploaded)}`));
    }

    if (walked.modules.length !== worker.modules.length) {
      return yield* Effect.die(new Error(`the release artifact carries ${String(walked.modules.length)} of the ${String(worker.modules.length)} module(s) the manifest names`));
    }

    context.note(`${walked.uploaded} asset(s) uploaded, ${walked.modules.length} module(s) held for the version.`);

    return { token: walked.token, modules: walked.modules, bytes: walked.moduleBytes };
  });
}

interface WalkedArtifact {
  readonly token: string;
  readonly modules: UploadPart[];
  readonly moduleBytes: number;
  readonly uploaded: number;
  /** The member whose base64 came out a different length than its size promised; the walk stopped there. */
  readonly misencoded: string | null;
}

async function walkArtifact(context: DeployContext, worker: ReleaseModules, session: AssetSession): Promise<WalkedArtifact> {
  const held = context.artifact.held;
  const prefix = `${worker.modulesPath}/`;
  const named = new Set(worker.modules);
  const modules: UploadPart[] = [];
  let moduleBytes = 0;
  let batch: UploadPart[] = [];
  let batchBytes = 0;
  let uploaded = 0;
  let token = session.token;
  // Cloudflare asks for each content hash once: two assets with the same bytes are one upload (the owner's free account,
  // 2026-10-21: 631 assets, 630 hashes asked for, and the run counted the second copy as an upload it was not asked for).
  const sent = new Set<string>();

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    token = await sendAssets(context, batch, token, held);
    uploaded += batch.length;
    held.release(batchBytes);
    batch = [];
    batchBytes = 0;
  };

  for await (const member of context.artifact.members()) {
    const moduleName = member.path.startsWith(prefix) ? member.path.slice(prefix.length) : '';

    if (named.has(moduleName)) {
      // The assets come first (`scripts/build-worker-release.ts`): the last batch goes before the module set is held.
      await flush();
      const body = await member.bytes();

      held.hold(body.length);
      moduleBytes += body.length;
      modules.push({
        name: moduleName,
        filename: moduleName,
        contentType: releaseModuleKind(moduleName) === 'wasm' ? 'application/wasm' : 'application/javascript+module',
        body,
      });
      continue;
    }

    const hash = session.hashes.get(member.path);

    if (hash === undefined || !session.wanted.has(hash) || sent.has(hash)) continue;
    sent.add(hash);

    // Flush before this member joins, so an oversized member travels alone.
    if (batchBytes + member.size > ASSET_BATCH_BYTES) await flush();

    const { encoded: body, at } = await base64Member(member, held);

    if (at !== body.length) {
      return { token, modules, moduleBytes, uploaded, misencoded: `${member.path} is ${String(member.size)} bytes and encoded to ${String(at)}` };
    }

    batch.push({ name: hash, filename: hash, contentType: contentTypeOf(member.path), body });
    batchBytes += body.length;
  }

  await flush();

  return { token, modules, moduleBytes, uploaded, misencoded: null };
}

/** Charges and releases only the transport's copy; the parts belong to the caller. */
async function sendAssets(
  context: DeployContext,
  parts: readonly UploadPart[],
  token: string,
  held: HeldBytes,
): Promise<string> {
  const bytes = parts.reduce((total, part) => total + part.body.length, 0);
  const uploadPath = `/accounts/${context.inputs.accountId}/workers/assets/upload?base64=true`;

  held.hold(bytes);

  const response = await context.transport.upload({ method: 'POST', path: uploadPath, bearer: token, parts });

  held.release(bytes);
  const answer = readEnvelope(uploadPath, response, v.object({ jwt: v.optional(v.string()) }));

  return answer.jwt ?? token;
}

// Streams into the body; `btoa` over a whole member would hold three copies of it. `at` is how far it wrote.
async function base64Member(member: ArtifactMember, held: HeldBytes): Promise<{ readonly encoded: Uint8Array<ArrayBuffer>; readonly at: number }> {
  const encoded = new Uint8Array(Math.ceil(member.size / 3) * 4);
  const carry = new Uint8Array(3);
  let carried = 0;
  let at = 0;

  held.hold(encoded.length);

  for await (const piece of member.chunks()) {
    let from = 0;

    if (carried > 0) {
      from = Math.min(3 - carried, piece.length);
      carry.set(piece.subarray(0, from), carried);
      carried += from;

      if (carried < 3) continue;

      at = writeBase64(encoded, at, carry);
      carried = 0;
    }

    const whole = from + Math.floor((piece.length - from) / 3) * 3;

    at = writeBase64(encoded, at, piece.subarray(from, whole));

    if (whole < piece.length) {
      carry.set(piece.subarray(whole), 0);
      carried = piece.length - whole;
    }
  }

  if (carried > 0) at = writeBase64(encoded, at, carry.subarray(0, carried));

  return { encoded, at };
}

function writeBase64(out: Uint8Array, at: number, bytes: Uint8Array): number {
  let cursor = at;

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];

    out[cursor] = BASE64_ALPHABET[first >> 2] ?? 0;
    out[cursor + 1] = BASE64_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)] ?? 0;
    out[cursor + 2] = second === undefined ? 0x3d : BASE64_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)] ?? 0;
    out[cursor + 3] = third === undefined ? 0x3d : BASE64_ALPHABET[third & 0x3f] ?? 0;
    cursor += 4;
  }

  return cursor;
}

function mebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/** `?deployable=true` answers every deployable version, unpaged, each with its annotations (wrangler 4.145.0's
 *  `versions deploy --tag` resolves tags from this list). */
async function taggedVersion(context: DeployContext, script: string): Promise<string | undefined> {
  const listed = await cloudflareResult(
    context.transport,
    { method: 'GET', path: `/accounts/${context.inputs.accountId}/workers/scripts/${script}/versions?deployable=true` },
    TaggedVersionsSchema,
  );

  return (listed.items ?? []).find((item) => item.annotations?.[VERSION_TAG] === context.tag)?.id;
}

async function scriptExists(transport: CloudflareTransport, accountId: string, script: string): Promise<boolean> {
  const response = await transport.request({
    method: 'GET',
    path: `/accounts/${accountId}/workers/scripts/${script}/settings`,
  });

  return response.status >= 200 && response.status < 300;
}

async function liveDeployment(context: DeployContext): Promise<readonly DeployedVersion[]> {
  const listed = await cloudflareResult(
    context.transport,
    { method: 'GET', path: `/accounts/${context.inputs.accountId}/workers/scripts/${context.inputs.instanceName}/deployments` },
    DeploymentsSchema,
  );

  return listed.deployments.at(0)?.versions ?? [];
}

function servingVersion(versions: readonly DeployedVersion[], except: string): string | undefined {
  let serving: DeployedVersion | undefined;

  for (const entry of versions) {
    if (entry.version_id !== except && (serving === undefined || entry.percentage > serving.percentage)) serving = entry;
  }

  return serving?.version_id;
}

async function deploy(context: DeployContext, versions: readonly DeployedVersion[]): Promise<void> {
  await cloudflareResult(
    context.transport,
    {
      method: 'POST',
      path: `/accounts/${context.inputs.accountId}/workers/scripts/${context.inputs.instanceName}/deployments`,
      body: {
        strategy: 'percentage',
        versions: versions.map((entry) => ({ version_id: entry.version_id, percentage: entry.percentage })),
      },
    },
    v.object({ id: v.optional(v.string()) }),
  );
}

async function objectExists(transport: CloudflareTransport, path: string): Promise<boolean> {
  const response = await transport.request({ method: 'HEAD', path });

  return response.status >= 200 && response.status < 300;
}

async function versionMetadata(
  context: DeployContext,
  manifest: ReleaseManifest,
  assetsToken: string,
  exists: boolean,
): Promise<JsonObject> {
  const bindings: JsonValue[] = [];

  for (const binding of manifest.bindings) {
    const wire = await wireBinding(context, manifest, binding);

    if (wire !== null) bindings.push(wire);
  }

  bindings.push(...varBindings(context, manifest));

  for (const name of [...MINTED_SECRETS, FIRST_OWNER_LINK_SECRET, ...COMPUTER_SECRETS, MAIL_ROUTING_SECRET, CREDITS_TOKEN_SECRET, ...context.inputs.providerKeyNames]) {
    const value = await context.vault.read(name);

    if (value !== null) bindings.push({ type: 'secret_text', name, text: value });
  }

  const classes = manifest.migrations.flatMap((migration) => migration.newSqliteClasses);
  const tag = manifest.migrations.at(-1)?.tag ?? 'v1';

  const metadata: JsonObject = {
    main_module: manifest.worker.mainModule,
    compatibility_date: manifest.worker.compatibilityDate,
    compatibility_flags: [...manifest.worker.compatibilityFlags],
    bindings,
    keep_bindings: ['secret_text', 'secret_key'],
    observability: { enabled: true },
    annotations: { [VERSION_TAG]: context.tag },
  };

  if (!exists) metadata.migrations = { new_tag: tag, new_sqlite_classes: classes };

  // The class's container, as Wrangler declares one with no image; the computer step makes its application.
  if (context.inputs.sandbox && manifest.computer !== null) metadata.containers = [{ class_name: manifest.computer.className }];

  Object.assign(metadata, assetsMetadata(assetsToken));

  return metadata;
}

/** The release's vars, as both Workers hold them. */
function varBindings(context: DeployContext, manifest: ReleaseManifest): JsonValue[] {
  return manifest.vars.flatMap((declared) => {
    if (declared.policy === 'ours') return [];
    const value = declared.policy === 'carried' ? declared.value ?? '' : derivedVar(context, declared.name);

    return value === null ? [] : [{ type: 'plain_text', name: declared.name, text: value }];
  });
}

/** Empty token: the assets the Worker holds already (`keep_assets`). Every request reaches the Worker before its assets. */
function assetsMetadata(token: string): JsonObject {
  return token === ''
    ? { keep_assets: true }
    : { assets: { jwt: token, config: { not_found_handling: 'single-page-application', run_worker_first: true } } };
}

// Null for the container (the computer's own step binds it, with its user registry) and bindings turned off.
async function wireBinding(
  context: DeployContext,
  manifest: ReleaseManifest,
  binding: ReleaseBinding,
): Promise<JsonValue | null> {
  const name = binding.binding;
  const resource = resourceName(context.inputs, binding.resource);

  switch (binding.kind) {
    case 'kv': {
      const id = context.facts.get(kvFact(name));

      return id === undefined ? null : { type: 'kv_namespace', name, namespace_id: id };
    }

    case 'r2':
      return { type: 'r2_bucket', name, bucket_name: resource };
    case 'vectorize':
      return { type: 'vectorize', name, index_name: resource };
    case 'durable-object': {
      if (!context.inputs.sandbox && manifest.migrations.some((migration) => migration.newSqliteClasses.includes(binding.resource))
        && binding.resource === 'KinuDevbox') return null;

      return { type: 'durable_object_namespace', name, class_name: binding.resource };
    }

    case 'analytics-engine':
      // Off on the account: an optional dataset is left out; a required one is bound, and Cloudflare says why it cannot be.
      return context.facts.get(FACT_ANALYTICS_OFF) !== undefined && !binding.required ? null : { type: 'analytics_engine', name, dataset: resource };
    case 'ai':
      return { type: 'ai', name };
    case 'browser':
      return { type: 'browser', name };
    case 'assets':
      return { type: 'assets', name };
    case 'version-metadata':
      return { type: 'version_metadata', name };
    case 'send-email':
      return { type: 'send_email', name };
    case 'worker-loader':
      return { type: 'worker_loader', name };
    case 'container':
      return null;
  }
}

// Null means no value; empty `PREVIEW_HOST_SUFFIX` is how previews are turned off.
function derivedVar(context: DeployContext, name: string): string | null {
  const address = context.facts.get(FACT_ADDRESS) ?? '';

  switch (name) {
    case 'CLI_PUBLIC_ORIGIN':
    case 'CLI_APPROVAL_ORIGIN':
      return address === '' ? null : `https://${address}`;
    case 'CLOUDFLARE_ACCOUNT_ID':
      return context.inputs.accountId;
    case 'AI_GATEWAY_URL':
      return context.facts.get(FACT_GATEWAY_URL) ?? null;
    case 'CONTROL_PLANE_ADMINS':
      return context.inputs.ownerEmail;
    case 'EMAIL_DOMAIN':
      return context.inputs.mailDomain ?? '';
    case 'KINU_MAIL_ZONE':
      return mailZoneVar(context);
    case 'MAIL_ACCOUNTS':
      return context.inputs.mailAccounts ?? 'operators';
    case 'PREVIEW_HOST_SUFFIX':
    case 'SIGN_IN_PROVIDERS':
      return '';
    default:
      return null;
  }
}

const CONTENT_TYPE_BY_EXTENSION = new Map<string, string>(Object.entries(ASSET_CONTENT_TYPES));

function contentTypeOf(path: string): string {
  return CONTENT_TYPE_BY_EXTENSION.get(extensionOf(path)) ?? 'application/octet-stream';
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');

  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
}
