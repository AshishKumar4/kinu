import { Effect, Cause } from 'effect';
import {
  DEFAULT_ROLE_ID,
  defaultSpecFor,
  fallbackWorkspaceIdentity, workspaceAddressRefusal,
  renderSoulMarkdown,
  type NameOrigin,
  type ProfileCatalogEnvelope,
  type ReasoningEffort, type WorkspaceEntry,
} from '@kinu.run/core';
import { carriesCauseCode, diagnostics, KinuError, logged, toKinuError, settle, settleLogged, type ErrorCode } from '@kinu.run/core/obs';
import * as v from 'valibot';
import type { UserCredentialClient } from '../providers/agent-registry';
import { sandboxIdForWorkspace, type UserCaller, type WorkspaceSeed } from '@kinu.run/core';
import { listAvailableModels, type AvailableModelsEnv } from './available-models';
import type { WorkspaceRegistration, WorkspaceRegistrationSource } from './workspaces';
import { indexWorkspace, type IndexFeedEnv } from '../control-plane/index-feed';
import type { OrchestratorAgent } from '../orchestrator';
import type { KinuDevbox } from '../kinu-devbox';
import { isOwnedByAnotherAccount } from './workspace-ownership';
import type { ObjectNamespace } from '@kinu.run/core';
import type { WorkspacePlacement } from './workspace-placement';

export interface CloudWorkspaceRegistry extends UserCredentialClient {
  /** The account's `default` tier is the single source of the default model, for new workspaces
   *  and every turn. A workspace creating another reads it with its own authority. */
  getWorkspaceProfileCatalog(caller: UserCaller): Promise<ProfileCatalogEnvelope>;
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

export const CreateCloudWorkspaceInputSchema = v.object({
  name: v.optional(v.string()),
  displayName: v.optional(v.string()),
  purpose: v.optional(v.string()),
  model: v.optional(v.string()),
  reasoningEffort: v.optional(v.picklist(['low', 'medium', 'high'])),
  role: v.optional(v.string()),
});

type CreateCloudWorkspaceInput = v.InferOutput<typeof CreateCloudWorkspaceInputSchema>;

export type CloudWorkspaceBirth = Pick<
  OrchestratorAgent,
  'claimOwner' | 'setInitialDisplayName' | 'setSoul' | 'resetWorkspaceBaseline'
  | 'setModel' | 'setReasoningEffort' | 'setRole' | 'beginGenesisTurn' | 'seedBlueprint' | 'readOwnerMail'
> & {
  /** Whether a workspace is already born there: the read a create reaches it first with, over RPC or in process. */
  storedWorkspace(): number | Promise<number>;
};

/** The workspace's computer, as its birth reaches it: a read that starts nothing. */
interface ComputerPlacing {
  getByName(name: string, options?: { readonly locationHint?: string }): Pick<KinuDevbox, 'boxSize'>;
}

export interface CreateCloudWorkspaceEnv<Id> extends AvailableModelsEnv<Id>, IndexFeedEnv<Id> {
  OrchestratorAgent: ObjectNamespace<Id, CloudWorkspaceBirth>;
  KinuDevbox?: ComputerPlacing;
}

export interface CreateCloudWorkspaceRequest<Id> {
  env: CreateCloudWorkspaceEnv<Id>;
  userId: string;
  userDO: CloudWorkspaceRegistry;
  caller: UserCaller;
  input: CreateCloudWorkspaceInput;
  /** The whole SOUL.md, for a workspace the owner approved as an agent proposed it, or installed from a blueprint;
   *  absent, it is rendered from the purpose. Not an HTTP field: only those two set it. */
  soul?: string;
  /** What a blueprint seeds before the first turn: its layout, its main agent's name, its schedules. */
  seed?: WorkspaceSeed;
  /** The region the workspace's object runs in (`placementFor`). */
  placement: WorkspacePlacement;
}

export function createCloudWorkspaceForUser<Id>(
  request: CreateCloudWorkspaceRequest<Id>,
): Promise<WorkspaceEntry> {
  return settle(Effect.gen(function* () {
    const { env, userId, userDO, caller, input, soul, seed, placement } = request;
    const trimmedPurpose = input.purpose?.trim() ?? '';
    const purpose = trimmedPurpose === '' ? undefined : trimmedPurpose;

    const menu = yield* Effect.promise(async () => listAvailableModels(env, userId, caller));

    // Refused when no first turn could run (`defaultSpecFor`). Only a named model is pinned: an unpinned workspace
    // follows the account's default tier, as on the CLI. The error copy is surface-specific.
    const servable = defaultSpecFor(
      input.model ?? (yield* Effect.promise(async () => userDO.getWorkspaceProfileCatalog(caller))).catalog.tiers.default.model,
      menu.models.map((entry) => entry.spec),
      new Set(menu.failures.map((failure) => failure.provider)),
    );

    if (!servable) {
      return yield* createConflict('unavailable', 'Cloudflare Workers AI is not connected. Reconnect Cloudflare with Workers AI permissions, or choose a default model in your user settings, then create the workspace again.');
    }

    const identity = yield* createInitialCloudAgentIdentity(input, purpose);

    // The first call to reach a workspace's object places it, and it never moves: reached here, with its hint and by a
    // read that makes nothing, before its row is published and anything else can reach it (`workspace-placement.ts`).
    yield* Effect.promise(async () => env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(identity.name), { locationHint: placement }).storedWorkspace());

    // Only this call knows whether the title is the owner's choice or the mission's first line.
    const registered = yield* Effect.promise(async () => userDO.registerWorkspace(
      caller, identity.name, identity.displayName, { purpose, nameOrigin: identity.nameOrigin },
    ));

    // A 'reserved' row is an uncommitted fork transfer's reservation; a create may not take it.
    if (registered.status === 'reserved') {
      return yield* createConflict('bad_input', `Workspace name conflict: "${identity.name}" is being created by a transfer that has not finished. Choose another name or try again once it lands.`);
    }

    const entry = registered.entry;

    // Already this owner's workspace: re-running birth would reseed SOUL.md, reset the baseline,
    // and open a second genesis turn. Return it unchanged so retries and races are idempotent.
    if (registered.status === 'active') return entry;

    return yield* Effect.catchCause(Effect.gen(function* () {
      const initialization: InitializeOrchestratorInput<Id> = {
        env, userId, userDO, agentName: entry.name, displayName: entry.displayName,
        nameOrigin: identity.nameOrigin, model: input.model, placement,
      };

      if (purpose) initialization.mission = purpose;

      if (soul !== undefined) initialization.soul = soul;

      if (seed !== undefined) initialization.seed = seed;

      if (input.reasoningEffort) initialization.reasoningEffort = input.reasoningEffort;

      if (input.role) initialization.role = input.role;
      yield* Effect.promise(async () => initializeOrchestrator(initialization));
      // Index only after claimOwner succeeds: the DO name is global, roster rows are per-account.
      // Non-fatal: the registry row is the truth and the drilldown reconciles from it.
      yield* Effect.promise(async () => indexWorkspace(env, {
        userId, name: entry.name, displayName: entry.displayName, createdAt: entry.createdAt,
      }));

      // No pre-turn naming call: the genesis turn's durable `auto_title` effect replaces the stand-in
      // title for every caller, retried until it lands.

      return entry;
    }), (failed) => Effect.gen(function* () {
      const err = Cause.squash(failed);
      // Only reached for a row this create inserted (`active` returned above), so undo is safe.
      // A rollback failure is recorded separately; the original fault still propagates.
      yield* logged('workspace.create_rollback_unexpected', { doing: 'undoing a failed workspace create', otherwise: 'unavailable' }, rollbackRegistration({ userId, userDO, caller, entry, cause: err }), { workspace: entry.name });

      return yield* Effect.failCause(failed);
    }));
  }));
}

/**
 * Undo the roster row a failed create inserted. If the DO belongs to another account, use
 * `releaseWorkspaceReservation` (never contacts it); otherwise `removeWorkspace`, which fails
 * closed and leaves the rows standing (recorded, tolerated). A release failure propagates.
 */
function rollbackRegistration(input: {
  userId: string;
  userDO: CloudWorkspaceRegistry;
  caller: UserCaller;
  entry: WorkspaceEntry;
  cause: unknown;
}): Effect.Effect<void, KinuError> {
  return Effect.gen(function* () {
    const { userId, userDO, caller, entry } = input;
    const contested = isOwnedByAnotherAccount({ cause: input.cause });

    const undo = contested
      ? Effect.promise(() => userDO.releaseWorkspaceReservation(caller, entry.name, entry.createdAt))
      : Effect.promise(() => userDO.removeWorkspace(caller, entry.name, userId));

    // Either undo forgets the workspace in the control plane's index as it removes the row (`UserWorkspaces`).
    yield* Effect.catchCause(undo, (failed) => {
      const failure = toKinuError({
        doing: contested
          ? 'releasing the roster row a failed create reserved'
          : 'tearing down the workspace a failed create registered',
        cause: Cause.squash(failed),
        otherwise: 'unavailable',
      });

      if (contested) return Effect.fail(failure);

      return Effect.sync(() => {
        diagnostics.failure('workspace.create_rollback_failed', failure, {
          workspace: entry.name, contested,
        });
      });
    });
  });
}

/** A create the account cannot make now: no model serves the first turn, or an unfinished transfer holds the name. */
const CREATE_CONFLICT = 'workspace_create_conflict';

function createConflict(code: ErrorCode, message: string): KinuError {
  return new KinuError(code, message, { cause: { code: CREATE_CONFLICT, message } });
}

export function isCreateConflict(input: { cause: unknown }): boolean {
  return carriesCauseCode(input, CREATE_CONFLICT);
}

interface InitialCloudAgentIdentity {
  name: string;
  displayName: string;
  nameOrigin: NameOrigin;
}

function createInitialCloudAgentIdentity(
  input: CreateCloudWorkspaceInput,
  purpose: string | undefined,
): Effect.Effect<InitialCloudAgentIdentity, KinuError> {
  return Effect.gen(function* () {
    const requestedName = input.name?.trim();

    if (requestedName) {
      // The name is the object's permanent address; refuse names no preview hostname could carry.
      const refusal = workspaceAddressRefusal(requestedName);

      if (refusal !== null) return yield* new KinuError('bad_input', `Invalid workspace name: ${refusal}`);

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
  });
}



interface InitializeOrchestratorInput<Id> {
  env: CreateCloudWorkspaceEnv<Id>;
  userId: string;
  userDO: CloudWorkspaceRegistry;
  agentName: string;
  displayName: string;
  nameOrigin: NameOrigin;
  mission?: string;
  soul?: string;
  seed?: WorkspaceSeed;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  role?: string;
  placement: WorkspacePlacement;
}

async function initializeOrchestrator<Id>(input: InitializeOrchestratorInput<Id>): Promise<void> {
  const {
    env, userId, userDO, agentName, displayName, nameOrigin,
    mission, soul, seed, model, reasoningEffort, role, placement,
  } = input;

  // The first call to reach the object places it, and it never moves (`workspace-placement.ts`).
  const orchestrator = env.OrchestratorAgent.get(
    env.OrchestratorAgent.idFromName(agentName), { locationHint: placement },
  );

  const claim = await orchestrator.claimOwner(userId, placement);
  // First: a new workspace may run turns without being opened, and each needs its identity
  // to reach the owner's UserDO.
  await userDO.ensureWorkspaceCapability(agentName, claim.capabilityHash);
  // Its computer is placed with it, before any turn can reach it unhinted.
  await settleLogged('workspace.computer_unplaced', { doing: "placing the workspace's computer", otherwise: 'unavailable' },
    async () => { await env.KinuDevbox?.getByName(sandboxIdForWorkspace(agentName), { locationHint: placement }).boxSize(); }, { workspace: agentName });
  await orchestrator.setInitialDisplayName(displayName, nameOrigin);
  await orchestrator.setSoul(soul ?? renderSoulMarkdown({ name: displayName, mission }));

  if (seed) await orchestrator.seedBlueprint(seed);
  // The Output diff is relative to birth: capture after identity seeding, before any turn.
  await orchestrator.resetWorkspaceBaseline();

  if (model) await orchestrator.setModel(model);

  if (reasoningEffort) await orchestrator.setReasoningEffort(reasoningEffort);

  if (role && role !== DEFAULT_ROLE_ID) await orchestrator.setRole(role);
  // Last, so soul, model and effort are already durable; the mission is read from the row,
  // not passed down this call.
  await orchestrator.beginGenesisTurn();
}

