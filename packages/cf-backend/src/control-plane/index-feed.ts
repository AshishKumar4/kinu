/**
 * How the control-plane index learns a user or workspace exists. All feeds are
 * best-effort and must never change the triggering request's outcome: rows are
 * derived from UserDOs and `ControlPlaneDO.replaceUserWorkspaces` repairs them.
 * The per-isolate memo only decides whether a write is worth attempting; never read to answer a request.
 */
import { diagnostics, toKinuError } from '@kinu.run/core/obs';
import type { AuthIdentity } from '../auth/session';
import { internalCaller } from './admin-caller';
import { controlPlaneStub, hasControlPlane, type ControlPlaneEnv } from './stub';
import type { ControlPlaneDO } from './control-plane-do';

export type IndexFeedSink = Pick<
  ControlPlaneDO, 'observeUser' | 'observeWorkspace' | 'touchWorkspace' | 'forgetWorkspace'
>;

/** Destination optional: "no control plane" is a first-class state; see `hasControlPlane`. */
export type IndexFeedEnv<Id> = Partial<ControlPlaneEnv<Id, IndexFeedSink>>;

/** Not forever: `last_seen_at` orders the users list; matches the monitoring cron period. */
const OBSERVE_TTL_MS = 15 * 60 * 1000;

const observed = new Map<string, number>();

/** Bounded so a long-lived isolate cannot grow it; eviction costs a repeat write, never a wrong answer. */
const OBSERVE_MEMO_MAX = 4096;

function shouldWrite(key: string, now: number): boolean {
  const last = observed.get(key);

  if (last !== undefined && now - last < OBSERVE_TTL_MS) return false;

  if (observed.size >= OBSERVE_MEMO_MAX) observed.clear();
  observed.set(key, now);

  return true;
}

/** `waitUntil` must not be destructured off a real ctx (loses `this`); pass a bound closure or the ctx. */
export interface RetainWork {
  waitUntil: (promise: Promise<unknown>) => void;
}

/** Retained with `waitUntil`; failure is reported as diagnostics and never affects the request. */
export function observeIdentity<Id>(
  env: IndexFeedEnv<Id>,
  identity: AuthIdentity,
  options: { retain: RetainWork; now?: number },
): void {
  const now = options.now ?? Date.now();

  if (!hasControlPlane(env)) return;

  if (!shouldWrite(identity.userId, now)) return;
  options.retain.waitUntil(retained(identity.userId, false, async () => {
    await controlPlaneStub(env).observeUser(await internalCaller(env), {
      userId: identity.userId,
      email: identity.email,
      displayName: identity.displayName ?? null,
      at: now,
    });
  }));
}

/**
 * Call only after ownership is proven: before that the path is a caller-chosen
 * name, and indexing it lets any signed-in user write rows into the operator list.
 */
export function observeWorkspaceUse<Id>(
  env: IndexFeedEnv<Id>,
  identity: AuthIdentity,
  workspace: string,
  options: { retain: RetainWork; now?: number },
): void {
  const now = options.now ?? Date.now();

  if (!hasControlPlane(env)) return;
  const key = `${identity.userId}\u0000${workspace}`;

  if (!shouldWrite(key, now)) return;
  options.retain.waitUntil(retained(key, true, async () => {
    // `touchWorkspace` preserves a title the create feed or a reconcile already supplied.
    await controlPlaneStub(env).touchWorkspace(await internalCaller(env), {
      userId: identity.userId, name: workspace, displayName: workspace, at: now,
    });
  }));
}

/** Dropping the memo entry on failure makes the next request retry instead of trusting a lost write. */
async function retained(key: string, hasWorkspace: boolean, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (cause) {
    observed.delete(key);
    diagnostics.failure('control_plane.observe_failed', toKinuError({
      doing: 'recording a control-plane index observation',
      cause,
      otherwise: 'unavailable',
    }), { hasWorkspace });
  }
}

/** Awaited, not retained: a create that returns before its index row exists looks like a failed create to an operator. */
export async function indexNewWorkspace<Id>(
  env: IndexFeedEnv<Id>,
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

/** Only after registry removal succeeds: a failed teardown keeps the registry row. */
export async function unindexWorkspace<Id>(
  env: IndexFeedEnv<Id>,
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
