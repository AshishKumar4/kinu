/**
 * How the control-plane index learns that a user or a workspace exists.
 *
 * TWO FEEDS, both best-effort, neither on the critical path:
 *
 *   1. `observeIdentity` — from the Worker's auth gate. A signed-in request
 *      proves an account exists and was here, and a request under
 *      `/api/workspaces/<name>` additionally proves that workspace is live.
 *   2. `indexNewWorkspace` — from the create path, immediately, so a workspace
 *      created and never opened is still in the index.
 *
 * WHY BEST-EFFORT IS THE RIGHT DESIGN AND NOT A SHORTCUT. Every row in this
 * index is a derived fact whose source of truth is a UserDO. A missing row costs
 * an operator a stale list until the next observation, and
 * `ControlPlaneDO.replaceUserWorkspaces` — which the user drilldown calls on
 * every open — repairs one account's rows from that source. So the failure mode
 * is a briefly incomplete list, and the alternative (making sign-in fail because
 * an index write failed) would be strictly worse. Nothing here is allowed to
 * change the outcome of the request that triggered it.
 *
 * THE ONCE-PER-ISOLATE MEMO is what makes feed 1 affordable. Without it every
 * authenticated request costs a Durable Object round trip to write a row that is
 * almost always already correct. `user/routes.ts` warms MCP connections with the
 * same pattern and for the same reason. The memo holds derived keys, not request
 * state: it is never read to answer a request, only to decide whether a write is
 * worth attempting, so a cold isolate is slower and never wrong.
 */
import { diagnostics, toKinuError } from '@kinu.run/core/obs';
import type { AuthIdentity } from '../auth/session';
import { internalCaller } from './admin-caller';
import { controlPlaneStub, hasControlPlane, type ControlPlaneEnv } from './stub';

/**
 * How long one isolate trusts its own observation before re-writing it.
 *
 * Not "forever": `last_seen_at` is what the users list is ordered by, so an
 * isolate that lives for hours would freeze the ordering of everyone it saw
 * first. Fifteen minutes matches the monitoring cron's period, which is this
 * deployment's existing answer to "how stale may an operational fact be".
 */
const OBSERVE_TTL_MS = 15 * 60 * 1000;

/** Last observation this isolate wrote, per key. Insertion is dynamic and
 *  entries expire, which is what a Map is for. */
const observed = new Map<string, number>();

/** Bound the memo so a long-lived isolate serving many accounts cannot grow it
 *  without limit. Dropping the oldest entries costs a repeated write, never a
 *  wrong answer. */
const OBSERVE_MEMO_MAX = 4096;

function shouldWrite(key: string, now: number): boolean {
  const last = observed.get(key);
  if (last !== undefined && now - last < OBSERVE_TTL_MS) return false;
  if (observed.size >= OBSERVE_MEMO_MAX) observed.clear();
  observed.set(key, now);
  return true;
}

/** The subset of `ExecutionContext` this needs. Narrow on purpose: `waitUntil`
 *  must not be destructured off a real ctx (it loses `this`), so the caller
 *  passes a bound closure or the ctx itself. */
export interface RetainWork {
  waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Record that this account — and, when the request names one, this workspace —
 * exists and was seen.
 *
 * Retained with `waitUntil` so it never delays the response, and swallowed at
 * the boundary in the one sense the no-swallow rule permits: the failure IS
 * reported, as a classified diagnostics failure, and only its effect on the
 * request is discarded.
 */
export function observeIdentity(
  env: ControlPlaneEnv,
  identity: AuthIdentity,
  options: { workspace?: string | null; retain: RetainWork; now?: number },
): void {
  const now = options.now ?? Date.now();
  const workspace = options.workspace ?? null;
  if (!hasControlPlane(env)) return;
  const key = workspace === null ? identity.userId : `${identity.userId}\u0000${workspace}`;
  if (!shouldWrite(key, now)) return;
  options.retain.waitUntil(write());

  async function write(): Promise<void> {
    try {
      const caller = await internalCaller(env);
      const stub = controlPlaneStub(env);
      await stub.observeUser(caller, {
        userId: identity.userId,
        email: identity.email,
        displayName: identity.displayName ?? null,
        at: now,
      });
      if (workspace !== null) {
        // `displayName` is the slug until the create feed or a reconcile
        // supplies the real title. Stating the slug is honest; inventing a
        // prettier string here would put a second title source in the tree.
        await stub.observeWorkspace(caller, {
          userId: identity.userId, name: workspace, displayName: workspace, at: now,
        });
      }
    } catch (cause) {
      // The observation is retried by the next request past the TTL, and the
      // drilldown reconciles from the UserDO regardless, so the index is
      // eventually right either way — but a persistent failure here means the
      // fleet list is quietly going stale, which is worth a line.
      observed.delete(key);
      diagnostics.failure('control_plane.observe_failed', toKinuError({
        doing: 'recording a control-plane index observation',
        cause,
        otherwise: 'unavailable',
      }), { hasWorkspace: workspace !== null });
    }
  }
}

/**
 * Index a workspace the instant it is registered.
 *
 * Awaited rather than retained: it runs inside the create request, which already
 * costs several Durable Object round trips, and a create that returns before its
 * index row exists is exactly how an operator watches a new workspace fail to
 * appear. A failure is still reported and still not fatal — the registry row is
 * the truth and this one is a copy.
 */
export async function indexNewWorkspace(
  env: ControlPlaneEnv,
  target: { userId: string; name: string; displayName: string; createdAt: number },
): Promise<void> {
  // No destination is not a lost write — see `hasControlPlane`.
  if (!hasControlPlane(env)) return;
  try {
    const caller = await internalCaller(env);
    await controlPlaneStub(env).observeWorkspace(caller, {
      userId: target.userId,
      name: target.name,
      displayName: target.displayName,
      createdAt: target.createdAt,
      at: target.createdAt,
    });
  } catch (cause) {
    diagnostics.failure('control_plane.index_workspace_failed', toKinuError({
      doing: 'indexing a newly created workspace in the control plane',
      cause,
      otherwise: 'unavailable',
    }), { workspace: target.name });
  }
}

/**
 * Tombstone a workspace the index has been told is gone.
 *
 * Called after the registry removal succeeds, never before: a failed teardown
 * leaves the registry row in place on purpose, and an index that had already
 * marked it removed would tell an operator the opposite of the truth.
 */
export async function unindexWorkspace(
  env: ControlPlaneEnv,
  target: { userId: string; name: string },
): Promise<void> {
  if (!hasControlPlane(env)) return;
  try {
    const caller = await internalCaller(env);
    await controlPlaneStub(env).forgetWorkspace(caller, target);
  } catch (cause) {
    diagnostics.failure('control_plane.unindex_workspace_failed', toKinuError({
      doing: 'tombstoning a removed workspace in the control plane',
      cause,
      otherwise: 'unavailable',
    }), { workspace: target.name });
  }
}
