/**
 * What a person answers before a deployment can run, and the defaults the
 * page and the CLI both start from.
 *
 * Everything here is data a step reads. Nothing here is a secret: the OAuth
 * token and any provider key live in the vault (`DeploySecretVault`), never in
 * the inputs, because the inputs are written into the durable run row and a
 * row is readable for as long as the run exists.
 */
import * as v from 'valibot';
import type { ReleaseManifest } from './manifest';

/** Where the deployment answers. `workers-dev` needs nothing from the person;
 *  `zone` needs a zone they hold and a hostname inside it, and the flow makes
 *  the custom domain (which is what creates the DNS record). */
export type DeployAddressKind = 'workers-dev' | 'zone';

export interface DeployAddress {
  readonly kind: DeployAddressKind;
  /** Empty for `workers-dev`: the hostname is `<instance>.<account subdomain>`
   *  and the account subdomain is read during the address step. */
  readonly hostname: string;
  readonly zoneId: string;
}

export interface DeployInputs {
  readonly accountId: string;
  readonly instanceName: string;
  readonly address: DeployAddress;
  /** The address the Access policy admits and the deployment's owner. */
  readonly ownerEmail: string;
  readonly accessEmails: readonly string[];
  /** Names of provider keys the person supplied. The values are in the vault;
   *  these names tell the secrets step which ones to put. */
  readonly providerKeyNames: readonly string[];
  /** The sandbox needs Workers Paid and is off by default (SELF-DEPLOY.md). */
  readonly sandbox: boolean;
}

const INSTANCE_NAME = /^[a-z0-9][a-z0-9-]{0,54}$/u;

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
  accessEmails: v.array(v.pipe(v.string(), v.email())),
  providerKeyNames: v.array(v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]*$/u))),
  sandbox: v.boolean(),
});

export const DEFAULT_INSTANCE_NAME = 'kinu';

/** The vault key the guided run holds the person's Cloudflare access token
 *  under, for the duration of the run only. */
export const ACCESS_TOKEN_KEY = 'cloudflare.access_token';

/** The refresh token, which the last step writes into the new Worker as its
 *  own secret and then deletes here. The deployment owns its key from that
 *  moment; kinu.run holds nothing. */
export const REFRESH_TOKEN_KEY = 'cloudflare.refresh_token';

/** The secret the deployment reads to refresh its own Cloudflare token. */
export const DEPLOYMENT_REFRESH_SECRET = 'KINU_SELF_DEPLOY_REFRESH_TOKEN';

/** The deployment's own record of what it is: instance name, account, address,
 *  version, and the channel it pulls updates from. Read by the Updates page. */
export const DEPLOYMENT_RECORD_SECRET = 'KINU_DEPLOYMENT_RECORD';

export interface DeploymentRecord {
  readonly accountId: string;
  readonly scriptName: string;
  readonly address: string;
  readonly version: string;
  readonly channelOrigin: string;
  readonly ownerEmail: string;
  readonly deployedAt: string;
}

/** Every secret the deployment needs that nobody has to type: the two root
 *  secrets are minted here and never leave the run. A person who wants to keep
 *  a copy reads them once from the page (the same rule the provisioner has:
 *  a key nobody has seen is a key nobody can restore). */
export const MINTED_SECRETS: readonly string[] = ['CREDENTIAL_ENCRYPTION_KEY', 'WEBHOOK_ROUTE_SECRET'];

/** The secrets this release asks a person for, in the order the page shows
 *  them. Optional ones are offered, required ones block the run. */
export function promptedSecrets(manifest: ReleaseManifest): readonly string[] {
  return manifest.secrets
    .filter((secret) => secret.handling === 'prompted' && !MINTED_SECRETS.includes(secret.name))
    .map((secret) => secret.name);
}

