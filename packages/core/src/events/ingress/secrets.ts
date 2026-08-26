/**
 * Webhook secret storage — the workspace-storage implementation of
 * {@link SecretStore}.
 *
 * Secrets live in their own table rather than beside the trigger row, so
 * `listTriggers` can never return one: reading a trigger and reading its secret
 * are separate queries, and only the ingress path makes the second.
 */

import * as v from 'valibot';
import type { SqlExec } from '../../types/primitives';
import type { SecretStore } from './webhook';

export interface WebhookSecretStore extends SecretStore {
  /** Store the secret a freshly registered webhook was created with. */
  put(secretId: string, triggerId: string, secret: string, now: number): void;
  /** Delete every secret stored for this trigger. Idempotent. Revocation
   *  calls this in the same host call that closes the trigger, so the
   *  credential dies with the thing it authenticated — never outliving it. */
  deleteByTrigger(triggerId: string): void;
}

const SecretRowSchema = v.object({ secret: v.string() });

export function createWebhookSecretStore(sql: SqlExec): WebhookSecretStore {
  // Created here rather than lazily in put(): a read against an absent table
  // throws, and swallowing that throw made "no webhook was ever registered"
  // indistinguishable from a revoked secret on the delivery path.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS webhook_secrets (
      secret_id TEXT PRIMARY KEY,
      trigger_id TEXT NOT NULL,
      secret TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  // One orphan sweep beside the DDL: a secret whose trigger is revoked or no
  // longer exists is plaintext with no door left to unlock. Pre-cutover
  // revocations leaked exactly these rows. Guarded from JS because SQLite
  // resolves the `triggers` reference at PREPARE time — a workspace that has
  // never initialised the hub tables must still be able to read its secrets.
  const hasTriggers = sql.exec(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'triggers'`,
  ).toArray().length > 0;
  if (hasTriggers) {
    sql.exec(`
      DELETE FROM webhook_secrets
      WHERE NOT EXISTS (
        SELECT 1 FROM triggers t
        WHERE t.id = webhook_secrets.trigger_id AND t.state != 'revoked'
      )`);
  }
  return {
    async get(secretId) {
      const row = sql.exec(
        `SELECT secret FROM webhook_secrets WHERE secret_id = ?`, secretId,
      ).toArray()[0];
      const parsed = v.safeParse(SecretRowSchema, row);
      return parsed.success ? parsed.output.secret : null;
    },
    put(secretId, triggerId, secret, now) {
      sql.exec(
        `INSERT INTO webhook_secrets (secret_id, trigger_id, secret, created_at) VALUES (?, ?, ?, ?)`,
        secretId, triggerId, secret, now,
      );
    },
    deleteByTrigger(triggerId) {
      sql.exec(`DELETE FROM webhook_secrets WHERE trigger_id = ?`, triggerId);
    },
  };
}
