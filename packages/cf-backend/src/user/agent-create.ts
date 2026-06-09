import { generateText } from 'ai';
import {
  agentIdentityPrompt,
  parseAgentIdentityOutput,
  renderSoulMarkdown,
} from '@proteus/core';
import type { OrchestratorAgent } from '../orchestrator.js';
import { createAgentProviderRegistry } from '../providers/agent-registry.js';
import { DEFAULT_WORKERS_AI_MODEL_SPEC, listAvailableModels, type ModelMenuEntry } from './available-models.js';
import type { AgentEntry, UserDO } from './user-do.js';

export interface CreateCloudAgentInput {
  name?: string;
  displayName?: string;
  purpose?: string;
}

export async function createCloudAgentForUser(
  env: Env,
  userId: string,
  userDO: DurableObjectStub<UserDO>,
  input: CreateCloudAgentInput,
): Promise<AgentEntry> {
  const purpose = input.purpose?.trim() || undefined;
  const models = await listAvailableModels(env, userId);
  const model = pickInitialModel(await userDO.getConfig('default_model'), models);
  if (!model) {
    throw new Error('Cloudflare Workers AI is not connected. Reconnect Cloudflare with Workers AI permissions, then create the agent again.');
  }

  const identity = input.name?.trim()
    ? { name: input.name.trim(), displayName: input.displayName?.trim() || input.name.trim(), nameOrigin: 'user' as const }
    : await suggestCloudAgentIdentity(env, userId, userDO, purpose ?? '', model);

  const hadAgent = await userDO.hasAgent(identity.name);
  const entry = await userDO.registerAgent(identity.name, identity.displayName, purpose);
  try {
    await initializeOrchestrator(env, userId, entry.name, entry.displayName, purpose, model);
    return entry;
  } catch (err) {
    if (!hadAgent) {
      try {
        await userDO.removeAgent(entry.name, userId);
      } catch (rollbackErr) {
        console.warn('[proteus] createCloudAgentForUser rollback failed:', rollbackErr instanceof Error ? rollbackErr.message : rollbackErr);
      }
    }
    throw err;
  }
}

async function suggestCloudAgentIdentity(
  env: Env,
  userId: string,
  userDO: DurableObjectStub<UserDO>,
  mission: string,
  modelSpec: string,
): Promise<{ name: string; displayName: string }> {
  const id = crypto.randomUUID();
  if (!mission.trim()) throw new Error('Mission required for automatic cloud agent naming.');
  try {
    const provider = createAgentProviderRegistry({ env, userDOStub: userDO, fetch });
    const result = await generateText({
      model: provider.resolveModel(modelSpec),
      system: 'You create short, useful names for persistent software agents.',
      prompt: agentIdentityPrompt(mission),
      maxOutputTokens: 80,
    });
    const identity = parseAgentIdentityOutput(result.text, id);
    if (!identity) throw new Error('model returned invalid naming JSON');
    return identity;
  } catch (err) {
    throw new Error(`Could not generate a cloud agent name: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function initializeOrchestrator(
  env: Env,
  userId: string,
  agentName: string,
  displayName: string,
  mission?: string,
  model?: string,
): Promise<void> {
  const orchestrator = env.OrchestratorAgent.get(
    env.OrchestratorAgent.idFromName(agentName),
  ) as DurableObjectStub<OrchestratorAgent>;
  await orchestrator.claimOwner(userId);
  await orchestrator.setSoul(renderSoulMarkdown({ name: displayName, mission }));
  if (model) await orchestrator.setModel(model);
}

function pickInitialModel(defaultModel: string | null, models: ModelMenuEntry[]): string | null {
  if (defaultModel && models.some((model) => model.spec === defaultModel)) return defaultModel;
  return models.find((model) => model.spec === DEFAULT_WORKERS_AI_MODEL_SPEC)?.spec
    ?? models[0]?.spec
    ?? null;
}
