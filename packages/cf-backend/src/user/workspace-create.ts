import { generateText } from 'ai';
import {
  WORKSPACE_TITLE_SYSTEM_PROMPT,
  DEFAULT_ROLE_ID,
  defaultSpecFor,
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
import { listAvailableModels } from './available-models';
import type { WorkspaceEntry, WorkspaceRegistration } from './user-do';
import { indexNewWorkspace, unindexWorkspace } from '../control-plane/index-feed';

export interface CloudWorkspaceRegistry extends UserCredentialClient {
  getConfig(caller: UserCaller, key: string): Promise<string | null>;
  registerWorkspace(
    caller: UserCaller,
    name: string,
    displayName?: string,
    purpose?: string,
  ): Promise<WorkspaceRegistration>;
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
  // The CHOICE is core's (`defaultSpecFor`): a configured default wins only if
  // the account can actually serve it, else the native Workers AI model, else
  // nothing — never the first entry in the menu, which used to sign new
  // workspaces up to a paid BYO provider. The COPY below stays here, because the
  // remedy is this surface's: the CLI's counterpart names `kinu auth`.
  const model = defaultSpecFor(
    input.model ?? await userDO.getConfig(caller, 'default_model'),
    menu.models.map((entry) => entry.spec),
  );
  if (!model) {
    throw new Error('Cloudflare Workers AI is not connected. Reconnect Cloudflare with Workers AI permissions, or choose a default model in your user settings, then create the workspace again.');
  }

  const identity = createInitialCloudAgentIdentity(input, purpose);

  const registered = await userDO.registerWorkspace(caller, identity.name, identity.displayName, purpose);
  // A name an uncommitted fork transfer is holding is not a name a create may
  // take: the roster row IS that reservation, and the workspace it will become
  // is still being streamed into.
  if (registered.status === 'reserved') {
    throw new Error(`Workspace name conflict: "${identity.name}" is being created by a transfer that has not finished. Choose another name or try again once it lands.`);
  }
  const entry = registered.entry;
  // ALREADY SOMEBODY'S. Creating over a live workspace used to run the whole
  // birth sequence on it — re-seeding SOUL.md from this request's mission,
  // resetting the Output baseline the workspace measures its diff against, and
  // opening a SECOND genesis turn beside whatever it was already doing. Two
  // creates racing on one name did it to each other, and a retried request did
  // it to itself. The name is taken by a workspace this owner already has, so
  // the honest answer is that workspace, unchanged and byte-stable across
  // retries.
  if (registered.status === 'active') return entry;
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
    if (identity.nameOrigin === 'auto' && purpose && options.waitUntil) {
      // A Worker request owns this pre-turn generation. Callers without that
      // request owner already queued the genesis turn, whose durable
      // `auto_title` effect derives the same title without delaying dispatch.
      options.waitUntil(scheduleCloudAgentDisplayNameGeneration(
        env, userDO, caller, entry.name, purpose, model, options,
      ));
    }
    return entry;
  } catch (err) {
    // Only a row THIS create inserted is rolled back, which is now a fact about
    // the status rather than a flag: an `active` create returned above without
    // touching the workspace, so the undo below can only ever be undoing its
    // own insert. `removeWorkspace` wipes an agent's whole Durable Object, and
    // that is only ever correct for a workspace this call brought into being.
    //
    // A ROLLBACK FAULT MUST NOT REPLACE THE FAULT THAT CAUSED IT. The caller
    // asked for a workspace, and why the create failed is the answer it needs;
    // an undo that could not finish is a second, separate fact. So the undo's
    // own failure is recorded under its own name here and the original still
    // propagates.
    try {
      await rollbackRegistration({ env, userId, userDO, caller, entry, cause: err });
    } catch (rollbackFailure) {
      diagnostics.failure('workspace.create_rollback_unexpected', toKinuError({
        doing: 'undoing a failed workspace create',
        cause: rollbackFailure,
        otherwise: 'unavailable',
      }), { workspace: entry.name });
    }
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
 *
 * ONE ROLLBACK FAILURE IS A STATE, THE REST ARE FAULTS. `removeWorkspace` fails
 * closed on purpose, so a teardown it could not finish deliberately leaves the
 * roster row standing — and the index row with it, which is why the tombstone
 * below is not reached on that path. That outcome is recorded with its class and
 * tolerated. The release path touches nothing but this account's own roster, so
 * a failure there is not a state this undo knows how to leave behind: it
 * propagates to the create, which records it beside the fault that started the
 * rollback. Returning nothing for both was how a rollback that never ran read
 * exactly like one that did.
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
  } catch (cause) {
    const failure = toKinuError({
      doing: contested
        ? 'releasing the roster row a failed create reserved'
        : 'tearing down the workspace a failed create registered',
      cause,
      otherwise: 'unavailable',
    });
    if (contested) throw failure;
    diagnostics.failure('workspace.create_rollback_failed', failure, {
      workspace: entry.name, contested,
    });
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

async function scheduleCloudAgentDisplayNameGeneration(
  env: Env,
  userDO: CloudWorkspaceRegistry,
  caller: UserCaller,
  agentName: string,
  mission: string,
  modelSpec: string,
  options: CreateCloudWorkspaceOptions,
): Promise<void> {
  try {
    await applyGeneratedDisplayName(
      env, userDO, caller, agentName, mission, modelSpec, options.suggestDisplayName,
    );
  } catch (cause) {
    diagnostics.failure('workspace.display_name_generation_failed', toKinuError({
      doing: "generating a new workspace's display name",
      cause,
      otherwise: 'unavailable',
    }), { workspace: agentName });
  }
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
  if (role && role !== DEFAULT_ROLE_ID) await orchestrator.setRole(role);
  // The agent takes the first turn. Last, so the soul, model and effort it runs
  // under are all already durable — and the mission it reads is the one the row
  // holds, not a second copy passed down this call.
  await orchestrator.beginGenesisTurn();
}

