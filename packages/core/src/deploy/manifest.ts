// `release.json`, generated from `wrangler.jsonc` by `scripts/release-manifest.ts`; the
// self-deploy flow reads only this (docs/SELF-DEPLOY.md). Vars are classified, never copied:
// kinu.run's vars carry its own identity.
import * as v from 'valibot';

const BINDING_KINDS = [
  'kv', 'r2', 'vectorize', 'durable-object', 'analytics-engine', 'ai', 'browser', 'assets',
  'version-metadata', 'send-email', 'worker-loader', 'container',
] as const;

export type BindingKind = (typeof BINDING_KINDS)[number];

export interface ReleaseBinding {
  readonly binding: string;
  readonly kind: BindingKind;
  /** Empty where the platform supplies it (`ai`, `assets`, `version-metadata`, `worker-loader`). */
  readonly resource: string;
  /** False where `env.d.ts` marks it optional; creation failure is reported, not fatal. */
  readonly required: boolean;
}

/** A wrong-width index binds fine and rejects every insert, so geometry ships with the release. */
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
  /** Generated from `SUPPLY` in `scripts/infra-manifest.ts`. */
  readonly prompt: string;
}

export type VarPolicy = 'carried' | 'derived' | 'ours';

export interface ReleaseVar {
  readonly name: string;
  readonly policy: VarPolicy;
  /** Only for `carried`; `ours` vars are never sent. */
  readonly value?: string;
}

export interface ReleaseFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  /** Cloudflare asset digest, `sha256(base64(bytes) + extension)` truncated to 32 hex; null for modules. */
  readonly assetHash: string | null;
}

export interface ReleaseWorker {
  readonly name: string;
  readonly mainModule: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  /** Main module first, relative to `modulesPath`: `main_module` must equal a part name. */
  readonly modules: readonly string[];
  readonly modulesPath: string;
  readonly assets: string;
  readonly assetsBinding: string;
  readonly crons: readonly string[];
}

/** `NIMBUS_RUNTIME_CACHE` seed, shared by every deployment of a release. */
export interface ReleaseSeed {
  readonly bucket: string;
  readonly url: string;
  readonly sha256: string;
}

export interface ReleaseManifest {
  readonly version: string;
  readonly sha: string;
  readonly builtAt: string;
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

// Matches `RELEASE_ARTIFACT_ROUTE`; also a local directory name, so no `/` or `..`.
const RELEASE_VERSION = /^[A-Za-z0-9._+-]+$/u;

// The local door writes these to disk, so escaping paths are refused here, once.
const ReleaseFilePathSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.check(
    (path: string) => !path.startsWith('/')
      && !path.includes('\\')
      && path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'a release file path must stay inside its release',
  ),
);

export const ReleaseManifestSchema: v.GenericSchema<ReleaseManifest> = v.object({
  version: v.pipe(v.string(), v.trim(), v.regex(RELEASE_VERSION)),
  sha: v.pipe(v.string(), v.trim(), v.minLength(1)),
  builtAt: v.pipe(v.string(), v.trim(), v.minLength(1)),
  channelOrigin: v.pipe(v.string(), v.url()),
  worker: v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    mainModule: v.pipe(v.string(), v.minLength(1)),
    compatibilityDate: v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/u)),
    compatibilityFlags: v.array(v.string()),
    modules: v.pipe(v.array(ReleaseFilePathSchema), v.minLength(1)),
    modulesPath: ReleaseFilePathSchema,
    assets: ReleaseFilePathSchema,
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
    path: ReleaseFilePathSchema,
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


/** Must match `workerArtifactPath`; the artifact is an R2 object, too large for a static asset. */
export const RELEASE_ARTIFACT_ROUTE = /^\/downloads\/(kinu-worker-[A-Za-z0-9._+-]+\.tar\.gz)$/u;

export function parseReleaseManifest(text: string): ReleaseManifest {
  return v.parse(ReleaseManifestSchema, JSON.parse(text));
}

export const RELEASE_MANIFEST_PATH = '/downloads/release.json';

export function workerArtifactPath(version: string): string {
  return `/downloads/kinu-worker-${version}.tar.gz`;
}
