import { Result } from 'effect';
import { exists, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * S4: scaffold promotion is pointer-first. The `.vN` file is canonical and the `current` row the single
 * pointer; each fault leaves one current pointer whose file a cold reopen executes.
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
  scaffoldSource,
  createScaffoldSurface,
} from '../src/index';
import { createTestRuntime } from './helpers';
import type { AgentRuntime } from '../src/types/agent-runtime';
import { RunEventRecorder } from '../src/events/recorder';
import { WORKSPACE_RUN_ID } from '../src/events/model-call';
import { createMemoryVfs, present } from '@kinu.run/test-utils';

const V1 = 'async function* run(rt, task) { yield "v1"; }';

function scaffoldVfsPath(rt: AgentRuntime, suffix: string): string {
  return `${rt.identity.scaffold.path}${suffix}`;
}

/** A second runtime over the same durable state — the cold reopen. */
function reopen(rt: AgentRuntime): AgentRuntime {
  const vfs = rt.agentStateVfs;

  return {
    ...rt,
    identity: {
      id: rt.identity.id,
      name: rt.identity.name,
      scaffold: createScaffoldSurface({
      vfs, sql: rt.storage.sql, actor: rt.actor, path: rt.identity.scaffold.path,
    }),
    },
  };
}

async function currentCount(rt: AgentRuntime): Promise<number> {
  return rt.storage.sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM scaffold_versions
    WHERE actor_id = ${rt.actor.actorId} AND status = 'current'`[0]?.n ?? 0;
}

/** Seed v0 canonically through the real bootstrap, then propose V1. */
async function seedAndPropose(rt: AgentRuntime): Promise<number> {
  await rt.storage.vfs.unlink(scaffoldVfsPath(rt, '.v0'));
  await bootstrapScaffold(rt);

  const mod = await modifyScaffold(
    rt,
    'Pointer-authority test proposal — long enough rationale for gate one.',
    V1,
  );

  expect(mod.ok).toBe(true);

  return present(mod.version, 'the proposed scaffold version');
}

describe('bootstrap seeds the canonical source', () => {
  test('a fresh workspace writes .v0, then its row', async () => {
    const { rt } = createTestRuntime();
    await rt.storage.vfs.unlink(scaffoldVfsPath(rt, '.v0'));

    await bootstrapScaffold(rt);

    expect(await exists(rt.storage.vfs, scaffoldVfsPath(rt, '.v0'))).toBe(true);
    expect(await scaffoldSource(rt, 0)).toBe(INITIAL_SCAFFOLD_SOURCE);
    expect(getCurrentScaffoldVersion(rt.storage.sql, rt.actor)).toBe(0);
    expect(await rt.identity.scaffold.read()).toBe(INITIAL_SCAFFOLD_SOURCE);
  });

  test('a workspace whose home holds no scaffold directory yet is born with one', async () => {
    const { rt: base } = createTestRuntime();
    const { vfs: lenient } = createMemoryVfs();

    // As a Durable Object's storage writes: a file whose directory is absent is refused, never made for it.
    const vfs: VFS = {
      ...lenient,
      writeFile: async (file, data, options) => {
        if (!(await exists(lenient, file.slice(0, file.lastIndexOf('/'))))) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });

        await lenient.writeFile(file, data, options);
      },
    };

    // A loop path in a directory nothing has made, as a home no turn has written into yet.
    const path = `${base.identity.scaffold.path.slice(0, base.identity.scaffold.path.lastIndexOf('/'))}-unborn/agent.js`;
    const scaffold = createScaffoldSurface({ vfs, sql: base.storage.sql, actor: base.actor, path });
    const rt: AgentRuntime = { ...base, agentStateVfs: vfs, identity: { ...base.identity, scaffold } };

    await bootstrapScaffold(rt);

    expect({ v0: await scaffoldSource(rt, 0), live: await rt.identity.scaffold.read() })
      .toEqual({ v0: INITIAL_SCAFFOLD_SOURCE, live: INITIAL_SCAFFOLD_SOURCE });
  });
});

describe('proposal boundary — source lands before the pending row', () => {
  test('a failed candidate-file write leaves no pending row behind', async () => {
    const { rt } = createTestRuntime();
    await rt.storage.vfs.unlink(scaffoldVfsPath(rt, '.v0'));
    await bootstrapScaffold(rt);

    const vfs = rt.agentStateVfs;
    const realWrite = vfs.writeFile.bind(vfs);
    rt.agentStateVfs = {
      ...vfs,
      writeFile: async (path: string, data: Uint8Array) => {
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
    expect(getPendingScaffold(rt.storage.sql, rt.actor)).toBeNull();
    expect((rt.storage.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM scaffold_versions
      WHERE actor_id = ${rt.actor.actorId}`)[0]?.n).toBe(1); // only v0

    // A retry succeeds cleanly once the disk recovers.
    rt.agentStateVfs = vfs;

    const retry = await modifyScaffold(
      rt,
      'Retry after the injected failure — long enough rationale for gate one.',
      V1,
    );

    expect(retry.ok).toBe(true);
    expect(await scaffoldSource(rt, present(retry.version, 'the retried proposal version'))).toBe(V1);
  });
});

describe('promotion boundary — one current pointer, executed source follows it', () => {
  test('promote moves the one current pointer, and the executed source is that version\'s file', async () => {
    const { rt } = createTestRuntime();
    const pendingVersion = await seedAndPropose(rt);
    const pending = present(getPendingScaffold(rt.storage.sql, rt.actor), 'the pending scaffold');

    await applyPromotionDecision(rt, pending, 'promote', new RunEventRecorder(rt.storage.sql, rt.actor));

    // Exactly one current pointer, and it names the promoted version.
    expect(currentCount(rt)).resolves.toBe(1);
    expect(getCurrentScaffoldVersion(rt.storage.sql, rt.actor)).toBe(pendingVersion);
    expect(await reopen(rt).identity.scaffold.read()).toBe(V1);
  });

  test('rollback decision retires the pending without touching the pointer', async () => {
    const { rt } = createTestRuntime();
    await seedAndPropose(rt);
    const pending = present(getPendingScaffold(rt.storage.sql, rt.actor), 'the pending scaffold');

    await applyPromotionDecision(rt, pending, 'rollback', new RunEventRecorder(rt.storage.sql, rt.actor));

    expect((rt.storage.sql<{ status: string }>`
      SELECT status FROM scaffold_versions
      WHERE actor_id = ${rt.actor.actorId} AND version = ${pending.version}`)[0]?.status)
      .toBe('rolled_back');
    expect(getCurrentScaffoldVersion(rt.storage.sql, rt.actor)).toBe(0);
    expect(await reopen(rt).identity.scaffold.read()).toBe(INITIAL_SCAFFOLD_SOURCE);
  });

  test('manual rollback flips the pointer first and refreshes the view', async () => {
    const { rt } = createTestRuntime();
    const pendingVersion = await seedAndPropose(rt);
    const promo = await applyPromotionDecision(rt, present(getPendingScaffold(rt.storage.sql, rt.actor), 'the pending scaffold'), 'promote', new RunEventRecorder(rt.storage.sql, rt.actor));
    expect(promo.action).toBe('promote');

    const rb = await rollbackScaffold(rt, 0);
    expect(Result.isSuccess(rb)).toBe(true);

    expect(getCurrentScaffoldVersion(rt.storage.sql, rt.actor)).toBe(0);
    expect((rt.storage.sql<{ status: string }>`
      SELECT status FROM scaffold_versions
      WHERE actor_id = ${rt.actor.actorId} AND version = ${pendingVersion}`)[0]?.status)
      .toBe('rolled_back');
    expect(currentCount(rt)).resolves.toBe(1);
    expect(await rt.identity.scaffold.read()).toBe(INITIAL_SCAFFOLD_SOURCE);
    expect(await reopen(rt).identity.scaffold.read()).toBe(INITIAL_SCAFFOLD_SOURCE);
  });

  test('repeated promote/rollback cycles keep exactly one current pointer', async () => {
    const { rt } = createTestRuntime();
    await rt.storage.vfs.unlink(scaffoldVfsPath(rt, '.v0'));
    await bootstrapScaffold(rt);

    for (let i = 1; i <= 3; i++) {
      const code = `async function* run(rt, task) { yield "v${i}"; }`;
      const mod = await modifyScaffold(rt, `Cycle ${i} proposal carrying a rationale well past the gate.`, code);
      expect(mod.ok).toBe(true);

      if (i % 2 === 1) {
        const promo = await applyPromotionDecision(rt, present(getPendingScaffold(rt.storage.sql, rt.actor), 'the pending scaffold'), 'promote', new RunEventRecorder(rt.storage.sql, rt.actor));
        expect(promo.action).toBe('promote');
        expect(await reopen(rt).identity.scaffold.read()).toBe(code);
      } else {
        const rb = await applyPromotionDecision(rt, present(getPendingScaffold(rt.storage.sql, rt.actor), 'the pending scaffold'), 'rollback', new RunEventRecorder(rt.storage.sql, rt.actor));
        expect(rb.action).toBe('rollback');
      }

      expect(currentCount(rt)).resolves.toBe(1);
    }

    expect(getCurrentScaffoldVersion(rt.storage.sql, rt.actor)).toBe(3);
  });

  // core-rest review P1-3: a promotion named `pending - 1` as its predecessor, so after a rollback the journal said v2.
  test('a promotion after a rolled-back proposal names the version it replaced', async () => {
    const { rt } = createTestRuntime();
    await rt.storage.vfs.unlink(scaffoldVfsPath(rt, '.v0'));
    await bootstrapScaffold(rt);
    const events = new RunEventRecorder(rt.storage.sql, rt.actor);

    const decide = async (index: number, decision: 'promote' | 'rollback') => {
      const code = `async function* run(rt, task) { yield "v${String(index)}"; }`;
      expect((await modifyScaffold(rt, `Proposal ${String(index)} carrying a rationale well past the gate.`, code)).ok).toBe(true);

      return await applyPromotionDecision(rt, present(getPendingScaffold(rt.storage.sql, rt.actor), 'the pending scaffold'), decision, events);
    };

    await decide(1, 'promote');
    await decide(2, 'rollback');
    const third = await decide(3, 'promote');

    expect(third).toMatchObject({ action: 'promote', fromVersion: 1, newCurrentVersion: 3 });
    expect(events.read(WORKSPACE_RUN_ID).flatMap((event) => (event.type === 'scaffold_promotion' ? [[event.fromVersion, event.toVersion]] : [])))
      .toEqual([[0, 1], [1, 3]]);
  });
});
