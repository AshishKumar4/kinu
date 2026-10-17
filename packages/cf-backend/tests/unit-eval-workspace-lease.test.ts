/**
 * An eval run's workspace is torn down by its account once the run stops marking it live, whether or not the run lived
 * to delete it. Staging 2026-10-16: a coding trial's run died at 22:14, its workspace was deleted only when the next run
 * took the slot at 05:11, and a job it had left streaming held its devbox and both objects awake for 7.6 h.
 */
import { Database } from 'bun:sqlite';
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { EVAL_WORKSPACE_BEAT_MS, EVAL_WORKSPACE_LEASE_MS, isEvalAccountEmail } from '@kinu.run/core';
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';

const DEV = 'eval-service@kinu.run';

const ACCOUNT = '0123456789abcdef0123456789abcdef';

afterEach(() => { setSystemTime(); });

/** An account on a deployment whose eval identity is {@link DEV}, signed in as `email`, and the jobs its alarm holds. */
async function account(email: string) {
  const db = new Database(':memory:');
  const harness = createTestUserDO({ storage: db, devUserEmail: DEV, durableObjectId: ACCOUNT });

  await harness.userDO.ensureProfile(await testOwner(), email);

  // The SDK makes its job table at the first job it is given.
  const armed = (): string[] => (db.query(`SELECT 1 FROM sqlite_master WHERE name = 'cf_agents_jobs'`).get() === null ? []
    : db.query<{ id: string }, []>(`SELECT id FROM cf_agents_jobs ORDER BY id`).all().map((row) => row.id));

  return { harness, armed, db };
}

/** Moves the clock to `at`, then runs what the account's alarm holds due by then, as the platform would. */
async function at(harness: Awaited<ReturnType<typeof account>>['harness'], time: number): Promise<void> {
  setSystemTime(new Date(time));
  await harness.userDO.alarm();
}

test("a run that stopped beating has its workspace torn down a lease after its last mark, and nothing stays armed", async () => {
  const start = Date.parse('2026-10-16T21:00:27Z');
  setSystemTime(new Date(start));
  const { harness, armed } = await account('eval-service+trial-4@kinu.run');
  const owner = await testOwner();

  await provisionTestWorkspace(harness, 'eval-coding-4-ue29g9');
  await provisionTestWorkspace(harness, 'eval-coding-5-k2m9x1');

  // Both runs beat for 70 minutes; then one dies, and the other beats on.
  for (let beat = 1; beat <= 70; beat += 1) {
    await at(harness, start + beat * EVAL_WORKSPACE_BEAT_MS);
    await harness.userDO.touchWorkspace(owner, 'eval-coding-4-ue29g9');
    await harness.userDO.touchWorkspace(owner, 'eval-coding-5-k2m9x1');
  }

  const died = start + 70 * EVAL_WORKSPACE_BEAT_MS;

  for (let beat = 1; beat < 10; beat += 1) {
    await at(harness, died + beat * EVAL_WORKSPACE_BEAT_MS);
    await harness.userDO.touchWorkspace(owner, 'eval-coding-5-k2m9x1');
  }

  expect(harness.destroyedWorkspaces).toEqual([]);
  await at(harness, died + EVAL_WORKSPACE_LEASE_MS);
  expect(harness.destroyedWorkspaces).toEqual(['eval-coding-4-ue29g9']);
  expect(armed()).toEqual(['eval-lease:eval-coding-5-k2m9x1']);

  // The other run ends as a run should, deleting its own workspace: its lease goes with it.
  await harness.userDO.removeWorkspace(owner, 'eval-coding-5-k2m9x1', ACCOUNT);
  expect(armed()).toEqual([]);
});

test("a person's account, or a workspace no eval made, holds no lease", async () => {
  const { harness, armed } = await account('ada@example.com');
  const owner = await testOwner();

  await provisionTestWorkspace(harness, 'eval-looks-like-one-abc123');
  await harness.userDO.touchWorkspace(owner, 'eval-looks-like-one-abc123');
  expect(armed()).toEqual([]);

  const evals = await account('eval-service@kinu.run');

  await provisionTestWorkspace(evals.harness, 'fernhill-bakery');
  expect(evals.armed()).toEqual([]);
});

test('an eval account is the eval identity itself or one it names, by its own address', () => {
  expect(['eval-service@kinu.run', 'eval-service+trial-4@kinu.run', 'eval-service+scripted@kinu.run'].map((email) => isEvalAccountEmail(DEV, email)))
    .toEqual([true, true, true]);
  expect(['eval-service+trial-0@kinu.run', 'eval-service+ada@kinu.run', 'ada@kinu.run', 'eval-service+trial-4@kinu.com'].map((email) => isEvalAccountEmail(DEV, email)))
    .toEqual([false, false, false, false]);
  expect(isEvalAccountEmail('', '')).toBe(false);
});
