import { generateText } from 'ai';
import {
  WORKSPACE_IDENTITY_SYSTEM_PROMPT,
  DEFAULT_WORKERS_AI_MODEL_SPEC,
  effortFor,
  workspaceIdentityPrompt,
  createWorkspaceNameFromMission,
  deriveWorkspaceTitle,
  fallbackWorkspaceIdentity,
  parseWorkspaceIdentityOutput,
  renderSoulMarkdown,
} from '@proteus/core';
import type { OrchestratorAgent } from '../orchestrator.js';
import { createAgentProviderRegistry } from '../providers/agent-registry.js';
import { listAvailableModels, type ModelMenuEntry } from './available-models.js';
import type { WorkspaceEntry, UserDO } from './user-do.js';

export interface CreateCloudWorkspaceInput {
  name?: string;
  displayName?: string;
  purpose?: string;
}

export interface CreateCloudWorkspaceOptions {
  waitUntil?: (promise: Promise<unknown>) => void;
  suggestDisplayName?: (mission: string) => Promise<string | null>;
}

export async function createCloudWorkspaceForUser(
  env: Env,
  userId: string,
  userDO: DurableObjectStub<UserDO>,
  input: CreateCloudWorkspaceInput,
  options: CreateCloudWorkspaceOptions = {},
): Promise<WorkspaceEntry> {
  const purpose = input.purpose?.trim() || undefined;
  const models = await listAvailableModels(env, userId);
  const model = pickInitialModel(await userDO.getConfig('default_model'), models);
  if (!model) {
    throw new Error('Cloudflare Workers AI is not connected. Reconnect Cloudflare with Workers AI permissions, then create the workspace again.');
  }

  const identity = createInitialCloudAgentIdentity(input, purpose);

  const { entry, existed } = await userDO.registerWorkspace(identity.name, identity.displayName, purpose);
  try {
    await initializeOrchestrator(env, userId, entry.name, entry.displayName, purpose, model);
    if (identity.nameOrigin === 'auto' && purpose) {
      scheduleCloudAgentDisplayNameGeneration(env, userDO, entry.name, purpose, model, options);
    }
    return entry;
  } catch (err) {
    // Roll back ONLY a row this create inserted. A pre-existing row — even an
    // archived one, which registerWorkspace resurrects on name conflict — must
    // never be destroyed here: removeWorkspace wipes the agent's whole DO.
    if (!existed) {
      try {
        await userDO.removeWorkspace(entry.name, userId);
      } catch (rollbackErr) {
        console.warn('[proteus] createCloudWorkspaceForUser rollback failed:', rollbackErr instanceof Error ? rollbackErr.message : rollbackErr);
      }
    }
    throw err;
  }
}

function createInitialCloudAgentIdentity(
  input: CreateCloudWorkspaceInput,
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
  const name = createWorkspaceNameFromMission(purpose ?? '', id);
  return {
    name,
    displayName: input.displayName?.trim()
      || (purpose ? deriveWorkspaceTitle(purpose) : fallbackWorkspaceIdentity('', id).displayName),
    nameOrigin: 'auto',
  };
}

function scheduleCloudAgentDisplayNameGeneration(
  env: Env,
  userDO: DurableObjectStub<UserDO>,
  agentName: string,
  mission: string,
  modelSpec: string,
  options: CreateCloudWorkspaceOptions,
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
    // No output cap: reasoning models spend budget on thinking before the
    // JSON, so a cap starves them into empty text and the generic name wins.
    ...effortFor('reflection'),
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
  await orchestrator.setProvisionalDisplayName(displayName);
  await orchestrator.setSoul(renderSoulMarkdown({ name: displayName, mission }));
  if (model) await orchestrator.setModel(model);
}

function pickInitialModel(defaultModel: string | null, models: ModelMenuEntry[]): string | null {
  if (defaultModel && models.some((model) => model.spec === defaultModel)) return defaultModel;
  return models.find((model) => model.spec === DEFAULT_WORKERS_AI_MODEL_SPEC)?.spec
    ?? models[0]?.spec
    ?? null;
}
