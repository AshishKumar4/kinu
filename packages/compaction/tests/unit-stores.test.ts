/** The real ports over shared storage primitives: the VFS transcript store's
 *  citable-path/write contract, the durable SQL compaction state (plan
 *  snapshot + prompt-token signal sharing one row without clobbering) and the
 *  archived-range index behind the navigation manifest. */

import { describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import {
  initWorkspaceSchema,
  type SqlExec,
  type SqlExecRow,
  type SqlExecutor,
  type SqlValue,
  type VFS,
} from '@kinu/core';
import {
  compactionTranscriptPath,
  createCompactionStateStore,
  createVfsTranscriptStore,
  type ArchiveRange,
  type PlanSnapshot,
} from '../src/index';

/** The compaction tables come from core's one workspace-schema list; a store
 *  test needs exactly those two tables, so it runs the same entry point. */
function initCompactionStateTable(db: Database): void {
  const exec: SqlExec = {
    exec(query, ...bindings) {
      const bound = bindings.map(sqliteBinding);
      const stmt = db.prepare<SqlExecRow, SQLQueryBindings[]>(query);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) {
        return { toArray: () => stmt.all(...bound) };
      }
      stmt.run(...bound);
      return { toArray: () => [] };
    },
  };
  initWorkspaceSchema({
    execRaw: (ddl) => db.exec(ddl),
    sql: sqliteSql(db),
    exec,
  });
}

function sqliteSql(db: Database): SqlExecutor {
  const sql: SqlExecutor = function <T = unknown>(
    strings: TemplateStringsArray,
    ...values: SqlValue[]
  ): T[] {
    const query = strings.reduce((acc, s, i) => acc + s + (i < values.length ? '?' : ''), '');
    const bound = values.map(sqliteBinding);
    const stmt = db.prepare<T, SQLQueryBindings[]>(query);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return stmt.all(...bound);
    stmt.run(...bound);
    return [];
  };
  return sql;
}

function sqliteBinding(value: SqlValue): SQLQueryBindings {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

function stateRig() {
  const db = new Database(':memory:');
  initCompactionStateTable(db);
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
interface MemoryVfs {
  vfs: VFS;
  files: Map<string, string>;
}

function memoryVfs(): MemoryVfs {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const vfs: VFS = {
    readFile: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile: async (path, data) => {
      files.set(path, data instanceof Uint8Array ? new TextDecoder().decode(data) : data);
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
      '.proteus/compaction/my-agent/deadbeef.md',
    );
    expect(compactionTranscriptPath('proteus-agent:session/../x', 'h#1')).toBe(
      '.proteus/compaction/proteus-agent_session_.._x/h_1.md',
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
    expect(citablePath('s', 'h')).toBe('.proteus/compaction/s/h.md');
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

  // A plan_json that is not JSON is corruption of our own persisted state, not
  // an absent plan: returning null told the caller "no plan yet", so the row
  // stayed corrupt and every load silently re-planned from scratch.
  test('a corrupt plan_json row surfaces instead of reading as no plan', () => {
    const { db, store } = stateRig();
    db.prepare(`INSERT INTO compaction_state (session_key, plan_json) VALUES ('s1', 'not json')`).run();
    expect(() => store.plans.load('s1')).toThrow(SyntaxError);
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
    initCompactionStateTable(db);
    const store = createCompactionStateStore(sqliteSql(db));
    expect(store.loadPromptTokens('legacy', 12)).toBe(5_000);
    expect(store.takeForceCompaction('legacy')).toBe(false);
    store.armForceCompaction('legacy');
    expect(store.takeForceCompaction('legacy')).toBe(true);
  });
});

describe('archive index', () => {
  const range = (overrides: Partial<ArchiveRange> = {}): ArchiveRange => ({
    rangeHash: 'h1',
    path: compactionTranscriptPath('s1', 'h1'),
    startTurn: 1,
    endTurn: 12,
    userTurns: 6,
    assistantTurns: 6,
    firstUserAsk: 'port the auth refresh',
    ...overrides,
  });

  test('ranges round-trip in turn order, per session', () => {
    const { store } = stateRig();
    expect(store.archive.list('s1')).toEqual([]);
    const second = range({ rangeHash: 'h2', startTurn: 13, endTurn: 18, userTurns: 3, assistantTurns: 3 });
    // Appended out of order — the index reads back by span, not by insertion.
    store.archive.append('s1', second);
    store.archive.append('s1', range());
    store.archive.append('s2', range({ firstUserAsk: 'another session' }));
    expect(store.archive.list('s1')).toEqual([range(), second]);
    expect(store.archive.list('s2')[0].firstUserAsk).toBe('another session');
  });

  test('re-appending the same range is a no-op, and clearing is per session', () => {
    const { store } = stateRig();
    store.archive.append('s1', range());
    store.archive.append('s1', range({ firstUserAsk: 'a later rewrite of the same hash' }));
    expect(store.archive.list('s1')).toEqual([range()]);

    store.archive.append('s2', range());
    store.archive.clear('s1');
    expect(store.archive.list('s1')).toEqual([]);
    expect(store.archive.list('s2')).toHaveLength(1);
  });

  test('the index survives a session whose plan and token signal were cleared', () => {
    const { store } = stateRig();
    store.archive.append('s1', range());
    store.plans.save('s1', snapshot('s1'));
    store.plans.save('s1', null);
    expect(store.archive.list('s1')).toEqual([range()]);
  });
});
