/** Secrets live in their own table so `listTriggers` can never return one. */

import * as v from 'valibot';
import type { SqlExec } from '../../types/primitives';
import type { SecretStore } from './webhook';

export interface WebhookSecretStore extends SecretStore {
  put(secretId: string, triggerId: string, secret: string, now: number): void;
  /** Revocation calls this in the same host call that closes the trigger. */
  deleteByTrigger(triggerId: string): void;
}

const SecretRowSchema = v.object({ secret: v.string() });

export function createWebhookSecretStore(sql: SqlExec): WebhookSecretStore {
  // Created eagerly: a read against an absent table throws.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS webhook_secrets (
      secret_id TEXT PRIMARY KEY,
      trigger_id TEXT NOT NULL,
      secret TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);

  // Guarded: SQLite resolves `triggers` at prepare time, and a workspace without hub tables must
  // still read its secrets.
  const hasTriggers = sql.exec(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'triggers'`,
  ).toArray().length > 0;

  if (hasTriggers) {
    // Not actor-scoped: `webhook_secrets` has no `actor_id`, so scoping would delete other actors'
    // live secrets. Sound only because trigger ids are ULIDs, unique across actors.
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
