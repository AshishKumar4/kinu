/**
 * Canonical conversation identity.
 *
 * One local workspace has ONE durable conversation per agent. The id lives in
 * the workspace's own `agent_config` table, so every process that opens the
 * workspace — an interactive CLI, a one-shot `kinu exec`, the scheduler
 * daemon's LocalAgentHost — resolves the same key and drives the same
 * conversation, instead of each JSONL recording session minting its own.
 *
 * The recorded JSONL files are diagnostics/export from here on; they never
 * decide where a turn lands.
 */

import { AGENT_CONFIG_KEYS, type AgentConfigStore } from './store';

/**
 * The conversation every workspace starts in.
 *
 * Adopted (not invented) when no row exists yet: every workspace created
 * before this seam already has its history under session id "default", so
 * adopting it keeps that history continuous instead of stranding it under an
 * id nothing reads any more.
 */
const FIRST_CONVERSATION_ID = 'default';

/** Resolve — creating on first use — the agent's canonical conversation id. */
export function canonicalConversationId(config: AgentConfigStore): string {
  const stored = config.get(AGENT_CONFIG_KEYS.conversationId);
  if (stored) return stored;
  config.set(AGENT_CONFIG_KEYS.conversationId, FIRST_CONVERSATION_ID);
  return FIRST_CONVERSATION_ID;
}
