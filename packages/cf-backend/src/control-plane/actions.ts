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
 * EVERY ACTION NAMES AN ACCOUNT, and that is a security property rather than a
 * convenience. A workspace name is unique inside one UserDO and nowhere else,
 * while `OrchestratorAgent` is addressed by that name GLOBALLY — so `(name)`
 * alone is not an address, it is a collision waiting for a second account to
 * register the same string. An operator picks a row from a cross-account list;
 * binding the row's `userId` to the action and resolving through
 * `claimOwnedWorkspace` is what stops a roster row in one account from reaching
 * another account's live object.
 *
 * Every arm returns an `ActionOutcome` and never throws for a refusal, because
 * the caller must be able to audit a refusal — a thrown error that produced no
 * row would be an unaudited attempt, and that is the one thing an audit log may
 * not miss.
 */
import { renderThrownChain, toKinuError, type ErrorCode } from '@kinu.run/core/obs';
import * as v from 'valibot';
import type { OrchestratorAgent } from '../orchestrator';
import type { UserDO } from '../user/user-do';
import { ownerCaller } from '../user/workspace-capability';
import { claimOwnedWorkspace } from '../user/workspace-ownership';
import { unindexWorkspace } from './index-feed';
import type { ControlPlaneEnv } from './stub';

/** The account an action is bound to. A UserDO name, which is what makes the
 *  workspace name beside it an address rather than a guess. Exported because
 *  the drilldown routes refuse anything else with the same shape. */
export const UserIdSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{32}$/));
const WorkspaceSchema = v.pipe(v.string(), v.nonEmpty());
const JobIdSchema = v.pipe(v.string(), v.nonEmpty());

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
    /** Exactly the answers `DeferredApprovalStore.decide` accepts. `always` is a
     *  standing approval, which is why it is its own answer rather than a flag
     *  on `approved`. */
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
    /** The operator retypes the workspace name. Not theatre: this is the one
     *  action here that destroys a user's data, and it is reachable from a list
     *  in which the row above belongs to somebody else. */
    confirm: v.pipe(v.string(), v.nonEmpty()),
  }),
]);

export type ControlAction = v.InferOutput<typeof ControlActionSchema>;

/**
 * Why an attempt ended the way it did, as a closed vocabulary.
 *
 * This is what reaches the operations dataset. The row's `detail` is free text
 * — for a thrown failure it is a rendered cause chain whose head is an upstream
 * exception message — and a three-month-retention dataset is not where that
 * belongs. One snake_case word per arm keeps the dataset groupable and keeps the
 * prose in the durable row, behind the same authorization that produced it.
 */
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

/** What an action did, in the shape the audit row and the analytics marker both
 *  need. `denied` means this plane refused it; `failed` means the owning object
 *  did. Keeping those apart is what stops a validation refusal being counted as
 *  an outage. */
export interface ActionOutcome {
  outcome: 'ok' | 'denied' | 'failed';
  /** The durable row's text. Never published to analytics. */
  detail: string;
  /** The published classification. Always present, so "every marker carries a
   *  reason" is a property of the type rather than of each call site. */
  reason: ActionReason;
  /** The classified code of a thrown failure, absent on every other arm. */
  code?: ErrorCode;
  /** How many things changed, when the action has a count worth recording. */
  affected?: number;
}

/** What an audited attempt was aimed at. `request` is the one that names no
 *  domain object: it is the body the schema refused, which is still an attempt an
 *  operator made and therefore still an audit row. */
export type AuditTargetKind = 'job' | 'approval' | 'workspace' | 'request';

/** How an action identifies itself in the audit log and in the ops dataset. */
export interface ActionIdentity {
  /** snake_case, because the analytics sink groups on the tail after the first
   *  dot and a dot here would split one operation across two group keys. */
  operation: string;
  targetKind: AuditTargetKind;
  /** `<userId>/<workspace>[/<jobId>]`. The account is IN the target because a
   *  workspace name alone does not identify a workspace, and an audit row that
   *  cannot say whose data was touched is not an audit row. */
  target: string;
}

export function describeAction(action: ControlAction): ActionIdentity {
  // Dotted action names become snake_case operation names: the analytics sink
  // groups on the tail after the first dot, so a dot there would split one
  // operation across two group keys.
  const operation = action.action.replace(/\./g, '_');
  const owned = `${action.userId}/${action.workspace}`;
  switch (action.action) {
    case 'job.cancel':
    case 'job.retry':
    case 'job.dismiss':
      return { operation, targetKind: 'job', target: `${owned}/${action.jobId}` };
    case 'approvals.decide':
      // The count lives in the detail ("approved 2 of 3"), not here: a target is
      // an address, and an address with a tally jammed onto it is neither.
      return { operation, targetKind: 'approval', target: owned };
    case 'jobs.clear':
    case 'shell_grants.revoke':
    case 'workspace.remove':
      return { operation, targetKind: 'workspace', target: owned };
  }
}

export interface ActionEnv extends ControlPlaneEnv {
  OrchestratorAgent: DurableObjectNamespace<OrchestratorAgent>;
  UserDO: DurableObjectNamespace<UserDO>;
}

/**
 * Run one action against the object that owns the state it changes.
 *
 * OWNERSHIP IS RESOLVED FIRST, through the same `claimOwnedWorkspace` the
 * owner's own requests go through — registry membership, then the workspace's
 * own identity check. An operator surface is cross-user by definition, so the
 * point is not to match the OPERATOR against the workspace; it is to prove that
 * the ACCOUNT the operator named really owns the workspace they named, before a
 * single RPC reaches it. Without that, a roster row one account holds for a name
 * another account owns resolves to the other account's live object, and the
 * operator acts on the wrong workspace while the UI shows the right owner.
 *
 * `claimOwnedWorkspace` returns the SDK's own stub resolution — the same one
 * `routeAgentRequest` performs for the owner's chat — so the admin path reaches
 * the same Durable Object instance rather than a second one that shares a name.
 */
export async function runControlAction(
  env: ActionEnv,
  action: ControlAction,
): Promise<ActionOutcome> {
  try {
    if (action.action === 'workspace.remove') {
      // Checked before anything is woken: it costs nothing, it is the operator's
      // own typo, and there is no reason to reach a Durable Object to refuse it.
      if (action.confirm !== action.workspace) {
        return { outcome: 'denied', detail: 'the typed name did not match', reason: 'name_mismatch' };
      }
      // The one arm that does NOT wake-and-claim. `UserDO.removeWorkspace` tears
      // the workspace's own Durable Object down BEFORE dropping the registry
      // row, and `destroyAgent` refuses unless the stored owner IS this account
      // — so the identity check is already inside the call, performed by the
      // object being destroyed. Claiming first would also run a fresh
      // workspace's scaffold bootstrap, which is a network round trip into a
      // workspace an operator is removing precisely because it does not work.
      const owner = await ownerCaller(env);
      const user = env.UserDO.get(env.UserDO.idFromName(action.userId));
      await user.removeWorkspace(owner, action.workspace, action.userId);
      // Only after the registry says it is gone. A tombstone written first
      // would tell an operator the opposite of the truth on a failed teardown.
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
        // `RetryOutcome` carries its own refusal text — a job that already
        // succeeded, or one whose tool no longer exists — so the reason is
        // reported rather than flattened into a boolean. It is the WORKSPACE's
        // prose, which is why it reaches the durable row and never the dataset.
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
        // Revoke exactly the grants that exist, read first: passing a guessed
        // set would silently no-op, and an audit row reading "revoked" with
        // nothing revoked is worse than no row.
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

/** An account that does not own the workspace it named. A refusal by this plane,
 *  not a failure of the owning object — which is why it is `denied`, and why the
 *  claim's own message reaches the audit row while the dataset gets one word. */
function notOwned(error: string): ActionOutcome {
  return { outcome: 'denied', detail: error, reason: 'not_owned' };
}
