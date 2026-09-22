/**
 * `release.json` — one build of this repository, as the shape a fresh account
 * has to be given.
 *
 * DERIVED, NOT WRITTEN DOWN. The bindings come from `packages/cf-backend/wrangler.jsonc`,
 * the requiredness from `env.d.ts` through `envFields()`, the Vectorize geometry from
 * the embedder, and the secrets census from `SUPPLY` — the same four sources
 * `scripts/infra-manifest.ts` reads. A second hand-kept list of "what a Kinu
 * deployment is made of" would drift from the config that deploys kinu.run, and
 * the drift would be invisible until somebody's deployment came up missing a
 * bucket. `scripts/release-manifest.test.ts` holds the binding set equal to the
 * one `deriveInfrastructure()` reads, in both directions.
 *
 * WHAT IS DECLARED HERE, and why it has to be: `VAR_POLICY`. kinu.run's `vars`
 * block carries kinu.run's identity — the eval bypass address, the owner's
 * alert mailbox, the control plane's Access audience, an account id. Copying
 * that into a stranger's Worker would hand them our eval identity and point
 * their admin plane at our Zero Trust organisation, so every var is classified
 * as carried (every deployment gets this value), derived (this deployment
 * computes its own) or ours (never sent), and an unclassified var fails the
 * gate rather than travelling by default.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { parseJsonc } from './jsonc';
import { ENV_TYPES, WRANGLER_CONFIG, envFields, vectorizeGeometry, SUPPLY, type Supply } from './infra-manifest';
import type {
  BindingKind, ReleaseBinding, ReleaseFile, ReleaseManifest, ReleaseMigration,
  ReleaseSecret, ReleaseSeed, ReleaseVar, ReleaseVectorIndex, VarPolicy,
} from '../packages/core/src/deploy/manifest';

const REPO = new URL('..', import.meta.url).pathname;

/** Where a deployment pulls its next version from, and where the CLI artifacts
 *  a self-hosted instance does not carry are served from. */
export const CHANNEL_ORIGIN = 'https://kinu.run';

/**
 * Every var in `wrangler.jsonc`, classified.
 *
 * `derived` names are computed by the flow (`derivedVar` in
 * `packages/core/src/deploy/steps.ts`); `ours` names are kinu.run's own and are
 * never sent to another account. Equality-pinned by the gate: a var added to
 * the config and not to this map fails, and a name here that the config no
 * longer has fails too, so the map cannot rot in either direction.
 */
export const VAR_POLICY = {
  AI_GATEWAY_URL: 'derived',
  SANDBOX_TRANSPORT: 'carried',
  PREVIEW_HOST_SUFFIX: 'derived',
  CLI_PUBLIC_ORIGIN: 'derived',
  CLI_APPROVAL_ORIGIN: 'derived',
  CLOUDFLARE_OAUTH_CLIENT_ID: 'ours',
  CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD: 'carried',
  CLOUDFLARE_AI_GATEWAY_ID: 'carried',
  CLOUDFLARE_ACCOUNT_ID: 'derived',
  ANALYTICS_DATASET_SUFFIX: 'carried',
  CONTROL_PLANE_ADMINS: 'derived',
  DEV_USER_EMAIL: 'ours',
  OPS_ALERT_EMAIL: 'ours',
  EMAIL_DOMAIN: 'ours',
  CONTROL_PLANE_ACCESS_TEAM_DOMAIN: 'ours',
  CONTROL_PLANE_ACCESS_AUD: 'ours',
} satisfies Record<string, VarPolicy>;

function isClassifiedVar(name: string): name is keyof typeof VAR_POLICY {
  return Object.hasOwn(VAR_POLICY, name);
}

/** A closed table has no index signature, so the lookup is a function rather
 *  than a subscript — and the absent case is exactly the one that must refuse. */
function policyFor(name: string): VarPolicy | undefined {
  return isClassifiedVar(name) ? VAR_POLICY[name] : undefined;
}

const BindingBlocksSchema = v.object({
  name: v.optional(v.string()),
  main: v.optional(v.string()),
  compatibility_date: v.optional(v.string()),
  compatibility_flags: v.optional(v.array(v.string())),
  vars: v.optional(v.record(v.string(), v.string())),
  assets: v.optional(v.object({ binding: v.string(), directory: v.string() })),
  kv_namespaces: v.optional(v.array(v.object({ binding: v.string() }))),
  r2_buckets: v.optional(v.array(v.object({ binding: v.string(), bucket_name: v.string() }))),
  vectorize: v.optional(v.array(v.object({ binding: v.string(), index_name: v.string() }))),
  analytics_engine_datasets: v.optional(v.array(v.object({ binding: v.string(), dataset: v.optional(v.string()) }))),
  durable_objects: v.optional(v.object({
    bindings: v.array(v.object({ name: v.string(), class_name: v.string() })),
  })),
  containers: v.optional(v.array(v.object({ class_name: v.string() }))),
  worker_loaders: v.optional(v.array(v.object({ binding: v.string() }))),
  send_email: v.optional(v.array(v.object({ name: v.string() }))),
  version_metadata: v.optional(v.object({ binding: v.string() })),
  ai: v.optional(v.object({ binding: v.string() })),
  migrations: v.optional(v.array(v.object({
    tag: v.string(),
    new_sqlite_classes: v.optional(v.array(v.string())),
  }))),
  triggers: v.optional(v.object({ crons: v.optional(v.array(v.string())) })),
});

type BindingBlocks = v.InferOutput<typeof BindingBlocksSchema>;

export function readWranglerConfig(configPath = WRANGLER_CONFIG): BindingBlocks {
  return parseJsonc(readFileSync(join(REPO, configPath), 'utf8'), BindingBlocksSchema, configPath);
}

/**
 * Every binding the deployed Worker carries, with the kind and the account
 * resource behind it.
 *
 * A KV namespace is the one binding whose account-side name is NOT in the
 * config — wrangler binds a namespace by id, and the title exists only in the
 * account (`docs/DEPLOYMENT.md`, KV titles). A fresh deployment has no id to
 * bind, so the release names the title it will create instead, derived from
 * the worker and the binding so two deployments in one account cannot collide.
 */
export function releaseBindings(config: BindingBlocks, optional: ReadonlySet<string>): readonly ReleaseBinding[] {
  const worker = config.name ?? 'kinu';
  const rows: ReleaseBinding[] = [];

  const add = (binding: string, kind: BindingKind, resource: string): void => {
    rows.push({ binding, kind, resource, required: !optional.has(binding) });
  };

  for (const namespace of config.kv_namespaces ?? []) {
    add(namespace.binding, 'kv', `${worker}-${namespace.binding.toLowerCase().replaceAll('_', '-')}`);
  }

  for (const bucket of config.r2_buckets ?? []) add(bucket.binding, 'r2', bucket.bucket_name);

  for (const index of config.vectorize ?? []) add(index.binding, 'vectorize', index.index_name);

  for (const dataset of config.analytics_engine_datasets ?? []) {
    add(dataset.binding, 'analytics-engine', dataset.dataset ?? dataset.binding);
  }

  for (const durable of config.durable_objects?.bindings ?? []) {
    add(durable.name, 'durable-object', durable.class_name);
  }

  for (const loader of config.worker_loaders ?? []) add(loader.binding, 'worker-loader', '');

  for (const email of config.send_email ?? []) add(email.name, 'send-email', '');

  if (config.ai !== undefined) add(config.ai.binding, 'ai', '');

  if (config.assets !== undefined) add(config.assets.binding, 'assets', '');

  if (config.version_metadata !== undefined) add(config.version_metadata.binding, 'version-metadata', '');

  return rows;
}

/**
 * The secrets census, from the one map that classifies a supplied value.
 *
 * REQUIREDNESS IS THE DEPLOYMENT'S, NOT KINU.RUN'S. `SUPPLY` derives a paired
 * secret's requiredness from the var it serves (`requiredIn`), and a released
 * deployment gets a different var set than kinu.run does: our Cloudflare OAuth
 * client id is classified `ours` and never travels, so demanding its client
 * secret from a person deploying their own Kinu would block the run on a
 * feature their deployment does not have. A secret whose var this release does
 * not send is offered, never required.
 *
 * `config-var` entries are vars, not secrets, and are left to `VAR_POLICY`.
 */
export function releaseSecrets(
  vars: readonly ReleaseVar[],
  supply: ReadonlyMap<string, Supply> = SUPPLY,
): readonly ReleaseSecret[] {
  const sent = new Set(vars.filter((entry) => entry.policy !== 'ours').map((entry) => entry.name));
  const rows: ReleaseSecret[] = [];

  for (const [name, entry] of supply) {
    if (entry.handling === 'config-var') continue;
    const required = entry.pairedWith === undefined ? entry.required : sent.has(entry.pairedWith);
    const whenPrompted = required ? 'prompted' : 'optional';

    rows.push({
      name,
      handling: entry.handling === 'prompt' ? whenPrompted : 'out-of-band',
      required,
      prompt: entry.source ?? entry.absent,
    });
  }

  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

export function releaseVars(config: BindingBlocks): readonly ReleaseVar[] {
  return Object.entries(config.vars ?? {}).map(([name, value]) => {
    const policy = policyFor(name);

    if (policy === undefined) {
      throw new Error(
        `release-manifest: \`${name}\` is a var in ${WRANGLER_CONFIG} that VAR_POLICY does not classify. `
        + 'Say whether every deployment carries this value, computes its own, or must never receive ours.',
      );
    }

    return policy === 'carried' ? { name, policy, value } : { name, policy };
  });
}

export interface ReleaseBuild {
  readonly version: string;
  readonly sha: string;
  readonly builtAt: string;
  readonly files: readonly ReleaseFile[];
  readonly modules: readonly string[];
  readonly seed: ReleaseSeed | null;
}

export function buildReleaseManifest(build: ReleaseBuild, configPath = WRANGLER_CONFIG): ReleaseManifest {
  const config = readWranglerConfig(configPath);

  const optional = new Set(envFields(readFileSync(join(REPO, ENV_TYPES), 'utf8'))
    .filter((field) => field.optional)
    .map((field) => field.name));

  const geometry = vectorizeGeometry();

  const indexes: ReleaseVectorIndex[] = (config.vectorize ?? []).map((index) => ({
    name: index.index_name,
    dimensions: geometry.dimensions,
    metric: geometry.metric,
  }));

  const migrations: ReleaseMigration[] = (config.migrations ?? []).map((migration) => ({
    tag: migration.tag,
    newSqliteClasses: migration.new_sqlite_classes ?? [],
  }));

  const vars = releaseVars(config);

  return {
    version: build.version,
    sha: build.sha,
    builtAt: build.builtAt,
    channelOrigin: CHANNEL_ORIGIN,
    worker: {
      name: config.name ?? 'kinu',
      mainModule: build.modules[0] ?? 'index.js',
      compatibilityDate: config.compatibility_date ?? '',
      compatibilityFlags: config.compatibility_flags ?? [],
      modules: build.modules,
      modulesPath: 'worker',
      assets: 'client',
      assetsBinding: config.assets?.binding ?? 'ASSETS',
      crons: config.triggers?.crons ?? [],
    },
    bindings: releaseBindings(config, optional),
    vectorIndexes: indexes,
    migrations,
    secrets: releaseSecrets(vars),
    vars,
    files: build.files,
    seed: build.seed,
  };
}

/** Cloudflare's asset digest: sha256 over the file's base64 text plus its
 *  extension, truncated to 32 hex characters
 *  (developers.cloudflare.com/workers/static-assets/direct-upload/, read
 *  2026-09-17). Computed at build so the deploy step reads only the files
 *  Cloudflare asks it to upload. */
export function assetDigest(bytes: Buffer, path: string): string {
  const dot = path.lastIndexOf('.');
  const extension = dot === -1 ? '' : path.slice(dot + 1);

  return createHash('sha256').update(bytes.toString('base64') + extension).digest('hex').slice(0, 32);
}
