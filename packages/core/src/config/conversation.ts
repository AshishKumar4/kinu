// One durable conversation per agent per workspace, keyed in `actor_config`; JSONL recordings never decide where a turn lands.

import { AGENT_CONFIG_KEYS, type AgentConfigStore } from './store';

/** Adopted when no row exists: recorded history already sits under session id "default". */
const FIRST_CONVERSATION_ID = 'default';

export function canonicalConversationId(config: AgentConfigStore): string {
  const stored = config.get(AGENT_CONFIG_KEYS.conversationId);

  if (stored) return stored;
  config.set(AGENT_CONFIG_KEYS.conversationId, FIRST_CONVERSATION_ID);

  return FIRST_CONVERSATION_ID;
}
