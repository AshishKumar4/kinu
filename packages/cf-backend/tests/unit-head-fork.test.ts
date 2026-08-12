/**
 * Heads are forks of their parent workspace.
 *
 * The production bug this locks down: a head got a freshly-created, empty
 * SqliteFS on its OWN facet storage, so an agent asked to research a codebase
 * the user had cloned into the workspace spawned heads that could see none of
 * it — and, because the tools were named `sandbox_*`, reported "found nothing"
 * rather than "no access".
 *
 * A head now builds a CF runtime keyed to the PARENT workspace (same container,
 * same Nimbus session, same device consent) with the parent's durable files
 * mounted at /workspace. An MCTS branch, seeded without a parent workspace by
 * spawnBranchFacet, still cannot build one at all.
 */

import { describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { HeadCapture, type HeadInput } from '@proteus/core';
import { mockAgentsSdk } from './helpers/agents-sdk.js';

mockAgentsSdk();

/** The sandbox id the runtime asked for — the observable proof that a head
 *  rides the PARENT workspace's container rather than a fresh one of its own. */
let requestedSandboxId: string | null = null;
mock.module('@cloudflare/sandbox', () => ({
  getSandbox: (_ns: unknown, id: string) => {
    requestedSandboxId = id;
    return {
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      readFile: async () => ({ content: '', exitCode: 0 }),
      writeFile: async () => ({ exitCode: 0 }),
      listFiles: async () => ({ files: [], exitCode: 0 }),
      deleteFile: async () => ({ exitCode: 0 }),
      exposePort: async () => ({}),
      unexposePort: () => {},
      getExposedPorts: async () => [],
      createBackup: async () => null,
      restoreBackup: async () => {},
    };
  },
}));

const { ExplorationAgent } = await import('../src/exploration.ts');

type SqlTag = <T>(strings: TemplateStringsArray, ...values: unknown[]) => T[];

function makeSqlTag(db: Database): SqlTag {
  return function <T>(strings: TemplateStringsArray, ...values: unknown[]): T[] {
    const query = strings.reduce((sql, part, i) => sql + part + (i < values.length ? '?' : ''), '');
    const statement = db.prepare(query);
    // workerd's SQL binder takes undefined and raw ArrayBuffers (SqliteFS binds
    // file chunks as ArrayBuffer); bun's takes neither.
    const bound = values.map((v) => {
      if (v === undefined) return null;
      if (v instanceof ArrayBuffer) return new Uint8Array(v);
      return v;
    });
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return statement.all(...(bound as never[])) as T[];
    statement.run(...(bound as never[]));
    return [];
  } as SqlTag;
}

interface ParentCall { method: string; arg: unknown }

/** A stand-in workspace orchestrator holding the files a head should be able to
 *  read, behind the same RPC methods the real one exposes. */
function makeParentWorkspace(files: Record<string, string>) {
  const calls: ParentCall[] = [];
  const stub = {
    async readWorkspaceFile(path: string) {
      calls.push({ method: 'readWorkspaceFile', arg: path });
      const content = files[path];
      return content === undefined
        ? { ok: false as const, error: { code: 'ENOENT', message: 'no such file', path } }
        : { ok: true as const, value: new TextEncoder().encode(content) };
    },
    async listWorkspaceFiles(path: string) {
      calls.push({ method: 'listWorkspaceFiles', arg: path });
      const prefix = path ? `${path}/` : '';
      const names = new Set<string>();
      for (const key of Object.keys(files)) {
        if (!key.startsWith(prefix)) continue;
        names.add(key.slice(prefix.length).split('/')[0]!);
      }
      return { ok: true as const, value: [...names] };
    },
    async writeWorkspaceFile(input: { kind: string; path: string; data?: string }) {
      calls.push({ method: 'writeWorkspaceFile', arg: input });
      if (input.kind === 'file') files[input.path] = String(input.data);
      return { ok: true as const, value: null };
    },
    async statWorkspaceFile(path: string) {
      calls.push({ method: 'statWorkspaceFile', arg: path });
      return { ok: true as const, value: files[path] === undefined ? null : { size: files[path]!.length, mtimeMs: 0, isDir: false } };
    },
    async deleteWorkspaceFile(path: string) {
      calls.push({ method: 'deleteWorkspaceFile', arg: path });
      delete files[path];
      return { ok: true as const, value: null };
    },
  };
  return { stub, calls };
}

interface Facet {
  setOwner(userId: string, token: string | null): Promise<unknown>;
  setSharedParent(name: string): Promise<unknown>;
  initHead(input: HeadInput): Promise<unknown>;
  runAsHead(): Promise<unknown>;
  headRuntime(): import('../src/runtime.js').CFRuntime;
  buildHeadTools(input: HeadInput, capture: HeadCapture): unknown;
}

function makeFacet(parentFiles: Record<string, string> = {}) {
  const db = new Database(':memory:');
  const parent = makeParentWorkspace(parentFiles);
  const ctx = {
    id: { toString: () => 'facet-id' },
    storage: {
      sql: {
        exec: (query: string, ...values: unknown[]) => {
          const statement = db.prepare(query);
          if (/^\s*(SELECT|PRAGMA)/i.test(query)) return { toArray: () => statement.all(...(values as never[])) };
          statement.run(...(values as never[]));
          return { toArray: () => [] };
        },
      },
    },
  };
  const env = {
    LOADER: {},
    Sandbox: {},
    PREVIEW_HOST_SUFFIX: 'preview.test',
    AI_GATEWAY_URL: 'https://gateway.test',
    AI_GATEWAY_AUTH: 'token',
    OrchestratorAgent: { idFromName: (name: string) => name, get: () => parent.stub },
    UserDO: { idFromName: (name: string) => name, get: () => ({}) },
  };
  const facet = new (ExplorationAgent as unknown as new (ctx: unknown, env: unknown) => Facet)(ctx, env);
  (facet as unknown as { sql: SqlTag }).sql = makeSqlTag(db);
  (facet as unknown as { name: string }).name = 'head-1';
  return { facet, parent };
}

function headInput(): HeadInput {
  return {
    id: 'head-1', rootId: 'root-1', parentId: null, depth: 0,
    task: 'map the cloned repo', rationale: 'the parser angle',
    inheritedContext: [],
    budget: { maxDepth: 1, maxWallClockMs: 30_000, spawnedAt: Date.now() },
    mergeStrategy: 'synthesize',
  };
}

describe('a head forks its parent workspace', () => {
  test('the parent workspace files are readable at /workspace', async () => {
    const { facet, parent } = makeFacet({ 'repo/README.md': '# cloned project' });
    await facet.setSharedParent('proteus-main');

    const rt = facet.headRuntime();
    const content = await rt.storage.vfs.readFile('/workspace/repo/README.md', { encoding: 'utf8' });

    expect(content).toBe('# cloned project');
    expect(parent.calls.map((c) => c.method)).toContain('readWorkspaceFile');
    expect(rt.compositeVfs.listMounts().map((m) => m.name)).toContain('workspace');
  });

  test('the parent workspace directory listing reaches the head', async () => {
    const { facet } = makeFacet({ 'repo/src/index.ts': 'x', 'repo/package.json': '{}' });
    await facet.setSharedParent('proteus-main');

    const names = await facet.headRuntime().storage.vfs.readdir('/workspace/repo');
    expect(names.sort()).toEqual(['package.json', 'src']);
  });

  test('exec planes are keyed to the PARENT workspace, not the head facet', async () => {
    requestedSandboxId = null;
    const { facet } = makeFacet();
    await facet.setSharedParent('proteus-main');

    facet.headRuntime();

    // The container the parent agent works in — `proteus-${workspaceName}` in
    // runtime.ts — and emphatically not `proteus-head-1`.
    expect(requestedSandboxId as string | null).toBe('proteus-proteus-main');
  });

  test('/local stays this head\'s own private scratch', async () => {
    const { facet, parent } = makeFacet();
    await facet.setSharedParent('proteus-main');
    const rt = facet.headRuntime();

    await rt.storage.vfs.writeFile('scratch/notes.md', 'private');

    expect(await rt.storage.vfs.readFile('scratch/notes.md', { encoding: 'utf8' })).toBe('private');
    expect(parent.calls.map((c) => c.method)).not.toContain('writeWorkspaceFile');
  });

  test("the head's writes to the parent workspace are attributed to that head", async () => {
    // The cf half of the attribution: a head's plane is its facet's own, so what
    // it writes over the parent RPC mount lands in ITS capture and nothing else's.
    const { facet } = makeFacet({ 'repo/parser.ts': 'one\ntwo\n' });
    await facet.setSharedParent('proteus-main');
    const capture = new HeadCapture();
    facet.buildHeadTools(headInput(), capture);
    const rt = facet.headRuntime();

    await rt.storage.vfs.writeFile('/workspace/repo/parser.ts', 'one\ntwo\nthree\n');
    await rt.storage.vfs.writeFile('/local/notes.md', 'my own thinking\n');

    expect(capture.files.snapshot()).toEqual([
      { path: '/workspace/repo/parser.ts', status: 'changed', added: 1, removed: 0 },
    ]);
  });

  test('an MCTS branch — seeded without a parent workspace — cannot fork at all', async () => {
    // spawnBranchFacet seeds setOwner and nothing else (unit-facet-spawn), so a
    // branch reaches this state and can never acquire the head runtime.
    const { facet } = makeFacet();
    await facet.setOwner('user-1', 'pwc_parent');
    await facet.initHead(headInput());

    await expect(facet.runAsHead()).rejects.toThrow('without a parent workspace');
  });
});
