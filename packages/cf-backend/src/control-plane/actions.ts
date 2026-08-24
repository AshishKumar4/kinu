/**
 * Every mutation the admin surface can perform, and nothing else.
 *
 * THE ONE RULE THIS FILE ENFORCES: an admin action is a PROXY. Each arm below
 * resolves the Durable Object that already owns the state and calls the
 * `@callable` that already implements the change. There is no second
 * implementation of cancelling a job, deciding an approval or removing a
 * workspace, so the admin path and the owner's own path cannot diverge, and a
 * fix to either is a fix to both. An arm that computed a change here instead of
 * delegating would be the parallel-system defect this repo deletes.
 *
 * WHY THE ACTION SET IS A CLOSED UNION rather than a generic "call this method"
 * bridge. A bridge forwarding an arbitrary method name would make the whole
 * ~90-method orchestrator surface reachable from a browser under one
 * authorization, including the turn-driving and model-spending ones. The union
 * IS the reach: adding an action is a deliberate edit whose name then appears in
 * the audit log.
 *
 * Every arm returns an `ActionOutcome` and never throws for a refusal, because
 * the caller must be able to audit a refusal — a thrown error that produced no
 * row would be an unaudited attempt, and that is the one thing an audit log may
 * not miss.
 */
import { getAgentByName } from 'agents';
import { renderThrownChain } from '@kinu.run/core/obs';
import * as v from 'valibot';
import type { OrchestratorAgent } from '../orchestrator';
import type { UserDO } from '../user/user-do';
import { ownerCaller } from '../user/workspace-capability';
import { unindexWorkspace } from './index-feed';
import type { ControlPlaneEnv } from './stub';

/**
 * The actions, as data.
 *
 * The operation name and target kind an audit row carries are derived from the
 * action itself in `describeAction`, so the log's vocabulary and the reachable
 * set are one declaration. An audit log whose operation names are assembled by
 * string concatenation somewhere else drifts from the actions it describes.
 */
export const ControlActionSchema = v.variant('action', [
  v.object({
    action: v.literal('job.cancel'),
    workspace: v.pipe(v.string(), v.nonEmpty()),
    jobId: v.pipe(v.string(), v.nonEmpty()),
  }),
  v.object({
    action: v.literal('job.retry'),
    workspace: v.pipe(v.string(), v.nonEmpty()),
    jobId: v.pipe(v.string(), v.nonEmpty()),
  }),
  v.object({
    action: v.literal('job.dismiss'),
    workspace: v.pipe(v.string(), v.nonEmpty()),
    jobId: v.pipe(v.string(), v.nonEmpty()),
  }),
  v.object({
    action: v.literal('jobs.clear'),
    workspace: v.pipe(v.string(), v.nonEmpty()),
  }),
  v.object({
    action: v.literal('approvals.decide'),
    workspace: v.pipe(v.string(), v.nonEmpty()),
    ids: v.pipe(v.array(v.pipe(v.string(), v.nonEmpty())), v.minLength(1)),
    /** Exactly the answers `DeferredApprovalStore.decide` accepts. `always` is a
     *  standing approval, which is why it is its own answer rather than a flag
     *  on `approved`. */
    decision: v.picklist(['approved', 'denied', 'always']),
  }),
  v.object({
    action: v.literal('shell_grants.revoke'),
    workspace: v.pipe(v.string(), v.nonEmpty()),
  }),
  v.object({
    action: v.literal('workspace.remove'),
    workspace: v.pipe(v.string(), v.nonEmpty()),
    userId: v.pipe(v.string(), v.regex(/^[a-f0-9]{32}$/)),
    /** The operator retypes the workspace name. Not theatre: this is the one
     *  action here that destroys a user's data, and it is reachable from a list
     *  in which the row above belongs to somebody else. */
    confirm: v.pipe(v.string(), v.nonEmpty()),
  }),
]);

export type ControlAction = v.InferOutput<typeof ControlActionSchema>;

/** What an action did, in the shape the audit row and the analytics marker both
 *  need. `denied` means this plane refused it; `failed` means the owning object
 *  did. Keeping those apart is what stops a validation refusal being counted as
 *  an outage. */
export interface ActionOutcome {
  outcome: 'ok' | 'denied' | 'failed';
  detail: string;
  /** How many things changed, when the action has a count worth recording. */
  affected?: number;
}

/** How an action identifies itself in the audit log and in the ops dataset. */
/** What an audited attempt was aimed at. `request` is the one that names no
 *  domain object: it is the body the schema refused, which is still an attempt an
 *  operator made and therefore still an audit row. */
export type AuditTargetKind = 'job' | 'approval' | 'workspace' | 'request';

export interface ActionIdentity {
  /** snake_case, because the analytics sink groups on the tail after the first
   *  dot and a dot here would split one operation across two group keys. */
  operation: string;
  targetKind: AuditTargetKind;
  target: string;
}

export function describeAction(action: ControlAction): ActionIdentity {
  // Dotted action names become snake_case operation names: the analytics sink
  // groups on the tail after the first dot, so a dot there would split one
  // operation across two group keys.
  const operation = action.action.replace(/\./g, '_');
  switch (action.action) {
    case 'job.cancel':
    case 'job.retry':
    case 'job.dismiss':
      return { operation, targetKind: 'job', target: `${action.workspace}/${action.jobId}` };
    case 'approvals.decide':
      return {
        operation, targetKind: 'approval',
        target: `${action.workspace}/${String(action.ids.length)}`,
      };
    case 'jobs.clear':
    case 'shell_grants.revoke':
    case 'workspace.remove':
      return { operation, targetKind: 'workspace', target: action.workspace };
  }
}

export interface ActionEnv extends ControlPlaneEnv {
  OrchestratorAgent: DurableObjectNamespace<OrchestratorAgent>;
  UserDO: DurableObjectNamespace<UserDO>;
}

/**
 * Run one action against the object that owns the state it changes.
 *
 * `getAgentByName` is the SDK's own resolution — the same one `routeAgentRequest`
 * performs for the owner's chat — so the admin path reaches the same Durable
 * Object instance rather than a second one that merely shares a name.
 *
 * Ownership is deliberately NOT re-derived here. An operator surface is
 * cross-user by definition; requiring an ownership match would make it useless
 * while looking careful. What bounds the reach is the closed action union above
 * and the fresh-auth admin gate in front of it.
 */
export async function runControlAction(
  env: ActionEnv,
  action: ControlAction,
): Promise<ActionOutcome> {
  try {
    switch (action.action) {
      case 'job.cancel': {
        const agent = await workspaceStub(env, action.workspace);
        const { ok } = await agent.cancelBackgroundJob(action.jobId);
        return ok
          ? { outcome: 'ok', detail: `cancelled ${action.jobId}`, affected: 1 }
          : { outcome: 'denied', detail: 'that job is not running' };
      }
      case 'job.retry': {
        const agent = await workspaceStub(env, action.workspace);
        const result = await agent.retryBackgroundJob(action.jobId);
        // `RetryOutcome` carries its own refusal text — a job that already
        // succeeded, or one whose tool no longer exists — so the reason is
        // reported rather than flattened into a boolean.
        return result.ok
          ? { outcome: 'ok', detail: `retrying ${result.jobId ?? action.jobId}`, affected: 1 }
          : { outcome: 'denied', detail: result.error ?? 'that job could not be retried' };
      }
      case 'job.dismiss': {
        const agent = await workspaceStub(env, action.workspace);
        const { ok } = await agent.dismissBackgroundJob(action.jobId);
        return ok
          ? { outcome: 'ok', detail: `dismissed ${action.jobId}`, affected: 1 }
          : { outcome: 'denied', detail: 'no such job' };
      }
      case 'jobs.clear': {
        const agent = await workspaceStub(env, action.workspace);
        const { ok } = await agent.clearBackgroundJobs();
        return ok
          ? { outcome: 'ok', detail: 'cleared settled jobs' }
          : { outcome: 'denied', detail: 'nothing to clear' };
      }
      case 'approvals.decide': {
        const agent = await workspaceStub(env, action.workspace);
        const { decided } = await agent.decideDeferredApprovals(action.ids, action.decision);
        return {
          outcome: decided.length > 0 ? 'ok' : 'denied',
          detail: decided.length > 0
            ? `${action.decision} ${String(decided.length)} of ${String(action.ids.length)}`
            : 'none of those approvals are still pending',
          affected: decided.length,
        };
      }
      case 'shell_grants.revoke': {
        const agent = await workspaceStub(env, action.workspace);
        // Revoke exactly the grants that exist, read first: passing a guessed
        // set would silently no-op, and an audit row reading "revoked" with
        // nothing revoked is worse than no row.
        const { grants } = await agent.getShellApprovalGrants();
        if (grants.length === 0) return { outcome: 'denied', detail: 'no standing grants' };
        const after = await agent.revokeShellApprovalGrants(grants);
        return {
          outcome: 'ok',
          detail: `revoked ${String(grants.length)}, ${String(after.grants.length)} remain`,
          affected: grants.length,
        };
      }
      case 'workspace.remove': {
        if (action.confirm !== action.workspace) {
          return { outcome: 'denied', detail: 'the typed name did not match' };
        }
        // `UserDO.removeWorkspace` tears the workspace's own Durable Object down
        // BEFORE dropping the registry row, and fails closed when that teardown
        // fails — which is exactly why this proxies it instead of doing either
        // half itself.
        const owner = await ownerCaller(env);
        const user = env.UserDO.get(env.UserDO.idFromName(action.userId));
        await user.removeWorkspace(owner, action.workspace, action.userId);
        // Only after the registry says it is gone. A tombstone written first
        // would tell an operator the opposite of the truth on a failed teardown.
        await unindexWorkspace(env, { userId: action.userId, name: action.workspace });
        return { outcome: 'ok', detail: `removed ${action.workspace}`, affected: 1 };
      }
    }
  } catch (cause) {
    return { outcome: 'failed', detail: renderThrownChain({ cause }) };
  }
}

function workspaceStub(
  env: ActionEnv, workspace: string,
): Promise<DurableObjectStub<OrchestratorAgent>> {
  return getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, workspace);
}
