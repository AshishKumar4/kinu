/**
 * S4 — scaffold promotion is pointer-first and recoverable.
 *
 * The canonical source of every scaffold version is its `.vN` file; the
 * `scaffold_versions.status='current'` row is the single current pointer;
 * `scaffold/agent.js` is a rebuildable view. Every boundary here injects a
 * fault at the exact write that used to be ordered crash-sensitively and
 * proves the invariant that survives it: exactly one current pointer, whose
 * version file is what a cold-reopened runtime executes.
 */

import { describe, test, expect } from 'bun:test';
import {
  bootstrapScaffold,
  INITIAL_SCAFFOLD_SOURCE,
  modifyScaffold,
  getPendingScaffold,
  getCurrentScaffoldVersion,
  applyPromotionDecision,
  rollbackScaffold,
  readScaffoldVersion,
  createScaffoldSurface,
} from '../src/index';
import { createTestRuntime } from './helpers';
import type { AgentRuntime } from '../src/types/agent-runtime';

const V0 = 'async function* run(rt, task) { yield "v0"; }';
const V1 = 'async function* run(rt, task) { yield "v1"; }';

function scaffoldVfsPath(rt: AgentRuntime, suffix: string): string {
  return `${rt.identity.scaffold.path}${suffix}`;
}

/** A second runtime over the same durable state — the cold reopen. */
function reopen(rt: AgentRuntime): AgentRuntime {
  const vfs = rt.agentStateVfs ?? rt.storage.vfs;
  return {
    ...rt,
    identity: {
      id: rt.identity.id,
      name: rt.identity.name,
      scaffold: createScaffoldSurface({ vfs, sql: rt.storage.sql, path: rt.identity.scaffold.path }),
    },
  };
}

async function currentCount(rt: AgentRuntime): Promise<number> {
  return rt.storage.sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM scaffold_versions WHERE status = 'current'`[0]?.n ?? 0;
}

/** Seed v0 canonically through the real bootstrap, then propose V1. */
async function seedAndPropose(rt: AgentRuntime): Promise<number> {
  await rt.storage.vfs.unlink(scaffoldVfsPath(rt, ''));
  await bootstrapScaffold(rt);
  const mod = await modifyScaffold(
    rt,
    'Pointer-authority test proposal — long enough rationale for gate one.',
    V1,
  );
  expect(mod.ok).toBe(true);
  return mod.version!;
}

describe('bootstrap seeds the canonical source', () => {
  test('a fresh workspace writes .v0 before its row and the view last', async () => {
    const { rt } = createTestRuntime();
    await rt.storage.vfs.unlink(scaffoldVfsPath(rt, ''));

    await bootstrapScaffold(rt);

    expect(await rt.storage.vfs.exists(scaffoldVfsPath(rt, '.v0'))).toBe(true);
    expect(await readScaffoldVersion(rt, 0)).toBe(INITIAL_SCAFFOLD_SOURCE);
    expect(getCurrentScaffoldVersion(rt.storage.sql)).toBe(0);
    // The live view materialises from the same canonical source.
    expect(await rt.identity.scaffold.read()).toBe(INITIAL_SCAFFOLD_SOURCE);
  });

  test('a preserved workspace gets its exact one-shot .v0 seed from the live source', async () => {
    const { rt } = createTestRuntime();
    await rt.storage.vfs.unlink(scaffoldVfsPath(rt, ''));
    // Preserved shape: a live file and no archive at all.
    await rt.storage.vfs.writeFile(scaffoldVfsPath(rt, ''), V0);

    await bootstrapScaffold(rt);

    expect(await rt.storage.vfs.exists(scaffoldVfsPath(rt, '.v0'))).toBe(true);
    expect(await readScaffoldVersion(rt, 0)).toBe(V0);
    expect(getCurrentScaffoldVersion(rt.storage.sql)).toBe(0);
    // One-shot: re-running changes nothing.
    await bootstrapScaffold(rt);
    expect(await readScaffoldVersion(rt, 0)).toBe(V0);
  });

  test('activation refreshes a stale view onto the current pointer', async () => {
    const { rt } = createTestRuntime();
    const pendingVersion = await seedAndPropose(rt);
    void rt.storage.sql`
      UPDATE scaffold_versions SET status = 'historical' WHERE version = 0`;
    void rt.storage.sql`
      UPDATE scaffold_versions SET status = 'current' WHERE version = ${pendingVersion}`;
    // The view was never rewritten (the crash window) — it still holds v0's seed.

    await bootstrapScaffold(rt);

    expect(await rt.identity.scaffold.read()).toBe(V1);
    expect(await (reopen(rt)).identity.scaffold.read()).toBe(V1);
  });
});

describe('proposal boundary — source lands before the pending row', () => {
  test('a failed candidate-file write leaves no pending row behind', async () => {
    const { rt } = createTestRuntime();
    await rt.storage.vfs.unlink(scaffoldVfsPath(rt, ''));
    await bootstrapScaffold(rt);

    const vfs = rt.agentStateVfs ?? rt.storage.vfs;
    const realWrite = vfs.writeFile.bind(vfs);
    rt.agentStateVfs = {
      ...vfs,
      writeFile: async (path: string, data: string | Uint8Array) => {
        if (path === scaffoldVfsPath(rt, '.v1')) throw new Error('injected disk failure');
        return realWrite(path, data);
      },
    };

    await expect(modifyScaffold(
      rt,
      'Fault-injected proposal — long enough rationale for gate one.',
      V1,
    )).rejects.toThrow('injected disk failure');

    // No row without its source: the proposal never happened.
    expect(getPendingScaffold(rt.storage.sql)).toBeNull();
    expect((rt.storage.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM scaffold_versions`)[0]?.n).toBe(1); // only v0

    // A retry succeeds cleanly once the disk recovers.
    rt.agentStateVfs = undefined;
    const retry = await modifyScaffold(
      rt,
      'Retry after the injected failure — long enough rationale for gate one.',
      V1,
    );
    expect(retry.ok).toBe(true);
    expect(await readScaffoldVersion(rt, retry.version!)).toBe(V1);
  });
});

describe('promotion boundary — one current pointer, executed source follows it', () => {
  test('promote commits the pointer even when the view write dies', async () => {
    const { rt } = createTestRuntime();
    const pendingVersion = await seedAndPropose(rt);
    const pending = getPendingScaffold(rt.storage.sql)!;

    const realWrite = rt.identity.scaffold.write.bind(rt.identity.scaffold);
    let viewWrites = 0;
    rt.identity.scaffold.write = async () => {
      viewWrites++;
      throw new Error('injected view-write failure');
    };

    await expect(applyPromotionDecision(rt, pending, 'promote'))
      .rejects.toThrow('injected view-write failure');

    // Exactly one current pointer, and it names the promoted version.
    expect(viewWrites).toBe(1);
    expect(currentCount(rt)).resolves.toBe(1);
    expect(getCurrentScaffoldVersion(rt.storage.sql)).toBe(pendingVersion);

    // Cold reopen executes the pointer's version file, not the stale view.
    expect(await reopen(rt).identity.scaffold.read()).toBe(V1);
    expect(rt.identity.scaffold.write).not.toBe(realWrite);

    // Activation heals the rebuildable view.
    rt.identity.scaffold.write = realWrite;
    await bootstrapScaffold(rt);
    expect(await rt.identity.scaffold.read()).toBe(V1);
  });

  test('rollback decision retires the pending without touching the pointer', async () => {
    const { rt } = createTestRuntime();
    await seedAndPropose(rt);
    const pending = getPendingScaffold(rt.storage.sql)!;

    rt.identity.scaffold.write = async () => {
      throw new Error('injected view-write failure');
    };
    await expect(applyPromotionDecision(rt, pending, 'rollback'))
      .rejects.toThrow('injected view-write failure');

    expect((rt.storage.sql<{ status: string }>`
      SELECT status FROM scaffold_versions WHERE version = ${pending.version}`)[0]?.status)
      .toBe('rolled_back');
    expect(getCurrentScaffoldVersion(rt.storage.sql)).toBe(0);
    expect(await reopen(rt).identity.scaffold.read()).toBe(INITIAL_SCAFFOLD_SOURCE);
  });

  test('manual rollback flips the pointer first and refreshes the view', async () => {
    const { rt } = createTestRuntime();
    const pendingVersion = await seedAndPropose(rt);
    const promo = await applyPromotionDecision(rt, getPendingScaffold(rt.storage.sql)!, 'promote');
    expect(promo.action).toBe('promote');

    const rb = await rollbackScaffold(rt, 0);
    expect(rb.ok).toBe(true);

    expect(getCurrentScaffoldVersion(rt.storage.sql)).toBe(0);
    expect((rt.storage.sql<{ status: string }>`
      SELECT status FROM scaffold_versions WHERE version = ${pendingVersion}`)[0]?.status)
      .toBe('rolled_back');
    expect(currentCount(rt)).resolves.toBe(1);
    expect(await rt.identity.scaffold.read()).toBe(INITIAL_SCAFFOLD_SOURCE);
    expect(await reopen(rt).identity.scaffold.read()).toBe(INITIAL_SCAFFOLD_SOURCE);
  });

  test('repeated promote/rollback cycles keep exactly one current pointer', async () => {
    const { rt } = createTestRuntime();
    await rt.storage.vfs.unlink(scaffoldVfsPath(rt, ''));
    await bootstrapScaffold(rt);

    for (let i = 1; i <= 3; i++) {
      const code = `async function* run(rt, task) { yield "v${i}"; }`;
      const mod = await modifyScaffold(rt, `Cycle ${i} proposal carrying a rationale well past the gate.`, code);
      expect(mod.ok).toBe(true);
      if (i % 2 === 1) {
        const promo = await applyPromotionDecision(rt, getPendingScaffold(rt.storage.sql)!, 'promote');
        expect(promo.action).toBe('promote');
        expect(await reopen(rt).identity.scaffold.read()).toBe(code);
      } else {
        const rb = await applyPromotionDecision(rt, getPendingScaffold(rt.storage.sql)!, 'rollback');
        expect(rb.action).toBe('rollback');
      }
      expect(currentCount(rt)).resolves.toBe(1);
    }
    expect(getCurrentScaffoldVersion(rt.storage.sql)).toBe(3);
  });
});
