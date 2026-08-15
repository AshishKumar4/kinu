// The local reader for the durable run-event log. cf serves runs + their
// events over RPC (listRuns / getRunEvents) and folds them into the Run
// Timeline spine; locally there was no run_events table at all, so a local
// workspace had no run history to read. These cover the CLI's readers over a
// throwaway PROTEUS_HOME — never the owner's real ~/.proteus.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { parseJsonValue, type JsonObject, type JsonValue } from '@proteus/core';

const tempDirs: string[] = [];
const repoRoot = resolve(__dirname, '../../..');

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Seed an agent.db carrying a recorded run, then read it back through the
 *  CLI's local-inspection module in a child process pinned to that home. */
function readLocal(expression: string): JsonValue {
  const home = mkdtempSync(join(tmpdir(), 'proteus-run-events-'));
  tempDirs.push(home);
  mkdirSync(join(home, 'jarvis'), { recursive: true });
  const db = new Database(join(home, 'jarvis', 'agent.db'));
  db.exec(`CREATE TABLE run_events (
    run_id TEXT NOT NULL, event_index INTEGER NOT NULL, type TEXT NOT NULL,
    payload TEXT NOT NULL, ts TEXT NOT NULL, PRIMARY KEY (run_id, event_index))`);
  const row = (index: number, type: string, extra: JsonObject = {}) => {
    const ts = new Date(1_700_000_000_000 + index * 1000).toISOString();
    const payload = { ...extra, type, eventIndex: index, runId: 'run-1', timestamp: ts };
    db.query(`INSERT INTO run_events VALUES (?, ?, ?, ?, ?)`)
      .run('run-1', index, type, JSON.stringify(payload), ts);
  };
  row(0, 'run_start', { agentId: 'jarvis', caused_by: 'chat', userMessage: 'hi' });
  row(1, 'tool_call_end', { name: 'run', toolCallId: 'tc-1', result: 'ok' });
  row(2, 'run_end', { reason: 'completed' });
  db.close();

  const script =
    `import * as m from './packages/cli/src/local-inspection.ts';` +
    `console.log(JSON.stringify(${expression}));`;
  const proc = Bun.spawnSync({
    cmd: [process.execPath, '-e', script],
    cwd: repoRoot,
    env: { ...process.env, PROTEUS_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return parseJsonValue(proc.stdout.toString());
}

describe('local run-event readers', () => {
  test('listLocalRuns reports the recorded run', () => {
    expect(readLocal(`m.listLocalRuns('jarvis')`)).toEqual([
      { runId: 'run-1', lastTs: expect.any(String), eventCount: 3 },
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
