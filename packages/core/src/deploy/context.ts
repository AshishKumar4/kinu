// Ports so the same steps run in the deploy DO, a self-update, and a test with no network.
import type { ArtifactMember, HeldBytes } from './artifact';
import type { CloudflareTransport } from './cloudflare';
import type { DeployInputs } from './inputs';
import type { ReleaseManifest } from './manifest';

/**
 * A walk, not a lookup: the DO cannot hold the unpacked archive (docs/SELF-DEPLOY.md).
 * Steps charge `held` for whatever they keep out of a member.
 */
export interface ArtifactSource {
  readonly held: HeldBytes;
  members(): AsyncIterable<ArtifactMember>;
}

/** GET only, deliberately narrower than `fetch`. */
export type HttpGet = (url: string, headers?: Readonly<Record<string, string>>) => Promise<Response>;

/** Secrets for the run only, kept out of the durable ledger. The last step calls `wipe`. */
export interface DeploySecretVault {
  read(name: string): Promise<string | null>;
  write(name: string, value: string): Promise<void>;
  wipe(): Promise<void>;
  names(): Promise<readonly string[]>;
}

/** Durable so a run resumed after eviction does not recreate resources. */
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
  /** Self-update: root secrets are not re-minted and the upload declares no migrations. */
  readonly update: boolean;
  /** Never a secret: pass resource names, not values. */
  note(message: string): void;
}

export const FACT_ACCOUNT_NAME = 'account.name';

export const FACT_WORKERS_SUBDOMAIN = 'account.workers_subdomain';

export const FACT_GATEWAY_URL = 'ai_gateway.url';

export const FACT_ACCESS_APP = 'access.app_id';

export const FACT_OWNER_EMAIL = 'access.owner_email';

export const FACT_VERSION_ID = 'worker.version_id';

/** Peak bytes the upload step held at once. */
export const FACT_UPLOAD_PEAK = 'worker.held_peak_bytes';

export const FACT_ADDRESS = 'worker.address';

export function kvFact(binding: string): string {
  return `kv.${binding}`;
}
