/**
 * A non-replayable optimisation pass (scaffold and prompt passes touch the live tool surface) runs at
 * most once per tick: a pass cut mid-run is abandoned to the next tick, never re-run, and never lost.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestActors } from '@kinu.run/test-utils';
import { initEffectTombstoneTable, oncePerTick } from '../src/identity/effect-tombstones';
import { createRecordingLogger, setDiagnosticsSink } from '../src/obs/index';
import { makeExecRaw, makeSql } from './helpers';

const LANE = 'probe_lane';

function lane() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const actor = createTestActors(sql, execRaw).main;
  initEffectTombstoneTable(execRaw);

  const once = (tick: string | undefined, pass: () => Promise<void>): Promise<void> =>
    oncePerTick(sql, actor, { scope: LANE, tick, workspace: 'quiet-maple' }, pass);

  const markers = (): number => sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM effect_tombstones WHERE actor_id = ${actor.actorId} AND scope = ${LANE}`[0]?.n ?? -1;

  return { once, markers };
}

describe('a pass keyed on a tick', () => {
  test('a cut pass is abandoned, not re-run; a new tick is a new obligation', async () => {
    const { once } = lane();
    const log = createRecordingLogger();
    let runs = 0;

    await expect(once('tick-1', async () => {
      runs++;
      await Promise.reject(new Error('the isolate went away mid-rollout'));
    })).rejects.toThrow('the isolate went away mid-rollout');
    expect(runs).toBe(1);

    const restore = setDiagnosticsSink(log);

    try {
      await once('tick-1', async () => { runs++; await Promise.resolve(); });
    } finally {
      restore();
    }

    expect(runs).toBe(1);
    expect(log.emitted.map((line) => [line.event, line.fields])).toEqual([
      ['evolution.interrupted_pass_abandoned', { workspace: 'quiet-maple', lane: LANE, tick: 'tick-1' }],
    ]);

    // The abandonment closed the tick: a third attempt is a plain no-op.
    await once('tick-1', async () => { runs++; await Promise.resolve(); });
    expect(runs).toBe(1);

    // Delayed, never dropped.
    await once('tick-2', async () => { runs++; await Promise.resolve(); });
    expect(runs).toBe(2);
  });

  /**
   * The marker is written in the same synchronous slice as the call; an earlier marker would let a
   * cut abandon a tick that never ran, and an idle workspace has no later carrier for it.
   */
  test('the tick marker says entered, not armed', async () => {
    const { once, markers } = lane();
    let markersWhenPassStarted = -1;

    await once('tick-1', async () => {
      markersWhenPassStarted = markers();
      await Promise.resolve();
    });

    expect(markersWhenPassStarted).toBe(0);
    expect(markers()).toBe(2);
  });

  test('a pass with no tick runs every time and keys nothing', async () => {
    const { once, markers } = lane();
    let runs = 0;

    await once(undefined, async () => { runs++; await Promise.resolve(); });
    await once(undefined, async () => { runs++; await Promise.resolve(); });

    expect(runs).toBe(2);
    expect(markers()).toBe(0);
  });
});
