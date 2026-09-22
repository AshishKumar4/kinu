import {
  DEFAULT_ROLE_ID,
  defaultSpecFor,
  fallbackWorkspaceIdentity, workspaceAddressRefusal,
  renderSoulMarkdown,
  isReasoningEffort,
  type NameOrigin,
  type ProfileCatalogEnvelope,
  type ReasoningEffort,
} from '@kinu.run/core';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';
import type { UserCredentialClient } from '../providers/agent-registry';
import type { UserCaller } from '@kinu.run/core';
import { listAvailableModels, type AvailableModelsEnv } from './available-models';
import type { WorkspaceEntry, WorkspaceRegistration, WorkspaceRegistrationSource } from './user-do';
import { indexNewWorkspace, unindexWorkspace, type IndexFeedEnv } from '../control-plane/index-feed';
import type { OrchestratorAgent } from '../orchestrator';
import type { ObjectNamespace } from '@kinu.run/core';

export interface CloudWorkspaceRegistry extends UserCredentialClient {
  /** The account's `default` tier is the single source of the default model, for new workspaces
   *  and every turn. */
  getProfileCatalog(caller: UserCaller): Promise<ProfileCatalogEnvelope>;
  registerWorkspace(
    caller: UserCaller,
    name: string,
    displayName?: string,
    from?: WorkspaceRegistrationSource,
  ): Promise<WorkspaceRegistration>;
  removeWorkspace(caller: UserCaller, name: string, ownerUserId: string): Promise<void>;
  /** Drop the roster row this create inserted (matched on `createdAt`) without touching the DO;
   *  the only correct undo when the object belongs to another account. */
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

export type CloudWorkspaceBirth = Pick<
  OrchestratorAgent,
  'claimOwner' | 'setInitialDisplayName' | 'setSoul' | 'resetWorkspaceBaseline'
  | 'setModel' | 'setReasoningEffort' | 'setRole' | 'beginGenesisTurn'
>;

export interface CreateCloudWorkspaceEnv<Id> extends AvailableModelsEnv<Id>, IndexFeedEnv<Id> {
  OrchestratorAgent: ObjectNamespace<Id, CloudWorkspaceBirth>;
}

export interface CreateCloudWorkspaceRequest<Id> {
  env: CreateCloudWorkspaceEnv<Id>;
  userId: string;
  userDO: CloudWorkspaceRegistry;
  caller: UserCaller;
  input: CreateCloudWorkspaceInput;
}

export async function createCloudWorkspaceForUser<Id>(
  request: CreateCloudWorkspaceRequest<Id>,
): Promise<WorkspaceEntry> {
  const { env, userId, userDO, caller, input } = request;
  const trimmedPurpose = input.purpose?.trim() ?? '';
  const purpose = trimmedPurpose === '' ? undefined : trimmedPurpose;

  if (input.reasoningEffort !== undefined && !isReasoningEffort(input.reasoningEffort)) {
    throw new Error(`Invalid reasoning effort: ${String(input.reasoningEffort)}`);
  }

  const menu = await listAvailableModels(env, userId, caller);

  // Core picks the model (`defaultSpecFor`): default tier if servable, else native Workers AI,
  // never the first menu entry (could be a paid BYO provider). The error copy is surface-specific.
  const model = defaultSpecFor(
    input.model ?? (await userDO.getProfileCatalog(caller)).catalog.tiers.default.model,
    menu.models.map((entry) => entry.spec),
  );

  if (!model) {
    throw new Error('Cloudflare Workers AI is not connected. Reconnect Cloudflare with Workers AI permissions, or choose a default model in your user settings, then create the workspace again.');
  }

  const identity = createInitialCloudAgentIdentity(input, purpose);

  // Only this call knows whether the title is the owner's choice or the mission's first line.
  const registered = await userDO.registerWorkspace(
    caller, identity.name, identity.displayName, { purpose, nameOrigin: identity.nameOrigin },
  );

  // A 'reserved' row is an uncommitted fork transfer's reservation; a create may not take it.
  if (registered.status === 'reserved') {
    throw new Error(`Workspace name conflict: "${identity.name}" is being created by a transfer that has not finished. Choose another name or try again once it lands.`);
  }

  const entry = registered.entry;

  // Already this owner's workspace: re-running birth would reseed SOUL.md, reset the baseline,
  // and open a second genesis turn. Return it unchanged so retries and races are idempotent.
  if (registered.status === 'active') return entry;

  try {
    const initialization: InitializeOrchestratorInput<Id> = {
      env, userId, userDO, agentName: entry.name, displayName: entry.displayName,
      nameOrigin: identity.nameOrigin, model,
    };

    if (purpose) initialization.mission = purpose;

    if (input.reasoningEffort) initialization.reasoningEffort = input.reasoningEffort;

    if (input.role) initialization.role = input.role;
    await initializeOrchestrator(initialization);
    // Index only after claimOwner succeeds: the DO name is global, roster rows are per-account.
    // Non-fatal: the registry row is the truth and the drilldown reconciles from it.
    await indexNewWorkspace(env, {
      userId, name: entry.name, displayName: entry.displayName, createdAt: entry.createdAt,
    });

    // No pre-turn naming call: the genesis turn's durable `auto_title` effect replaces the stand-in
    // title for every caller, retried until it lands.

    return entry;
  } catch (err) {
    // Only reached for a row this create inserted (`active` returned above), so undo is safe.
    // A rollback failure is recorded separately; the original fault still propagates.
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
 * Undo the roster row a failed create inserted. If the DO belongs to another account, use
 * `releaseWorkspaceReservation` (never contacts it); otherwise `removeWorkspace`, which fails
 * closed and leaves the rows standing (recorded, tolerated). A release failure propagates.
 */
async function rollbackRegistration<Id>(input: {
  env: CreateCloudWorkspaceEnv<Id>;
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

  // Unconditional: tombstoning a row that was never written is a no-op.
  await unindexWorkspace(env, { userId, name: entry.name });
}

/** `claimOwner`'s refusal for another account's name. Matched by message because error classes
 *  don't survive DO RPC; same reading `claimOwnedWorkspace` uses for 403. */
const OWNED_BY_ANOTHER = /owned by a different user/i;

interface InitialCloudAgentIdentity {
  name: string;
  displayName: string;
  nameOrigin: NameOrigin;
}

function createInitialCloudAgentIdentity(
  input: CreateCloudWorkspaceInput,
  purpose: string | undefined,
): InitialCloudAgentIdentity {
  const requestedName = input.name?.trim();

  if (requestedName) {
    // The name is the object's permanent address; refuse names no preview hostname could carry.
    const refusal = workspaceAddressRefusal(requestedName);

    if (refusal !== null) throw new Error(`Invalid workspace name: ${refusal}`);

    const named = input.displayName?.trim() ?? '';

    return {
      name: requestedName,
      displayName: named === '' ? requestedName : named,
      nameOrigin: 'user',
    };
  }

  const requestedDisplayName = input.displayName?.trim() ?? '';
  const fallback = fallbackWorkspaceIdentity(purpose ?? '', crypto.randomUUID());

  return {
    name: fallback.name,
    // 'auto': `fallback.displayName` is a stand-in the genesis turn's `auto_title` effect replaces;
    // recorded as 'user', nothing could replace it (#18).
    displayName: requestedDisplayName === '' ? fallback.displayName : requestedDisplayName,
    nameOrigin: requestedDisplayName === '' ? 'auto' : 'user',
  };
}



interface InitializeOrchestratorInput<Id> {
  env: CreateCloudWorkspaceEnv<Id>;
  userId: string;
  userDO: CloudWorkspaceRegistry;
  agentName: string;
  displayName: string;
  nameOrigin: NameOrigin;
  mission?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  role?: string;
}

async function initializeOrchestrator<Id>(input: InitializeOrchestratorInput<Id>): Promise<void> {
  const {
    env, userId, userDO, agentName, displayName, nameOrigin,
    mission, model, reasoningEffort, role,
  } = input;

  const orchestrator = env.OrchestratorAgent.get(
    env.OrchestratorAgent.idFromName(agentName),
  );

  const claim = await orchestrator.claimOwner(userId);
  // First: a new workspace may run turns without being opened, and each needs its identity
  // to reach the owner's UserDO.
  await userDO.ensureWorkspaceCapability(agentName, claim.capabilityHash);
  await orchestrator.setInitialDisplayName(displayName, nameOrigin);
  await orchestrator.setSoul(renderSoulMarkdown({ name: displayName, mission }));
  // The Output diff is relative to birth: capture after identity seeding, before any turn.
  await orchestrator.resetWorkspaceBaseline();

  if (model) await orchestrator.setModel(model);

  if (reasoningEffort) await orchestrator.setReasoningEffort(reasoningEffort);

  if (role && role !== DEFAULT_ROLE_ID) await orchestrator.setRole(role);
  // Last, so soul, model and effort are already durable; the mission is read from the row,
  // not passed down this call.
  await orchestrator.beginGenesisTurn();
}

