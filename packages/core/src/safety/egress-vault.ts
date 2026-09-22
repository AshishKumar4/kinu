/**
 * Egress secret vault: owner secrets sealed in their own DO with the shared credential cipher, key and rotation.
 * Separate from `user_credentials` because that key spelling carries model-tier reach policy.
 * The container only sees a random placeholder, never derived from the secret; the destination is re-checked
 * per request. Plaintext exists only here and in the outbound handler, outside the container.
 */

import * as v from 'valibot';
import type { CredentialCipher } from '../credentials/envelope';
import { toKinuError } from '../obs/error';
import { diagnostics } from '../obs/log';
import type { SqlExec } from '../types/primitives';
import { nanoid } from '../utils/nanoid';
import {
  EGRESS_PLACEHOLDER_PREFIX,
  PLACEHOLDER_BODY_LENGTH,
  isEgressPlaceholder,
  planEgress,
  type EgressRequestFacts,
  type EgressSecretBinding,
} from './egress-gate';

/** Lands in a rule name and a SQL key, so held to the credential-key shape. */
const BINDING_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;

/** Hostname or `*` glob; a scheme, path, port or whitespace would silently never match. */
const HOST_PATTERN_RE = /^[a-zA-Z0-9.*_-]{1,253}$/;

export interface EgressSecretSummary extends EgressSecretBinding {
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PutEgressSecretInput {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly secret: string;
}

/** `substitutions` carries plaintext: substitution is positional inside a request this DO does not own. */
export type EgressInjectionResult =
  | { readonly kind: 'forward'; readonly substitutions: readonly EgressInjection[] }
  | { readonly kind: 'refuse'; readonly status: number; readonly reason: string };

export interface EgressInjection {
  readonly placeholder: string;
  readonly secret: string;
}


/** `aad` binds a ciphertext to one binding in one user's store. */
export interface EgressVaultDeps {
  readonly sql: SqlExec;
  readonly cipher: CredentialCipher;
  readonly aad: (id: string) => string;
}

export function initEgressVaultTables(sql: SqlExec): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_egress_secrets (
      id          TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      host        TEXT NOT NULL,
      placeholder TEXT NOT NULL UNIQUE,
      secret      TEXT NOT NULL,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  // Placeholder UNIQUE is load-bearing: a shared placeholder would spend one secret where another was approved.
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_egress_secrets_placeholder
            ON user_egress_secrets (placeholder)`);
}

/** Independent of the secret by construction. */
function mintEgressPlaceholder(): string {
  return `${EGRESS_PLACEHOLDER_PREFIX}${nanoid(PLACEHOLDER_BODY_LENGTH)}`;
}

const EgressSecretRowSchema = v.object({
  id: v.string(),
  label: v.string(),
  host: v.string(),
  placeholder: v.string(),
  created_at: v.number(),
  updated_at: v.number(),
});

/** Every binding, no secret material. */
export function listEgressSecrets(sql: SqlExec): EgressSecretSummary[] {
  return sql.exec(
    `SELECT id, label, host, placeholder, created_at, updated_at
       FROM user_egress_secrets ORDER BY id`,
  ).toArray().map((row) => {
    const binding = v.parse(EgressSecretRowSchema, row);

    return {
      id: binding.id,
      label: binding.label,
      host: binding.host,
      placeholder: binding.placeholder,
      createdAt: binding.created_at,
      updatedAt: binding.updated_at,
    };
  });
}

/** Add or replace a secret. Replacing keeps the placeholder, so rotation needs no container change. */
export async function putEgressSecret(
  deps: EgressVaultDeps,
  input: PutEgressSecretInput,
): Promise<EgressSecretBinding> {
  if (!BINDING_ID_RE.test(input.id)) {
    throw new Error(`Invalid egress secret id "${input.id}" — letters, digits, dot, dash, underscore, up to 128.`);
  }

  if (!HOST_PATTERN_RE.test(input.host)) {
    throw new Error(
      `Invalid egress host "${input.host}" — a hostname or a * glob, with no scheme, port, path or space.`,
    );
  }

  if (input.secret.length === 0) throw new Error('An egress secret cannot be empty.');

  if (isEgressPlaceholder(input.secret)) {
    throw new Error('That value is a placeholder, not a secret.');
  }

  if (input.label.length === 0 || input.label.length > 200) {
    throw new Error('An egress secret needs a label of 1–200 characters.');
  }

  const existing = readOne(PlaceholderRow, deps.sql, `SELECT placeholder FROM user_egress_secrets WHERE id = ?`, input.id);
  const placeholder = existing ? String(existing.placeholder) : mintEgressPlaceholder();
  const sealed = await deps.cipher.seal(deps.aad(input.id), input.secret);
  deps.sql.exec(
    `INSERT INTO user_egress_secrets (id, label, host, placeholder, secret)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       label = excluded.label, host = excluded.host, secret = excluded.secret,
       updated_at = unixepoch() * 1000`,
    input.id, input.label, input.host, placeholder, sealed,
  );

  return { id: input.id, label: input.label, host: input.host, placeholder };
}

/** Returns whether a row went away ("revoked" vs "was never there"). */
export function revokeEgressSecret(sql: SqlExec, id: string): boolean {
  return sql.exec(`DELETE FROM user_egress_secrets WHERE id = ? RETURNING id`, id).toArray().length > 0;
}

/**
 * Decide one intercepted request and open only the secrets it may spend.
 * `active` is the approval gate's consent; this checks destination on every request.
 */
export async function resolveEgressInjection(
  deps: EgressVaultDeps,
  facts: EgressRequestFacts,
  active: readonly EgressSecretBinding[],
): Promise<EgressInjectionResult> {
  const plan = planEgress(facts, active);

  if (plan.kind === 'refuse') return plan;

  if (plan.substitutions.length === 0) return { kind: 'forward', substitutions: [] };

  const substitutions: EgressInjection[] = [];

  for (const { bindingId, placeholder } of plan.substitutions) {
    const row = readOne(SecretRow, deps.sql, `SELECT secret FROM user_egress_secrets WHERE id = ?`, bindingId);

    if (!row) {
      // Revoked since configuration: fail closed rather than forward the dummy.
      return {
        kind: 'refuse',
        status: 403,
        reason: 'A secret this request needs has been revoked.',
      };
    }

    substitutions.push({ placeholder, secret: await deps.cipher.open(deps.aad(bindingId), String(row.secret)) });
  }

  return { kind: 'forward', substitutions };
}

/**
 * Re-seal every row under the current key; false when any row failed, so the caller withholds
 * `credential_envelope_key_id` (rotation drops the previous key on the strength of that marker).
 */
export async function rewrapEgressSecrets(
  deps: EgressVaultDeps,
): Promise<boolean> {
  let clean = true;

  for (const raw of deps.sql.exec(`SELECT id, secret FROM user_egress_secrets`).toArray()) {
    const parsed = v.safeParse(IdSecretRow, raw);

    if (!parsed.success) { clean = false; continue; }

    const { id, secret } = parsed.output;

    try {
      const plaintext = await deps.cipher.open(deps.aad(id), secret);
      const resealed = await deps.cipher.seal(deps.aad(id), plaintext);
      deps.sql.exec(`UPDATE user_egress_secrets SET secret = ? WHERE id = ?`, resealed, id);
    } catch (error) {
      clean = false;
      diagnostics.failure('egress.secret_reseal_failed', toKinuError({
        doing: 'resealing an egress secret under the current key',
        cause: error,
        otherwise: 'bad_input',
      }), { secretId: id });
    }
  }

  return clean;
}

const PlaceholderRow = v.object({ placeholder: v.string() });

const SecretRow = v.object({ secret: v.string() });

const IdSecretRow = v.object({ id: v.string(), secret: v.string() });

function readOne<Schema extends v.GenericSchema>(
  schema: Schema, sql: SqlExec, query: string, ...values: string[]
): v.InferOutput<Schema> | undefined {
  const row = sql.exec(query, ...values).toArray()[0];

  if (row === undefined) return undefined;
  const parsed = v.safeParse(schema, row);

  if (!parsed.success) {
    throw new Error(`user_egress_secrets row does not match its expected shape: ${query}`);
  }

  return parsed.output;
}
