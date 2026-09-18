/**
 * What a deploy step is given, as ports.
 *
 * A step touches four outside things: Cloudflare (the transport), the release
 * artifact's bytes, secret material, and what earlier steps established. Each
 * is a port so the same steps run in the deploy Durable Object, in a
 * deployment updating itself, and in a test with no network.
 */
import type { ArtifactMember, HeldBytes } from './artifact';
import type { CloudflareTransport } from './cloudflare';
import type { DeployInputs } from './inputs';
import type { ReleaseManifest } from './manifest';

/**
 * The artifact's files, in the order the archive carries them.
 *
 * A WALK RATHER THAN A LOOKUP. The Durable Object that installs a release
 * cannot hold the unpacked archive (docs/SELF-DEPLOY.md § What the artifact
 * weighs), so a step takes each member as it arrives and keeps only what it
 * has to. `held` is the run's accountant: the reader charges the compressed
 * buffer, and a step charges whatever it keeps out of a member.
 */
export interface ArtifactSource {
  readonly held: HeldBytes;
  members(): AsyncIterable<ArtifactMember>;
}

/** Reading a URL that is not the Cloudflare API: the runtime cache seed and the
 *  smoke check against the new deployment. Narrower than `fetch` on purpose —
 *  the flow needs a GET, and a port the size of the whole Fetch API would let a
 *  step reach for streaming, credentials or a method nobody reviewed. */
export type HttpGet = (url: string) => Promise<Response>;

/**
 * Secret material for the length of the run and no longer.
 *
 * The vault is deliberately separate from the ledger: a ledger row is durable
 * and readable, and the person's Cloudflare token, their provider keys and the
 * minted root secrets must be in neither a row nor a log line. `wipe` is what
 * the last step calls, and what the run's completion is proved by.
 */
export interface DeploySecretVault {
  read(name: string): Promise<string | null>;
  write(name: string, value: string): Promise<void>;
  wipe(): Promise<void>;
  names(): Promise<readonly string[]>;
}

/**
 * What earlier steps established: a KV namespace id, the created gateway, the
 * uploaded version. Durable, because a run that resumes after an eviction
 * must not create a second namespace to learn the id of the first.
 */
export interface DeployFacts {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export interface DeployContext {
  readonly manifest: ReleaseManifest;
  readonly inputs: DeployInputs;
  readonly transport: CloudflareTransport;
  readonly artifact: ArtifactSource;
  readonly vault: DeploySecretVault;
  readonly facts: DeployFacts;
  readonly http: HttpGet;
  /** Whether this run is a deployment updating itself rather than a first
   *  sitting. Two steps must know: the root secrets are minted once and never
   *  again, and an upload onto an existing script declares no migrations. */
  readonly update: boolean;
  /** A line of progress inside a step, streamed to the page and kept on the
   *  step's row. Never a secret: steps pass resource names, not values. */
  note(message: string): void;
}

export const FACT_ACCOUNT_NAME = 'account.name';

export const FACT_WORKERS_SUBDOMAIN = 'account.workers_subdomain';

export const FACT_GATEWAY_URL = 'ai_gateway.url';

export const FACT_ACCESS_APP = 'access.app_id';

/** The address the Access policy admits, and therefore the address a person is
 *  told to sign in with once the run is over. A fact rather than a read of the
 *  inputs row: the page that comes back after a reload holds no answers. */
export const FACT_OWNER_EMAIL = 'access.owner_email';

export const FACT_VERSION_ID = 'worker.version_id';

/** The most the upload step was holding at once, in bytes: the compressed
 *  artifact, the module set it must send in one request, and the asset batch
 *  in flight. Durable because it is what says whether the next release still
 *  installs from inside a Durable Object, and a run that reset would leave no
 *  other trace of how close it came. */
export const FACT_UPLOAD_PEAK = 'worker.held_peak_bytes';

export const FACT_ADDRESS = 'worker.address';

export function kvFact(binding: string): string {
  return `kv.${binding}`;
}
