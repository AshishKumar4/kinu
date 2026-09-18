/**
 * The deployment, as idempotent steps (docs/SELF-DEPLOY.md § The Cloudflare
 * door, step 6).
 *
 * Every step looks before it creates, so a re-run after an eviction, a retry
 * after a refusal, and a second sitting on the same account all reach the same
 * place. Each one records what it established as a fact, because the step that
 * needs a KV namespace id runs in a different Durable Object activation than
 * the step that created it.
 *
 * API SHAPES. Endpoints and payloads are Cloudflare's published v4 reference,
 * read 2026-09-17: multipart Worker upload and version upload
 * (developers.cloudflare.com/workers/configuration/multipart-upload-metadata/,
 * .../api/resources/workers/subresources/scripts/subresources/versions/methods/create/),
 * the three-phase asset upload (.../workers/static-assets/direct-upload/, which
 * also fixes the asset hash: `sha256(base64(content) + extension)` truncated to
 * 32 hex characters), and the KV, R2, Vectorize, AI Gateway, Access, DNS and
 * Workers domains resources. None of them is measured against a live account
 * from this tree — there is no Cloudflare credential here — so the proof that
 * the flow holds is the fake transport in the suite, and the first real run is
 * the measurement.
 */
import * as v from 'valibot';
import { cloudflareResult, readEnvelope, type CloudflareTransport, type UploadPart } from './cloudflare';
import {
  FACT_ACCESS_APP, FACT_ACCOUNT_NAME, FACT_ADDRESS, FACT_GATEWAY_URL, FACT_OWNER_EMAIL,
  FACT_VERSION_ID, FACT_WORKERS_SUBDOMAIN, kvFact, type DeployContext,
} from './context';
import {
  DEPLOYMENT_RECORD_SECRET, DEPLOYMENT_REFRESH_SECRET, MINTED_SECRETS, REFRESH_TOKEN_KEY,
  type DeployInputs, type DeploymentRecord,
} from './inputs';
import type { JsonObject, JsonValue } from '../utils/json';
import type { ReleaseBinding, ReleaseFile, ReleaseManifest } from './manifest';

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

const ASSET_CONTENT_TYPES = {
  html: 'text/html', js: 'text/javascript', mjs: 'text/javascript',
  css: 'text/css', json: 'application/json', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
  txt: 'text/plain', map: 'application/json', wasm: 'application/wasm',
  sh: 'text/x-shellscript', wgsl: 'text/plain', tar: 'application/x-tar',
  gz: 'application/gzip', webmanifest: 'application/manifest+json',
} satisfies Record<string, string>;

/** The step list for one release and one set of answers. */
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

      // The address is settled here, before anything is created, because the
      // Access application is keyed by hostname and a workers.dev hostname is
      // not knowable until the account's subdomain is read. Binding it is the
      // address step's job; knowing it is this one's.
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

        // The geometry travels with the release: an index created at the wrong
        // width binds and then rejects every insert.
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
        // Honest absence: the hosted language runtimes live in this bucket, and
        // without a seed they are absent. The deployment runs; `eval` in a
        // hosted runtime answers 127 until an operator seeds it.
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

      for (const object of objects.objects) {
        const body = await context.http(object.url);

        if (!body.ok) throw new Error(`${object.url} answered HTTP ${body.status}`);

        await context.transport.upload({
          method: 'PUT',
          path: `/accounts/${context.inputs.accountId}/r2/buckets/${bucket}/objects/${object.key}`,
          parts: [{
            name: 'file',
            contentType: 'application/octet-stream',
            body: new Uint8Array(await body.arrayBuffer()),
          }],
        });
      }

      return `${objects.objects.length} toolchain object(s) seeded.`;
    },
  };
}

function secretsStep(manifest: ReleaseManifest): DeployStep {
  return {
    id: 'secrets',
    title: 'Mint the deployment secrets',
    async run(context: DeployContext): Promise<string> {
      // Before the upload, not after: a version's secrets are bindings of that
      // version, so a version uploaded without them runs a deployment whose
      // signed-in surfaces all answer 503.
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

function uploadStep(manifest: ReleaseManifest): DeployStep {
  return {
    id: 'upload',
    title: 'Upload the Worker',
    async run(context: DeployContext): Promise<string> {
      const accountId = context.inputs.accountId;
      const script = context.inputs.instanceName;
      const completion = await uploadAssets(context, manifest, script);
      const modules: UploadPart[] = [];

      for (const path of manifest.worker.modules) {
        modules.push({
          name: path,
          filename: path,
          contentType: path.endsWith('.wasm') ? 'application/wasm' : 'application/javascript+module',
          body: await context.artifact.read(`${manifest.worker.modulesPath}/${path}`),
        });
      }

      const metadata = await versionMetadata(context, manifest, completion);
      const exists = await scriptExists(context.transport, accountId, script);

      const path = exists
        ? `/accounts/${accountId}/workers/scripts/${script}/versions`
        : `/accounts/${accountId}/workers/scripts/${script}`;

      const response = await context.transport.upload({
        method: exists ? 'POST' : 'PUT',
        path,
        parts: [
          { name: 'metadata', contentType: 'application/json', body: JSON.stringify(metadata) },
          ...modules,
        ],
      });

      const version = readEnvelope(path, response, VersionSchema);

      context.facts.set(FACT_VERSION_ID, version.id);

      return `Version ${version.id} uploaded with ${modules.length} module(s).`;
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
        // A Workers custom domain creates the proxied DNS record itself; that
        // is the whole reason the flow asks for a zone rather than a hostname.
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
        // A version upload does not serve traffic until a deployment points at
        // it. The first upload (`PUT .../scripts/<name>`) already deployed, and
        // pointing a deployment at the same version again is a no-op.
        await context.transport.request({
          method: 'POST',
          path: `/accounts/${accountId}/workers/scripts/${script}/deployments`,
          body: { strategy: 'percentage', versions: [{ version_id: version, percentage: 100 }] },
        });
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

      if (address === undefined) throw new Error('no address was bound, so nothing can be checked');

      const response = await context.http(`https://${address}/api/health`);

      if (!response.ok) {
        throw new Error(`https://${address}/api/health answered HTTP ${response.status}`);
      }

      const health = v.parse(
        v.object({ version: v.optional(v.string()), sha: v.optional(v.string()) }),
        await response.json(),
      );

      return `Health answers ${health.version ?? 'an unstamped build'}.`;
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

      if (refresh === null) {
        throw new Error('the run holds no refresh token, so the deployment cannot own its own key');
      }

      const record: DeploymentRecord = {
        accountId,
        scriptName: script,
        address: context.facts.get(FACT_ADDRESS) ?? '',
        version: manifest.version,
        channelOrigin: manifest.channelOrigin,
        ownerEmail: context.inputs.ownerEmail,
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

      // The last act of the run: kinu.run holds nothing about this account
      // from here on, and the deployment updates itself by pulling.
      await context.vault.wipe();

      return `${script} holds its own key; this run holds nothing.`;
    },
  };
}

/* ── the upload's three phases ────────────────────────────────────────── */

async function uploadAssets(
  context: DeployContext,
  manifest: ReleaseManifest,
  script: string,
): Promise<string> {
  const prefix = `${manifest.worker.assets}/`;
  const assets = manifest.files.filter((file) => file.path.startsWith(prefix) && file.assetHash !== null);

  if (assets.length === 0) return '';

  const catalog = new Map<string, ReleaseFile>();
  const wire: JsonObject = {};

  for (const asset of assets) {
    const served = `/${asset.path.slice(prefix.length)}`;

    catalog.set(asset.assetHash ?? '', asset);
    wire[served] = { hash: asset.assetHash ?? '', size: asset.size };
  }

  const sessionPath = `/accounts/${context.inputs.accountId}/workers/scripts/${script}/assets-upload-session`;

  const session = await cloudflareResult(
    context.transport,
    { method: 'POST', path: sessionPath, body: { manifest: wire } },
    AssetSessionSchema,
  );

  let token = session.jwt ?? '';
  const buckets = session.buckets ?? [];

  context.note(`${assets.length} asset(s), ${buckets.length} batch(es) to upload.`);

  for (const bucket of buckets) {
    const parts: UploadPart[] = [];

    for (const hash of bucket) {
      const asset = catalog.get(hash);

      if (asset === undefined) throw new Error(`Cloudflare asked for asset ${hash}, which this release does not carry`);
      const bytes = await context.artifact.read(asset.path);

      parts.push({
        name: hash,
        filename: hash,
        contentType: contentTypeOf(asset.path),
        body: base64(bytes),
      });
    }

    const uploadPath = `/accounts/${context.inputs.accountId}/workers/assets/upload?base64=true`;
    const response = await context.transport.upload({ method: 'POST', path: uploadPath, bearer: token, parts });
    const answer = readEnvelope(uploadPath, response, v.object({ jwt: v.optional(v.string()) }));

    token = answer.jwt ?? token;
  }

  return token;
}

async function scriptExists(transport: CloudflareTransport, accountId: string, script: string): Promise<boolean> {
  const response = await transport.request({
    method: 'GET',
    path: `/accounts/${accountId}/workers/scripts/${script}/settings`,
  });

  return response.status >= 200 && response.status < 300;
}

async function versionMetadata(
  context: DeployContext,
  manifest: ReleaseManifest,
  assetsToken: string,
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

  return {
    main_module: manifest.worker.mainModule,
    compatibility_date: manifest.worker.compatibilityDate,
    compatibility_flags: [...manifest.worker.compatibilityFlags],
    bindings,
    migrations: { new_tag: tag, new_sqlite_classes: classes },
    ...(assetsToken === ''
      ? { keep_assets: true }
      : {
        assets: {
          jwt: assetsToken,
          config: { not_found_handling: 'single-page-application', run_worker_first: true },
        },
      }),
    observability: { enabled: true },
  };
}

/** One binding as the upload metadata spells it, or null for a binding this
 *  deployment does not get — the container, which needs Workers Paid and an
 *  image in the user's own registry, and anything the answers turned off. */
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

/** A var the deployment computes for itself. Null where this deployment has no
 *  value for it — an empty string would be a claim, and `PREVIEW_HOST_SUFFIX`
 *  empty is exactly how previews are turned off. */
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

/** A resource's name in this deployment. kinu.run's own names are the defaults
 *  a single-instance account gets; a second instance on the same account needs
 *  its own, so the instance name prefixes anything not already carrying it. */
function resourceName(inputs: DeployInputs, base: string): string {
  if (inputs.instanceName === 'kinu' || base.startsWith(inputs.instanceName)) return base;

  return base.startsWith('kinu-') ? `${inputs.instanceName}-${base.slice('kinu-'.length)}` : `${inputs.instanceName}-${base}`;
}

/** The `Content-Type` the asset is served with. A closed table, so an
 *  extension nobody listed falls to the byte stream rather than to a wrong
 *  claim about what the file is. */
function contentTypeOf(path: string): string {
  const extension = extensionOf(path);

  // SAFETY: `Object.hasOwn` checked own-key membership in ASSET_CONTENT_TYPES —
  // the exact invariant `keyof typeof ASSET_CONTENT_TYPES` states.
  return Object.hasOwn(ASSET_CONTENT_TYPES, extension)
    ? ASSET_CONTENT_TYPES[extension as keyof typeof ASSET_CONTENT_TYPES]
    : 'application/octet-stream';
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');

  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
}

/** Base64 in chunks: `String.fromCharCode(...bytes)` on a megabyte-sized asset
 *  overflows the argument stack, which is a crash on exactly the biggest file
 *  in the bundle and on nothing smaller. */
function base64(bytes: Uint8Array): string {
  let binary = '';

  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }

  return btoa(binary);
}
