/**
 * Heads are forks of their parent workspace.
 *
 * The production bug this locks down: a head got a freshly-created, empty
 * filesystem on its OWN facet storage, so an agent asked to research a codebase
 * the user had cloned into the workspace spawned heads that could see none of
 * it — and, because the tools were named `sandbox_*`, reported "found nothing"
 * rather than "no access".
 *
 * A head now builds a CF runtime keyed to the PARENT workspace (same container,
 * same Nimbus session, same device consent) and reaches the parent's durable
 * files through a `parent` EXECUTOR — `parent.readFile`, and `parent.exec` into
 * the parent's real shell. Not a directory of the head's own filesystem: the
 * parent is a different Durable Object over async RPC, exactly like the sandbox
 * and the user's machine, and the head's own filesystem stays private scratch a
 * sibling cannot see. An MCTS branch, seeded without a parent workspace by
 * spawnBranchFacet, still cannot build one at all.
 */

import { describe, expect, mock, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type { AgentContext } from 'agents';
import {
  HeadCapture,
  type HeadId,
  type HeadInput,
  type HeadReport,
  type ParentRpcWrite,
  type SqlExecRow,
  type SqlValue,
} from '@proteus/core';
import { mockAgentsSdk } from './helpers/agents-sdk.js';
import * as v from 'valibot';

mockAgentsSdk();

/** The sandbox id the runtime asked for — the observable proof that a head
 *  rides the PARENT workspace's container rather than a fresh one of its own. */
let requestedSandboxId: string | null = null;
const lastRequestedSandboxId = (): string | null => requestedSandboxId;
/** Restores performed through the handle the runtime built. A head rides a
 *  container it does not own, so this must stay at zero however it is touched. */
let restoresPerformed = 0;
mock.module('@cloudflare/sandbox', () => ({
  getSandbox: (_ns: DurableObjectNamespace, id: string) => {
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
      restoreBackup: async () => { restoresPerformed += 1; },
    };
  },
}));

const { ExplorationAgent } = await import('../src/exploration.ts');

function nativeBindings(values: SqlValue[]): SQLQueryBindings[] {
  return values.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
}

interface ParentCall { method: string; arg: unknown }

function makeNimbusNamespace(files: Record<string, string>) {
  const execOptions: Array<{ shellId?: string; shellRoot?: string } | undefined> = [];
  const directories = new Set(['/home', '/home/user']);
  const content = new Map(
    Object.entries(files).map(([path, value]) => [`/home/user/${path}`, value]),
  );
  for (const path of content.keys()) {
    const parts = path.split('/');
    for (let i = 2; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  const list = (path: string) => {
    const prefix = `${path.replace(/\/$/, '')}/`;
    const entries = new Map<string, 'file' | 'directory'>();
    for (const directory of directories) {
      if (!directory.startsWith(prefix)) continue;
      const rest = directory.slice(prefix.length);
      if (rest && !rest.includes('/')) entries.set(rest, 'directory');
    }
    for (const file of content.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      entries.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? 'file' : 'directory');
    }
    return [...entries].map(([name, type]) => ({ name, type }));
  };
  const stub = {
    _rpcReady: async () => ({ ok: true as const, preinstalled: [] }),
    _rpcReadFile: async (path: string) => content.get(path) ?? null,
    _rpcReadFileBytes: async (path: string) => {
      const value = content.get(path);
      return value === undefined ? null : new TextEncoder().encode(value);
    },
    _rpcWriteFile: async (path: string, value: string | Uint8Array) => {
      content.set(path, v.is(v.string(), value) ? value : new TextDecoder().decode(value));
    },
    _rpcReaddir: async (path: string) => list(path),
    _rpcStat: async (path: string) => directories.has(path)
      ? { type: 'directory', size: 0, mtime: 0, mode: 0o755 }
      : content.has(path)
        ? { type: 'file', size: content.get(path)!.length, mtime: 0, mode: 0o644 }
        : null,
    _rpcExists: async (path: string) => directories.has(path) || content.has(path),
    _rpcMkdir: async (path: string) => { directories.add(path); },
    _rpcDeleteFile: async (path: string) => { content.delete(path); directories.delete(path); },
    _rpcExec: async (command: string, options?: { shellId?: string; shellRoot?: string }) => {
      execOptions.push(options);
      const match = /^grep -rl (\S+) \.$/.exec(command.trim());
      const needle = match?.at(1);
      const hits = needle
        ? [...content].filter(([, value]) => value.includes(needle))
          .map(([path]) => path.replace(/^\/home\/user\//, ''))
        : [];
      return {
        command, success: true, stdout: hits.join('\n'), stderr: '',
        exitCode: 0, duration: 0, timestamp: 0,
      };
    },
  };
  return {
    binding: { idFromName: (name: string) => name, get: () => stub },
    content,
    execOptions,
  };
}

/** A stand-in workspace orchestrator holding the files a head should be able to
 *  read, behind the same RPC methods the real one exposes. */
function makeParentWorkspace(files: Record<string, string>) {
  const calls: ParentCall[] = [];
  const stub = {
    // A facet's approval policy is its ROOT's — it reads these two off the
    // parent rather than its own empty agent_config, which is what stops a head
    // re-asking for consent the owner already gave on the workspace. Both are
    // reachable through AGENT_RPC_ACCESS on ORCHESTRATOR_RPC_SURFACE.
    async getShellApprovalMode() {
      return { mode: 'strict' as const };
    },
    async getShellApprovalGrants() {
      const grants: { rule: string; executor: string }[] = [];
      return { grants };
    },
    async execWorkspaceCommand(command: string) {
      calls.push({ method: 'execWorkspaceCommand', arg: command });
      // Enough of a shell to prove the round trip is one call, not a walk.
      const needle = /^grep -rl (\S+) \.$/.exec(command.trim())?.at(1);
      const hits = needle ? Object.entries(files).filter(([, value]) => value.includes(needle)).map(([key]) => key) : [];
      return { ok: true as const, value: { stdout: hits.join('\n'), stderr: '', exitCode: 0 } };
    },
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
        const name = key.slice(prefix.length).split('/').at(0);
        if (name) names.add(name);
      }
      return { ok: true as const, value: [...names] };
    },
    async writeWorkspaceFile(input: ParentRpcWrite) {
      calls.push({ method: 'writeWorkspaceFile', arg: input });
      if (input.kind === 'file') {
        files[input.path] = v.is(v.string(), input.data)
          ? input.data
          : new TextDecoder().decode(input.data);
      }
      return { ok: true as const, value: null };
    },
    async statWorkspaceFile(path: string) {
      calls.push({ method: 'statWorkspaceFile', arg: path });
      const content = files[path];
      return { ok: true as const, value: content === undefined ? null : { size: content.length, mtimeMs: 0, isDir: false } };
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
  setOwner(userId: string, token: string | null): Promise<{ ok: true }>;
  setSharedParent(name: string): Promise<{ ok: true }>;
  initHead(input: HeadInput): Promise<{ ok: true; id: HeadId }>;
  runAsHead(): Promise<HeadReport>;
  headRuntime(capture: HeadCapture): import('../src/runtime.js').CFRuntime;
}

const HeadRuntimeProbeSchema = v.object({
  storage: v.object({ vfs: v.object({ writeFile: v.function() }) }),
  executionRouter: v.object({
    getProvider: v.function(),
    listExecutors: v.function(),
  }),
});

function makeFacet(parentFiles: Record<string, string> = {}) {
  const db = new Database(':memory:');
  const parent = makeParentWorkspace(parentFiles);
  const nimbus = makeNimbusNamespace(parentFiles);
  const ctx = {
    id: { toString: () => 'facet-id' },
    storage: {
      sql: {
        // Iterable as well as `toArray`-able: workerd's SqlStorage.exec returns
        // a cursor, and code that spreads one is exercising the real contract.
        exec: (query: string, ...values: SqlValue[]) => {
          const statement = db.prepare<SqlExecRow, SQLQueryBindings[]>(query);
          const bound = nativeBindings(values);
          const rows = /^\s*(SELECT|WITH|PRAGMA)/i.test(query)
            ? statement.all(...bound)
            : (statement.run(...bound), []);
          return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
        },
      },
      // A real one, not a callback passthrough: the durable filesystem's
      // atomicity rests on this, and a fake would turn every atomic write
      // into a torn one that still reports success.
      transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
    },
  };
  const bindings = {
    LOADER: {},
    NIMBUS_SESSION: nimbus.binding,
    Sandbox: {},
    PREVIEW_HOST_SUFFIX: 'preview.test',
    AI_GATEWAY_URL: 'https://gateway.test',
    AI_GATEWAY_AUTH: 'token',
    OrchestratorAgent: { idFromName: (name: string) => name, get: () => parent.stub },
    UserDO: { idFromName: (name: string) => name, get: () => ({}) },
  };
  const partialContext: Partial<AgentContext> = {};
  Object.assign(partialContext, ctx);
  // SAFETY: ExplorationAgent reaches only the constructed identity, SQL, and
  // transaction members in this harness; each is implemented above.
  const agentContext = partialContext as AgentContext;
  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, bindings);
  // SAFETY: Head runtime construction reaches only the locally constructed
  // loader, execution namespaces, preview config, and owner namespaces.
  const testEnv = partialEnv as Env;
  const concrete = new ExplorationAgent(agentContext, testEnv);
  // The SDK runs `onStart` before it can dispatch a single @callable — the first
  // `subAgent()` for a name awaits it — and `initFacetSchema` is the whole of
  // what it runs. The stand-in base class does not, so the harness does: a facet
  // reached before its own tables exist is a state no spawner can produce.
  concrete.onStart();
  const headRuntimeMember = Object.getOwnPropertyDescriptor(
    ExplorationAgent.prototype,
    'headRuntime',
  )?.value;
  if (!v.is(v.function(), headRuntimeMember)) throw new Error('ExplorationAgent headRuntime seam is missing');
  Object.defineProperty(concrete, 'name', { value: 'head-1', configurable: true });
  const facet: Facet = {
    setOwner: concrete.setOwner.bind(concrete),
    setSharedParent: concrete.setSharedParent.bind(concrete),
    initHead: concrete.initHead.bind(concrete),
    runAsHead: concrete.runAsHead.bind(concrete),
    headRuntime: (capture): ReturnType<Facet['headRuntime']> => {
      const runtime = headRuntimeMember.call(concrete, capture);
      if (!v.is(HeadRuntimeProbeSchema, runtime)) throw new Error('headRuntime returned an invalid runtime');
      // SAFETY: HeadRuntimeProbeSchema validated the runtime returned by the
      // private method from the concrete ExplorationAgent instance above.
      return runtime as ReturnType<Facet['headRuntime']>;
    },
  };
  return { facet, parent, nimbus, db };
}

function headInput(): HeadInput {
  return {
    id: 'head-1', rootId: 'root-1', parentId: null, depth: 0,
    task: 'map the cloned repo', mode: 'build', rationale: 'the parser angle',
    inheritedContext: [],
    budget: { maxDepth: 1, maxWallClockMs: 30_000, spawnedAt: Date.now() },
    mergeStrategy: 'synthesize',
  };
}

describe('a head forks its parent workspace', () => {
  test("the canonical workspace's files are readable without a parent executor", async () => {
    const { facet, parent } = makeFacet({ 'repo/README.md': '# cloned project' });
    await facet.setOwner('user-1', 'pwc_parent');
    await facet.setSharedParent('proteus-main');

    const rt = facet.headRuntime(new HeadCapture());
    const workspace = rt.executionRouter!.getProvider('workspace')!;
    const content = await workspace.tools.readFile.execute('repo/README.md');

    expect(content).toBe('# cloned project');
    expect(parent.calls).toHaveLength(0);
    expect(rt.executionRouter!.listExecutors().map((e) => e.name)).not.toContain('parent');
  });

  test('the canonical workspace directory listing reaches the head', async () => {
    const { facet } = makeFacet({ 'repo/src/index.ts': 'x', 'repo/package.json': '{}' });
    await facet.setOwner('user-1', 'pwc_parent');
    await facet.setSharedParent('proteus-main');

    const workspace = facet.headRuntime(new HeadCapture()).executionRouter!.getProvider('workspace')!;
    const names = v.parse(v.array(v.string()), await workspace.tools.readdir.execute('repo'));
    expect(names.sort()).toEqual(['package.json', 'src']);
  });

  test("searching the workspace is one real shell call, not an RPC file walk", async () => {
    const { facet, parent, nimbus } = makeFacet({ 'repo/a.ts': 'needle here', 'repo/b.ts': 'nothing' });
    await facet.setOwner('user-1', 'pwc_parent');
    await facet.setSharedParent('proteus-main');

    const workspace = facet.headRuntime(new HeadCapture()).executionRouter!.getProvider('workspace')!;
    const found = await workspace.tools.exec.execute('grep -rl needle .');

    expect(String(found)).toContain('repo/a.ts');
    expect(parent.calls).toHaveLength(0);
    expect(nimbus.execOptions).toContainEqual({ shellId: 'head:head-1', shellRoot: '/home/user' });
  });

  test('exec planes are keyed to the PARENT workspace, not the head facet', async () => {
    requestedSandboxId = null;
    const { facet } = makeFacet();
    await facet.setOwner('user-1', 'pwc_parent');
    await facet.setSharedParent('proteus-main');

    facet.headRuntime(new HeadCapture());

    // The container the parent agent works in — `proteus-${workspaceName}` in
    // runtime.ts — and emphatically not `proteus-head-1`.
    expect(lastRequestedSandboxId()).toBe('proteus-proteus-main');
  });

  test('a head never decides the restore of the container it only rides', async () => {
    restoresPerformed = 0;
    const { facet, db } = makeFacet();
    await facet.setOwner('user-1', 'pwc_parent');
    await facet.setSharedParent('proteus-main');

    const rt = facet.headRuntime(new HeadCapture());
    // A backup handle on the FACET's own storage — `agent_config` is created by
    // the runtime above, and the restore is read at first touch, not at build.
    // It is not the shared container's history: `proteus-proteus-main` belongs to
    // the parent, so acting on it would roll that container back to whatever
    // this head last happened to record.
    db.prepare("INSERT INTO agent_config (key, value) VALUES ('workspace_backup', ?)")
      .run(JSON.stringify({ id: 'bk-1', dir: '/workspace' }));

    await rt.sandboxHandle!.exec('true');
    await rt.sandboxHandle!.exec('true');

    // Zero, and the second touch is what makes it a regression test: with an
    // EMPTY key the old wrapper marked the container restored having restored
    // nothing, one-shot and never retried, so every later call execed against
    // whatever state it found. A facet that cannot mark the container restored
    // cannot mark it falsely.
    expect(restoresPerformed).toBe(0);
  });

  test("a head writes the canonical workspace rather than private duplicate bytes", async () => {
    const { facet, parent, nimbus } = makeFacet();
    await facet.setOwner('user-1', 'pwc_parent');
    await facet.setSharedParent('proteus-main');
    const rt = facet.headRuntime(new HeadCapture());

    await rt.storage.vfs.writeFile('shared/notes.md', 'visible');

    expect(nimbus.content.get('/home/user/shared/notes.md')).toBe('visible');
    expect(parent.calls.map((c) => c.method)).not.toContain('writeWorkspaceFile');
  });

  test("the head's direct workspace writes are attributed to that head", async () => {
    const { facet } = makeFacet({ 'repo/parser.ts': 'one\ntwo\n' });
    await facet.setOwner('user-1', 'pwc_parent');
    await facet.setSharedParent('proteus-main');
    const capture = new HeadCapture();
    const rt = facet.headRuntime(capture);

    const workspace = rt.executionRouter!.getProvider('workspace')!;
    await workspace.tools.readFile.execute('repo/parser.ts');
    await workspace.tools.writeFile.execute('repo/parser.ts', 'one\ntwo\nthree\n');

    expect(capture.files.snapshot()).toEqual([
      { path: 'repo/parser.ts', status: 'changed', added: 1, removed: 0 },
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
