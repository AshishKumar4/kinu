/**
 * Agent soul — the agent's declared purpose.
 *
 * The agent itself cannot modify this (no `setSoul` tool is exposed to the LLM).
 * This is the constitutional safety boundary that prevents an agent from
 * rewriting its own purpose.
 *
 * The user/operator CAN update the soul out-of-band via:
 *   - cf-backend: the `setSoul` @callable RPC, used by the Settings page UI
 *   - direct SQL: `UPDATE agent_soul SET purpose = ...`
 *
 * This module's `writeSoul` is the creation-time helper used during agent
 * genesis; it refuses to overwrite an existing soul. Operator edits should
 * go through the backend-specific RPC, not this helper.
 */

import type { SqlExecutor } from '../types/primitives.js';

/** Read the agent's declared purpose. */
export function readSoul(sql: SqlExecutor): string | null {
  const rows = sql<{ purpose: string }>`SELECT purpose FROM agent_soul LIMIT 1`;
  return rows[0]?.purpose ?? null;
}

/**
 * Write the soul at creation time. Refuses to overwrite an existing soul —
 * operator edits of an existing agent should use a backend-specific RPC
 * (e.g. `setSoul` on the cf-backend), not this helper.
 */
export function writeSoul(sql: SqlExecutor, purpose: string): void {
  const existing = readSoul(sql);
  if (existing) {
    throw new Error('Agent soul already exists. writeSoul is creation-only; use the backend setSoul RPC to update an existing agent.');
  }
  sql`INSERT INTO agent_soul (purpose, created_at) VALUES (${purpose}, ${Date.now()})`;
}
