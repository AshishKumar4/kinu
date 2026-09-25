/** SOUL.md and its mission row cannot drift: `writeSoul` is the only writer of either. */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  readSoul, readMission, writeSoul, seedSoul, summarizeSoul, summarizeSoulBytes, SOUL_PATH,
} from '../src/identity/soul';
import { initAllTables } from '../src/state/workspace-schema';
import { createWorkspace } from '../src/workspace-birth';
import { makeSql, makeExecRaw, createWorkspaceBundle } from './helpers';

const TEST_LLM = { name: 'test', baseURL: 'http://localhost:0', headers: {}, model: 'test-model' };

function freshWorkspace() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initAllTables(makeExecRaw(db), makeSql(db));
  void sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'W'}, ${'atlas'}, ${100})`;

  return { db, sql, vfs: createWorkspaceBundle(db).vfs };
}

describe('the soul is a file', () => {
  test('writeSoul round-trips through the workspace filesystem', async () => {
    const { sql, vfs } = freshWorkspace();
    await writeSoul(vfs, sql, '# Atlas\n\n## Mission\n\nHelp with testing.');

    expect(await readSoul(vfs)).toBe('# Atlas\n\n## Mission\n\nHelp with testing.');
    expect(await vfs.readFile(SOUL_PATH, { encoding: 'utf8' })).toContain('Help with testing.');
  });

  test('a workspace with no soul reads as null rather than throwing', async () => {
    const { vfs } = freshWorkspace();
    expect(await readSoul(vfs)).toBeNull();
  });

  test('an empty document is no document', async () => {
    const { sql, vfs } = freshWorkspace();
    await writeSoul(vfs, sql, '   \n  ');
    expect(await readSoul(vfs)).toBeNull();
  });

  test('a host-owned writer can protect the file without duplicating mission updates', async () => {
    const { sql, vfs } = freshWorkspace();
    const writes: Array<{ path: string; content: string }> = [];
    const content = '# Atlas\n\n## Mission\n\nsecond mission';

    await writeSoul(vfs, sql, content, async (path, markdown) => {
      writes.push({ path, content: markdown });
      await vfs.writeFile(path, markdown);
    });

    expect(writes).toEqual([{ path: SOUL_PATH, content }]);
    expect(await readSoul(vfs)).toBe(content);
    expect(readMission(sql)).toBe('second mission');
  });
});

describe('the mission a read-only listing reads', () => {
  test('writeSoul maintains it, so the row cannot drift from the document', async () => {
    const { sql, vfs } = freshWorkspace();
    await writeSoul(vfs, sql, '# Atlas\n\n## Mission\n\nHelp with testing.');

    expect(readMission(sql)).toBe('Help with testing.');
    expect(readMission(sql)).toBe(summarizeSoul(await readSoul(vfs)));
  });

  test('it is readable without opening a filesystem — the point of it existing', async () => {
    const { db, sql, vfs } = freshWorkspace();
    await seedSoul(vfs, sql, { name: 'atlas', mission: 'ship the thing' });

    // A handle with no workspace filesystem, as `kinu list` has, so a listing never writes.
    const listing = makeSql(db);
    expect(readMission(listing)).toBe('ship the thing');
  });

  test('a workspace whose soul was never written reports no mission', () => {
    const { sql } = freshWorkspace();
    expect(readMission(sql)).toBeNull();
  });
});

describe('workspace birth', () => {
  test('createWorkspace seeds a readable soul and a matching mission', async () => {
    const db = new Database(':memory:');

    const rt = await createWorkspace(db, {
      name: 'atlas', purpose: 'Help with testing.', llm: TEST_LLM,
    });

    const identity = makeSql(db)<{ name: string }>`SELECT name FROM workspace_identity LIMIT 1`[0];
    expect(identity?.name).toBe('atlas');
    expect(await readSoul(rt.storage.vfs)).toContain('Help with testing.');
    expect(readMission(makeSql(db))).toBe('Help with testing.');
  });

  test('the seeds are real files the agent can read back', async () => {
    const db = new Database(':memory:');

    const rt = await createWorkspace(db, {
      name: 'quiet-harbor-1a4e20', title: 'Atlas', purpose: 'Help with testing.', llm: TEST_LLM,
    });

    expect(await rt.storage.vfs.readFile('scaffold/agent.js', { encoding: 'utf8' })).toContain('async');
    expect(await rt.storage.vfs.readFile('memory/MEMORY.md', { encoding: 'utf8' })).toContain('Atlas');
  });

  /** `name` is the address and `title` is the name; a workspace is born untitled. */
  test('the documents a model reads are headed by the title, never by the slug', async () => {
    const titled = await createWorkspace(new Database(':memory:'), {
      name: 'quiet-harbor-1a4e20', title: 'Callback Audit', purpose: 'Audit it.', llm: TEST_LLM,
    });

    expect(await readSoul(titled.storage.vfs)).toStartWith('# Callback Audit');

    const untitled = await createWorkspace(new Database(':memory:'), {
      name: 'quiet-harbor-1a4e20', purpose: 'Audit it.', llm: TEST_LLM,
    });

    const soul = await readSoul(untitled.storage.vfs) ?? '';
    expect(soul).toStartWith('# Kinu');
    expect(soul).not.toContain('quiet-harbor-1a4e20');
    expect(await untitled.storage.vfs.readFile('memory/MEMORY.md', { encoding: 'utf8' }))
      .not.toContain('quiet-harbor-1a4e20');
  });
});

describe('the mission of a document that is still bytes', () => {
  // Includes the chunked-scan edge cases: missions past or split across the scan boundary.
  const filler = (bytes: number): string => 'filler line\n'.repeat(Math.ceil(bytes / 12));

  const documents = {
    'the shape every SOUL is written in': '# Atlas\n\n## Mission\n\nHelp with testing.\n',
    'a mission far past a fixed prefix': `# Atlas\n\n${filler(96 * 1024)}\n## Mission\n\nHelp late in the file.\n`,
    'a mission straddling the scan boundary': `# Atlas\n\n## Mission\n\n${filler(64 * 1024)}the tail of the mission\n`,
    'a multi-byte character on the scan boundary': `# Atlas\n\n## Mission\n\n${'é'.repeat(32 * 1024)}\n`,
    'an empty mission section': '# Atlas\n\n## Mission\n\n## Notes\n\nThe fallback line.\n',
    'no mission heading at all': '# Atlas\n\nJust a line.\n',
    'one enormous line': `# Atlas\n\n## Mission\n\n${'word '.repeat(64 * 1024)}`,
    'a mission indented past anything a scan could keep': `# A\n\n## Mission\n\n${' '.repeat(1000)}actual`,
    'a heading behind a wall of whitespace': `# A\n\n${' '.repeat(4096)}## Mission\n\nfound anyway\n`,
    'a single mission line of several megabytes': `# A\n\n## Mission\n\n${'long '.repeat(512 * 1024)}\n`,
    'nothing at all': '',
  } satisfies Record<string, string>;

  for (const [document, soul] of Object.entries(documents)) {
    test(`reads what the whole-document form reads: ${document}`, () => {
      expect(summarizeSoulBytes(new TextEncoder().encode(soul))).toBe(summarizeSoul(soul));
    });
  }

  test('the mission is the one a late heading declares, not a truncated prefix', () => {
    const soul = `# Atlas\n\n${filler(96 * 1024)}\n## Mission\n\nHelp late in the file.\n`;
    expect(summarizeSoulBytes(new TextEncoder().encode(soul))).toBe('Help late in the file.');
  });
});
