// The deployment as idempotent steps (docs/SELF-DEPLOY.md): each looks before it creates and
// records what it established as a fact, since steps may run in different DO activations.
// API shapes follow Cloudflare's v4 reference. Unmeasured premises: re-declaring migrations on a
// version upload is refused, a version upload drops secrets not named in `keep_bindings`, and a
// deployment takes a 0% version (wrangler 4.129.0 sends one).
import * as v from 'valibot';
import { cloudflareResult, readEnvelope, type CloudflareTransport, type UploadPart } from './cloudflare';
import {
  FACT_ACCESS_APP, FACT_ACCOUNT_NAME, FACT_ADDRESS, FACT_GATEWAY_URL, FACT_OWNER_EMAIL,
  FACT_UPLOAD_PEAK, FACT_VERSION_ID, FACT_WORKERS_SUBDOMAIN, kvFact, type DeployContext,
} from './context';
import {
  DEPLOYMENT_RECORD_SECRET, DEPLOYMENT_REFRESH_SECRET, DEPLOY_CLIENT_ID_KEY, MINTED_SECRETS,
  REFRESH_TOKEN_KEY,
  type DeployInputs, type DeploymentRecord,
} from './inputs';
import { HealthAnswerSchema } from './update';
import type { ArtifactMember, HeldBytes } from './artifact';
import type { JsonObject, JsonValue } from '../utils/json';
import type { ReleaseBinding, ReleaseManifest } from './manifest';

export interface DeployStep {
  readonly id: string;
  readonly title: string;
  run(context: DeployContext): Promise<string>;
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
  return [
    accountStep(),
    kvStep(manifest),
    bucketStep(manifest),
    vectorizeStep(manifest),
    gatewayStep(),
    accessStep(),
    seedStep(manifest),
    secretsStep(manifest),
    uploadStep(manifest),
    addressStep(inputs),
    smokeStep(),
    promoteStep(),
    handoverStep(manifest),
  ];
}

function accountStep(): DeployStep {
  return {
    id: 'account',
    title: 'Read the account',
    async run(context: DeployContext): Promise<string> {
      const account = await cloudflareResult(
        context.transport,
        { method: 'GET', path: `/accounts/${context.inputs.accountId}` },
        NamedSchema,
      );

      const name = account.name ?? context.inputs.accountId;

      context.facts.set(FACT_ACCOUNT_NAME, name);

      // Settled first: the Access application is keyed by hostname.
      if (context.inputs.address.kind === 'zone') {
        context.facts.set(FACT_ADDRESS, context.inputs.address.hostname);

        return `Deploying into ${name}, answering on ${context.inputs.address.hostname}.`;
      }

      const workers = await cloudflareResult(
        context.transport,
        { method: 'GET', path: `/accounts/${context.inputs.accountId}/workers/subdomain` },
        SubdomainSchema,
      );

      context.facts.set(FACT_WORKERS_SUBDOMAIN, workers.subdomain);
      context.facts.set(FACT_ADDRESS, `${context.inputs.instanceName}.${workers.subdomain}.workers.dev`);

      return `Deploying into ${name}, answering on ${context.inputs.instanceName}.${workers.subdomain}.workers.dev.`;
    },
  };
}

function kvStep(manifest: ReleaseManifest): DeployStep {
  return {
    id: 'kv',
    title: 'Create the session store',
    async run(context: DeployContext): Promise<string> {
      const wanted = manifest.bindings.filter((binding) => binding.kind === 'kv');
      const base = `/accounts/${context.inputs.accountId}/storage/kv/namespaces`;

      const existing = await cloudflareResult(
        context.transport,
        { method: 'GET', path: `${base}?per_page=100` },
        v.array(v.object({ id: v.string(), title: v.string() })),
      );

      for (const binding of wanted) {
        const title = resourceName(context.inputs, binding.resource);
        const found = existing.find((row) => row.title === title);

        if (found !== undefined) {
          context.facts.set(kvFact(binding.binding), found.id);
          context.note(`${title} already exists.`);
          continue;
        }

        const created = await cloudflareResult(
          context.transport,
          { method: 'POST', path: base, body: { title } },
          IdSchema,
        );

        context.facts.set(kvFact(binding.binding), created.id);
        context.note(`${title} created.`);
      }

      return `${wanted.length} KV namespace(s) ready.`;
    },
  };
}

function bucketStep(manifest: ReleaseManifest): DeployStep {
  return {
    id: 'r2',
    title: 'Create the buckets',
    async run(context: DeployContext): Promise<string> {
      const wanted = manifest.bindings.filter((binding) => binding.kind === 'r2');
      const base = `/accounts/${context.inputs.accountId}/r2/buckets`;

      const existing = await cloudflareResult(
        context.transport,
        { method: 'GET', path: `${base}?per_page=100` },
        v.object({ buckets: v.optional(v.array(v.object({ name: v.string() }))) }),
      );

      const held = new Set((existing.buckets ?? []).map((bucket) => bucket.name));

      for (const binding of wanted) {
        const name = resourceName(context.inputs, binding.resource);

        if (held.has(name)) {
          context.note(`${name} already exists.`);
          continue;
        }

        await cloudflareResult(
          context.transport,
          { method: 'POST', path: base, body: { name } },
          v.object({ name: v.optional(v.string()) }),
        );

        context.note(`${name} created.`);
      }

      return `${wanted.length} bucket(s) ready.`;
    },
  };
}

function vectorizeStep(manifest: ReleaseManifest): DeployStep {
  return {
    id: 'vectorize',
    title: 'Create the memory index',
    async run(context: DeployContext): Promise<string> {
      const base = `/accounts/${context.inputs.accountId}/vectorize/v2/indexes`;

      const existing = await cloudflareResult(
        context.transport,
        { method: 'GET', path: base },
        v.array(v.object({ name: v.string() })),
      );

      const held = new Set(existing.map((index) => index.name));

      for (const index of manifest.vectorIndexes) {
        const name = resourceName(context.inputs, index.name);

        if (held.has(name)) {
          context.note(`${name} already exists.`);
          continue;
        }

        await cloudflareResult(
          context.transport,
          {
            method: 'POST',
            path: base,
            body: { name, config: { dimensions: index.dimensions, metric: index.metric } },
          },
          v.object({ name: v.optional(v.string()) }),
        );

        context.note(`${name} created at ${index.dimensions} dimensions, ${index.metric}.`);
      }

      return `${manifest.vectorIndexes.length} index(es) ready.`;
    },
  };
}

function gatewayStep(): DeployStep {
  return {
    id: 'ai-gateway',
    title: 'Create the AI gateway',
    async run(context: DeployContext): Promise<string> {
      const accountId = context.inputs.accountId;
      const id = context.inputs.instanceName;
      const base = `/accounts/${accountId}/ai-gateway/gateways`;

      const existing = await cloudflareResult(
        context.transport,
        { method: 'GET', path: `${base}?per_page=100` },
        v.array(v.object({ id: v.string() })),
      );

      if (!existing.some((gateway) => gateway.id === id)) {
        await cloudflareResult(
          context.transport,
          {
            method: 'POST',
            path: base,
            body: { id, cache_ttl: 0, collect_logs: true, rate_limiting_interval: 0, rate_limiting_limit: 0 },
          },
          v.object({ id: v.optional(v.string()) }),
        );
      }

      const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${id}/workers-ai/v1`;

      context.facts.set(FACT_GATEWAY_URL, url);

      return `Gateway ${id} ready.`;
    },
  };
}

function accessStep(): DeployStep {
  return {
    id: 'access',
    title: 'Set up sign-in',
    async run(context: DeployContext): Promise<string> {
      const hostname = context.facts.get(FACT_ADDRESS);

      if (hostname === undefined) throw new Error('the account step settled no address for the Access application');

      const emails = new Set([context.inputs.ownerEmail, ...context.inputs.accessEmails]);
      const base = `/accounts/${context.inputs.accountId}/access/apps`;

      const apps = await cloudflareResult(
        context.transport,
        { method: 'GET', path: base },
        v.array(v.object({ id: v.string(), domain: v.optional(v.string()) })),
      );

      const held = apps.find((app) => app.domain === hostname);

      const appId = held?.id ?? (await cloudflareResult(
        context.transport,
        {
          method: 'POST',
          path: base,
          body: { name: `Kinu ${context.inputs.instanceName}`, domain: hostname, type: 'self_hosted', session_duration: '24h' },
        },
        IdSchema,
      )).id;

      context.facts.set(FACT_ACCESS_APP, appId);
      context.facts.set(FACT_OWNER_EMAIL, context.inputs.ownerEmail);

      await cloudflareResult(
        context.transport,
        {
          method: 'POST',
          path: `${base}/${appId}/policies`,
          body: {
            name: 'Owners',
            decision: 'allow',
            include: [...emails].map((email) => ({ email: { email } })),
          },
        },
        v.object({ id: v.optional(v.string()) }),
      );

      return `One-time PIN sign-in for ${emails.size} address(es).`;
    },
  };
}

function seedStep(manifest: ReleaseManifest): DeployStep {
  return {
    id: 'seed',
    title: 'Seed the runtime cache',
    async run(context: DeployContext): Promise<string> {
      const seed = manifest.seed;

      if (seed === null) {
        return 'This release publishes no runtime cache seed; hosted runtimes stay absent.';
      }

      const index = await context.http(seed.url);

      if (!index.ok) {
        throw new Error(`the runtime cache seed at ${seed.url} answered HTTP ${index.status}`);
      }

      const objects = v.parse(
        v.object({ objects: v.array(v.object({ key: v.string(), url: v.pipe(v.string(), v.url()) })) }),
        await index.json(),
      );

      const bucket = resourceName(context.inputs, seed.bucket);
      let uploaded = 0;

      for (const object of objects.objects) {
        const path = `/accounts/${context.inputs.accountId}/r2/buckets/${bucket}/objects/${object.key}`;

        if (await objectExists(context.transport, path)) continue;
        const body = await context.http(object.url);

        if (!body.ok) throw new Error(`${object.url} answered HTTP ${body.status}`);

        await context.transport.upload({
          method: 'PUT',
          path,
          parts: [{
            name: 'file',
            contentType: 'application/octet-stream',
            body: new Uint8Array(await body.arrayBuffer()),
          }],
        });
        uploaded += 1;
      }

      return `${String(uploaded)} of ${String(objects.objects.length)} toolchain object(s) uploaded; the rest were already there.`;
    },
  };
}

function secretsStep(manifest: ReleaseManifest): DeployStep {
  return {
    id: 'secrets',
    title: 'Mint the deployment secrets',
    async run(context: DeployContext): Promise<string> {
      // Runs before the upload: secrets are bindings of a version.
      // Root keys are minted once; re-minting `CREDENTIAL_ENCRYPTION_KEY` would make stored
      // credentials unreadable. Updates carry them via `keep_bindings`.
      if (context.update) {
        return `${MINTED_SECRETS.length} secret(s) kept from the running version.`;
      }

      for (const name of MINTED_SECRETS) {
        if (await context.vault.read(name) !== null) continue;
        const bytes = new Uint8Array(32);

        crypto.getRandomValues(bytes);
        await context.vault.write(name, base64(bytes));
      }

      const supplied = context.inputs.providerKeyNames.length;

      const missing = manifest.secrets
        .filter((secret) => secret.required && secret.handling === 'prompted')
        .filter((secret) => !MINTED_SECRETS.includes(secret.name))
        .map((secret) => secret.name)
        .filter((name) => !context.inputs.providerKeyNames.includes(name));

      if (missing.length > 0) {
        throw new Error(`this release requires ${missing.join(', ')}, which no answer supplied`);
      }

      return `${MINTED_SECRETS.length} secret(s) minted, ${supplied} supplied.`;
    },
  };
}

/** Asset session first, then one walk: assets go out in bounded batches, modules are kept
 *  because a version is one multipart request. */
function uploadStep(manifest: ReleaseManifest): DeployStep {
  return {
    id: 'upload',
    title: 'Upload the Worker',
    async run(context: DeployContext): Promise<string> {
      const accountId = context.inputs.accountId;
      const script = context.inputs.instanceName;
      const session = await openAssetSession(context, manifest, script);
      const carried = await carryArtifact(context, manifest, session);
      const exists = await scriptExists(context.transport, accountId, script);
      const metadata = await versionMetadata(context, manifest, carried.token, exists);

      const path = exists
        ? `/accounts/${accountId}/workers/scripts/${script}/versions`
        : `/accounts/${accountId}/workers/scripts/${script}`;

      // The transport copies every part, so the module set is held twice in flight.
      context.artifact.held.hold(carried.bytes);

      const response = await context.transport.upload({
        method: exists ? 'POST' : 'PUT',
        path,
        parts: [
          { name: 'metadata', contentType: 'application/json', body: JSON.stringify(metadata) },
          ...carried.modules,
        ],
      });

      context.artifact.held.release(carried.bytes * 2);

      const uploaded = readEnvelope(path, response, VersionSchema);
      // A first upload answers the script; its deployment names the version.
      const version = exists ? uploaded.id : servingVersion(await liveDeployment(context), '');
      const peak = context.artifact.held.peak();

      if (version === undefined) throw new Error(`${script} was created, and no deployment names its version`);

      context.facts.set(FACT_VERSION_ID, version);
      context.facts.set(FACT_UPLOAD_PEAK, String(peak));

      return `Version ${version} uploaded with ${carried.modules.length} module(s), `
        + `holding ${mebibytes(peak)} at the peak.`;
    },
  };
}

function addressStep(inputs: DeployInputs): DeployStep {
  return {
    id: 'address',
    title: 'Bind the address',
    async run(context: DeployContext): Promise<string> {
      const accountId = context.inputs.accountId;
      const script = context.inputs.instanceName;

      if (inputs.address.kind === 'workers-dev') {
        await cloudflareResult(
          context.transport,
          {
            method: 'POST',
            path: `/accounts/${accountId}/workers/scripts/${script}/subdomain`,
            body: { enabled: true, previews_enabled: false },
          },
          v.object({ enabled: v.optional(v.boolean()) }),
        );
      } else {
        // A Workers custom domain creates the proxied DNS record itself.
        await cloudflareResult(
          context.transport,
          {
            method: 'PUT',
            path: `/accounts/${accountId}/workers/domains`,
            body: { hostname: inputs.address.hostname, zone_id: inputs.address.zoneId, service: script, environment: 'production' },
          },
          v.object({ id: v.optional(v.string()) }),
        );
      }

      const version = context.facts.get(FACT_VERSION_ID);

      if (version !== undefined) {
        const serving = servingVersion(await liveDeployment(context), version);

        // At 0% only the smoke's override reaches it.
        await deploy(context, serving === undefined
          ? [{ version_id: version, percentage: 100 }]
          : [{ version_id: version, percentage: 0 }, { version_id: serving, percentage: 100 }]);
      }

      return `Answering on ${context.facts.get(FACT_ADDRESS) ?? ''}.`;
    },
  };
}

function smokeStep(): DeployStep {
  return {
    id: 'smoke',
    title: 'Check it answers',
    async run(context: DeployContext): Promise<string> {
      const address = context.facts.get(FACT_ADDRESS);
      const version = context.facts.get(FACT_VERSION_ID);

      if (address === undefined) throw new Error('no address was bound, so nothing can be checked');

      if (version === undefined) throw new Error('no version was uploaded, so nothing can be checked');
      const url = `https://${address}/api/health`;
      const response = await context.http(url, { [VERSION_OVERRIDE_HEADER]: `${context.inputs.instanceName}="${version}"` });

      if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);

      const { build, versionId } = v.parse(HealthAnswerSchema, await response.json());

      // An unapplied override reaches the serving version, which may be this build.
      if (versionId !== version) {
        throw new Error(`${url} was answered by version ${versionId ?? 'unnamed'}, and the version under test is ${version}`);
      }

      if (build === null || build.version !== context.manifest.version || build.sha !== context.manifest.sha) {
        throw new Error(
          `${url} answers ${build?.version ?? 'an unstamped build'}`
          + ` (${build?.sha ?? 'no sha'}), and this release is ${context.manifest.version}`
          + ` (${context.manifest.sha})`,
        );
      }

      return `Version ${version} answers ${build.version}.`;
    },
  };
}

function promoteStep(): DeployStep {
  return {
    id: 'promote',
    title: 'Send it all traffic',
    async run(context: DeployContext): Promise<string> {
      const version = context.facts.get(FACT_VERSION_ID);

      if (version === undefined) throw new Error('no version was uploaded, so nothing can take the traffic');

      await deploy(context, [{ version_id: version, percentage: 100 }]);

      return `Version ${version} serves all traffic.`;
    },
  };
}

function handoverStep(manifest: ReleaseManifest): DeployStep {
  return {
    id: 'handover',
    title: 'Hand the deployment its own key',
    async run(context: DeployContext): Promise<string> {
      const accountId = context.inputs.accountId;
      const script = context.inputs.instanceName;
      const refresh = await context.vault.read(REFRESH_TOKEN_KEY);
      const clientId = await context.vault.read(DEPLOY_CLIENT_ID_KEY);

      if (refresh === null) {
        throw new Error('the run holds no refresh token, so the deployment cannot own its own key');
      }

      if (clientId === null) {
        throw new Error('the run cannot name the OAuth client, so the deployment could never refresh');
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

      await cloudflareResult(
        context.transport,
        { method: 'PUT', path: base, body: { name: DEPLOYMENT_REFRESH_SECRET, text: refresh, type: 'secret_text' } },
        v.object({ name: v.optional(v.string()) }),
      );

      await cloudflareResult(
        context.transport,
        { method: 'PUT', path: base, body: { name: DEPLOYMENT_RECORD_SECRET, text: JSON.stringify(record), type: 'secret_text' } },
        v.object({ name: v.optional(v.string()) }),
      );

      await context.vault.wipe();

      return `${script} holds its own key; this run holds nothing.`;
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
async function openAssetSession(
  context: DeployContext,
  manifest: ReleaseManifest,
  script: string,
): Promise<AssetSession> {
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

  const session = await cloudflareResult(
    context.transport,
    { method: 'POST', path: sessionPath, body: { manifest: wire } },
    AssetSessionSchema,
  );

  const wanted = new Set((session.buckets ?? []).flat());

  context.note(`${hashes.size} asset(s), ${wanted.size} of them to upload.`);

  return { token: session.jwt ?? '', wanted, hashes };
}

interface CarriedRelease {
  readonly token: string;
  readonly modules: readonly UploadPart[];
  readonly bytes: number;
}

/** `scripts/build-worker-release.ts` orders assets before modules to lower the peak; either order installs. */
async function carryArtifact(
  context: DeployContext,
  manifest: ReleaseManifest,
  session: AssetSession,
): Promise<CarriedRelease> {
  const held = context.artifact.held;
  const prefix = `${manifest.worker.modulesPath}/`;
  const named = new Set(manifest.worker.modules);
  const modules: UploadPart[] = [];
  let moduleBytes = 0;
  let batch: UploadPart[] = [];
  let batchBytes = 0;
  let uploaded = 0;
  let token = session.token;

  for await (const member of context.artifact.members()) {
    const moduleName = member.path.startsWith(prefix) ? member.path.slice(prefix.length) : '';

    if (named.has(moduleName)) {
      const body = await member.bytes();

      held.hold(body.length);
      moduleBytes += body.length;
      modules.push({
        name: moduleName,
        filename: moduleName,
        contentType: moduleName.endsWith('.wasm') ? 'application/wasm' : 'application/javascript+module',
        body,
      });
      continue;
    }

    const hash = session.hashes.get(member.path);

    if (hash === undefined || !session.wanted.has(hash)) continue;

    // Flush before this member joins, so an oversized member travels alone.
    if (batchBytes > 0 && batchBytes + member.size > ASSET_BATCH_BYTES) {
      token = await sendAssets(context, batch, token, held);
      uploaded += batch.length;
      held.release(batchBytes);
      batch = [];
      batchBytes = 0;
    }

    const body = await base64Member(member, held);

    batch.push({ name: hash, filename: hash, contentType: contentTypeOf(member.path), body });
    batchBytes += body.length;
  }

  if (batch.length > 0) {
    token = await sendAssets(context, batch, token, held);
    uploaded += batch.length;
    held.release(batchBytes);
  }

  if (uploaded !== session.wanted.size) {
    throw new Error(`Cloudflare asked for ${String(session.wanted.size)} asset(s) and the release artifact carries ${String(uploaded)}`);
  }

  if (modules.length !== manifest.worker.modules.length) {
    throw new Error(`the release artifact carries ${String(modules.length)} of the ${String(manifest.worker.modules.length)} module(s) the manifest names`);
  }

  context.note(`${uploaded} asset(s) uploaded, ${modules.length} module(s) held for the version.`);

  return { token, modules, bytes: moduleBytes };
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

// Streams into the body; `btoa` over a whole member would hold three copies of it.
async function base64Member(member: ArtifactMember, held: HeldBytes): Promise<Uint8Array<ArrayBuffer>> {
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

  if (at !== encoded.length) throw new Error(`${member.path} is ${String(member.size)} bytes and encoded to ${String(at)}`);

  return encoded;
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

  for (const declared of manifest.vars) {
    if (declared.policy === 'ours') continue;
    const value = declared.policy === 'carried' ? declared.value ?? '' : derivedVar(context, declared.name);

    if (value !== null) bindings.push({ type: 'plain_text', name: declared.name, text: value });
  }

  for (const name of [...MINTED_SECRETS, ...context.inputs.providerKeyNames]) {
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
  };

  if (!exists) metadata.migrations = { new_tag: tag, new_sqlite_classes: classes };

  if (assetsToken === '') {
    metadata.keep_assets = true;
  } else {
    metadata.assets = {
      jwt: assetsToken,
      config: { not_found_handling: 'single-page-application', run_worker_first: true },
    };
  }

  return metadata;
}

// Null for the container (needs Workers Paid and a user registry) and bindings turned off.
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
        && binding.resource === 'KinuSandbox') return null;

      return { type: 'durable_object_namespace', name, class_name: binding.resource };
    }

    case 'analytics-engine':
      return { type: 'analytics_engine', name, dataset: resource };
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
    case 'PREVIEW_HOST_SUFFIX':
      return '';
    default:
      return null;
  }
}

// Prefixed by instance name so several instances can share an account.
function resourceName(inputs: DeployInputs, base: string): string {
  if (inputs.instanceName === 'kinu' || base.startsWith(inputs.instanceName)) return base;

  return base.startsWith('kinu-') ? `${inputs.instanceName}-${base.slice('kinu-'.length)}` : `${inputs.instanceName}-${base}`;
}

const CONTENT_TYPE_BY_EXTENSION = new Map<string, string>(Object.entries(ASSET_CONTENT_TYPES));

function contentTypeOf(path: string): string {
  return CONTENT_TYPE_BY_EXTENSION.get(extensionOf(path)) ?? 'application/octet-stream';
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');

  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
}

// Only for the 32-byte minted secrets; assets use `base64Member`.
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
