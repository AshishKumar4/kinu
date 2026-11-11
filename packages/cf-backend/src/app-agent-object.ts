/** The object one app agent's conversation is kept in (app-agent-do.ts), named by its payer, app and person. */
import { objectNamed } from '@kinu.run/core';
import { appAgentKey, type AppAgentConversation } from '@kinu.run/core/slates';
import type { AppAgentDO } from './app-agent-do';

export function appAgentObject(env: Pick<Env, 'APP_AGENT'>, conversation: AppAgentConversation): DurableObjectStub<AppAgentDO> {
  return objectNamed(env.APP_AGENT, appAgentKey(conversation));
}
