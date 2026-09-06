/**
 * A facet's window onto the workspace its orchestrator owns.
 *
 * A subordinate or an exploration head runs in its own Durable Object facet with
 * its own SQLite — private ledgers, a private scaffold, a private transcript —
 * and SHARES the workspace: the same SOUL.md, the same `memory/`, the same tree.
 * With Nimbus held as a library in the orchestrator's own object, "the same
 * tree" means one Durable Object hop, so this module is that hop and nothing
 * else.
 *
 * ONE RPC NAME, ONE UNION. The whole `NimbusSandboxHandle` crosses through
 * `workspaceBoxOp`, rather than thirty methods on the orchestrator's public
 * surface. Every argument and every result is structured-clone-safe by
 * construction (strings, numbers, plain records, `Uint8Array`), the op names are
 * a closed set the compiler checks against the result map below, and the
 * orchestrator's RPC allow-list has one entry to review instead of thirty.
 *
 * WHO MAY CALL IT. Another Durable Object in this Worker, and nothing else. It
 * is deliberately NOT `@callable`: `NimbusExecOptions.cred` names a uid, so a
 * browser socket that could reach this could run a command as uid 0. That is the
 * same boundary the arrangement it replaces had — a facet reached the workspace's
 * session object directly and stamped the same credential — and it is enforced
 * the same way, by absence from the callable surface.
 */

import type {
  NimbusExecOptions, NimbusExecResult, NimbusPortInfo, NimbusSandboxHandle, NimbusStartResult,
  JsonValue, GadgetCallResult, GadgetBindingRequest, SlateCallResult, SlateBindingRequest,
} from '@kinu.run/core';

type BoxFiles = NimbusSandboxHandle['files'];
type BoxPorts = NonNullable<NimbusSandboxHandle['ports']>;

/** The language/install pair `runCode` accepts, named because the op union and
 *  the handle's own optional parameter must not drift. */
export type WorkspaceRunCodeOptions = NimbusExecOptions & {
  language?: 'javascript' | 'typescript' | 'python' | 'ruby' | 'shell';
  install?: 'never' | 'ifMissing';
};

export type WorkspaceBoxOp =
  | { op: 'ready' }
  | { op: 'exec'; command: string; options?: NimbusExecOptions }
  | { op: 'startProcess'; command: string; options?: NimbusExecOptions }
  | { op: 'runCode'; code: string; options?: WorkspaceRunCodeOptions }
  | { op: 'files.read'; path: string }
  | { op: 'files.readBytes'; path: string }
  | { op: 'files.readRange'; path: string; offset: number; length: number }
  | { op: 'files.write'; path: string; content: string | Uint8Array }
  | { op: 'files.stat'; path: string }
  | { op: 'files.lstat'; path: string }
  | { op: 'files.rename'; from: string; to: string }
  | { op: 'files.chmod'; path: string; mode: number }
  | { op: 'files.list'; path?: string }
  | { op: 'files.exists'; path: string }
  | { op: 'files.mkdir'; path: string }
  | { op: 'files.delete'; path: string; options?: { recursive?: boolean } }
  | { op: 'runtimes.ensure'; specs: readonly string[]; options?: { force?: boolean } }
  | { op: 'runtimes.install'; spec: string; options?: { force?: boolean } }
  | { op: 'runtimes.list' }
  | { op: 'processes.list' }
  | { op: 'processes.kill'; pid: number }
  | { op: 'processes.logs'; pid: number; options?: { lines?: number; bytes?: number } }
  | { op: 'ports.expose'; port: number }
  | { op: 'ports.unexpose'; port: number }
  | { op: 'ports.list' };

/** What each op answers with. Keyed by the op name so the client's return type
 *  is derived rather than restated, which is what stops a caller reading an
 *  `exec` result off a `stat`. */
export interface WorkspaceBoxResults {
  'ready': undefined;
  'exec': NimbusExecResult;
  'startProcess': NimbusStartResult;
  'runCode': NimbusExecResult;
  'files.read': string | null;
  'files.readBytes': Uint8Array | null;
  'files.readRange': Awaited<ReturnType<NonNullable<BoxFiles['readRange']>>>;
  'files.write': undefined;
  'files.stat': Awaited<ReturnType<NonNullable<BoxFiles['stat']>>>;
  'files.lstat': Awaited<ReturnType<NonNullable<BoxFiles['lstat']>>>;
  'files.rename': undefined;
  'files.chmod': undefined;
  'files.list': Awaited<ReturnType<BoxFiles['list']>>;
  'files.exists': boolean;
  'files.mkdir': undefined;
  'files.delete': undefined;
  'runtimes.ensure': JsonValue | undefined;
  'runtimes.install': JsonValue | undefined;
  'runtimes.list': JsonValue | undefined;
  'processes.list': JsonValue | undefined;
  'processes.kill': JsonValue | undefined;
  'processes.logs': JsonValue | undefined;
  'ports.expose': Awaited<ReturnType<NonNullable<BoxPorts['expose']>>>;
  'ports.unexpose': JsonValue | undefined;
  'ports.list': Awaited<ReturnType<NonNullable<BoxPorts['list']>>>;
}

/** Any op's answer — what the CLASS METHOD itself is typed as. The RPC crossing
 *  is deliberately MONOMORPHIC on the Durable Object: a generic method on the
 *  real `DurableObjectStub<OrchestratorAgent>` makes the SDK's mapped stub type
 *  recurse through every op variant, which TypeScript reports as "type
 *  instantiation is excessively deep". The narrowing lives on
 *  {@link WorkspaceBoxRpc}, whose only production instance is minted by the
 *  declared cast in {@link workspaceOwner}. */
export type WorkspaceBoxResult = WorkspaceBoxResults[WorkspaceBoxOp['op']];

/** The orchestrator method this module's two halves meet at, typed per op so a
 *  caller's return type is derived from {@link WorkspaceBoxResults} rather than
 *  narrowed at thirty call sites. Declared as an interface so a facet can hold
 *  a narrowed stub and a test can hold a fake. */
export interface WorkspaceBoxRpc {
  workspaceBoxOp<Op extends WorkspaceBoxOp>(
    shellId: string, op: Op,
  ): Promise<WorkspaceBoxResults[Op['op']]>;
}

/**
 * Every method a caller in this Worker reaches on the object that owns a
 * workspace, as one named owner contract: the file-plane op a facet makes,
 * and the two gadget calls a binding entrypoint or a facet actor makes.
 * Declared here, beside the narrowing that hands it out, so the concrete
 * type is constructed once and each caller takes the slice it needs.
 */
export interface WorkspaceOwnerRpc extends WorkspaceBoxRpc {
  gadgetCall(slug: string, method: string, args: JsonValue[]): Promise<GadgetCallResult>;
  /** The request as the process sent it; the host parses it (`GadgetHost.bindingCall`). */
  gadgetBindingCall(slug: string, name: string, request: GadgetBindingRequest): Promise<GadgetCallResult>;
  slateBindingCall(id: string, name: string, request: SlateBindingRequest): Promise<SlateCallResult>;
}

interface WorkspaceOwnerNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): WorkspaceOwnerRpc;
}

/**
 * The object that owns one workspace's bytes, as the methods a caller in this
 * Worker needs of it.
 *
 * Narrowed the way `userDOStubFor` narrows the UserDO binding, and for the same
 * reason: instantiating `DurableObjectStub<OrchestratorAgent>` here makes the
 * SDK's mapped stub type walk that class's entire RPC surface, which TypeScript
 * gives up on ("type instantiation is excessively deep"). The narrow view also
 * says what a caller may reach, which is exactly this.
 */
export function workspaceOwner(
  env: { OrchestratorAgent: Pick<DurableObjectNamespace, 'idFromName' | 'get'> },
  workspaceName: string,
): WorkspaceOwnerRpc {
  const view: Partial<WorkspaceOwnerNamespace> = {};
  Object.assign(view, {
    idFromName: (name: string) => env.OrchestratorAgent.idFromName(name),
    get: (id: DurableObjectId) => env.OrchestratorAgent.get(id),
  });
  // SAFETY: the view above is constructed with exactly the two members
  // WorkspaceOwnerNamespace declares, and orchestrator.ts declares
  // `workspaceBoxOp` delegating to `applyWorkspaceBoxOp` — whose switch answers
  // every op with the `WorkspaceBoxResults` member keyed by that op's own name,
  // the correspondence the interface's generic promises — and `gadgetCall` and
  // `gadgetBindingCall` with these signatures, delegating to `GadgetHost`.
  const namespace = view as WorkspaceOwnerNamespace;
  return namespace.get(namespace.idFromName(workspaceName));
}

/** The one method a facet needs of the object that owns its workspace. */
export function workspaceBoxOwner(
  env: { OrchestratorAgent: Pick<DurableObjectNamespace, 'idFromName' | 'get'> },
  workspaceName: string,
): WorkspaceBoxRpc {
  return workspaceOwner(env, workspaceName);
}

/**
 * A surface a handle does not carry is a fault and not an empty answer.
 *
 * Every box the workspace host builds carries all of these; the interface makes
 * them optional because a NARROWER handle is expressible, and a narrower handle
 * reaching this dispatcher means the owner composed something it should not have.
 */
function required<T>(surface: T | undefined, name: string): T {
  if (!surface) throw new Error(`the hosted workspace box has no ${name} surface`);
  return surface;
}

/**
 * Run one op against the workspace box that owns the bytes.
 *
 * The orchestrator's `workspaceBoxOp` is a one-line delegator to this, so the
 * dispatch table lives beside the union it dispatches and a new op cannot be
 * added without a branch.
 */
export async function applyWorkspaceBoxOp(
  box: NimbusSandboxHandle, op: WorkspaceBoxOp,
): Promise<WorkspaceBoxResult> {
  const files = box.files;
  switch (op.op) {
    case 'ready': await box.ready(); return undefined;
    case 'exec': return await box.exec(op.command, op.options);
    case 'startProcess':
      return await required(box.startProcess, 'startProcess')(op.command, op.options);
    case 'runCode': return await required(box.runCode, 'runCode')(op.code, op.options);
    case 'files.read': return await files.read(op.path);
    case 'files.readRange':
      return await required(files.readRange, 'files.readRange')(op.path, op.offset, op.length);
    case 'files.readBytes': return await required(files.readBytes, 'files.readBytes')(op.path);
    case 'files.write': await files.write(op.path, op.content); return undefined;
    case 'files.stat': return await required(files.stat, 'files.stat')(op.path);
    case 'files.lstat': return await required(files.lstat, 'files.lstat')(op.path);
    case 'files.rename': await required(files.rename, 'files.rename')(op.from, op.to); return undefined;
    case 'files.chmod': await required(files.chmod, 'files.chmod')(op.path, op.mode); return undefined;
    case 'files.list': return await files.list(op.path);
    case 'files.exists': return await files.exists(op.path);
    case 'files.mkdir': await required(files.mkdir, 'files.mkdir')(op.path); return undefined;
    case 'files.delete': await files.delete(op.path, op.options); return undefined;
    case 'runtimes.ensure':
      return await required(box.runtimes?.ensure, 'runtimes.ensure')([...op.specs], op.options);
    case 'runtimes.install':
      return await required(box.runtimes?.install, 'runtimes.install')(op.spec, op.options);
    case 'runtimes.list': return await required(box.runtimes?.list, 'runtimes.list')();
    case 'processes.list': return await required(box.processes?.list, 'processes.list')();
    case 'processes.kill': return await required(box.processes?.kill, 'processes.kill')(op.pid);
    case 'processes.logs':
      return await required(box.processes?.logs, 'processes.logs')(op.pid, op.options);
    case 'ports.expose': return await required(box.ports?.expose, 'ports.expose')(op.port);
    case 'ports.unexpose': return await required(box.ports?.unexpose, 'ports.unexpose')(op.port);
    case 'ports.list': return await required(box.ports?.list, 'ports.list')();
  }
}

/**
 * The same `NimbusSandboxHandle`, one Durable Object hop away.
 *
 * `owner` is resolved per call rather than captured: a facet's stub is derived
 * from the workspace name it was seeded with, and a facet that has not been
 * seeded yet must fail with that sentence rather than with a null dereference
 * thirty methods deep.
 */
export function createWorkspaceBoxClient(deps: {
  owner: () => WorkspaceBoxRpc;
  shellId: string;
}): NimbusSandboxHandle {
  const call = <Op extends WorkspaceBoxOp>(op: Op): Promise<WorkspaceBoxResults[Op['op']]> =>
    deps.owner().workspaceBoxOp(deps.shellId, op);
  return {
    ready: async () => { await call({ op: 'ready' }); },
    exec: (command, options) => call({ op: 'exec', command, options }),
    startProcess: (command, options) => call({ op: 'startProcess', command, options }),
    runCode: (code, options) => call({ op: 'runCode', code, options }),
    files: {
      read: (path) => call({ op: 'files.read', path }),
      readRange: (path, offset, length) => call({ op: 'files.readRange', path, offset, length }),
      readBytes: (path) => call({ op: 'files.readBytes', path }),
      write: async (path, content) => { await call({ op: 'files.write', path, content }); },
      stat: (path) => call({ op: 'files.stat', path }),
      lstat: (path) => call({ op: 'files.lstat', path }),
      rename: async (from, to) => { await call({ op: 'files.rename', from, to }); },
      chmod: async (path, mode) => { await call({ op: 'files.chmod', path, mode }); },
      list: (path) => call({ op: 'files.list', path }),
      exists: (path) => call({ op: 'files.exists', path }),
      mkdir: async (path) => { await call({ op: 'files.mkdir', path }); },
      delete: async (path, options) => { await call({ op: 'files.delete', path, options }); },
    },
    runtimes: {
      ensure: (specs, options) => call({
        op: 'runtimes.ensure',
        specs: Array.isArray(specs) ? specs : [specs],
        options,
      }),
      install: (spec, options) => call({ op: 'runtimes.install', spec, options }),
      list: () => call({ op: 'runtimes.list' }),
    },
    processes: {
      list: () => call({ op: 'processes.list' }),
      kill: (pid) => call({ op: 'processes.kill', pid }),
      logs: (pid, options) => call({ op: 'processes.logs', pid, options }),
    },
    ports: {
      expose: (port) => call({ op: 'ports.expose', port }),
      unexpose: (port) => call({ op: 'ports.unexpose', port }),
      list: (): Promise<Array<NimbusPortInfo & { url?: string }>> => call({ op: 'ports.list' }),
    },
  };
}
