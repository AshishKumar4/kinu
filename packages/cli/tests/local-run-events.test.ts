import { scratchDir } from '../../test-utils/src/scratch';
import { mkdirSync } from 'node:fs';

import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { initRunEventTables, parseJsonValue, type JsonObject, type JsonValue } from '@kinu.run/core';
import { makeSql } from '@kinu.run/cli-backend';
import { createTestActor } from '../../core/tests/helpers';

const repoRoot = resolve(__dirname, '../../..');

function readLocal(expression: string): JsonValue {
  const home = scratchDir('run-events');
  mkdirSync(join(home, 'jarvis'), { recursive: true });
  const db = new Database(join(home, 'jarvis', 'agent.db'));
  const execRaw = (ddl: string) => { db.exec(ddl); };

  initRunEventTables(execRaw);
  // `run_events` is scoped by the store's main actor, so the seed registers a real workspace identity.
  const actor = createTestActor(makeSql(db), execRaw, 'run-events-workspace', 'jarvis');

  const row = (index: number, type: string, extra: JsonObject = {}) => {
    const ts = new Date(1_700_000_000_000 + index * 1000).toISOString();
    const payload = { ...extra, type, eventIndex: index, runId: 'run-1', timestamp: ts };
    db.query(`INSERT INTO run_events (actor_id, run_id, event_index, type, payload, ts)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(actor.actorId, 'run-1', index, type, JSON.stringify(payload), ts);
  };

  row(0, 'run_start', { agentId: 'jarvis', caused_by: 'chat', userMessage: 'hi' });
  row(1, 'tool_call_end', { name: 'shell', toolCallId: 'tc-1', result: 'ok' });
  row(2, 'run_end', { reason: 'completed' });
  db.close();

  const script =
    `import * as m from './packages/cli/src/local-inspection.ts';` +
    `console.log(JSON.stringify(${expression}));`;

  const proc = Bun.spawnSync({
    cmd: [process.execPath, '-e', script],
    cwd: repoRoot,
    env: { ...process.env, KINU_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());

  return parseJsonValue(proc.stdout.toString());
}

describe('local run-event readers', () => {
  test('listLocalRuns reports the recorded run', () => {
    expect(readLocal(`m.listLocalRuns('jarvis')`)).toEqual([
      { runId: 'run-1', lastTs: new Date(1_700_000_000_000 + 2 * 1000).toISOString(), eventCount: 3 },
    ]);
  });

  test('listLocalRunEvents replays a run, and `since` replays only the tail', () => {
    expect(readLocal(`m.listLocalRunEvents('jarvis', 'run-1').map(e => e.type)`))
      .toEqual(['run_start', 'tool_call_end', 'run_end']);
    expect(readLocal(`m.listLocalRunEvents('jarvis', 'run-1', { since: 2 }).map(e => e.type)`))
      .toEqual(['run_end']);
  });

  test('the local timeline leads with the durable run events', () => {
    expect(readLocal(`m.listLocalTimeline('jarvis').map(r => r.kind)`))
      .toEqual(['run:run_end', 'run:tool_call_end', 'run:run_start']);
  });
});
