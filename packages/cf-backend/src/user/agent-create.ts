import { generateText } from 'ai';
import {
  WORKSPACE_IDENTITY_SYSTEM_PROMPT,
  DEFAULT_WORKERS_AI_MODEL_SPEC,
  workspaceIdentityPrompt,
  createWorkspaceNameFromMission,
  deriveWorkspaceTitle,
  parseWorkspaceIdentityOutput,
  renderSoulMarkdown,
} from '@proteus/core';
import type { OrchestratorAgent } from '../orchestrator.js';
import { createAgentProviderRegistry } from '../providers/agent-registry.js';
import { listAvailableModels, type ModelMenuEntry } from './available-models.js';
import type { AgentEntry, UserDO } from './user-do.js';

export interface CreateCloudAgentInput {
  name?: string;
  displayName?: string;
  purpose?: string;
}

export interface CreateCloudAgentOptions {
  waitUntil?: (promise: Promise<unknown>) => void;
  suggestDisplayName?: (mission: string) => Promise<string | null>;
}

export async function createCloudAgentForUser(
  env: Env,
  userId: string,
  userDO: DurableObjectStub<UserDO>,
  input: CreateCloudAgentInput,
  options: CreateCloudAgentOptions = {},
): Promise<AgentEntry> {
  const purpose = input.purpose?.trim() || undefined;
  const models = await listAvailableModels(env, userId);
  const model = pickInitialModel(await userDO.getConfig('default_model'), models);
  if (!model) {
    throw new Error('Cloudflare Workers AI is not connected. Reconnect Cloudflare with Workers AI permissions, then create the agent again.');
  }

  const identity = createInitialCloudAgentIdentity(input, purpose);

  const { entry, existed } = await userDO.registerAgent(identity.name, identity.displayName, purpose);
  try {
    await initializeOrchestrator(env, userId, entry.name, entry.displayName, purpose, model);
    if (identity.nameOrigin === 'auto' && purpose) {
      scheduleCloudAgentDisplayNameGeneration(env, userDO, entry.name, purpose, model, options);
    }
    return entry;
  } catch (err) {
    // Roll back ONLY a row this create inserted. A pre-existing row — even an
    // archived one, which registerAgent resurrects on name conflict — must
    // never be destroyed here: removeAgent wipes the agent's whole DO.
    if (!existed) {
      try {
        await userDO.removeAgent(entry.name, userId);
      } catch (rollbackErr) {
        console.warn('[proteus] createCloudAgentForUser rollback failed:', rollbackErr instanceof Error ? rollbackErr.message : rollbackErr);
      }
    }
    throw err;
  }
}

function createInitialCloudAgentIdentity(
  input: CreateCloudAgentInput,
  purpose: string | undefined,
): { name: string; displayName: string; nameOrigin: 'auto' | 'user' } {
  const requestedName = input.name?.trim();
  if (requestedName) {
    return {
      name: requestedName,
      displayName: input.displayName?.trim() || requestedName,
      nameOrigin: 'user',
    };
  }
  const id = crypto.randomUUID();
  const name = createWorkspaceNameFromMission(purpose ?? 'agent', id);
  return {
    name,
    displayName: input.displayName?.trim() || deriveWorkspaceTitle(purpose ?? '') || name,
    nameOrigin: 'auto',
  };
}

function scheduleCloudAgentDisplayNameGeneration(
  env: Env,
  userDO: DurableObjectStub<UserDO>,
  agentName: string,
  mission: string,
  modelSpec: string,
  options: CreateCloudAgentOptions,
): void {
  const task = applyGeneratedDisplayName(env, userDO, agentName, mission, modelSpec, options.suggestDisplayName)
    .catch((err) => {
      console.warn('[proteus] cloud agent display-name generation failed:', err instanceof Error ? err.message : err);
    });
  if (options.waitUntil) options.waitUntil(task);
  else void task;
}

async function applyGeneratedDisplayName(
  env: Env,
  userDO: DurableObjectStub<UserDO>,
  agentName: string,
  mission: string,
  modelSpec: string,
  suggestDisplayName?: (mission: string) => Promise<string | null>,
): Promise<void> {
  const displayName = suggestDisplayName
    ? await suggestDisplayName(mission)
    : await suggestCloudAgentDisplayName(env, userDO, mission, modelSpec);
  if (!displayName) return;
  const orchestrator = env.OrchestratorAgent.get(
    env.OrchestratorAgent.idFromName(agentName),
  ) as DurableObjectStub<OrchestratorAgent>;
  await orchestrator.setAutoDisplayName(displayName);
}

async function suggestCloudAgentDisplayName(
  env: Env,
  userDO: DurableObjectStub<UserDO>,
  mission: string,
  modelSpec: string,
): Promise<string | null> {
  const id = crypto.randomUUID();
  const provider = createAgentProviderRegistry({ env, userDOStub: userDO, fetch });
  const result = await generateText({
    model: provider.resolveModel(modelSpec),
    system: WORKSPACE_IDENTITY_SYSTEM_PROMPT,
    prompt: workspaceIdentityPrompt(mission),
    maxOutputTokens: 80,
  });
  return parseWorkspaceIdentityOutput(result.text, id)?.displayName ?? null;
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
