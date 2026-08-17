/**
 * The egress secret vault — the owner's secrets, encrypted, in their own DO,
 * spent on their behalf without ever entering the container.
 *
 * WHY THIS IS A TABLE AND NOT A `user_credentials` KEY. `user_credentials` is
 * the authoritative store for PROVIDER credentials, and its shape is a
 * `Credential` discriminated union (`bearer | oauth | openai-compat`) whose key
 * SPELLING carries policy: `credential-headers.ts` decides model-tier reach by
 * matching `<name>.bearer` / `openai-compat.*`, and its own comment warns that
 * "a future non-model credential must not be stored under that suffix, or it
 * would silently inherit model-tier reach". An egress secret is a different
 * entity — it is bound to a HOST and carries a PLACEHOLDER, neither of which
 * the `Credential` union has room for — so giving it its own table keeps both
 * shapes honest instead of widening a union every consumer must then handle.
 *
 * WHAT IS REUSED, which is everything that matters: the same Durable Object,
 * the same `createCredentialCipher` (AES-256-GCM, HKDF-derived, `pce1.`
 * envelope), the same AAD discipline, the same `CREDENTIAL_ENCRYPTION_KEY` and
 * its rotation list, the same `reconcileColumns` path, and the same
 * `requireTier` caller gate. There is no second cipher, no second key and no
 * second store.
 *
 * WHAT THE CONTAINER CAN OBSERVE. A placeholder, and nothing else. The
 * placeholder is 32 bytes of CSPRNG output, generated here at bind time and
 * never derived from the secret — no hash, no prefix, no truncation — so
 * holding it tells the container nothing about the value it stands for, and
 * comparing two placeholders tells it nothing about whether two secrets are
 * equal. It is also not a bearer instrument: {@link resolveEgressInjection}
 * re-checks the destination on every single request, so lifting a placeholder
 * out of one request and posting it somewhere else yields a refusal.
 *
 * WHERE PLAINTEXT EXISTS. Exactly two places: inside this module while a seal
 * or an open is in flight, and in the outbound handler that attaches it to the
 * upstream request. The handler runs in the Workers runtime, OUTSIDE the
 * container — the same trust boundary `getAuthHeaders` already hands
 * ready-to-attach provider headers across. It is never written to the
 * container's environment, filesystem, process arguments, or any response the
 * container reads.
 */

import * as v from 'valibot';
import { reconcileColumns, type SqlExec, type SqlExecutor } from '@proteus/core';
import {
  EGRESS_PLACEHOLDER_BYTES,
  isEgressPlaceholder,
  planEgress,
  type EgressRequestFacts,
  type EgressSecretBinding,
} from '@proteus/core';
import { randomToken } from '../lib/crypto.js';
import type { CredentialCipher } from './credential-envelope.js';

/** A binding id is owner-authored and lands in a rule name and a SQL key, so
 *  it is held to the same shape as a credential key. */
const BINDING_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;

/** A host pattern may be a hostname or a `*` glob. Anything with a scheme,
 *  path, port or whitespace is a mistake that would silently never match. */
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

/** What the outbound handler gets back. `substitutions` carries the plaintext
 *  because the substitution is POSITIONAL inside an HTTP request this DO does
 *  not own; see the module header on where plaintext is allowed to be. */
export type EgressInjectionResult =
  | { readonly kind: 'forward'; readonly substitutions: readonly EgressInjection[] }
  | { readonly kind: 'refuse'; readonly status: number; readonly reason: string };

export interface EgressInjection {
  readonly placeholder: string;
  readonly secret: string;
}


/** What every vault operation needs: this DO's storage, the deployment cipher,
 *  and the AAD that binds a ciphertext to one binding in one user's store. */
export interface EgressVaultDeps {
  readonly sql: SqlExec;
  readonly cipher: CredentialCipher;
  readonly aad: (id: string) => string;
}

/** DDL owner for the vault. Called from `initUserTables`, which is the UserDO's
 *  only boot hook. */
export function initEgressVaultTables(sql: SqlExec, tagged: SqlExecutor): void {
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
  // The placeholder is how an intercepted request is resolved back to a
  // binding, so that lookup is indexed rather than a scan per request. UNIQUE
  // in the CREATE above is the property that matters: two bindings sharing a
  // placeholder would let one secret be spent where the other was approved.
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_egress_secrets_placeholder
            ON user_egress_secrets (placeholder)`);
  // Declared for the post-release column discipline: every column a shipped
  // table gains must stay listed here forever, or a DO created before it
  // breaks with `no such column`.
  reconcileColumns(tagged, (ddl) => { sql.exec(ddl); }, 'user_egress_secrets', {});
}

/** A fresh placeholder. Independent of the secret by construction — this
 *  function never sees one. */
export function mintEgressPlaceholder(): string {
  return `pxs1_${randomToken(EGRESS_PLACEHOLDER_BYTES)}`;
}

/** What the owner and the UI may see: every binding, no secret material. */
export function listEgressSecrets(sql: SqlExec): EgressSecretSummary[] {
  return sql.exec(
    `SELECT id, label, host, placeholder, created_at, updated_at
       FROM user_egress_secrets ORDER BY id`,
  ).toArray().map((row) => ({
    id: String(row.id),
    label: String(row.label),
    host: String(row.host),
    placeholder: String(row.placeholder),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

/**
 * Add or replace a secret.
 *
 * Replacing one KEEPS its placeholder. That is deliberate: a rotated key must
 * not require the container to be told a new dummy, and re-minting would leave
 * the old placeholder live in whatever config the agent already wrote. The
 * placeholder identifies the binding; the secret behind it is what rotates.
 */
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
    // Storing a placeholder AS a secret would make the substitution a no-op
    // and leave the container believing it holds a working credential.
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

/** Revoke a secret. Returns whether a row went away, so a caller can tell
 *  "revoked" from "was never there" instead of reporting success either way. */
export function revokeEgressSecret(sql: SqlExec, id: string): boolean {
  const before = sql.exec(`SELECT id FROM user_egress_secrets WHERE id = ?`, id).toArray().length > 0;
  if (!before) return false;
  sql.exec(`DELETE FROM user_egress_secrets WHERE id = ?`, id);
  return true;
}

/**
 * Decide one intercepted request and open only the secrets it may spend.
 *
 * `active` is the caller's view of which bindings the workspace has been
 * granted — the approval gate's answer, not this module's. The vault decides
 * DESTINATION; the approval gate decided CONSENT. Both must hold, and they are
 * enforced in different places on purpose: consent is a slow question asked of
 * the owner once, destination is a fast check made on every request.
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
      // The binding was in the handler's configured view but is gone from the
      // vault — revoked between configuration and this request. Fail closed:
      // forwarding the dummy would spend nothing but would look like a
      // working request that the upstream simply rejected.
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
 * Re-seal every row under the current key. Called by the UserDO's one rewrap
 * pass, beside the `user_credentials` and `user_mcp_servers.headers` loops.
 *
 * Load-bearing: the single marker `user_schema_meta.credential_envelope_key_id`
 * asserts the WHOLE store is sealed under the current keyId, and the documented
 * rotation drops `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` on the strength of that
 * assertion. A sealed column left out of the pass would be orphaned by the
 * next rotation, permanently.
 *
 * Returns false when any row failed, so the caller withholds the marker.
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
      console.warn(`[proteus] egress secret ${id} could not be re-sealed:`,
        error instanceof Error ? error.message : String(error));
    }
  }
  return clean;
}

/** Row readers. Validated rather than asserted, the same way
 *  `createWebhookSecretStore` reads its one column: a shape mismatch here means
 *  the table is not what this module thinks it is, and that must not be
 *  discovered by a downstream `undefined`. */
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
