/**
 * Defends: a push watcher losing a delivery GitHub never sends again. GitHub counts an answer slower than 10 s as failed
 * and does not redeliver it by itself (docs.github.com/webhooks/using-webhooks/handling-failed-webhook-deliveries), so
 * the route answers once the delivery is kept, before its check begins, and the delivery's job runs the check. Through
 * the real webhook route into a real OrchestratorAgent, whose job queue runs as its alarm runs it. The clock is pinned,
 * so the timer wake a fire arms never comes due and each alarm runs the kept deliveries alone.
 */
import { afterAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  checkAnswerOf, createWebhookSecretStore, hmacSha256Hex, registerPushWatcher, TriggerRegistry, webhookRoutePath,
  type RunCheck, type WatchOutcome,
} from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';
import { makeSqlExec } from '../../core/tests/helpers';
import {
  eventsOver, orchestratorHarness, reactivateOrchestratorHarness, workspaceMainActor, type StartedHarness,
} from './helpers/actor-harness';
import { serveFamily } from './helpers/api';

// Dynamic: the SDK stand-in `actor-harness` installs must precede the route's graph.
const { webhookDeliveryRoutes } = await import('../src/events/routes');

const ORIGIN = 'https://app.example';

const ROUTE_SECRET = 'push-deliveries-route-secret-0123456789';

const BODY = '{"ref":"refs/heads/main","after":"abc123","repository":{"full_name":"Owner/Repo"}}';

const PINNED_NOW = new Date('2026-03-01T12:00:00.000Z');

const FIRE: WatchOutcome = { kind: 'answered', answer: present(checkAnswerOf({ fire: true, brief: 'main moved' }), 'a fire') };

type JobRow = Record<string, string | number | null>;

beforeEach(() => { setSystemTime(PINNED_NOW); });

afterAll(() => { setSystemTime(); });

/** A workspace with a push watcher on owner/repo, and GitHub delivering to it through the route. */
async function watched() {
  let harness: StartedHarness = orchestratorHarness();

  await harness.started;
  const { db } = harness;
  const sql = makeSqlExec(db);
  const registry = new TriggerRegistry(sql, workspaceMainActor(db), { scheduleAt: async () => {} });

  const { trigger_id, secret } = await registerPushWatcher(registry, createWebhookSecretStore(sql), {
    repo: 'owner/repo', event: 'push', check: { code: 'return { fire: true, brief: "main moved" };' },
  }, Date.now());

  const path = await webhookRoutePath(ROUTE_SECRET, { workspaceName: harness.agent.name, triggerId: trigger_id });
  const signature = `sha256=${await hmacSha256Hex(secret, BODY)}`;
  const route = serveFamily(webhookDeliveryRoutes(() => async () => harness.agent));
  let began = Promise.withResolvers<void>();
  let checks = 0;

  return {
    db,
    trigger: trigger_id,
    get agent() { return harness.agent; },
    checks: () => checks,
    /** Each check from here ends as `run` does. */
    checking(run: RunCheck): void {
      harness.agent.harnessWatchChecks = async (check, state, input) => {
        checks += 1;
        began.resolve();

        return await run(check, state, input);
      };
    },
    /** GitHub's delivery of the push: the route's status, or `checked first` where a check began before it answered. */
    async deliver(): Promise<number | 'checked first'> {
      began = Promise.withResolvers<void>();

      const answered = route(new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature, 'x-github-event': 'push', 'x-github-delivery': crypto.randomUUID() },
        body: BODY,
      }), { WEBHOOK_ROUTE_SECRET: ROUTE_SECRET }).then((response) => present(response, 'an answer').status);

      return await Promise.race([answered, began.promise.then(() => 'checked first' as const)]);
    },
    /** The object reset: a new activation over the same storage, and whatever the old one was running never ends. */
    async reset(): Promise<void> {
      harness = await reactivateOrchestratorHarness(db);
    },
    fires: () => eventsOver(db).query({ variant: 'timer' }).length,
    kept: () => keptJobs(db),
  };
}

function keptJobs(db: Database): JobRow[] {
  return db.query<JobRow, []>("SELECT * FROM cf_agents_jobs WHERE capability = 'kinu-pending-deliveries'").all();
}

describe('a push watcher keeps every delivery GitHub would not send again', () => {
  test('a reset during its check still fires once, with nothing sent again', async () => {
    const w = await watched();
    const reached = Promise.withResolvers<void>();

    w.checking(() => {
      reached.resolve();

      return new Promise<never>(() => undefined);
    });

    expect(await w.deliver()).toBe(202);
    const dying = w.agent.alarm();

    await reached.promise;
    expect(w.fires()).toBe(0);

    await w.reset();
    w.checking(async () => FIRE);
    await w.agent.alarm();

    expect(w.fires()).toBe(1);
    expect(w.checks()).toBe(2);
    expect(w.kept()).toEqual([]);
    expect(Bun.peek.status(dying)).toBe('pending');
  });

  test("a check longer than GitHub's 10 s still fires, the route having answered before it began", async () => {
    const w = await watched();

    w.checking(async () => {
      setSystemTime(new Date(Date.now() + 11_000));

      return FIRE;
    });

    expect(await w.deliver()).toBe(202);
    expect(w.checks()).toBe(0);

    await w.agent.alarm();

    expect(w.fires()).toBe(1);
    expect(w.kept()).toEqual([]);
  });

  test('the same signed delivery sent again, while kept or once fired, fires once', async () => {
    const w = await watched();

    w.checking(async () => FIRE);

    expect(await w.deliver()).toBe(202);
    expect(await w.deliver()).toBe(202);
    expect(w.kept()).toHaveLength(1);

    await w.agent.alarm();
    expect(w.fires()).toBe(1);

    expect(await w.deliver()).toBe(202);
    expect(w.kept()).toEqual([]);
    expect(w.checks()).toBe(1);
  });

  test('a check that fails for a while fires once it recovers, with nothing sent again', async () => {
    const w = await watched();

    w.checking(async () => ({ kind: 'transient', detail: 'GitHub answered 502' }));
    expect(await w.deliver()).toBe(202);
    await w.agent.alarm();

    expect(w.fires()).toBe(0);
    const [job] = w.kept();

    w.checking(async () => FIRE);
    setSystemTime(new Date(Number(present(job, 'the job kept to try again')['time'])));
    await w.agent.alarm();

    expect(w.fires()).toBe(1);
    expect(w.kept()).toEqual([]);
  });

  test('a check that throws through every attempt is tried again a lap later, and fires once it stops', async () => {
    const w = await watched();

    w.checking(async () => {
      throw new Error('the check broke');
    });

    expect(await w.deliver()).toBe(202);
    await w.agent.alarm();

    expect(w.fires()).toBe(0);
    const [job] = w.kept();

    w.checking(async () => FIRE);
    setSystemTime(new Date(Number(present(job, 'the job kept to try again')['time'])));
    await w.agent.alarm();

    expect(w.fires()).toBe(1);
    expect(w.kept()).toEqual([]);
  });

  test('a delivery whose watcher parks before its check waits for it, and goes when the watcher is cancelled', async () => {
    const w = await watched();

    w.checking(async () => FIRE);
    expect(await w.deliver()).toBe(202);
    expect(await w.agent.githubPushGone()).toBe(1);
    await w.agent.alarm();

    expect(w.checks()).toBe(0);
    expect(w.kept()).toHaveLength(1);

    await w.agent.cancelTrigger(w.trigger, 'owner');
    expect(w.kept()).toEqual([]);
    expect(w.fires()).toBe(0);
  });

  test('a job run again after its fire committed, a reset having come before its row went, fires nothing more', async () => {
    const w = await watched();
    let standing: JobRow | undefined;

    // The job's row as its run leaves it until the check returns: what a reset after the fire's commit finds.
    w.checking(async () => {
      [standing] = w.kept();

      return FIRE;
    });

    expect(await w.deliver()).toBe(202);
    await w.agent.alarm();
    expect(w.fires()).toBe(1);

    const row = present(standing, 'the job row the check ran under');
    const columns = Object.keys(row);

    w.db.query(`INSERT INTO cf_agents_jobs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(row));
    await w.reset();
    w.checking(async () => FIRE);
    await w.agent.alarm();

    expect(w.fires()).toBe(1);
    expect(w.checks()).toBe(1);
    expect(w.kept()).toEqual([]);
  });
});
