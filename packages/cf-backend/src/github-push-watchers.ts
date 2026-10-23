// A workspace's push watchers: each a webhook trigger that GitHub's deliveries for one repository reach, through a hook
// the owner's account made with its GitHub connection. Made, deleted with their trigger, parked while GitHub is
// disconnected, and resumed with a new hook once it is connected again.
import { Effect } from 'effect';
import * as v from 'valibot';
import {
  gitHubPushOf, keepPushHook, parkWatcher, registerPushWatcher, resumeWatcher, webhookRoutePath,
  type GitHubPush, type PushWatcher, type PushWatcherOpts, type TriggerRegistry, type WebhookSecretStore,
} from '@kinu.run/core';
import { attempt, diagnostics, KinuError, renderThrownChain, settle } from '@kinu.run/core/obs';

/** The owner's account, as a push watcher asks it to make and delete its hook. */
export interface PushHookAccount {
  hookCreate(ask: { readonly repo: string; readonly url: string; readonly secret: string; readonly events: readonly string[] }): Promise<{ readonly hookId: number }>;
  hookDelete(repo: string, hookId: number): Promise<void>;
}

export interface PushWatcherHost {
  readonly registry: TriggerRegistry;
  readonly secrets: WebhookSecretStore;
  readonly workspace: string;
  /** What signs the workspace's webhook routes; null where none is configured. */
  readonly routeSecret: string | null;
  /** The deployment's public origin, which GitHub delivers to. */
  readonly origin: string | undefined;
  readonly account: PushHookAccount;
  /** The trigger revoked with its secret, as cancelling it would. */
  readonly revoke: (triggerId: string) => Promise<void>;
}

const PARKED_ON_GITHUB = 'GitHub was disconnected from this account; connect it again in Settings > Connections and this watcher resumes.';

/** The signed route GitHub delivers a trigger's deliveries to. */
function routeOf(host: PushWatcherHost, triggerId: string): Effect.Effect<string, KinuError> {
  return Effect.gen(function* () {
    const { routeSecret, origin } = host;

    if (routeSecret === null || origin === undefined || origin === '') {
      return yield* new KinuError('unavailable', 'This deployment has no public webhook route, so GitHub has nowhere to deliver.');
    }

    return `${origin}${yield* Effect.promise(() => webhookRoutePath(routeSecret, { workspaceName: host.workspace, triggerId }))}`;
  });
}

/** The account makes a trigger's hook at GitHub, and the trigger keeps its id. */
function hooked(host: PushWatcherHost, triggerId: string, push: { readonly repo: string; readonly events: readonly string[] }, secret: string): Effect.Effect<number, KinuError> {
  return Effect.gen(function* () {
    const url = yield* routeOf(host, triggerId);

    const made = yield* attempt({ doing: `making a hook on ${push.repo}`, otherwise: 'unavailable' }, () => host.account.hookCreate({
      repo: push.repo, url, secret, events: push.events,
    }));

    keepPushHook(host.registry, triggerId, made.hookId);

    return made.hookId;
  });
}

/** A push watcher: its trigger, then its hook at GitHub; one GitHub will not make leaves no trigger behind. */
export function createPushWatcher(host: PushWatcherHost, opts: PushWatcherOpts): Effect.Effect<PushWatcher, KinuError> {
  return Effect.gen(function* () {
    const { trigger_id, secret } = yield* Effect.promise(() => registerPushWatcher(host.registry, host.secrets, opts, Date.now()));

    const hookId = yield* Effect.catch(hooked(host, trigger_id, opts, secret), (refused) => Effect.andThen(
      Effect.promise(() => host.revoke(trigger_id)),
      Effect.fail(refused),
    ));

    return { id: trigger_id, kind: 'webhook_durable', repo: opts.repo, hookId };
  });
}

/** A cancelled push watcher's hook, deleted at GitHub; one that cannot be is logged, its deliveries refused anyway. */
export function deletePushHook(host: PushWatcherHost, push: GitHubPush): Promise<void> {
  const { hookId } = push;

  if (hookId === undefined) return Promise.resolve();

  return settle(Effect.catch(
    attempt({ doing: `deleting hook ${hookId} on ${push.repo}`, otherwise: 'unavailable' }, () => host.account.hookDelete(push.repo, hookId)),
    (failed) => Effect.sync(() => { diagnostics.event('github.push_hook_not_deleted', { repo: push.repo, hookId, cause: renderThrownChain({ cause: failed }) }); }),
  ));
}

/** Every live push watcher parked on its connection, GitHub having been disconnected; how many. */
export function parkPushWatchers(host: PushWatcherHost, now: number): number {
  return host.registry.list({ kind: 'webhook_durable', state: 'active' })
    .filter((trigger) => gitHubPushOf(trigger) !== null)
    .filter((trigger) => parkWatcher(host.registry, trigger.id, { reason: 'connection', detail: PARKED_ON_GITHUB }, now))
    .length;
}

const ParkedOnConnectionSchema = v.object({ watch: v.object({ parked: v.object({ reason: v.literal('connection') }) }) });

/** Every push watcher parked on its connection checking again, each with a new hook: GitHub connected once more. One
 *  GitHub will not hook stays parked, and says so in the log. How many resumed. */
export function resumePushWatchers(host: PushWatcherHost, now: number): Promise<number> {
  return settle(Effect.gen(function* () {
    let resumed = 0;

    for (const trigger of host.registry.list({ kind: 'webhook_durable', state: 'paused' })) {
      const push = gitHubPushOf(trigger);
      const secretId = trigger.spec['secret_id'];

      if (push === null || typeof secretId !== 'string' || !v.is(ParkedOnConnectionSchema, trigger.spec)) continue;
      const secret = yield* Effect.promise(() => host.secrets.get(secretId));

      const made = secret === null ? null : yield* Effect.result(hooked(host, trigger.id, push, secret));

      if (made === null || made._tag === 'Failure') {
        diagnostics.event('github.push_watcher_not_resumed', { triggerId: trigger.id, repo: push.repo, cause: made === null ? 'its secret is gone' : made.failure.message });
        continue;
      }

      if (yield* Effect.promise(() => resumeWatcher(host.registry, trigger.id, 'connection', now))) resumed += 1;
    }

    return resumed;
  }));
}
