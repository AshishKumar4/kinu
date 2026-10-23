/**
 * Every admin mutation. Each arm proxies the owning DO's existing `@callable`; never reimplement.
 * The closed union is the reach: a generic method bridge would expose the whole orchestrator surface.
 * Every action names an account, since `OrchestratorAgent` is addressed by workspace name globally.
 * Arms return `ActionOutcome` and never throw for a refusal, so every attempt is audited.
 */
import { Cause, Effect, Result } from 'effect';
import { renderThrownChain, settle, toKinuError, type ErrorCode } from '@kinu.run/core/obs';
import { objectNamed, decodeJsonValue, type JsonValue } from '@kinu.run/core';
import * as v from 'valibot';
import type { OrchestratorAgent } from '../orchestrator';
import type { UserDO } from '../user/user-do';
import { ownerCaller } from '@kinu.run/core';
import { claimOwnedWorkspace } from '../user/workspace-ownership';
import type { IndexFeedSink } from './index-feed';
import { controlPlaneStub, type ControlPlaneEnv } from './stub';
import type { ControlPlaneDO } from './control-plane-do';
import type { PresentedCaller } from '@kinu.run/core/control-plane';
import { STORED_CLASSES } from '@kinu.run/core';
import { accountIdFor } from '../auth/store';
import type { SignInDeclarationEnv } from '@kinu.run/core/identity';
import type { ObjectNamespace } from '@kinu.run/core';

/** A UserDO name; it makes the workspace name beside it an address rather than a guess. */
export const UserIdSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{32}$/));

const WorkspaceSchema = v.pipe(v.string(), v.nonEmpty());

const JobIdSchema = v.pipe(v.string(), v.nonEmpty());

const SUPPORT_READ_REASONS = ['support_ticket', 'incident', 'owner_request'] as const;

const Index = v.pipe(v.number(), v.integer(), v.minValue(0));

/** The actions, as data; `describeAction` derives audit names from these, so vocabulary cannot drift. */
export const ControlActionSchema = v.variant('action', [
  v.object({
    action: v.literal('job.cancel'),
    userId: UserIdSchema,
    workspace: WorkspaceSchema,
    jobId: JobIdSchema,
  }),
  v.object({
    action: v.literal('job.retry'),
    userId: UserIdSchema,
    workspace: WorkspaceSchema,
    jobId: JobIdSchema,
  }),
  v.object({
    action: v.literal('job.dismiss'),
    userId: UserIdSchema,
    workspace: WorkspaceSchema,
    jobId: JobIdSchema,
  }),
  v.object({
    action: v.literal('jobs.clear'),
    userId: UserIdSchema,
    workspace: WorkspaceSchema,
  }),
  v.object({
    action: v.literal('approvals.decide'),
    userId: UserIdSchema,
    workspace: WorkspaceSchema,
    ids: v.pipe(v.array(v.pipe(v.string(), v.nonEmpty())), v.minLength(1)),
    /** Exactly the answers `DeferredApprovalStore.decide` accepts. */
    decision: v.picklist(['approved', 'denied', 'always']),
  }),
  v.object({
    action: v.literal('shell_grants.revoke'),
    userId: UserIdSchema,
    workspace: WorkspaceSchema,
  }),
  v.object({
    action: v.literal('workspace.turn_read'),
    userId: UserIdSchema,
    workspace: WorkspaceSchema,
    turnId: v.pipe(v.string(), v.nonEmpty()),
    reason: v.picklist(SUPPORT_READ_REASONS),
    actor: v.optional(v.pipe(v.string(), v.nonEmpty())),
    at: v.optional(v.object({ epoch: Index, revision: Index, from: v.optional(Index) })),
  }),
  v.object({
    action: v.literal('workspace.remove'),
    userId: UserIdSchema,
    workspace: WorkspaceSchema,
    /** The operator retypes the name: the one destructive action, picked from a cross-account list. */
    confirm: v.pipe(v.string(), v.nonEmpty()),
  }),
  // An account's standing (core limits/): its class, and a suspension that starts nothing new until lifted.
  v.object({ action: v.literal('account.class'), userId: UserIdSchema, class: v.picklist(STORED_CLASSES) }),
  v.object({ action: v.literal('account.suspend'), userId: UserIdSchema, reason: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300)) }),
  v.object({ action: v.literal('account.unsuspend'), userId: UserIdSchema }),
  /** An email invited before or after its first sign-in: its account is the one that email signs in as. */
  v.object({ action: v.literal('invite.email'), email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email()) }),
  /** A single-use link, 7 days: whoever signs in and opens it is invited. */
  v.object({ action: v.literal('invite.link') }),
]);

export type ControlAction = v.InferOutput<typeof ControlActionSchema>;

/** Closed reason vocabulary for the ops dataset; free-text `detail` stays in the durable row. */
type ActionReason =
  | 'ok'
  | 'not_owned'
  | 'not_running'
  | 'not_retriable'
  | 'no_such_job'
  | 'nothing_to_clear'
  | 'none_pending'
  | 'no_grants'
  | 'name_mismatch'
  | 'threw';

/** `denied`: this plane refused; `failed`: the owning object did. Keeps refusals out of outage counts. */
export interface ActionOutcome {
  outcome: 'ok' | 'denied' | 'failed';
  /** The durable row's text. Never published to analytics. */
  detail: string;
  reason: ActionReason;
  code?: ErrorCode;
  affected?: number;
  /** Never audited. */
  result?: JsonValue;
}

/** `request` names no domain object: a body the schema refused, still audited. */
type AuditTargetKind = 'job' | 'approval' | 'workspace' | 'request' | 'account' | 'invite';

export interface ActionIdentity {
  /** snake_case: the analytics sink groups on the tail after the first dot. */
  operation: string;
  targetKind: AuditTargetKind;
  /** `<userId>/<workspace>[/<jobId>]`: a workspace name alone does not identify a workspace. */
  target: string;
}

export function describeAction(action: ControlAction): ActionIdentity {
  // The analytics sink groups on the tail after the first dot, so dots become underscores.
  const operation = action.action.replace(/\./g, '_');

  switch (action.action) {
    case 'account.class':
    case 'account.suspend':
    case 'account.unsuspend':
      return { operation, targetKind: 'account', target: action.userId };
    case 'invite.email':
      return { operation, targetKind: 'invite', target: action.email };
    case 'invite.link':
      return { operation, targetKind: 'invite', target: '' };
    case 'job.cancel':
    case 'job.retry':
    case 'job.dismiss':
    case 'approvals.decide':
    case 'jobs.clear':
    case 'shell_grants.revoke':
    case 'workspace.remove':
    case 'workspace.turn_read':
      return describeWorkspaceAction(operation, action);
  }
}

/** A workspace's action: its target names the account and the workspace. */
function describeWorkspaceAction(operation: string, action: Extract<ControlAction, { workspace: string }>): ActionIdentity {
  const owned = `${action.userId}/${action.workspace}`;

  switch (action.action) {
    case 'job.cancel':
    case 'job.retry':
    case 'job.dismiss':
      return { operation, targetKind: 'job', target: `${owned}/${action.jobId}` };
    case 'approvals.decide':
      return { operation, targetKind: 'approval', target: owned };
    case 'jobs.clear':
    case 'shell_grants.revoke':
    case 'workspace.remove':
      return { operation, targetKind: 'workspace', target: owned };
    case 'workspace.turn_read':
      return { operation, targetKind: 'workspace', target: `${owned}/${action.turnId}` };
  }
}

/** `claimOwner` is included because the object is resolved by proving ownership first. */
export type ActionTarget = Pick<OrchestratorAgent,
  | 'claimOwner'
  | 'cancelBackgroundJob'
  | 'retryBackgroundJob'
  | 'dismissBackgroundJob'
  | 'clearBackgroundJobs'
  | 'decideDeferredApprovals'
  | 'getShellApprovalGrants'
  | 'revokeShellApprovalGrants'
  | 'supportReadTurn'
>;

export type ActionRegistry = Pick<UserDO,
  'hasWorkspace' | 'ensureWorkspaceCapability' | 'removeWorkspace' | 'limits_setClass' | 'limits_suspend' | 'limits_unsuspend' | 'limits'
>;

/** The control plane as the account actions reach it: its index feed, and the accounts list's mirror and invite links. */
type ActionControlPlane = IndexFeedSink & Pick<ControlPlaneDO, 'noteAccountStanding' | 'createInvite'>;

export interface ActionEnv<Id> extends ControlPlaneEnv<Id, ActionControlPlane>, SignInDeclarationEnv {
  OrchestratorAgent: ObjectNamespace<Id, ActionTarget>;
  UserDO: ObjectNamespace<Id, ActionRegistry>;
}

/**
 * Resolves ownership first via `claimOwnedWorkspace`, proving the named account owns the named
 * workspace before any RPC reaches it; returns the same stub resolution `routeAgentRequest` uses.
 */
export function runControlAction<Id>(
  env: ActionEnv<Id>,
  action: ControlAction,
  operator: { readonly email: string; readonly caller: PresentedCaller },
): Promise<ActionOutcome> {
  return settle(Effect.catchCause(Effect.promise(() => (isAccountAction(action) ? accountAction(env, action, operator) : controlAction(env, action))), (failed) => Effect.sync((): ActionOutcome => {
    const cause = Cause.squash(failed);

    // The chain is the durable row's detail; the CODE is what the dataset gets.
    return {
      outcome: 'failed',
      detail: renderThrownChain({ cause }),
      reason: 'threw',
      code: toKinuError({ doing: 'running an admin control action', cause, otherwise: 'unavailable' }).code,
    };
  })));
}

type AccountAction = Extract<ControlAction, { action: `account.${string}` | `invite.${string}` }>;

function isAccountAction(action: ControlAction): action is AccountAction {
  return action.action.startsWith('account.') || action.action.startsWith('invite.');
}

/**
 * An account's standing, set in its own object (core limits/) and mirrored for the accounts list. An invite by email
 * reaches the account that email signs in as, whether it has signed in yet or not: its object keeps the class until it
 * does.
 */
async function accountAction<Id>(env: ActionEnv<Id>, action: AccountAction, operator: { readonly email: string; readonly caller: PresentedCaller }): Promise<ActionOutcome> {
  const owner = await ownerCaller(env);
  const plane = controlPlaneStub(env);

  if (action.action === 'invite.link') {
    const { token, expiresAt } = await plane.createInvite(operator.caller, operator.email);

    return { outcome: 'ok', detail: `invite link made, open until ${new Date(expiresAt).toISOString()}`, reason: 'ok', result: { path: `/invite/${token}`, expiresAt } };
  }

  const userId = action.action === 'invite.email' ? await accountIdFor(env, action.email) : action.userId;
  const user = objectNamed(env.UserDO, userId);

  if (action.action === 'account.suspend') await user.limits_suspend(owner, action.reason, operator.email);
  else if (action.action === 'account.unsuspend') await user.limits_unsuspend(owner);
  else await user.limits_setClass(owner, action.action === 'invite.email' ? 'invited' : action.class, operator.email);
  const now = await user.limits(owner);
  const klass = now.class === 'invited' ? 'invited' : 'free';

  await plane.noteAccountStanding(operator.caller, userId, { class: klass, suspendedAt: now.suspended?.at ?? null });

  return { outcome: 'ok', detail: `${userId} is ${now.class}${now.suspended === null ? '' : ', suspended'}`, reason: 'ok', affected: 1 };
}

async function controlAction<Id>(env: ActionEnv<Id>, action: Exclude<ControlAction, AccountAction>): Promise<ActionOutcome> {
  if (action.action === 'workspace.remove') {
    // Checked before waking any Durable Object.
    if (action.confirm !== action.workspace) {
      return { outcome: 'denied', detail: 'the typed name did not match', reason: 'name_mismatch' };
    }

    // Does not wake-and-claim: `removeWorkspace`/`destroyAgent` check ownership inside the call, and
    // claiming would run a broken workspace's scaffold bootstrap.
    const owner = await ownerCaller(env);
    const user = objectNamed(env.UserDO, action.userId);
    // The registry's teardown forgets it in the index once it is gone; a failed one leaves no tombstone.
    await user.removeWorkspace(owner, action.workspace, action.userId);

    return {
      outcome: 'ok', detail: `removed ${action.workspace}`, reason: 'ok', affected: 1,
    };
  }

  const owned = await claimOwnedWorkspace(env, action.userId, action.workspace);

  if (Result.isFailure(owned)) return notOwned(owned.failure.error);
  const agent = owned.success;

  switch (action.action) {
    case 'job.cancel': {
      const { ok } = await agent.cancelBackgroundJob(action.jobId);

      return ok
        ? { outcome: 'ok', detail: `cancelled ${action.jobId}`, reason: 'ok', affected: 1 }
        : { outcome: 'denied', detail: 'that job is not running', reason: 'not_running' };
    }

    case 'job.retry': {
      const result = await agent.retryBackgroundJob(action.jobId);

      // Workspace prose: reaches the durable row, never the dataset.
      return result.ok
        ? {
          outcome: 'ok', detail: `retrying ${result.jobId ?? action.jobId}`,
          reason: 'ok', affected: 1,
        }
        : {
          outcome: 'denied', detail: result.error ?? 'that job could not be retried',
          reason: 'not_retriable',
        };
    }

    case 'job.dismiss': {
      const { ok } = await agent.dismissBackgroundJob(action.jobId);

      return ok
        ? { outcome: 'ok', detail: `dismissed ${action.jobId}`, reason: 'ok', affected: 1 }
        : { outcome: 'denied', detail: 'no such job', reason: 'no_such_job' };
    }

    case 'jobs.clear': {
      const { ok } = await agent.clearBackgroundJobs();

      return ok
        ? { outcome: 'ok', detail: 'cleared settled jobs', reason: 'ok' }
        : { outcome: 'denied', detail: 'nothing to clear', reason: 'nothing_to_clear' };
    }

    case 'approvals.decide': {
      const { decided } = await agent.decideDeferredApprovals(action.ids, action.decision);

      return decided.length > 0
        ? {
          outcome: 'ok',
          detail: `${action.decision} ${String(decided.length)} of ${String(action.ids.length)}`,
          reason: 'ok',
          affected: decided.length,
        }
        : {
          outcome: 'denied', detail: 'none of those approvals are still pending',
          reason: 'none_pending', affected: 0,
        };
    }

    case 'workspace.turn_read': {
      const read = await agent.supportReadTurn({
        turnId: action.turnId, reason: action.reason,
        ...(action.actor !== undefined && { actor: action.actor }),
        ...(action.at !== undefined && { at: action.at }),
      });

      return {
        outcome: 'ok', detail: `read turn ${action.turnId} for ${action.reason}`, reason: 'ok',
        result: decodeJsonValue({ value: read }),
      };
    }

    case 'shell_grants.revoke': {
      // Revoke exactly the grants read first: a guessed set would silently no-op yet audit as revoked.
      const { grants } = await agent.getShellApprovalGrants();

      if (grants.length === 0) {
        return { outcome: 'denied', detail: 'no standing grants', reason: 'no_grants' };
      }

      const after = await agent.revokeShellApprovalGrants(grants);

      return {
        outcome: 'ok',
        detail: `revoked ${String(grants.length)}, ${String(after.grants.length)} remain`,
        reason: 'ok',
        affected: grants.length,
      };
    }
  }
}

/** A refusal by this plane (`denied`), not a failure of the owning object. */
function notOwned(error: string): ActionOutcome {
  return { outcome: 'denied', detail: error, reason: 'not_owned' };
}
