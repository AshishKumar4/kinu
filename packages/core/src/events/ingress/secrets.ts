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
  };
}
