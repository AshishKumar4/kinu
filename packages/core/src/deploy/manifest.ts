/**
 * `release.json` — what one build of this repository IS, as data.
 *
 * The self-deploy flow never reads the repository (docs/SELF-DEPLOY.md). It
 * reads this manifest: the bindings a deployment needs, the resource behind
 * each one, the Durable Object classes and their migrations, the secrets a
 * person has to supply, the vars that are ours and the vars that are theirs,
 * and the sha256 of every file in the artifact. `scripts/release-manifest.ts`
 * generates it from `packages/cf-backend/wrangler.jsonc`, so a self-hosted
 * deployment cannot be shaped differently from kinu.run's own.
 *
 * WHY THE VARS ARE CLASSIFIED RATHER THAN COPIED. kinu.run's `vars` block
 * carries kinu.run's identity: the eval bypass address, the owner's alert
 * mailbox, the control-plane Access audience, an account id. Copying that
 * block into somebody else's Worker hands them our eval identity and points
 * their admin plane at our Zero Trust organisation. So every var is one of
 * three things — carried as-is, computed for this deployment, or ours alone —
 * and `scripts/release-manifest.test.ts` fails on a var that is none of them.
 */
import * as v from 'valibot';

/** The binding kinds `wrangler.jsonc` can declare. A binding whose kind is
 *  absent here cannot be provisioned by the flow, which is why the generator
 *  refuses to emit one rather than describing it as something else. */
const BINDING_KINDS = [
  'kv', 'r2', 'vectorize', 'durable-object', 'analytics-engine', 'ai', 'assets',
  'version-metadata', 'send-email', 'worker-loader', 'container',
] as const;

export type BindingKind = (typeof BINDING_KINDS)[number];

export interface ReleaseBinding {
  readonly binding: string;
  readonly kind: BindingKind;
  /** The account-level resource this binding needs by name — a KV title, a
   *  bucket, an index, a Durable Object class. Empty where the platform
   *  supplies it (`ai`, `assets`, `version-metadata`, `worker-loader`). */
  readonly resource: string;
  /** False where `env.d.ts` marks the binding optional: the deployment boots
   *  without it and loses one capability, so a failure to create it is worth
   *  reporting but not worth refusing the deployment over. */
  readonly required: boolean;
}

/** A Vectorize index binds fine at the wrong width and then rejects every
 *  insert, so the geometry travels with the release rather than being a
 *  number somebody retypes at create time. */
export interface ReleaseVectorIndex {
  readonly name: string;
  readonly dimensions: number;
  readonly metric: string;
}

export interface ReleaseMigration {
  readonly tag: string;
  readonly newSqliteClasses: readonly string[];
}

export type SecretHandling = 'prompted' | 'out-of-band' | 'optional';

export interface ReleaseSecret {
  readonly name: string;
  readonly handling: SecretHandling;
  readonly required: boolean;
  /** What the flow shows a person when it asks. Generated from `SUPPLY` in
   *  `scripts/infra-manifest.ts`, the one place that classifies a secret. */
  readonly prompt: string;
}

export type VarPolicy = 'carried' | 'derived' | 'ours';

export interface ReleaseVar {
  readonly name: string;
  readonly policy: VarPolicy;
  /** Present only for `carried`: the value every deployment gets. A `derived`
   *  var is computed per deployment and an `ours` var is never sent. */
  readonly value?: string;
}

export interface ReleaseFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  /** Cloudflare's asset digest for a file under the assets directory:
   *  `sha256(base64(bytes) + extension)` truncated to 32 hex characters
   *  (workers/static-assets/direct-upload, read 2026-09-17). Precomputed at
   *  build so the upload step reads only the files Cloudflare asks for
   *  instead of every file in the bundle to learn their digests. Null for a
   *  Worker module, which is uploaded as a part and never hashed. */
  readonly assetHash: string | null;
}

export interface ReleaseWorker {
  readonly name: string;
  readonly mainModule: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  /** Module names as the upload's parts are keyed, main module first. A name
   *  is relative to `modulesPath` inside the artifact, because `main_module`
   *  in the upload metadata must equal a part's name. */
  readonly modules: readonly string[];
  /** Directory inside the artifact holding the Worker's modules. */
  readonly modulesPath: string;
  /** Directory inside the artifact holding the static assets. */
  readonly assets: string;
  readonly assetsBinding: string;
  readonly crons: readonly string[];
}

/** The toolchain blobs `NIMBUS_RUNTIME_CACHE` is seeded with, referenced by
 *  digest because they are published once per Nimbus release and shared by
 *  every deployment that runs that release. */
export interface ReleaseSeed {
  readonly bucket: string;
  readonly url: string;
  readonly sha256: string;
}

export interface ReleaseManifest {
  readonly version: string;
  readonly sha: string;
  readonly builtAt: string;
  /** Where a deployment pulls its next version from. Updates are pulled by
   *  the deployment; kinu.run never pushes into anyone's account. */
  readonly channelOrigin: string;
  readonly worker: ReleaseWorker;
  readonly bindings: readonly ReleaseBinding[];
  readonly vectorIndexes: readonly ReleaseVectorIndex[];
  readonly migrations: readonly ReleaseMigration[];
  readonly secrets: readonly ReleaseSecret[];
  readonly vars: readonly ReleaseVar[];
  readonly files: readonly ReleaseFile[];
  readonly seed: ReleaseSeed | null;
}

const Sha256Schema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));

export const ReleaseManifestSchema: v.GenericSchema<ReleaseManifest> = v.object({
  version: v.pipe(v.string(), v.trim(), v.minLength(1)),
  sha: v.pipe(v.string(), v.trim(), v.minLength(1)),
  builtAt: v.pipe(v.string(), v.trim(), v.minLength(1)),
  channelOrigin: v.pipe(v.string(), v.url()),
  worker: v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    mainModule: v.pipe(v.string(), v.minLength(1)),
    compatibilityDate: v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/u)),
    compatibilityFlags: v.array(v.string()),
    modules: v.pipe(v.array(v.string()), v.minLength(1)),
    modulesPath: v.pipe(v.string(), v.minLength(1)),
    assets: v.pipe(v.string(), v.minLength(1)),
    assetsBinding: v.pipe(v.string(), v.minLength(1)),
    crons: v.array(v.string()),
  }),
  bindings: v.array(v.object({
    binding: v.pipe(v.string(), v.minLength(1)),
    kind: v.picklist(BINDING_KINDS),
    resource: v.string(),
    required: v.boolean(),
  })),
  vectorIndexes: v.array(v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    dimensions: v.pipe(v.number(), v.integer(), v.minValue(1)),
    metric: v.pipe(v.string(), v.minLength(1)),
  })),
  migrations: v.array(v.object({
    tag: v.pipe(v.string(), v.minLength(1)),
    newSqliteClasses: v.array(v.string()),
  })),
  secrets: v.array(v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    handling: v.picklist(['prompted', 'out-of-band', 'optional']),
    required: v.boolean(),
    prompt: v.string(),
  })),
  vars: v.array(v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    policy: v.picklist(['carried', 'derived', 'ours']),
    value: v.optional(v.string()),
  })),
  files: v.array(v.object({
    path: v.pipe(v.string(), v.minLength(1)),
    sha256: Sha256Schema,
    size: v.pipe(v.number(), v.integer(), v.minValue(0)),
    assetHash: v.nullable(v.pipe(v.string(), v.regex(/^[0-9a-f]{32}$/u))),
  })),
  seed: v.nullable(v.object({
    bucket: v.pipe(v.string(), v.minLength(1)),
    url: v.pipe(v.string(), v.url()),
    sha256: Sha256Schema,
  })),
});


/**
 * Where a release artifact is published, and the pattern the Worker serves it
 * on. One spelling: the artifact is an R2 object rather than a static asset
 * (it is larger than the per-file limit `scripts/deploy.test.ts` measures), so
 * the path exists twice by construction — in the manifest a deployment reads, and in the route
 * that streams the bytes — and two spellings of it would be a 404 nobody sees
 * until somebody's install.
 */
export const RELEASE_ARTIFACT_ROUTE = /^\/downloads\/(kinu-worker-[A-Za-z0-9._+-]+\.tar\.gz)$/u;
