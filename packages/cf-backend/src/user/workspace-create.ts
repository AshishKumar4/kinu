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
} from '@kinu.run/core';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';
import type { OrchestratorAgent } from '../orchestrator';
import { createAgentProviderRegistry } from '../providers/agent-registry';
import type { UserCredentialClient } from '../providers/agent-registry';
import type { UserCaller } from './workspace-capability';
import { listAvailableModels, type ModelMenuEntry } from './available-models';
import type { WorkspaceEntry } from './user-do';
import { indexNewWorkspace, unindexWorkspace } from '../control-plane/index-feed';

export interface CloudWorkspaceRegistry extends UserCredentialClient {
  getConfig(caller: UserCaller, key: string): Promise<string | null>;
  registerWorkspace(
    caller: UserCaller,
    name: string,
    displayName?: string,
    purpose?: string,
  ): Promise<{ entry: WorkspaceEntry; existed: boolean }>;
  removeWorkspace(caller: UserCaller, name: string, ownerUserId: string): Promise<void>;
  /** Drop the exact roster row this create inserted, matched on its own
   *  `createdAt`, without touching the workspace's Durable Object. The only
   *  correct undo when the object turned out to belong to another account. */
  releaseWorkspaceReservation(caller: UserCaller, name: string, createdAt: number): Promise<boolean>;
  ensureWorkspaceCapability(name: string, presentedHash: string | null): Promise<void>;
}

export interface CreateCloudWorkspaceInput {
  name?: string;
  displayName?: string;
  purpose?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  role?: string;
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
      env, userId, userDO, agentName: entry.name, displayName: entry.displayName,
      nameOrigin: identity.nameOrigin, model,
    };
    if (purpose) initialization.mission = purpose;
    if (input.reasoningEffort) initialization.reasoningEffort = input.reasoningEffort;
    if (input.role) initialization.role = input.role;
    await initializeOrchestrator(initialization);
    // AFTER the workspace's own object has accepted this account as its owner,
    // never before. `OrchestratorAgent` is addressed by a GLOBAL name while a
    // roster row is per-account, so two accounts can register the same name and
    // only one claim can win. Indexing at registration published a row saying
    // this account owns that workspace while the claim was still outstanding —
    // and the loser's row survived, because the rollback below cannot destroy a
    // Durable Object it does not own. Reported and non-fatal: the registry row
    // is the truth and this is a copy of it, and the user drilldown reconciles
    // from that row anyway.
    await indexNewWorkspace(env, {
      userId, name: entry.name, displayName: entry.displayName, createdAt: entry.createdAt,
    });
    if (identity.nameOrigin === 'auto' && purpose) {
      scheduleCloudAgentDisplayNameGeneration(env, userDO, caller, entry.name, purpose, model, options);
    }
    return entry;
  } catch (err) {
    // Roll back ONLY a row this create inserted. A pre-existing row — even an
    // archived one, which registerWorkspace resurrects on name conflict — must
    // never be destroyed here: removeWorkspace wipes the agent's whole DO.
    if (!existed) await rollbackRegistration({ env, userId, userDO, caller, entry, cause: err });
    throw err;
  }
}

/**
 * Undo the roster row a failed create inserted.
 *
 * TWO PATHS, and picking the wrong one is a cross-user defect rather than an
 * untidy rollback. `removeWorkspace` is the right undo for a workspace this
 * account owns: it tears the Durable Object down first and fails closed if that
 * teardown fails. But when the create failed BECAUSE the object already belongs
 * to somebody else, that teardown is a call into a victim's workspace which
 * correctly refuses — and the refusal used to leave this account's roster row in
 * place, pointing at a workspace it does not own, which every later ownership
 * check then had to catch. `releaseWorkspaceReservation` exists for exactly this
 * case: it drops the one row this create inserted, matched on its own
 * `createdAt`, and never contacts the target object at all.
 */
async function rollbackRegistration(input: {
  env: Env;
  userId: string;
  userDO: CloudWorkspaceRegistry;
  caller: UserCaller;
  entry: WorkspaceEntry;
  cause: unknown;
}): Promise<void> {
  const { env, userId, userDO, caller, entry } = input;
  const contested = OWNED_BY_ANOTHER.test(renderThrownChain({ cause: input.cause }));
  try {
    if (contested) {
      await userDO.releaseWorkspaceReservation(caller, entry.name, entry.createdAt);
    } else {
      await userDO.removeWorkspace(caller, entry.name, userId);
    }
  } catch (rollbackErr) {
    diagnostics.failure('workspace.create_rollback_failed', toKinuError({
      doing: 'rolling back a partially created workspace',
      cause: rollbackErr,
      otherwise: 'unavailable',
    }), { workspace: entry.name, contested });
    return;
  }
  // The index row this create published, if it got that far. A tombstone for a
  // row that was never written is a no-op, which is why this is unconditional
  // rather than guarded by a flag that could disagree with the truth.
  await unindexWorkspace(env, { userId, name: entry.name });
}

/** `OrchestratorAgent.claimOwner`'s refusal when the name is already another
 *  account's workspace. Matched rather than typed because it crosses a Durable
 *  Object RPC boundary, where an error class does not survive and the message is
 *  the contract — the same reading `claimOwnedWorkspace` does to answer 403. */
const OWNED_BY_ANOTHER = /owned by a different user/i;

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
  const requestedDisplayName = input.displayName?.trim();
  const fallback = fallbackWorkspaceIdentity(purpose ?? '', crypto.randomUUID());
  return {
    name: fallback.name,
    displayName: requestedDisplayName || fallback.displayName,
    nameOrigin: requestedDisplayName ? 'user' : 'auto',
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
      diagnostics.failure('workspace.display_name_generation_failed', toKinuError({
        doing: "generating a new workspace's display name",
        cause: err,
        otherwise: 'unavailable',
      }), { workspace: agentName });
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
  nameOrigin: 'user' | 'auto';
  mission?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  role?: string;
}

async function initializeOrchestrator(input: InitializeOrchestratorInput): Promise<void> {
  const {
    env, userId, userDO, agentName, displayName, nameOrigin,
    mission, model, reasoningEffort, role,
  } = input;
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
  await orchestrator.setInitialDisplayName(displayName, nameOrigin);
  await orchestrator.setSoul(renderSoulMarkdown({ name: displayName, mission }));
  // The Output diff is relative to workspace birth, never to the first time
  // somebody happens to open the tab. Capture after identity seeding and
  // before any user/peer turn can change files.
  await orchestrator.resetWorkspaceBaseline();
  if (model) await orchestrator.setModel(model);
  if (reasoningEffort) await orchestrator.setReasoningEffort(reasoningEffort);
  if (role && role !== 'general') await orchestrator.setRole(role);
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
