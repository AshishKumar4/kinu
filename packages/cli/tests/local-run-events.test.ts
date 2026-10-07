import { createTestActorsOver, runToExit, workspaceDatabase } from '@kinu.run/test-utils';
import { scratchDir } from '../../test-utils/src/scratch';
import { mkdirSync } from 'node:fs';

import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { initWorkspaceSchema, parseJsonValue, type JsonObject, type JsonValue } from '@kinu.run/core';
import { makeWorkspaceSchemaSql, stampSchemaGenesis } from '@kinu.run/cli-backend';

const repoRoot = resolve(__dirname, '../../..');

async function readLocal(expression: string): Promise<JsonValue> {
  const home = scratchDir('run-events');
  mkdirSync(join(home, 'jarvis'), { recursive: true });
  const db = workspaceDatabase(join(home, 'jarvis', 'agent.db'));

  // A workspace as `kinu create` leaves one: the whole schema, and `run_events` scoped by its main actor.
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const actor = createTestActorsOver(db, { name: 'jarvis' }).main;
  stampSchemaGenesis(db);

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

  const proc = await runToExit([process.execPath, '-e', script], {
    cwd: repoRoot,
    env: { ...process.env, KINU_HOME: home },
  });

  if (proc.exitCode !== 0) throw new Error(proc.stderr);

  return parseJsonValue(proc.stdout);
}

describe('local run-event readers', () => {
  test('listLocalRuns reports the recorded run', async () => {
    expect(await readLocal(`m.listLocalRuns('jarvis')`)).toEqual([
      { runId: 'run-1', lastTs: new Date(1_700_000_000_000 + 2 * 1000).toISOString(), eventCount: 3 },
    ]);
  });

  test('listLocalRunEvents replays a run, and `since` replays only the tail', async () => {
    expect(await readLocal(`m.listLocalRunEvents('jarvis', 'run-1').map(e => e.type)`))
      .toEqual(['run_start', 'tool_call_end', 'run_end']);
    expect(await readLocal(`m.listLocalRunEvents('jarvis', 'run-1', { since: 2 }).map(e => e.type)`))
      .toEqual(['run_end']);
  });

  // The cloud's shape (core's `getRunTimeline`): one span per event, oldest first, each labelled.
  test('the local timeline is the run\'s durable events as spans, oldest first', async () => {
    expect(await readLocal(`m.listLocalTimeline('jarvis').map(r => [r.rawType, r.kind, r.label])`)).toEqual([
      ['run_start', 'trigger', expect.stringContaining('Run started')],
      ['tool_call_end', 'runtime-exec', 'shell'],
      ['run_end', 'other', 'Run ended (completed)'],
    ]);
  });
});
