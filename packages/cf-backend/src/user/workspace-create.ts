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
  isReasoningEffort,
  type ReasoningEffort,
} from '@proteus/core';
import type { OrchestratorAgent } from '../orchestrator.js';
import { createAgentProviderRegistry } from '../providers/agent-registry.js';
import type { UserCaller } from './workspace-capability.js';
import { listAvailableModels, type ModelMenuEntry } from './available-models.js';
import type { WorkspaceEntry, UserDO } from './user-do.js';

export interface CreateCloudWorkspaceInput {
  name?: string;
  displayName?: string;
  purpose?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface CreateCloudWorkspaceOptions {
  waitUntil?: (promise: Promise<unknown>) => void;
  suggestDisplayName?: (mission: string) => Promise<string | null>;
}

export async function createCloudWorkspaceForUser(
  env: Env,
  userId: string,
  userDO: DurableObjectStub<UserDO>,
  caller: UserCaller,
  input: CreateCloudWorkspaceInput,
  options: CreateCloudWorkspaceOptions = {},
): Promise<WorkspaceEntry> {
  const purpose = input.purpose?.trim() || undefined;
  if (input.reasoningEffort !== undefined && !isReasoningEffort(input.reasoningEffort)) {
    throw new Error(`Invalid reasoning effort: ${String(input.reasoningEffort)}`);
  }
  const models = await listAvailableModels(env, userId, caller);
  const model = pickInitialModel(input.model ?? await userDO.getConfig(caller, 'default_model'), models);
  if (!model) {
    throw new Error('Cloudflare Workers AI is not connected. Reconnect Cloudflare with Workers AI permissions, then create the workspace again.');
  }

  const identity = createInitialCloudAgentIdentity(input, purpose);

  const { entry, existed } = await userDO.registerWorkspace(caller, identity.name, identity.displayName, purpose);
  try {
    await initializeOrchestrator({
      env, userId, userDO, agentName: entry.name, displayName: entry.displayName,
      ...(purpose ? { mission: purpose } : {}),
      ...(model ? { model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    });
    if (identity.nameOrigin === 'auto' && purpose) {
      scheduleCloudAgentDisplayNameGeneration(env, userDO, caller, entry.name, purpose, model, options);
    }
    return entry;
  } catch (err) {
    // Roll back ONLY a row this create inserted. A pre-existing row — even an
    // archived one, which registerWorkspace resurrects on name conflict — must
    // never be destroyed here: removeWorkspace wipes the agent's whole DO.
    if (!existed) {
      try {
        await userDO.removeWorkspace(caller, entry.name, userId);
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
  caller: UserCaller,
  agentName: string,
  mission: string,
  modelSpec: string,
  options: CreateCloudWorkspaceOptions,
): void {
  const task = applyGeneratedDisplayName(env, userDO, caller, agentName, mission, modelSpec, options.suggestDisplayName)
    .catch((err) => {
      console.warn('[proteus] cloud agent display-name generation failed:', err instanceof Error ? err.message : err);
    });
  if (options.waitUntil) options.waitUntil(task);
  else void task;
}

async function applyGeneratedDisplayName(
  env: Env,
  userDO: DurableObjectStub<UserDO>,
  caller: UserCaller,
  agentName: string,
  mission: string,
  modelSpec: string,
  suggestDisplayName?: (mission: string) => Promise<string | null>,
): Promise<void> {
  const displayName = suggestDisplayName
    ? await suggestDisplayName(mission)
    : await suggestCloudAgentDisplayName(env, userDO, caller, mission, modelSpec);
  if (!displayName) return;
  const orchestrator = env.OrchestratorAgent.get(
    env.OrchestratorAgent.idFromName(agentName),
  ) as DurableObjectStub<OrchestratorAgent>;
  await orchestrator.setAutoDisplayName(displayName);
}

async function suggestCloudAgentDisplayName(
  env: Env,
  userDO: DurableObjectStub<UserDO>,
  caller: UserCaller,
  mission: string,
  modelSpec: string,
): Promise<string | null> {
  const id = crypto.randomUUID();
  const provider = createAgentProviderRegistry({ env, userDO: { stub: userDO, caller }, fetch });
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

async function initializeOrchestrator(input: {
  env: Env;
  userId: string;
  userDO: DurableObjectStub<UserDO>;
  agentName: string;
  displayName: string;
  mission?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): Promise<void> {
  const { env, userId, userDO, agentName, displayName, mission, model, reasoningEffort } = input;
  const orchestrator = env.OrchestratorAgent.get(
    env.OrchestratorAgent.idFromName(agentName),
  ) as DurableObjectStub<OrchestratorAgent>;
  const claim = await orchestrator.claimOwner(userId);
  // Before anything else touches it: a new workspace runs its first turn (a
  // peer's task, an auto-title, an inbound email) without ever being opened,
  // and every one of those needs its identity to reach the owner's UserDO.
  await userDO.ensureWorkspaceCapability(agentName, claim.capabilityHash);
  await orchestrator.setProvisionalDisplayName(displayName);
  await orchestrator.setSoul(renderSoulMarkdown({ name: displayName, mission }));
  if (model) await orchestrator.setModel(model);
  if (reasoningEffort) await orchestrator.setReasoningEffort(reasoningEffort);
}

function pickInitialModel(defaultModel: string | null, models: ModelMenuEntry[]): string | null {
  if (defaultModel && models.some((model) => model.spec === defaultModel)) return defaultModel;
  return models.find((model) => model.spec === DEFAULT_WORKERS_AI_MODEL_SPEC)?.spec
    ?? models[0]?.spec
    ?? null;
}
