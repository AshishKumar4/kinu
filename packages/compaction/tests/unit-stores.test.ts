/** The real ports over shared storage primitives: the VFS transcript store's
 *  citable-path/write contract and the durable SQL compaction state (plan
 *  snapshot + prompt-token signal sharing one row without clobbering). */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { SqlExecutor, SqlValue, VFS } from '@proteus/core';
import {
  compactionTranscriptPath,
  createCompactionStateStore,
  createVfsTranscriptStore,
  initCompactionStateTable,
  type PlanSnapshot,
} from '../src/index.js';

function sqliteSql(db: Database): SqlExecutor {
  return (<T = unknown>(strings: TemplateStringsArray, ...values: SqlValue[]): T[] => {
    const query = strings.reduce((acc, s, i) => acc + s + (i < values.length ? '?' : ''), '');
    const stmt = db.prepare(query);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return stmt.all(...(values as never[])) as T[];
    stmt.run(...(values as never[]));
    return [];
  }) as SqlExecutor;
}

function stateRig() {
  const db = new Database(':memory:');
  initCompactionStateTable((ddl) => db.exec(ddl));
  return { db, store: createCompactionStateStore(sqliteSql(db)) };
}

function snapshot(sessionId: string): PlanSnapshot {
  return {
    sessionId,
    rangeHash: 'abc123',
    contextLimit: 10_000,
    rawTailStartMessageId: 'm-9',
    transcriptRelativePath: compactionTranscriptPath(sessionId, 'abc123'),
    beforeTokens: 9_000,
    afterPruneTokens: 3_000,
    overheadTokens: 500,
    triggerTokens: 8_500,
    targetTokens: 3_000,
    requiresCustomCompaction: false,
    createdAt: Date.now(),
  };
}

/** Map-backed VFS that surfaces EEXIST on repeat mkdir, like real backends can. */
function memoryVfs(): { vfs: VFS; files: Map<string, string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const vfs: VFS = {
    readFile: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile: async (path, data) => {
      files.set(path, String(data));
    },
    readdir: async () => [],
    stat: async () => null,
    unlink: async (path) => {
      files.delete(path);
    },
    mkdir: async (path) => {
      if (dirs.has(path)) throw new Error(`EEXIST: directory exists ${path}`);
      dirs.add(path);
    },
    exists: async (path) => files.has(path) || dirs.has(path),
  };
  return { vfs, files };
}

describe('compactionTranscriptPath', () => {
  test('lives under the hidden /local compaction dir and sanitizes hostile segments', () => {
    expect(compactionTranscriptPath('my-agent', 'deadbeef')).toBe(
      '/local/.proteus/compaction/my-agent/deadbeef.md',
    );
    expect(compactionTranscriptPath('proteus-agent:session/../x', 'h#1')).toBe(
      '/local/.proteus/compaction/proteus-agent_session_.._x/h_1.md',
    );
  });
});

describe('createVfsTranscriptStore', () => {
  test('creates the parent directory, writes the transcript, and the citable path reads back', async () => {
    const { vfs, files } = memoryVfs();
    const store = createVfsTranscriptStore(() => vfs);
    const path = store.citablePath('agent-a', 'hash1');
    const { absolutePath } = await store.write(path, '# transcript');
    expect(absolutePath).toBe(path);
    expect(files.get(path)).toBe('# transcript');
    expect(await vfs.readFile(path)).toBe('# transcript');
  });

  test('citablePath survives unbound invocation (the engine passes it around bare)', () => {
    const { citablePath } = createVfsTranscriptStore(() => memoryVfs().vfs);
    expect(citablePath('s', 'h')).toBe('/local/.proteus/compaction/s/h.md');
  });

  test('a second write into the same directory tolerates mkdir EEXIST', async () => {
    const { vfs } = memoryVfs();
    const store = createVfsTranscriptStore(() => vfs);
    await store.write(store.citablePath('a', 'h1'), 'one');
    await store.write(store.citablePath('a', 'h2'), 'two');
    expect(await vfs.readFile(store.citablePath('a', 'h2'))).toBe('two');
  });
});

describe('createCompactionStateStore', () => {
  test('plan snapshots round-trip through the durable row', () => {
    const { store } = stateRig();
    expect(store.plans.load('s1')).toBeNull();
    const snap = snapshot('s1');
    store.plans.save('s1', snap);
    expect(store.plans.load('s1')).toEqual(snap);
  });

  test('save(null) clears a stale plan but keeps the prompt-token signal', () => {
    const { store } = stateRig();
    store.savePromptTokens('s1', 12_345, 30);
    store.plans.save('s1', snapshot('s1'));
    store.plans.save('s1', null);
    expect(store.plans.load('s1')).toBeNull();
    expect(store.loadPromptTokens('s1', 30)).toBe(12_345);
  });

  test('prompt-token updates never clobber the stored plan', () => {
    const { store } = stateRig();
    const snap = snapshot('s1');
    store.plans.save('s1', snap);
    store.savePromptTokens('s1', 9_000, 30);
    store.savePromptTokens('s1', 11_000, 33);
    expect(store.plans.load('s1')).toEqual(snap);
    expect(store.loadPromptTokens('s1', 33)).toBe(11_000);
  });

  test('a shrunken history voids the measurement; regrowth past it revalidates', () => {
    const { store } = stateRig();
    store.savePromptTokens('s1', 200_000, 120);
    expect(store.loadPromptTokens('s1', 121)).toBe(200_000); // grew — valid
    expect(store.loadPromptTokens('s1', 120)).toBe(200_000); // exact — valid
    // Restart truncation / undo: the history this measured no longer exists.
    expect(store.loadPromptTokens('s1', 41)).toBeNull();
    // A fresh measurement over the shrunken stream re-arms the signal.
    store.savePromptTokens('s1', 3_000, 41);
    expect(store.loadPromptTokens('s1', 41)).toBe(3_000);
  });

  test('sessions are isolated and invalid token values are ignored', () => {
    const { store } = stateRig();
    store.savePromptTokens('s1', 100, 10);
    store.savePromptTokens('s2', 0, 10);
    store.savePromptTokens('s3', Number.NaN, 10);
    expect(store.loadPromptTokens('s1', 10)).toBe(100);
    expect(store.loadPromptTokens('s2', 10)).toBeNull();
    expect(store.loadPromptTokens('s3', 10)).toBeNull();
    expect(store.loadPromptTokens('missing', 10)).toBeNull();
  });

  test('a corrupt plan_json row degrades to null instead of throwing', () => {
    const { db, store } = stateRig();
    db.prepare(`INSERT INTO compaction_state (session_key, plan_json) VALUES ('s1', 'not json')`).run();
    expect(store.plans.load('s1')).toBeNull();
  });

  test('force-compaction arms once and is consumed exactly once (never loops)', () => {
    const { store } = stateRig();
    expect(store.takeForceCompaction('s1')).toBe(false);
    store.armForceCompaction('s1');
    expect(store.takeForceCompaction('s1')).toBe(true);
    expect(store.takeForceCompaction('s1')).toBe(false);
    // Sessions are isolated.
    store.armForceCompaction('s1');
    expect(store.takeForceCompaction('s2')).toBe(false);
    expect(store.takeForceCompaction('s1')).toBe(true);
  });

  test('arming force-compaction never clobbers the plan or the token signal', () => {
    const { store } = stateRig();
    const snap = snapshot('s1');
    store.plans.save('s1', snap);
    store.savePromptTokens('s1', 9_000, 30);
    store.armForceCompaction('s1');
    expect(store.plans.load('s1')).toEqual(snap);
    expect(store.loadPromptTokens('s1', 30)).toBe(9_000);
    expect(store.takeForceCompaction('s1')).toBe(true);
    expect(store.plans.load('s1')).toEqual(snap);
    expect(store.loadPromptTokens('s1', 30)).toBe(9_000);
  });

  test('a pre-overflow-recovery table gains the flag column on init', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE compaction_state (
      session_key        TEXT PRIMARY KEY,
      plan_json          TEXT,
      last_prompt_tokens INTEGER,
      measured_at_length INTEGER
    )`);
    db.prepare(`INSERT INTO compaction_state (session_key, last_prompt_tokens, measured_at_length)
                VALUES ('legacy', 5000, 12)`).run();
    initCompactionStateTable((ddl) => db.exec(ddl));
    const store = createCompactionStateStore(sqliteSql(db));
    expect(store.loadPromptTokens('legacy', 12)).toBe(5_000);
    expect(store.takeForceCompaction('legacy')).toBe(false);
    store.armForceCompaction('legacy');
    expect(store.takeForceCompaction('legacy')).toBe(true);
  });
});
