/**
 * Every admin mutation. Each arm proxies the owning DO's existing `@callable`; never reimplement.
 * The closed union is the reach: a generic method bridge would expose the whole orchestrator surface.
 * Every action names an account, since `OrchestratorAgent` is addressed by workspace name globally.
 * Arms return `ActionOutcome` and never throw for a refusal, so every attempt is audited.
 */
import { renderThrownChain, toKinuError, type ErrorCode } from '@kinu.run/core/obs';
import * as v from 'valibot';
import type { OrchestratorAgent } from '../orchestrator';
import type { UserDO } from '../user/user-do';
import { ownerCaller } from '@kinu.run/core';
import { claimOwnedWorkspace } from '../user/workspace-ownership';
import { unindexWorkspace, type IndexFeedSink } from './index-feed';
import type { ControlPlaneEnv } from './stub';
import type { ObjectNamespace } from '@kinu.run/core';

/** A UserDO name; it makes the workspace name beside it an address rather than a guess. */
export const UserIdSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{32}$/));

const WorkspaceSchema = v.pipe(v.string(), v.nonEmpty());

const JobIdSchema = v.pipe(v.string(), v.nonEmpty());

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
    action: v.literal('workspace.remove'),
    userId: UserIdSchema,
    workspace: WorkspaceSchema,
    /** The operator retypes the name: the one destructive action, picked from a cross-account list. */
    confirm: v.pipe(v.string(), v.nonEmpty()),
  }),
]);

export type ControlAction = v.InferOutput<typeof ControlActionSchema>;

/** Closed reason vocabulary for the ops dataset; free-text `detail` stays in the durable row. */
export type ActionReason =
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
}

/** `request` names no domain object: a body the schema refused, still audited. */
export type AuditTargetKind = 'job' | 'approval' | 'workspace' | 'request';

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
>;

export type ActionRegistry = Pick<UserDO,
  'hasWorkspace' | 'ensureWorkspaceCapability' | 'removeWorkspace'
>;

export interface ActionEnv<Id> extends ControlPlaneEnv<Id, IndexFeedSink> {
  OrchestratorAgent: ObjectNamespace<Id, ActionTarget>;
  UserDO: ObjectNamespace<Id, ActionRegistry>;
}

/**
 * Resolves ownership first via `claimOwnedWorkspace`, proving the named account owns the named
 * workspace before any RPC reaches it; returns the same stub resolution `routeAgentRequest` uses.
 */
export async function runControlAction<Id>(
  env: ActionEnv<Id>,
  action: ControlAction,
): Promise<ActionOutcome> {
  try {
    if (action.action === 'workspace.remove') {
      // Checked before waking any Durable Object.
      if (action.confirm !== action.workspace) {
        return { outcome: 'denied', detail: 'the typed name did not match', reason: 'name_mismatch' };
      }

      // Does not wake-and-claim: `removeWorkspace`/`destroyAgent` check ownership inside the call, and
      // claiming would run a broken workspace's scaffold bootstrap.
      const owner = await ownerCaller(env);
      const user = env.UserDO.get(env.UserDO.idFromName(action.userId));
      await user.removeWorkspace(owner, action.workspace, action.userId);
      // Only after the registry says it is gone; a failed teardown must not leave a tombstone.
      await unindexWorkspace(env, { userId: action.userId, name: action.workspace });

      return {
        outcome: 'ok', detail: `removed ${action.workspace}`, reason: 'ok', affected: 1,
      };
    }

    const owned = await claimOwnedWorkspace(env, action.userId, action.workspace);

    if (!owned.ok) return notOwned(owned.error);
    const agent = owned.agent;

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
  } catch (cause) {
    // The chain is the durable row's detail; the CODE is what the dataset gets.
    return {
      outcome: 'failed',
      detail: renderThrownChain({ cause }),
      reason: 'threw',
      code: toKinuError({ doing: 'running an admin control action', cause, otherwise: 'unavailable' }).code,
    };
  }
}

/** A refusal by this plane (`denied`), not a failure of the owning object. */
function notOwned(error: string): ActionOutcome {
  return { outcome: 'denied', detail: error, reason: 'not_owned' };
}
