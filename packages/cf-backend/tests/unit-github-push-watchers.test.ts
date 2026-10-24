// A workspace's push watchers over a real trigger registry and secret store: made with a hook the owner's account makes,
// revoked when GitHub will not make it, parked while GitHub is disconnected, and resumed with a new hook. The account
// is faked; its own tests are unit-github-hooks.test.ts.
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { Effect, Exit } from 'effect';
import {
  TriggerRegistry, cancelTrigger, createWebhookSecretStore, gitHubPushOf, initEventsHubTables, initWebhookIngressTables,
  type WatchCheck,
} from '@kinu.run/core';
import { sqlStorageOver } from '@kinu.run/core/identity';
import { createTestActorsOver, present } from '@kinu.run/test-utils';
import { createPushWatcher, parkPushWatchers, resumePushWatchers, type PushHookAccount, type PushWatcherHost } from '../src/github-push-watchers';
import { ORCHESTRATOR_STARTED_RPC } from '../src/rpc-surface';

const NOW = 1_700_000_000_000;

const CHECK: WatchCheck = { code: 'return { fire: input.event === "push", brief: "main moved" };' };

/** The workspace's registry and secrets; the account answers each hook it is asked to make with the next id, or refuses. */
function workspace(refuse = false) {
  const db = new Database(':memory:');
  const sql = sqlStorageOver(db);

  initEventsHubTables(sql);
  initWebhookIngressTables(sql);
  const registry = new TriggerRegistry(sql, createTestActorsOver(db).main, { scheduleAt: async () => {} });
  const secrets = createWebhookSecretStore(sql);
  const made: Array<{ readonly repo: string; readonly url: string; readonly events: readonly string[] }> = [];
  const deleted: Array<readonly [string, number]> = [];
  const forgotten: string[] = [];
  const resumed: string[] = [];

  const account: PushHookAccount = {
    hookCreate: async (ask) => {
      if (refuse) throw new Error('GitHub would not make a hook on owner/repo: Not Found (the GitHub connection needs admin rights on it)');
      made.push({ repo: ask.repo, url: ask.url, events: ask.events });

      return { hookId: 40 + made.length };
    },
    hookDelete: async (repo, hookId) => { deleted.push([repo, hookId]); },
  };

  const host: PushWatcherHost = {
    registry, secrets, workspace: 'shop', routeSecret: 'route-secret', origin: 'https://kinu.example.com', account,
    revoke: async (id) => { await cancelTrigger({ registry, trigger_id: id, now: NOW, caller: 'owner', secrets }); },
    forgetClaims: (id) => { forgotten.push(id); },
    resumeDeliveries: async (id) => { resumed.push(id); },
  };

  return { registry, secrets, host, made, deleted, forgotten, resumed };
}

const pushOf = (w: ReturnType<typeof workspace>, id: string) => gitHubPushOf(present(w.registry.get(id), 'the watcher'));

describe('a push watcher', () => {
  test('is parked and resumed by the account through the workspace\'s RPC seal, on a started workspace', () => {
    expect(ORCHESTRATOR_STARTED_RPC).toEqual(expect.arrayContaining(['githubPushGone', 'githubPushBack']));
  });

  test('is a GitHub-signed webhook trigger with its check, whose hook delivers to its own signed route', async () => {
    const w = workspace();
    const watcher = await Effect.runPromise(createPushWatcher(w.host, { repo: 'owner/repo', event: 'push', label: 'pushes', check: CHECK }));
    const trigger = present(w.registry.get(watcher.id), 'its trigger');

    expect(watcher).toEqual({ id: watcher.id, kind: 'webhook_durable', repo: 'owner/repo', hookId: 41 });
    expect(trigger.spec).toMatchObject({ auth_mode: 'github', label: 'pushes', check: CHECK, push: { source: 'github-repo', repo: 'owner/repo', event: 'push', hookId: 41 } });
    expect(w.made).toEqual([{ repo: 'owner/repo', url: expect.stringMatching(new RegExp(`^https://kinu\\.example\\.com/api/workspaces/shop/webhook/${watcher.id}/`, 'u')), events: ['push'] }]);
    const secretId = trigger.spec['secret_id'];

    expect(typeof secretId === 'string' ? await w.secrets.get(secretId) : null).toMatch(/^[0-9a-f]{64}$/u);
  });

  test('one GitHub will not hook leaves no trigger, and says GitHub\'s words', async () => {
    const w = workspace(true);
    const made = await Effect.runPromiseExit(createPushWatcher(w.host, { repo: 'owner/repo', event: 'push', check: CHECK }));

    expect(Exit.isFailure(made) && String(made.cause)).toContain('needs admin rights on it');
    expect(w.registry.list({ kind: 'webhook_durable', state: 'active' })).toEqual([]);
  });

  test('parks while GitHub is disconnected, and resumes with a new hook and a new secret once it is connected again', async () => {
    const w = workspace();
    const watcher = await Effect.runPromise(createPushWatcher(w.host, { repo: 'owner/repo', event: 'push', check: CHECK }));
    const secretId = present(w.registry.get(watcher.id), 'the watcher').spec['secret_id'];
    const secretOf = async () => (typeof secretId === 'string' ? await w.secrets.get(secretId) : null);
    const before = await secretOf();

    expect(parkPushWatchers(w.host, NOW)).toBe(1);
    expect(w.registry.get(watcher.id)?.state).toBe('paused');

    // None left parked on GitHub: the account stops asking.
    expect(await resumePushWatchers(w.host, NOW + 1)).toBe(0);
    expect(w.registry.get(watcher.id)?.state).toBe('active');
    expect(pushOf(w, watcher.id)?.hookId).toBe(42);
    expect(w.made.map((hook) => hook.repo)).toEqual(['owner/repo', 'owner/repo']);
    // A hook GitHub never deleted as it went signs with the old secret, which no longer verifies; its claims go with it.
    expect(await secretOf()).not.toBe(before);
    expect(w.forgotten).toEqual([watcher.id]);
    // What GitHub delivered before it went is checked now, with no delivery sent again.
    expect(w.resumed).toEqual([watcher.id]);
  });

  test('one GitHub will not hook again stays parked, and is counted so the account asks again', async () => {
    const w = workspace();
    await Effect.runPromise(createPushWatcher(w.host, { repo: 'owner/repo', event: 'push', check: CHECK }));
    parkPushWatchers(w.host, NOW);

    const refusing: PushWatcherHost = { ...w.host, account: { ...w.host.account, hookCreate: async () => { throw new Error('GitHub would not make a hook'); } } };

    expect(await resumePushWatchers(refusing, NOW + 1)).toBe(1);
  });

  test('cancelled while GitHub makes its hook, the hook is deleted again and nothing is left delivering', async () => {
    const w = workspace();

    const cancelling: PushWatcherHost = {
      ...w.host,
      account: {
        ...w.host.account,
        hookCreate: async (ask) => {
          const id = present(w.registry.list({ kind: 'webhook_durable', state: 'active' })[0], 'the new watcher').id;

          await w.host.revoke(id);

          return w.host.account.hookCreate(ask);
        },
      },
    };

    const made = await Effect.runPromiseExit(createPushWatcher(cancelling, { repo: 'owner/repo', event: 'push', check: CHECK }));

    expect(Exit.isFailure(made) && String(made.cause)).toContain('cancelled while its hook was made');
    expect(w.deleted).toEqual([['owner/repo', 41]]);
  });

  test('one its owner paused is neither parked again nor resumed by GitHub coming back', async () => {
    const w = workspace();
    const watcher = await Effect.runPromise(createPushWatcher(w.host, { repo: 'owner/repo', event: 'push', check: CHECK }));

    w.registry.pause(watcher.id, NOW);

    expect(parkPushWatchers(w.host, NOW)).toBe(0);
    expect(await resumePushWatchers(w.host, NOW + 1)).toBe(0);
    expect(w.registry.get(watcher.id)?.state).toBe('paused');
    expect(w.made).toHaveLength(1);
  });
});
