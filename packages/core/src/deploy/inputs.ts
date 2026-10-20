// Inputs land in the durable run row, so no secret belongs here; secrets live in the vault.
import * as v from 'valibot';
import type { ReleaseManifest } from './manifest';

export type DeployAddressKind = 'workers-dev' | 'zone';

export interface DeployAddress {
  readonly kind: DeployAddressKind;
  /** Empty for `workers-dev`; the address step derives it. */
  readonly hostname: string;
  readonly zoneId: string;
}

export interface DeployInputs {
  readonly accountId: string;
  readonly instanceName: string;
  readonly address: DeployAddress;
  /** The person's Cloudflare email: the first owner's, and the deployment's admin. */
  readonly ownerEmail: string;
  /** Names only; values are in the vault. */
  readonly providerKeyNames: readonly string[];
  /** Needs Workers Paid (SELF-DEPLOY.md). */
  readonly sandbox: boolean;
  /** The domain mail addresses sit on (docs/MAIL.md §1); absent or '' gives the deployment no mail. */
  readonly mailDomain?: string;
  /** Who may claim a mail address: the operators (the default), or everyone. */
  readonly mailAccounts?: 'operators' | 'everyone';
}

// Letter first: an RFC 8941 key in the override header.
const INSTANCE_NAME = /^[a-z][a-z0-9-]{0,54}$/u;

export const DeployInputsSchema: v.GenericSchema<DeployInputs> = v.object({
  accountId: v.pipe(v.string(), v.regex(/^[0-9a-f]{32}$/u)),
  instanceName: v.pipe(v.string(), v.regex(INSTANCE_NAME)),
  address: v.variant('kind', [
    v.object({
      kind: v.literal('workers-dev'),
      hostname: v.literal(''),
      zoneId: v.literal(''),
    }),
    v.object({
      kind: v.literal('zone'),
      hostname: v.pipe(v.string(), v.regex(/^[a-z0-9.-]+\.[a-z]{2,}$/u)),
      zoneId: v.pipe(v.string(), v.regex(/^[0-9a-f]{32}$/u)),
    }),
  ]),
  ownerEmail: v.pipe(v.string(), v.email()),
  providerKeyNames: v.array(v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]*$/u))),
  sandbox: v.boolean(),
  // Optional: a record written before mail reads as a deployment without it.
  mailDomain: v.optional(v.union([v.literal(''), v.pipe(v.string(), v.regex(/^[a-z0-9.-]+\.[a-z]{2,}$/u))])),
  mailAccounts: v.optional(v.picklist(['operators', 'everyone'])),
});

export const DEFAULT_INSTANCE_NAME = 'kinu';

export const ACCESS_TOKEN_KEY = 'cloudflare.access_token';

/** The last step moves this into the new Worker's secrets and deletes it here. */
export const REFRESH_TOKEN_KEY = 'cloudflare.refresh_token';

/** A refresh must name its client, so the deployment keeps it. */
export const DEPLOY_CLIENT_ID_KEY = 'cloudflare.client_id';

export const DEPLOYMENT_REFRESH_SECRET = 'KINU_SELF_DEPLOY_REFRESH_TOKEN';

export const DEPLOYMENT_RECORD_SECRET = 'KINU_DEPLOYMENT_RECORD';

/** Holds the full `DeployInputs`, since an update reruns the same plan. */
export interface DeploymentRecord {
  readonly inputs: DeployInputs;
  readonly address: string;
  readonly version: string;
  readonly channelOrigin: string;
  readonly clientId: string;
  readonly deployedAt: string;
}

export const DeploymentRecordSchema: v.GenericSchema<DeploymentRecord> = v.object({
  inputs: DeployInputsSchema,
  address: v.string(),
  version: v.string(),
  channelOrigin: v.string(),
  clientId: v.string(),
  deployedAt: v.string(),
});

/** Minted by the run; the page shows them once. */
export const MINTED_SECRETS: readonly string[] = ['CREDENTIAL_ENCRYPTION_KEY', 'WEBHOOK_ROUTE_SECRET', 'JWT_SECRET'];

/** Required only of a deployment with the computer. */
export const COMPUTER_SECRETS: readonly string[] = ['DEVBOX_REGISTRY_TOKEN'];

/** The first owner's one-time seat, as the deployment's built-in sign-in reads it (`firstOwnerLinkSecret`). */
export const FIRST_OWNER_LINK_SECRET = 'KINU_FIRST_OWNER_LINK';

/** How long the setup link creates the owner. */
export const FIRST_OWNER_LINK_MS = 7 * 24 * 60 * 60 * 1000;

export function promptedSecrets(manifest: ReleaseManifest): readonly string[] {
  return manifest.secrets
    .filter((secret) => secret.handling === 'prompted' && !MINTED_SECRETS.includes(secret.name))
    .map((secret) => secret.name);
}

