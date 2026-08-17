import { generateText } from 'ai';
import {
  WORKSPACE_TITLE_SYSTEM_PROMPT,
  DEFAULT_WORKERS_AI_MODEL_SPEC,
  effortFor,
  workspaceTitlePrompt,
  fallbackWorkspaceIdentity,
  parseWorkspaceTitle,
  renderSoulMarkdown,
  isReasoningEffort,
  normalizeUsage,
  type ReasoningEffort,
} from '@proteus/core';
import type { OrchestratorAgent } from '../orchestrator.js';
import { createAgentProviderRegistry } from '../providers/agent-registry.js';
import type { UserCredentialClient } from '../providers/agent-registry.js';
import type { UserCaller } from './workspace-capability.js';
import { listAvailableModels, type ModelMenuEntry } from './available-models.js';
import type { WorkspaceEntry } from './user-do.js';

export interface CloudWorkspaceRegistry extends UserCredentialClient {
  getConfig(caller: UserCaller, key: string): Promise<string | null>;
  registerWorkspace(
    caller: UserCaller,
    name: string,
    displayName?: string,
    purpose?: string,
  ): Promise<{ entry: WorkspaceEntry; existed: boolean }>;
  removeWorkspace(caller: UserCaller, name: string, ownerUserId: string): Promise<void>;
  ensureWorkspaceCapability(name: string, presentedHash: string | null): Promise<void>;
}

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
  userDO: CloudWorkspaceRegistry,
  caller: UserCaller,
  input: CreateCloudWorkspaceInput,
  options: CreateCloudWorkspaceOptions = {},
): Promise<WorkspaceEntry> {
  const purpose = input.purpose?.trim() || undefined;
  if (input.reasoningEffort !== undefined && !isReasoningEffort(input.reasoningEffort)) {
    throw new Error(`Invalid reasoning effort: ${String(input.reasoningEffort)}`);
  }
  const menu = await listAvailableModels(env, userId, caller);
  const model = pickInitialModel(input.model ?? await userDO.getConfig(caller, 'default_model'), menu.models);
  if (!model) {
    throw new Error('Cloudflare Workers AI is not connected. Reconnect Cloudflare with Workers AI permissions, or choose a default model in your user settings, then create the workspace again.');
  }

  const identity = createInitialCloudAgentIdentity(input, purpose);

  const { entry, existed } = await userDO.registerWorkspace(caller, identity.name, identity.displayName, purpose);
  try {
    const initialization: InitializeOrchestratorInput = {
      env, userId, userDO, agentName: entry.name, displayName: entry.displayName, model,
    };
    if (purpose) initialization.mission = purpose;
    if (input.reasoningEffort) initialization.reasoningEffort = input.reasoningEffort;
    await initializeOrchestrator(initialization);
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

interface InitialCloudAgentIdentity {
  name: string;
  displayName: string;
  nameOrigin: 'auto' | 'user';
}

function createInitialCloudAgentIdentity(
  input: CreateCloudWorkspaceInput,
  purpose: string | undefined,
): InitialCloudAgentIdentity {
  const requestedName = input.name?.trim();
  if (requestedName) {
    return {
      name: requestedName,
      displayName: input.displayName?.trim() || requestedName,
      nameOrigin: 'user',
    };
  }
  const fallback = fallbackWorkspaceIdentity(purpose ?? '', crypto.randomUUID());
  return {
    name: fallback.name,
    displayName: input.displayName?.trim() || fallback.displayName,
    nameOrigin: 'auto',
  };
}

function scheduleCloudAgentDisplayNameGeneration(
  env: Env,
  userDO: CloudWorkspaceRegistry,
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
  userDO: CloudWorkspaceRegistry,
  caller: UserCaller,
  agentName: string,
  mission: string,
  modelSpec: string,
  suggestDisplayName?: (mission: string) => Promise<string | null>,
): Promise<void> {
  const displayName = suggestDisplayName
    ? await suggestDisplayName(mission)
    : await suggestCloudAgentDisplayName(env, userDO, caller, mission, modelSpec, agentName);
  if (!displayName) return;
  // SAFETY: Env.OrchestratorAgent is generated from the OrchestratorAgent binding and exposes its RPC methods.
  const orchestrator = env.OrchestratorAgent.get(
    env.OrchestratorAgent.idFromName(agentName),
  ) as DurableObjectStub<OrchestratorAgent>;
  await orchestrator.setAutoDisplayName(displayName);
}

/**
 * `agentName` is here so the call can be filed against the workspace it names.
 *
 * This is the first model call of a workspace's life and it happens before any
 * turn, so there is no run to attach it to — the reserved workspace run id is
 * where the actor files exactly this case. Reported through the same cross-DO
 * port a facet uses, because the total that has to account for it lives in that
 * Durable Object and not in this Worker.
 */
async function suggestCloudAgentDisplayName(
  env: Env,
  userDO: CloudWorkspaceRegistry,
  caller: UserCaller,
  mission: string,
  modelSpec: string,
  agentName: string,
): Promise<string | null> {
  const provider = createAgentProviderRegistry({ env, userDO: { stub: userDO, caller }, fetch });
  const result = await generateText({
    model: provider.resolveModel(modelSpec),
    system: WORKSPACE_TITLE_SYSTEM_PROMPT,
    prompt: workspaceTitlePrompt(mission),
    // No output cap: reasoning models spend budget on thinking before the
    // JSON, so a cap starves them into empty text and the generic name wins.
    ...effortFor('reflection'),
  });
  // SAFETY: Env.OrchestratorAgent is generated from the OrchestratorAgent binding and exposes its RPC methods.
  const orchestrator = env.OrchestratorAgent.get(
    env.OrchestratorAgent.idFromName(agentName),
  ) as DurableObjectStub<OrchestratorAgent>;
  const modelId = result.response?.modelId;
  const usage = normalizeUsage(result.usage);
  await orchestrator.reportFacetModelCall(modelId
    ? { source: 'fast', usage, spec: modelSpec, modelId }
    : { source: 'fast', usage, spec: modelSpec });
  return parseWorkspaceTitle(result.text);
}

interface InitializeOrchestratorInput {
  env: Env;
  userId: string;
  userDO: CloudWorkspaceRegistry;
  agentName: string;
  displayName: string;
  mission?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

async function initializeOrchestrator(input: InitializeOrchestratorInput): Promise<void> {
  const { env, userId, userDO, agentName, displayName, mission, model, reasoningEffort } = input;
  // SAFETY: Env.OrchestratorAgent is generated from the OrchestratorAgent binding and exposes its RPC methods.
  const orchestrator = env.OrchestratorAgent.get(
    env.OrchestratorAgent.idFromName(agentName),
  ) as DurableObjectStub<OrchestratorAgent>;
  const claim = await orchestrator.claimOwner(userId);
  // Before anything else touches it: a new workspace runs its first turn (its
  // own genesis turn, a peer's task, an auto-title, an inbound email) without
  // ever being opened, and every one of those needs its identity to reach the
  // owner's UserDO.
  await userDO.ensureWorkspaceCapability(agentName, claim.capabilityHash);
  await orchestrator.setProvisionalDisplayName(displayName);
  await orchestrator.setSoul(renderSoulMarkdown({ name: displayName, mission }));
  // The Output diff is relative to workspace birth, never to the first time
  // somebody happens to open the tab. Capture after identity seeding and
  // before any user/peer turn can change files.
  await orchestrator.resetWorkspaceBaseline();
  if (model) await orchestrator.setModel(model);
  if (reasoningEffort) await orchestrator.setReasoningEffort(reasoningEffort);
  // The agent takes the first turn. Last, so the soul, model and effort it runs
  // under are all already durable — and the mission it reads is the one the row
  // holds, not a second copy passed down this call.
  await orchestrator.beginGenesisTurn();
}

/** The model a new workspace starts on. An explicit choice wins; with none, the
 *  native Workers AI default is the only automatic answer. Falling through to
 *  whatever model happened to be first in the menu silently put new workspaces
 *  on a paid BYO provider. */
export function pickInitialModel(defaultModel: string | null, models: ModelMenuEntry[]): string | null {
  if (defaultModel && models.some((model) => model.spec === defaultModel)) return defaultModel;
  return models.find((model) => model.spec === DEFAULT_WORKERS_AI_MODEL_SPEC)?.spec ?? null;
}
