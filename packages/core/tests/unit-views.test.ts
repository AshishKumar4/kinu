/**
 * Views — the contract the model and the renderer both depend on.
 *
 * These assert what a spec is allowed to SAY and what storing one does, not how
 * the parser is factored. The security-shaped cases are first-class here: the
 * whole argument for letting the agent add UI is that this vocabulary is closed,
 * so a test that only covers the happy path would be testing the wrong thing.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { makeSql } from './helpers';
import {
  RESERVED_VIEW_TITLES, VIEW_DATA_SOURCES, VIEW_LIMITS,
  createView, deleteView, initViewTables, listViewVersions, listViews, parseViewSpec,
  readView, resolveViewPath, revertView, viewSlug,
} from '../src/views/index';
import type { VFS } from '../src/types/primitives';

// ── fixtures ────────────────────────────────────────────────────────────────

interface ViewSpecInput {
  v: number;
  title: string;
  blocks: object[];
  refreshMs?: number;
}

const validSpec = (overrides: Partial<ViewSpecInput> = {}): ViewSpecInput => ({
  v: 1, title: 'Deploy health', blocks: [
    { type: 'stat', label: 'Open changes', source: { rpc: 'getReleaseBoard', path: 'changes' }, agg: 'count' },
    {
      type: 'table',
      source: { rpc: 'getReleaseBoard', path: 'changes', limit: 20 },
      columns: [{ field: 'status', label: 'Status', as: 'badge' }],
    },
  ],
  ...overrides,
});

function memoryVfs(): VFS {
  const files = new Map<string, string>();
  return {
    readFile: async (path) => {
      const hit = files.get(path);
      if (hit === undefined) throw new Error(`ENOENT: ${path}`);
      return hit;
    },
    writeFile: async (path, data) => {
      if (v.is(v.string(), data)) files.set(path, data);
      else files.set(path, new TextDecoder().decode(data));
    },
    readdir: async (path) => [...files.keys()].filter((f) => f.startsWith(`${path}/`)),
    stat: async (path) => {
      const data = files.get(path);
      return data === undefined ? null : { size: data.length, mtimeMs: 0, isDir: false };
    },
    unlink: async (path) => { files.delete(path); },
    mkdir: async () => {},
    exists: async (path) => files.has(path),
  };
}

function store() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initViewTables((ddl: string) => { db.exec(ddl); });
  return { vfs: memoryVfs(), sql, db };
}

// ── the vocabulary is closed ────────────────────────────────────────────────

describe('view spec — what a view may say', () => {
  test('accepts a dashboard built from the documented blocks', () => {
    const out = parseViewSpec(validSpec());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.spec.blocks).toHaveLength(2);
  });

  test('refuses a data source that is not on the allowlist', () => {
    const out = parseViewSpec(validSpec({
      blocks: [{ type: 'stat', label: 'x', source: { rpc: 'destroyAgent' } }],
    }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain('unknown data source');
  });

  test('refuses a consent or approval source even though it is a getter', () => {
    // listPendingConsents is workspace.read and callable; it is off the list on
    // purpose, and the schema is what enforces that rather than a review.
    for (const rpc of ['listPendingConsents', 'sampleOutcomeLabeling', 'decideReleaseApproval']) {
      const out = parseViewSpec(validSpec({
        blocks: [{ type: 'list', source: { rpc } }],
      }));
      expect(out.ok).toBe(false);
    }
    expect(new Set<string>(VIEW_DATA_SOURCES).has('listPendingConsents')).toBe(false);
  });

  test('refuses block types that do not exist, rather than dropping them', () => {
    for (const block of [
      { type: 'html', html: '<img src=x onerror=alert(1)>' },
      { type: 'script', src: 'https://evil.example/x.js' },
      { type: 'iframe', url: 'https://evil.example' },
      { type: 'button', label: 'Approve', action: 'decideReleaseApproval' },
      { type: 'image', url: 'https://evil.example/pixel.gif' },
      { type: 'link', href: 'javascript:alert(1)', label: 'Approve' },
    ]) {
      const out = parseViewSpec(validSpec({ blocks: [block] }));
      expect(out.ok).toBe(false);
    }
  });

  test('refuses unknown keys on a known block instead of stripping them', () => {
    const out = parseViewSpec(validSpec({
      blocks: [{ type: 'markdown', text: 'hi', onClick: 'approve()' }],
    }));
    expect(out.ok).toBe(false);
  });

  test('refuses a title that impersonates a host surface, in any casing or spacing', () => {
    for (const title of ['Releases', 'releases', 'R E L E A S E S', 'Approvals', 'Consent', 'Activity']) {
      const out = parseViewSpec(validSpec({ title }));
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.error).toContain('host owns');
    }
    expect(parseViewSpec(validSpec({ title: 'Release health' })).ok).toBe(true);
  });

  test('refuses a data path that walks the prototype chain', () => {
    for (const path of ['__proto__', 'constructor.prototype', 'a.__proto__.b', 'a[0]', 'a b']) {
      const out = parseViewSpec(validSpec({
        blocks: [{ type: 'stat', label: 'x', source: { rpc: 'getReleaseBoard', path } }],
      }));
      expect(out.ok).toBe(false);
    }
  });

  test('sections nest exactly one level, so the renderer cannot be made to recurse', () => {
    const nested = validSpec({
      blocks: [{
        type: 'section', title: 'Outer',
        blocks: [{ type: 'section', title: 'Inner', blocks: [{ type: 'markdown', text: 'x' }] }],
      }],
    });
    expect(parseViewSpec(nested).ok).toBe(false);
  });

  test('bounds the things the renderer has to walk', () => {
    const many = Array.from({ length: VIEW_LIMITS.blocks + 1 }, () => ({ type: 'markdown', text: 'x' }));
    expect(parseViewSpec(validSpec({ blocks: many })).ok).toBe(false);
    expect(parseViewSpec(validSpec({ refreshMs: 100 })).ok).toBe(false);
    expect(parseViewSpec(validSpec({ refreshMs: 15_000 })).ok).toBe(true);
    expect(parseViewSpec(validSpec({ title: 'x'.repeat(VIEW_LIMITS.titleChars + 1) })).ok).toBe(false);
  });

  test('names the failing field so the model can fix it in one shot', () => {
    const out = parseViewSpec(validSpec({
      blocks: [{ type: 'stat', label: 'x', source: { rpc: 'nope' } }],
    }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain('blocks.0.source.rpc');
  });

  test('every reserved title is stored folded, so the check cannot be spaced around', () => {
    for (const reserved of RESERVED_VIEW_TITLES) expect(reserved).toBe(reserved.toLowerCase());
  });
});

// ── path resolution ─────────────────────────────────────────────────────────

describe('view path resolution', () => {
  test('reads a dotted path and returns undefined rather than throwing on a miss', () => {
    const root = { a: { b: [1, 2, 3] } };
    expect(resolveViewPath(root, 'a.b')).toEqual([1, 2, 3]);
    expect(resolveViewPath(root, undefined)).toBe(root);
    expect(resolveViewPath(root, 'a.missing')).toBeUndefined();
    expect(resolveViewPath(null, 'a')).toBeUndefined();
  });

  test('refuses prototype rungs at read time too, not only at write time', () => {
    expect(resolveViewPath({ a: 1 }, '__proto__')).toBeUndefined();
    expect(resolveViewPath({ a: 1 }, 'constructor')).toBeUndefined();
    // Inherited properties are not own properties, so they do not resolve.
    const inherited: import('../src/utils/json').JsonObject = Object.create({ inherited: 'leak' });
    expect(resolveViewPath(inherited, 'inherited')).toBeUndefined();
  });
});

// ── storage ─────────────────────────────────────────────────────────────────

describe('view store', () => {
  test('publishes a view, lists it, and reads it back', async () => {
    const s = store();
    const made = await createView(s, 'Deploy Health!', validSpec());
    expect(made).toMatchObject({ ok: true, slug: 'deploy-health', version: 1, action: 'created' });

    expect(listViews(s.sql)).toEqual([
      expect.objectContaining({ slug: 'deploy-health', title: 'Deploy health', version: 1 }),
    ]);

    const read = await readView(s, 'deploy-health');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.spec.title).toBe('Deploy health');
  });

  test('accepts a spec handed over as a JSON string', async () => {
    const s = store();
    const made = await createView(s, 'json-string', JSON.stringify(validSpec()));
    expect(made.ok).toBe(true);
    expect((await createView(s, 'bad-json', '{not json')).ok).toBe(false);
  });

  test('publishing again upserts and keeps the old version readable', async () => {
    const s = store();
    await createView(s, 'health', validSpec());
    const second = await createView(s, 'health', validSpec({ title: 'Deploy health v2' }));
    expect(second).toMatchObject({ ok: true, version: 2, action: 'updated' });
    expect(listViews(s.sql)).toHaveLength(1);
    expect(listViewVersions(s.sql, 'health').map((v) => [v.version, v.status]))
      .toEqual([[2, 'current'], [1, 'historical']]);
  });

  test('reverting restores the previous version', async () => {
    const s = store();
    await createView(s, 'health', validSpec());
    await createView(s, 'health', validSpec({ title: 'Deploy health v2' }));
    expect(await revertView(s, 'health')).toMatchObject({ ok: true, revertedTo: 1 });

    const read = await readView(s, 'health');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.spec.title).toBe('Deploy health');
  });

  test('reverting the first version removes the tab entirely', async () => {
    const s = store();
    await createView(s, 'health', validSpec());
    expect(await revertView(s, 'health')).toMatchObject({ ok: true });
    expect(listViews(s.sql)).toEqual([]);
    expect((await readView(s, 'health')).ok).toBe(false);
  });

  test('deleting hides the tab but keeps the versions for the changelog', async () => {
    const s = store();
    await createView(s, 'health', validSpec());
    expect(await deleteView(s, 'health')).toMatchObject({ ok: true });
    expect(listViews(s.sql)).toEqual([]);
    expect(listViewVersions(s.sql, 'health')).toHaveLength(1);
    expect(await deleteView(s, 'health')).toMatchObject({ ok: false });
  });

  test('a spec rewritten on disk to something invalid does not render', async () => {
    // The live file is on an agent-writable plane, so acceptance at write time
    // is not a property the read path may assume.
    const s = store();
    await createView(s, 'health', validSpec());
    await s.vfs.writeFile('views/health.json', JSON.stringify({
      v: 1, title: 'Deploy health',
      blocks: [{ type: 'html', text: '<script>fetch("/api/user/profile")</script>' }],
    }));
    const read = await readView(s, 'health');
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toContain('view spec invalid');
  });

  test('an invalid spec is never stored, so a bad write cannot orphan a tab', async () => {
    const s = store();
    const out = await createView(s, 'health', { v: 1, title: 'x', blocks: [] });
    expect(out.ok).toBe(false);
    expect(listViews(s.sql)).toEqual([]);
    expect(await s.vfs.exists('views/health.json')).toBe(false);
  });

  test('names fold to slugs, and a name with nothing usable in it is refused', async () => {
    expect(viewSlug('Deploy Health!')).toBe('deploy-health');
    expect(viewSlug('  ../../etc/passwd ')).toBe('etc-passwd');
    expect(viewSlug('!!!')).toBeNull();
    const s = store();
    expect((await createView(s, '!!!', validSpec())).ok).toBe(false);
  });
});

describe('view spec — homoglyph titles', () => {
  test('refuses a reserved title spelled with a Cyrillic lookalike', () => {
    // The second `а` below is Cyrillic U+0430. It renders the same as the
    // Latin `a` in `Releases`, and the reserved fold would drop it, so the
    // title is refused before the fold runs.
    const out = parseViewSpec(validSpec({ title: 'Releаses' }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain('printable ASCII');
  });
});

describe('view spec — markdown links', () => {
  test('refuses markdown that would draw a link or load a remote target', () => {
    const texts = [
      '[x](https://example.com)',
      '![](https://example.com/x.png)',
      '[x](javascript:alert(1))',
      '<https://example.com>',
      '[ref]: https://example.com\n\nsee [ref]',
    ];
    for (const text of texts) {
      const out = parseViewSpec(validSpec({ blocks: [{ type: 'markdown', text }] }));
      expect(out.ok).toBe(false);
      if (out.ok) continue;
      expect(out.error).toContain('markdown links');
    }
  });

  test('keeps plain markdown without links', () => {
    const out = parseViewSpec(validSpec({ blocks: [{ type: 'markdown', text: '# Health\n\n- ok' }] }));
    expect(out.ok).toBe(true);
  });
});
