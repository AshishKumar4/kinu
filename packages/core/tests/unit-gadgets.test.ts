/**
 * Gadgets — the contract the model, the host and the bridge depend on.
 *
 * These assert what a manifest may DECLARE, what the file plane's listing
 * says, and what each binding kind lets a server reach. The security-shaped
 * cases come first: the whole argument for running agent code is that its
 * reach is exactly the declared bindings, so a test that only covered the
 * happy path would be testing the wrong thing.
 */

import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  GADGET_DATA_SOURCES, GADGET_LIMITS,
  gadgetFilesRoot, gadgetSummary, isGadgetMethodName, listGadgets,
  parseGadgetManifest, readGadget, readGadgetClient, readGadgetServer,
  resolveGadgetDataSource, resolveGadgetFilePath, reviewGadgetMcpCall,
} from '../src/gadgets/index';
import { sha256Hex } from '../src/safety/argument-digest';
import type { VFS } from '../src/types/primitives';
import type { JsonObject } from '../src/utils/json';
import { makeVfsError } from '../src/vfs/errno';

// ── fixtures ────────────────────────────────────────────────────────────────

const manifest = (overrides: JsonObject = {}) => ({
  v: 1, title: 'Deploy health', ...overrides,
});

/** A map-backed tree with honest directory semantics: readdir answers entry
 *  NAMES, stat distinguishes directories, a missing read raises ENOENT. */
function memoryVfs(seed: Record<string, string> = {}): VFS {
  const files = new Map<string, string>(Object.entries(seed));
  const dirs = new Set<string>();
  const noteDirs = (path: string) => {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  };
  for (const path of files.keys()) noteDirs(path);
  return {
    readFile: async (path) => {
      const hit = files.get(path);
      if (hit === undefined) throw makeVfsError('ENOENT', `no such file: ${path}`, path);
      return hit;
    },
    writeFile: async (path, data) => {
      files.set(path, v.is(v.string(), data) ? data : new TextDecoder().decode(data));
      noteDirs(path);
    },
    readdir: async (path) => {
      const names = new Set<string>();
      for (const candidate of [...files.keys(), ...dirs]) {
        if (candidate.startsWith(`${path}/`)) names.add(candidate.slice(path.length + 1).split('/')[0]!);
      }
      return [...names];
    },
    stat: async (path) => {
      const data = files.get(path);
      if (data !== undefined) return { size: data.length, mtimeMs: 0, isDir: false };
      return dirs.has(path) ? { size: 0, mtimeMs: 0, isDir: true } : null;
    },
    unlink: async (path) => { files.delete(path); },
    mkdir: async (path) => { dirs.add(path); },
    exists: async (path) => files.has(path) || dirs.has(path),
  };
}

// ── the manifest is closed ──────────────────────────────────────────────────

describe('gadget manifest — what a gadget may declare', () => {
  test('accepts a title with the three binding kinds', () => {
    const out = parseGadgetManifest(manifest({
      subtitle: 'What shipped today',
      bindings: {
        FILES: { kind: 'files', root: 'reports' },
        WORKSPACE: { kind: 'workspace' },
        GITHUB: { kind: 'mcp', server: 'github', tools: ['list_issues'] },
      },
    }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(Object.keys(out.manifest.bindings ?? {})).toEqual(['FILES', 'WORKSPACE', 'GITHUB']);
  });

  test('refuses a binding kind that does not exist, rather than dropping it', () => {
    const out = parseGadgetManifest(manifest({ bindings: { NET: { kind: 'fetch', host: 'example.com' } } }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain('bindings.NET');
  });

  test('refuses unknown keys instead of stripping them', () => {
    for (const bad of [
      manifest({ html: '<script>' }),
      manifest({ bindings: { FILES: { kind: 'files', write: true } } }),
      manifest({ bindings: { W: { kind: 'workspace', sources: ['listPendingActions'] } } }),
    ]) {
      expect(parseGadgetManifest(bad).ok).toBe(false);
    }
  });

  test('a binding name is the env key the code spells, so it is UPPER_SNAKE_CASE', () => {
    for (const name of ['files', 'Files', '1FILES', 'FILES-A', 'A'.repeat(33)]) {
      expect(parseGadgetManifest(manifest({ bindings: { [name]: { kind: 'workspace' } } })).ok).toBe(false);
    }
    expect(parseGadgetManifest(manifest({ bindings: { MY_FILES2: { kind: 'workspace' } } })).ok).toBe(true);
    // valibot's `record` drops the prototype-walking keys rather than
    // validating them, so a manifest naming one mints nothing under it.
    const walker = parseGadgetManifest(JSON.parse('{"v":1,"title":"Deploy health","bindings":{"__proto__":{"kind":"workspace"}}}'));
    expect(walker.ok && Object.keys(walker.manifest.bindings ?? {})).toEqual([]);
  });

  test('a files root is workspace-relative and cannot climb', () => {
    for (const root of ['/etc', '../other', 'a/../b', 'reports/..', '.', '']) {
      expect(parseGadgetManifest(manifest({ bindings: { F: { kind: 'files', root } } })).ok).toBe(false);
    }
    expect(parseGadgetManifest(manifest({ bindings: { F: { kind: 'files', root: 'reports/2026' } } })).ok).toBe(true);
  });

  test('refuses the host surfaces as titles, whatever the case or spacing', () => {
    for (const title of ['Releases', 'releases', 'R E L E A S E S', 'R e-l_e.a s e S', 'Approvals', 'Consent', 'Activity', 'Settings']) {
      const out = parseGadgetManifest(manifest({ title }));
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.error).toContain('host owns');
    }
    expect(parseGadgetManifest(manifest({ title: 'Release health' })).ok).toBe(true);
  });

  test('refuses a non-ASCII title, because the reserved fold would drop it', () => {
    expect(parseGadgetManifest(manifest({ title: 'Rеleases' })).ok).toBe(false);
  });

  test('bounds what the host mints and draws', () => {
    const many = Object.fromEntries(
      Array.from({ length: GADGET_LIMITS.bindings + 1 }, (_, i) => [`B${i}`, { kind: 'workspace' }]),
    );
    expect(parseGadgetManifest(manifest({ bindings: many })).ok).toBe(false);
    expect(parseGadgetManifest(manifest({ title: 'x'.repeat(GADGET_LIMITS.titleChars + 1) })).ok).toBe(false);
    expect(parseGadgetManifest(manifest({ v: 2 })).ok).toBe(false);
  });

  test('a files binding defaults to the gadget\'s own data directory', () => {
    expect(gadgetFilesRoot('todo', { kind: 'files' })).toBe('gadgets/todo/data');
    expect(gadgetFilesRoot('todo', { kind: 'files', root: 'reports' })).toBe('reports');
  });
});

// ── the file plane's view ───────────────────────────────────────────────────

describe('gadgets on the file plane', () => {
  test('lists valid gadgets, names broken ones, and ignores plain directories', async () => {
    const vfs = memoryVfs({
      'gadgets/health/gadget.json': JSON.stringify(manifest()),
      'gadgets/health/server.js': "import { RpcTarget } from './capnweb.js'; export class Gadget extends RpcTarget {}",
      'gadgets/health/client.js': 'document.body.textContent = "hi"',
      'gadgets/broken/gadget.json': '{"v":1,"title":"Releases"}',
      'gadgets/notes/README.md': 'not a gadget',
      'gadgets/Bad Name/gadget.json': JSON.stringify(manifest()),
    });
    const listing = await listGadgets(vfs);
    expect(listing.gadgets.map((g) => g.slug)).toEqual(['health']);
    expect(listing.gadgets[0]).toMatchObject({ hasServer: true, hasClient: true });
    expect(listing.problems.map((p) => p.slug).sort()).toEqual(['Bad Name', 'broken']);
    expect(listing.problems.find((p) => p.slug === 'broken')?.error).toContain('host owns');
    expect(gadgetSummary(listing.gadgets[0]!)).toEqual({
      slug: 'health', title: 'Deploy health', subtitle: null, hasServer: true, hasClient: true, bindings: [],
    });
  });

  test('a workspace with no gadgets directory lists nothing', async () => {
    expect(await listGadgets(memoryVfs())).toEqual({ gadgets: [], problems: [] });
  });

  test('reads re-validate: a manifest edited into invalidity is refused with its field', async () => {
    const vfs = memoryVfs({ 'gadgets/health/gadget.json': JSON.stringify(manifest()) });
    expect((await readGadget(vfs, 'health')).ok).toBe(true);
    await vfs.writeFile('gadgets/health/gadget.json', JSON.stringify(manifest({ bindings: { X: { kind: 'shell' } } })));
    const read = await readGadget(vfs, 'health');
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('bad_input');
    expect(read.error).toContain('bindings.X');
  });

  test('a missing gadget, a bad slug and a half-written gadget each answer their class', async () => {
    const vfs = memoryVfs({ 'gadgets/health/gadget.json': JSON.stringify(manifest()) });
    expect(await readGadget(vfs, 'nope')).toMatchObject({ ok: false, reason: 'missing' });
    expect(await readGadget(vfs, '../SOUL.md')).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(await readGadgetClient(vfs, 'health')).toMatchObject({ ok: false, reason: 'missing' });
    expect(await readGadgetServer(vfs, 'health')).toMatchObject({ ok: false, reason: 'missing' });
    await vfs.writeFile('gadgets/health/client.js', 'render()');
    await vfs.writeFile('gadgets/health/client.css', 'body{}');
    expect(await readGadgetClient(vfs, 'health')).toEqual({ ok: true, js: 'render()', css: 'body{}' });
  });

  test('the server digest is over the bytes the resident process boots', async () => {
    const vfs = memoryVfs({
      'gadgets/health/gadget.json': JSON.stringify(manifest()),
      'gadgets/health/server.js': "import { RpcTarget } from './capnweb.js'; export class Gadget extends RpcTarget { hello() { return 1 } }",
    });
    const first = await readGadgetServer(vfs, 'health');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.digest).toBe(sha256Hex(first.js));
    await vfs.writeFile('gadgets/health/server.js', "import { RpcTarget } from './capnweb.js'; export class Gadget extends RpcTarget { hello() { return 2 } }");
    const second = await readGadgetServer(vfs, 'health');
    expect(second.ok && second.digest !== first.digest).toBe(true);
  });
});

// ── the bridge's name rule ──────────────────────────────────────────────────

describe('gadget method names the bridge forwards', () => {
  test('forwards JSON methods and refuses the constructor and private names', () => {
    for (const name of ['list', 'addItem', 'get_state', 'v2', 'fetch', 'alarm', 'connect', 'webSocketMessage', 'webSocketClose', 'webSocketError']) expect(isGadgetMethodName(name)).toBe(true);
    for (const name of ['constructor', '_private', '#secret', 'a.b', '', 'x'.repeat(65)]) {
      expect(isGadgetMethodName(name)).toBe(false);
    }
  });
});

// ── what each binding reaches ───────────────────────────────────────────────

describe('gadget bindings — the pure half of each kind', () => {
  test('a files binding resolves under its root and refuses every way out', () => {
    expect(resolveGadgetFilePath('reports', 'today/summary.md')).toEqual({ ok: true, path: 'reports/today/summary.md' });
    expect(resolveGadgetFilePath('reports', './a//b/../c.md')).toEqual({ ok: true, path: 'reports/a/c.md' });
    expect(resolveGadgetFilePath('reports', '')).toEqual({ ok: true, path: 'reports' });
    for (const escape of ['../SOUL.md', 'a/../../x', '/home/user/SOUL.md', 'a\0b']) {
      expect(resolveGadgetFilePath('reports', escape)).toMatchObject({ ok: false, reason: 'denied' });
    }
  });

  test('a workspace binding reads the closed list and nothing host-owned', () => {
    for (const source of GADGET_DATA_SOURCES) expect(resolveGadgetDataSource(source).ok).toBe(true);
    for (const withheld of ['listPendingActions', 'listPendingConsents', 'sampleOutcomeLabeling', 'destroyAgent', 'getMctsNodeDetail']) {
      expect(resolveGadgetDataSource(withheld)).toMatchObject({ ok: false, reason: 'denied' });
    }
  });

  test('an mcp binding refuses a tool the manifest did not introduce before any ladder runs', () => {
    const out = reviewGadgetMcpCall({
      slug: 'issues', binding: { kind: 'mcp', server: 'github', tools: ['list_issues'] },
      tool: 'create_issue', args: { title: 'x' },
      tools: [{ name: 'list_issues', readOnly: true }, { name: 'create_issue', readOnly: false }],
    });
    expect(out).toMatchObject({ ok: false, reason: 'denied' });
  });

  test('an mcp binding reports a tool the connection does not offer as missing', () => {
    const out = reviewGadgetMcpCall({
      slug: 'issues', binding: { kind: 'mcp', server: 'github' },
      tool: 'nope', args: {}, tools: [{ name: 'list_issues', readOnly: true }],
    });
    expect(out).toMatchObject({ ok: false, reason: 'missing' });
  });

  test('a read-only tool is an observation; a side effect is the owner\'s decision, keyed to the gadget', () => {
    const tools = [{ name: 'list_issues', readOnly: true }, { name: 'create_issue', readOnly: false }];
    const binding = { kind: 'mcp', server: 'github' } as const;
    const read = reviewGadgetMcpCall({ slug: 'issues', binding, tool: 'list_issues', args: {}, tools });
    expect(read.ok && read.review.review.decision).toBe('allow');
    const write = reviewGadgetMcpCall({ slug: 'issues', binding, tool: 'create_issue', args: { title: 'x' }, tools });
    expect(write.ok).toBe(true);
    if (!write.ok) return;
    expect(write.review.review.decision).toBe('gate');
    // The rule and the executor are what a standing grant is stored under
    // (docs/LIVE-UI.md §2.1), so the literals are the contract: a renamed
    // rule would orphan every grant an owner has given.
    expect(write.review.review.hits.map((h) => h.rule)).toEqual(['gadget_mcp_action']);
    expect(write.review.subject).toEqual({
      command: 'mcp github/create_issue {"title":"x"}',
      executor: 'gadget:issues',
    });
  });
});
