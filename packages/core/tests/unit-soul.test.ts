/** SOUL.md and its mission row cannot drift: `writeSoul` is the only writer of either. */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  readSoul, readMission, writeSoul, seedSoul, summarizeSoul, summarizeSoulBytes, SOUL_PATH,
} from '../src/identity/soul';
import { initAllTables } from '../src/state/workspace-schema';
import { createWorkspace } from '../src/workspace-birth';
import { makeSql, makeExecRaw, createWorkspaceBundle } from './helpers';
import { writeWorkspaceSoul } from '../src/vfs/workspace-planes';

const TEST_LLM = { name: 'test', baseURL: 'http://localhost:0', headers: {}, model: 'test-model' };

function freshWorkspace() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initAllTables(makeExecRaw(db), makeSql(db));
  void sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'W'}, ${'atlas'}, ${100})`;

  const bundle = createWorkspaceBundle(db);

  return { db, sql, vfs: bundle.vfs, seal: (content: string) => writeWorkspaceSoul(bundle, content) };
}

describe('the soul is a file', () => {
  test('writeSoul round-trips through the workspace filesystem', async () => {
    const { sql, vfs, seal } = freshWorkspace();
    await writeSoul(sql, '# Atlas\n\n## Mission\n\nHelp with testing.', seal);

    expect(await readSoul(vfs)).toBe('# Atlas\n\n## Mission\n\nHelp with testing.');
    expect(await vfs.readFile(SOUL_PATH, { encoding: 'utf8' })).toContain('Help with testing.');
  });

  test('an unborn workspace reads as no soul rather than throwing', async () => {
    const db = new Database(':memory:');
    initAllTables(makeExecRaw(db), makeSql(db));
    expect(await readSoul(createWorkspaceBundle(db).vfs)).toBeNull();
  });

  test('an empty document is no document', async () => {
    const { sql, vfs, seal } = freshWorkspace();
    await writeSoul(sql, '   \n  ', seal);
    expect(await readSoul(vfs)).toBeNull();
  });


});

describe('the mission a read-only listing reads', () => {
  test('writeSoul maintains it, so the row cannot drift from the document', async () => {
    const { sql, vfs, seal } = freshWorkspace();
    await writeSoul(sql, '# Atlas\n\n## Mission\n\nHelp with testing.', seal);

    expect(readMission(sql)).toBe('Help with testing.');
    expect(readMission(sql)).toBe(summarizeSoul(await readSoul(vfs)));
  });

  test('it is readable without opening a filesystem — the point of it existing', async () => {
    const { db, sql, seal } = freshWorkspace();
    await seedSoul(sql, { name: 'atlas', mission: 'ship the thing' }, seal);

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
