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
import type { WorkspaceBoxOp, WorkspaceBoxResult } from '../src/workspace-box-rpc';
import {
  BUILTIN_PROFILE_CATALOG,
  CRAFT_NEUTRAL_PRIOR,
  HeadCapture,
  profileCatalogDigest,
  resolveTurnProfile,
  type ResolvedTurnProfile,
  type HeadId,
  type HeadInput,
  type HeadReport,
  type ParentRpcWrite,
  type SqlExecRow,
  type SqlValue,
} from '@kinu.run/core';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { platformGatewayEnv } from './helpers/platform-gateway';
import * as v from 'valibot';

mockAgentsSdk();

/** The sandbox id the runtime asked for — the observable proof that a head
 *  rides the PARENT workspace's container rather than a fresh one of its own. */
let requestedSandboxId: string | null = null;
const lastRequestedSandboxId = (): string | null => requestedSandboxId;
/** Restores performed through the handle the runtime built. A head rides a
 *  container it does not own, so this must stay at zero however it is touched. */
let restoresPerformed = 0;
let egressConfigured = 0;
// Keep the REAL module for everything this file does not fake: the mock is
// process-wide, and a missing `proxyToSandbox`/`Sandbox` export is a load-time
// failure for whichever later file binds them.
import * as actualSandboxSdk from '@cloudflare/sandbox';
await mock.module('@cloudflare/sandbox', () => ({
  ...actualSandboxSdk,
  getSandbox: (_ns: DurableObjectNamespace, id: string) => {
    requestedSandboxId = id;
    return {
      ensureReady: async () => {},
      // A command with no caller-set deadline takes the PROCESS lane, so the
      // double has to be able to run one: `exec` here is the SDK's bounded
      // lane and is deliberately not what the handle reaches.
      startProcess: async () => ({
        id: 'p1',
        exitCode: 0,
        waitForExit: async () => ({ exitCode: 0 }),
        getStatus: async () => 'exited',
      }),
      getProcessLogs: async () => ({ stdout: '', stderr: '' }),
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
      // Egress interception is configured before the container can run
      // anything, so every handle-backed operation reaches this. Recorded
      // rather than ignored: a facet must ride the configuration its ROOT
      // installed, so a head configuring the container would be a defect of
      // the same shape as a head deciding its restore.
      configureEgress: async () => { egressConfigured += 1; },
    };
  },
}));

const { ExplorationAgent } = await import('../src/exploration');

function nativeBindings(values: SqlValue[]): SQLQueryBindings[] {
  return values.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
}

function profileFixture(providerRevision: string): ResolvedTurnProfile {
  return resolveTurnProfile({
    envelope: {
      authority: { kind: 'account', accountId: 'acct-1' },
      version: 1,
      digest: profileCatalogDigest(BUILTIN_PROFILE_CATALOG),
      catalog: BUILTIN_PROFILE_CATALOG,
    },
    provider: {
      revision: providerRevision,
      availableModels: [BUILTIN_PROFILE_CATALOG.tiers.default.model],
    },
    roleId: 'general',
    workMode: 'build',
    availableTools: [],
    activeSkills: [],
  });
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
  /**
   * The workspace as a facet now reaches it: ONE op over ONE RPC into the
   * orchestrator that holds the filesystem. The `_rpc*` shapes above are the
   * same in-memory tree, kept because the ops are answered from them — a head
   * reading its parent's SOUL.md and one grepping its parent's tree exercise the
   * same rows either way.
   */
  const boxOp = async (shellId: string, op: WorkspaceBoxOp): Promise<WorkspaceBoxResult> => {
    switch (op.op) {
      case 'ready': return undefined;
      case 'exec': return await stub._rpcExec(op.command, { shellId });
      case 'files.read': return await stub._rpcReadFile(op.path);
      case 'files.readBytes': return await stub._rpcReadFileBytes(op.path);
      case 'files.write': await stub._rpcWriteFile(op.path, op.content); return undefined;
      case 'files.list': return await stub._rpcReaddir(op.path ?? '/');
      case 'files.stat': return await stub._rpcStat(op.path);
      case 'files.lstat': return await stub._rpcStat(op.path);
      case 'files.exists': return await stub._rpcExists(op.path);
      case 'files.mkdir': await stub._rpcMkdir(op.path); return undefined;
      case 'files.delete': await stub._rpcDeleteFile(op.path); return undefined;
      default:
        throw new Error(`this fixture's workspace does not answer ${op.op}`);
    }
  };
  return {
    binding: { idFromName: (name: string) => name, get: () => stub },
    boxOp,
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
  facetProfile(): Promise<ResolvedTurnProfile>;
  initHead(input: HeadInput): Promise<{ ok: true; id: HeadId }>;
  runAsHead(): Promise<HeadReport>;
  headRuntime(capture: HeadCapture): import('../src/runtime').CFRuntime;
}

const HeadRuntimeProbeSchema = v.object({
  storage: v.object({ vfs: v.object({ writeFile: v.function() }) }),
  executionRouter: v.object({
    getProvider: v.function(),
    listExecutors: v.function(),
  }),
});

/** A facet over its own fresh storage, or, with `existingDb`, a SECOND facet
 *  instance over storage a first one already wrote. That second form is a COLD
 *  ACTIVATION: no instance fields, the same durable rows, which is exactly what
 *  the platform hands back after an eviction between two RPCs. */
function makeFacet(
  parentFiles: Record<string, string> = {},
  existingDb?: Database,
  parentProfiles: Readonly<Record<string, ResolvedTurnProfile>> = {},
) {
  const db = existingDb ?? new Database(':memory:');
  const parent = makeParentWorkspace(parentFiles);
  const nimbus = makeNimbusNamespace(parentFiles);
  const profileCalls: string[] = [];
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
    Sandbox: {},
    PREVIEW_HOST_SUFFIX: 'preview.test',
    ...platformGatewayEnv(),
    OrchestratorAgent: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        ...parent.stub,
        // The workspace's byte plane, which after the one-DO cutover is reached
        // here and nowhere else.
        workspaceBoxOp: (shellId: string, op: WorkspaceBoxOp) => nimbus.boxOp(shellId, op),
        facetTurnProfile: async (): Promise<ResolvedTurnProfile> => {
          profileCalls.push(name);
          const profile = parentProfiles[name];
          if (!profile) throw new Error(`no profile fixture for ${name}`);
          return profile;
        },
      }),
    },
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
  const facetProfileMember = Object.getOwnPropertyDescriptor(
    ExplorationAgent.prototype,
    'facetProfile',
  )?.value;
  if (!v.is(v.function(), facetProfileMember)) throw new Error('ExplorationAgent facetProfile seam is missing');
  Object.defineProperty(concrete, 'name', { value: 'head-1', configurable: true });
  const facet: Facet = {
    setOwner: concrete.setOwner.bind(concrete),
    setSharedParent: concrete.setSharedParent.bind(concrete),
    facetProfile: (): Promise<ResolvedTurnProfile> => {
      const profile = facetProfileMember.call(concrete);
      if (!(profile instanceof Promise)) throw new Error('facetProfile returned a non-promise');
      // SAFETY: the private seam's declared return is Promise<ResolvedTurnProfile>.
      return profile as Promise<ResolvedTurnProfile>;
    },
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
  return { facet, parent, nimbus, db, profileCalls };
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
    await facet.setSharedParent('kinu-main');

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
    await facet.setSharedParent('kinu-main');

    const workspace = facet.headRuntime(new HeadCapture()).executionRouter!.getProvider('workspace')!;
    const names = v.parse(v.array(v.string()), await workspace.tools.readdir.execute('repo'));
    expect(names.sort()).toEqual(['package.json', 'src']);
  });

  test("searching the workspace is one real shell call, not an RPC file walk", async () => {
    const { facet, parent, nimbus } = makeFacet({ 'repo/a.ts': 'needle here', 'repo/b.ts': 'nothing' });
    await facet.setOwner('user-1', 'pwc_parent');
    await facet.setSharedParent('kinu-main');

    const workspace = facet.headRuntime(new HeadCapture()).executionRouter!.getProvider('workspace')!;
    const found = await workspace.tools.exec.execute('grep -rl needle .');

    expect(String(found)).toContain('repo/a.ts');
    expect(parent.calls).toHaveLength(0);
    // The head's OWN durable shell, named in the RPC argument. `shellRoot` is
    // gone with the remote sandbox that used to stamp it: a named shell over a
    // library-held workspace starts in that workspace's own root.
    expect(nimbus.execOptions).toContainEqual({ shellId: 'head:head-1' });
  });

  test('exec planes are keyed to the PARENT workspace, not the head facet', async () => {
    requestedSandboxId = null;
    const { facet } = makeFacet();
    await facet.setOwner('user-1', 'pwc_parent');
    await facet.setSharedParent('kinu-main');

    facet.headRuntime(new HeadCapture());

    // The container the parent agent works in — `kinu-${workspaceName}` in
    // runtime.ts — and emphatically not `kinu-head-1`.
    expect(lastRequestedSandboxId()).toBe('kinu-kinu-main');
  });

  test('a head never decides the restore of the container it only rides', async () => {
    restoresPerformed = 0;
    const { facet, db } = makeFacet();
    await facet.setOwner('user-1', 'pwc_parent');
    await facet.setSharedParent('kinu-main');

    const rt = facet.headRuntime(new HeadCapture());
    // A backup handle on the FACET's own storage — `agent_config` is created by
    // the runtime above, and the restore is read at first touch, not at build.
    // It is not the shared container's history: `kinu-kinu-main` belongs to
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
    await facet.setSharedParent('kinu-main');
    const rt = facet.headRuntime(new HeadCapture());

    await rt.storage.vfs.writeFile('shared/notes.md', 'visible');

    expect(nimbus.content.get('/home/user/shared/notes.md')).toBe('visible');
    expect(parent.calls.map((c) => c.method)).not.toContain('writeWorkspaceFile');
  });

  test("the head's direct workspace writes are attributed to that head", async () => {
    const { facet } = makeFacet({ 'repo/parser.ts': 'one\ntwo\n' });
    await facet.setOwner('user-1', 'pwc_parent');
    await facet.setSharedParent('kinu-main');
    const capture = new HeadCapture();
    const rt = facet.headRuntime(capture);

    const workspace = rt.executionRouter!.getProvider('workspace')!;
    await workspace.tools.readFile.execute('repo/parser.ts');
    await workspace.tools.writeFile.execute('repo/parser.ts', 'one\ntwo\nthree\n');

    expect(capture.files.snapshot()).toEqual([
      { path: 'repo/parser.ts', status: 'changed', added: 1, removed: 0 },
    ]);
  });

  /**
   * A head's SQL ledgers are its FACET's own storage, and `initWorkspaceSchema`
   * runs on no facet that only explores — so the runtime that builds the head's
   * `workspace.*` plane is the only thing that can provision what that plane
   * reads. `listTools` reads the crafted-tool quality columns ON `crafted_tools`
   * and `createTool` seeds them, so with the memory and craft stores alone a
   * head raised `no such table: crafted_tools` on its first call. Pinned on both
   * backends: the CLI head hit exactly this inside a paid delegation run.
   */
  test("the head's own workspace plane scores the tools it crafts", async () => {
    const { facet } = makeFacet();
    await facet.setOwner('user-1', 'pwc_parent');
    await facet.setSharedParent('kinu-main');

    const workspace = facet.headRuntime(new HeadCapture()).executionRouter!.getProvider('workspace')!;

    expect(await workspace.tools.listTools.execute()).toEqual([]);
    expect(await workspace.tools.createTool.execute(
      'echo_back', 'Return its argument.', 'async (args) => args',
    )).toEqual({ ok: true, name: 'echo_back', action: 'created' });
    expect(await workspace.tools.listTools.execute()).toEqual([
      { name: 'echo_back', description: 'Return its argument.', qualityScore: CRAFT_NEUTRAL_PRIOR },
    ]);
  });

  test('a reseeded parent never reuses the former root profile', async () => {
    const firstProfile = profileFixture('root-first');
    const secondProfile = profileFixture('root-second');
    const { facet, profileCalls } = makeFacet({}, undefined, {
      'root-first': firstProfile,
      'root-second': secondProfile,
    });

    await facet.setSharedParent('root-first');
    expect(await facet.facetProfile()).toBe(firstProfile);

    await facet.setSharedParent('root-second');
    expect(await facet.facetProfile()).toBe(secondProfile);
    expect(profileCalls).toEqual(['root-first', 'root-second']);
  });
  test('an MCTS branch — seeded without a parent workspace — cannot fork at all', async () => {
    // spawnBranchFacet seeds setOwner and nothing else (unit-facet-spawn), so a
    // branch reaches this state and can never acquire the head runtime.
    const { facet } = makeFacet();
    await facet.setOwner('user-1', 'pwc_parent');
    await facet.initHead(headInput());

    await expect(facet.runAsHead()).rejects.toThrow('without a parent workspace');
  });

  test('a facet evicted between initHead and runAsHead activates from its stored row', async () => {
    // `facet-spawn.ts` states the contract every bootstrap RPC owes: it persists,
    // so a facet hibernating between spawn and run recovers. `setOwner` and
    // `setSharedParent` honoured it through FacetIdentity; `initHead` kept its
    // input on the instance alone, so an eviction in that window left an
    // ACKNOWLEDGED bootstrap with nothing behind it and `runAsHead` threw
    // "called before initHead()". The cost was not one head: `HeadController.run`
    // awaits its heads together, so one such throw rejected the whole split,
    // discarding siblings that had already spent their tokens.
    const first = makeFacet();
    await first.facet.setOwner('user-1', 'pwc_parent');
    await first.facet.initHead(headInput());

    // THE EVICTION: a second instance over the same durable storage. No instance
    // fields, the same rows — which is exactly what the platform hands back.
    const cold = makeFacet({}, first.db);

    // Past the guard is the whole assertion. It still refuses, but for the
    // reason the case above establishes for a head with no shared parent — not
    // for a bootstrap it has no memory of.
    await expect(cold.facet.runAsHead()).rejects.toThrow('without a parent workspace');
  });

  test('a stored activation that no longer matches its schema refuses by name', async () => {
    // The row was written by an EARLIER activation, so a shape that has since
    // changed is a real condition on this path rather than an impossible one. It
    // has to fail here, naming the mismatch, instead of reaching the run loop
    // with a half-formed work spec.
    const first = makeFacet();
    await first.facet.setOwner('user-1', 'pwc_parent');
    await first.facet.initHead(headInput());
    first.db.prepare(`UPDATE facet_activation SET payload = ? WHERE id = 1`)
      .run(JSON.stringify({ kind: 'head', input: { id: 'head-1' } }));

    const cold = makeFacet({}, first.db);
    await expect(cold.facet.runAsHead()).rejects.toThrow('does not match the stored work spec');
  });
});
