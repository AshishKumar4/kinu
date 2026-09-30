/**
 * A workspace whose boot fails does not start: activation fails with the boot's own cause, so the SDK leaves the object
 * unstarted and every request fails with that cause until a later activation boots (docs/onstart DESIGN: "boot
 * failure is swallowed" was violation 5). Owed work keeps its existing wake.
 */
import { expect, test } from 'bun:test';
import { orchestratorHarness, reactivateOrchestratorHarness } from './helpers/actor-harness';

test('a boot that fails fails the activation with its cause, and the next activation boots', async () => {
  const { db } = orchestratorHarness();

  // The file store refuses the write every boot makes first: its generation.
  for (const write of ['INSERT', 'UPDATE']) {
    db.exec(`CREATE TRIGGER unreachable_${write} BEFORE ${write} ON kinu_workspace_generation
      BEGIN SELECT RAISE(ABORT, 'the file store is unreachable'); END`);
  }

  const { agent, started } = await reactivateOrchestratorHarness(db);

  // Every request starts the object first, and fails as the start does.
  await expect(started).rejects.toThrow('the file store is unreachable');
  await expect(agent.lifecycle.start()).rejects.toThrow('the file store is unreachable');

  for (const write of ['INSERT', 'UPDATE']) db.exec(`DROP TRIGGER unreachable_${write}`);
  await expect(agent.lifecycle.start()).resolves.toBeUndefined();
});

// ironwood-cairn-6dbcb8de, 2026-09-29 18:04-18:18Z: the box's once-a-minute question started a resting workspace each
// time, booting its files and arming the wake that retried its owed effects. What it reads is this activation's own
// runs, which an object that did not start has none of.
test('the box asking whether its container is in use does not start the workspace', async () => {
  const { db } = orchestratorHarness();

  for (const write of ['INSERT', 'UPDATE']) {
    db.exec(`CREATE TRIGGER unreachable_${write} BEFORE ${write} ON kinu_workspace_generation
      BEGIN SELECT RAISE(ABORT, 'the file store is unreachable'); END`);
  }

  const { agent, started } = await reactivateOrchestratorHarness(db);

  await expect(started).rejects.toThrow('the file store is unreachable');
  await expect(agent.sandboxInUse()).resolves.toBe(false);
});

