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
  gadgetSummary, isGadgetMethodName, listGadgets,
  parseGadgetManifest, readGadget, readGadgetClient, readGadgetServer,
  routeGadgetBindingCall, type GadgetBindingRequest, type GadgetManifest,
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
  test('accepts a title with the four binding kinds', () => {
    const out = parseGadgetManifest(manifest({
      subtitle: 'What shipped today',
      bindings: {
        WS: { kind: 'namespace', namespace: 'workspace' },
        WEB: { kind: 'namespace', namespace: 'web', members: ['search'] },
        DATA: { kind: 'rpc', methods: ['listBackgroundJobs', 'getExecutors'] },
        GITHUB: { kind: 'mcp', server: 'github', tools: ['list_issues'] },
        TODO: { kind: 'app', id: 'todo' },
      },
    }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(Object.keys(out.manifest.bindings ?? {})).toEqual(['WS', 'WEB', 'DATA', 'GITHUB', 'TODO']);
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
      manifest({ bindings: { WS: { kind: 'namespace', namespace: 'workspace', write: true } } }),
      manifest({ bindings: { D: { kind: 'rpc', methods: ['getExecutors'], sources: ['listPendingActions'] } } }),
      manifest({ bindings: { A: { kind: 'app', id: 'todo', methods: ['list'] } } }),
    ]) {
      expect(parseGadgetManifest(bad).ok).toBe(false);
    }
  });

  test('an rpc binding names workspace.read read models and nothing else, at parse', () => {
    for (const method of ['listPendingActions', 'listPendingConsents', 'sampleOutcomeLabeling', 'destroyAgent', 'getMctsNodeDetail']) {
      const out = parseGadgetManifest(manifest({ bindings: { D: { kind: 'rpc', methods: [method] } } }));
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.error).toContain(method);
    }
    expect(parseGadgetManifest(manifest({ bindings: { D: { kind: 'rpc', methods: [] } } })).ok).toBe(false);
    expect(parseGadgetManifest(manifest({ bindings: { D: { kind: 'rpc', methods: [...GADGET_DATA_SOURCES] } } })).ok).toBe(true);
  });

  test('a namespace is a codemode name and an app id is a slug; neither is looked up at parse', () => {
    for (const namespace of ['', 'Work space', '../x', 'a'.repeat(41)]) {
      expect(parseGadgetManifest(manifest({ bindings: { N: { kind: 'namespace', namespace } } })).ok).toBe(false);
    }
    // Whether the workspace HAS the namespace is a call-time answer.
    expect(parseGadgetManifest(manifest({ bindings: { N: { kind: 'namespace', namespace: 'laptop' } } })).ok).toBe(true);
    expect(parseGadgetManifest(manifest({ bindings: { N: { kind: 'namespace', namespace: 'workspace', members: [] } } })).ok).toBe(false);
    for (const id of ['', 'Todo', '../x', 'a b']) {
      expect(parseGadgetManifest(manifest({ bindings: { A: { kind: 'app', id } } })).ok).toBe(false);
    }
    expect(parseGadgetManifest(manifest({ bindings: { A: { kind: 'app', id: 'other-app' } } })).ok).toBe(true);
  });

  test('a binding name is the env key the code spells, so it is UPPER_SNAKE_CASE', () => {
    const rpc = { kind: 'rpc', methods: ['getExecutors'] };
    for (const name of ['files', 'Files', '1FILES', 'FILES-A', 'A'.repeat(33)]) {
      expect(parseGadgetManifest(manifest({ bindings: { [name]: rpc } })).ok).toBe(false);
    }
    expect(parseGadgetManifest(manifest({ bindings: { MY_FILES2: rpc } })).ok).toBe(true);
    // valibot's `record` drops the prototype-walking keys rather than
    // validating them, so a manifest naming one mints nothing under it.
    const walker = parseGadgetManifest(JSON.parse(
      '{"v":1,"title":"Deploy health","bindings":{"__proto__":{"kind":"rpc","methods":["getExecutors"]}}}',
    ));
    expect(walker.ok && Object.keys(walker.manifest.bindings ?? {})).toEqual([]);
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
      Array.from({ length: GADGET_LIMITS.bindings + 1 }, (_, i) => [`B${i}`, { kind: 'rpc', methods: ['getExecutors'] }]),
    );
    expect(parseGadgetManifest(manifest({ bindings: many })).ok).toBe(false);
    expect(parseGadgetManifest(manifest({ title: 'x'.repeat(GADGET_LIMITS.titleChars + 1) })).ok).toBe(false);
    expect(parseGadgetManifest(manifest({ v: 2 })).ok).toBe(false);
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

describe('gadget bindings — the one pure decision over the manifest and the request', () => {
  const declared: GadgetManifest = {
    v: 1,
    title: 'Deploy health',
    bindings: {
      WS: { kind: 'namespace', namespace: 'workspace' },
      WEB: { kind: 'namespace', namespace: 'web', members: ['search'] },
      DATA: { kind: 'rpc', methods: ['listBackgroundJobs'] },
      GITHUB: { kind: 'mcp', server: 'github', tools: ['list_issues'] },
      ANY_MCP: { kind: 'mcp', server: 'linear' },
      TODO: { kind: 'app', id: 'todo' },
    },
  };
  const request = (member: string, args: GadgetBindingRequest['args'] = [], depth = 0): GadgetBindingRequest =>
    ({ member, args, depth });
  const route = (name: string, req: GadgetBindingRequest) =>
    routeGadgetBindingCall({ slug: 'health', manifest: declared, name, request: req });

  test('a name the manifest no longer declares is denied, whatever the member', () => {
    expect(route('FILES', request('read', ['x']))).toMatchObject({ ok: false, reason: 'denied' });
  });

  test('a namespace binding routes any member when none are listed, and only the listed ones otherwise', () => {
    expect(route('WS', request('exec', ['ls']))).toEqual({
      ok: true, route: { kind: 'namespace', namespace: 'workspace', member: 'exec', args: ['ls'] },
    });
    expect(route('WEB', request('search', ['kinu']))).toMatchObject({ ok: true, route: { kind: 'namespace', member: 'search' } });
    const withheld = route('WEB', request('fetch', ['https://example.com']));
    expect(withheld).toMatchObject({ ok: false, reason: 'denied' });
    if (withheld.ok) return;
    expect(withheld.error).toContain('search');
  });

  test('an rpc binding routes a declared read model with no arguments', () => {
    expect(route('DATA', request('listBackgroundJobs'))).toEqual({
      ok: true, route: { kind: 'rpc', method: 'listBackgroundJobs' },
    });
    expect(route('DATA', request('getExecutors'))).toMatchObject({ ok: false, reason: 'denied' });
    expect(route('DATA', request('listBackgroundJobs', [5]))).toMatchObject({ ok: false, reason: 'bad_input' });
  });

  test('an mcp binding routes a tool as its member with one JSON object, on the named connection', () => {
    expect(route('GITHUB', request('list_issues', [{ state: 'open' }]))).toEqual({
      ok: true, route: { kind: 'mcp', server: 'github', tool: 'list_issues', args: { state: 'open' } },
    });
    expect(route('ANY_MCP', request('create_issue'))).toEqual({
      ok: true, route: { kind: 'mcp', server: 'linear', tool: 'create_issue', args: {} },
    });
    expect(route('GITHUB', request('create_issue', [{ title: 'x' }]))).toMatchObject({ ok: false, reason: 'denied' });
    expect(route('GITHUB', request('list_issues', ['open']))).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(route('GITHUB', request('list_issues', [{}, {}]))).toMatchObject({ ok: false, reason: 'bad_input' });
  });

  test('an app binding routes a method on the other app one hop deeper, until the depth bound', () => {
    expect(route('TODO', request('addItem', ['milk'], 2))).toEqual({
      ok: true, route: { kind: 'app', id: 'todo', method: 'addItem', args: ['milk'], depth: 2 },
    });
    expect(route('TODO', request('_private'))).toMatchObject({ ok: false, reason: 'bad_input' });
    const cycle = route('TODO', request('addItem', [], GADGET_LIMITS.appDepth));
    expect(cycle).toMatchObject({ ok: false, reason: 'denied' });
    if (cycle.ok) return;
    expect(cycle.error).toContain(String(GADGET_LIMITS.appDepth));
  });
});
