import { Effect } from 'effect';
import { settle } from '@kinu.run/core/obs';
import type { ContextTreeRemote, Memory } from '@kinu.run/core';
import type { NimbusSessionSurface } from '@nimbus-sh/sdk/sandbox';
import type { AgentWorkspace } from './agent-turn';

/** 2026-10-09, workerd 2026-09-30, jobs 20261009183355-6c5db02f / 20261009183400-d64f3c13:
 * awaiting a rejected RpcPromise leaves its pipeline open; disposing that promise closes the relay's Tail as ok.
 * Fulfilled answers can own live stubs or streams, so their disposer belongs to the consumer, not this adapter. */
function workspaceRpcAnswer<T>(pending: Promise<T>): Effect.Effect<T> {
  return Effect.promise(() => pending).pipe(Effect.onError(() => Effect.sync(() => disposeRpc(pending))));
}

/** An answer that is data, read whole once it settles: its pipeline is released then too, so a turn's many calls hold
 *  none of theirs open (2026-10-11, the worker-heap gate: main's isolate allocated 246.8 MB over a 150-step turn, 118.3 MB
 *  once each was released). */
function workspaceRpcData<T>(pending: Promise<T>): Effect.Effect<T> {
  return workspaceRpcAnswer(pending).pipe(Effect.tap(() => Effect.sync(() => { disposeRpc(pending); })));
}

/** What crosses an RPC owning a pipeline or a stub: a pending call, or a served context tree a call answered. */
export type RpcCrossing = Promise<unknown> | ContextTreeRemote;

/** An RPC's disposer, where it crossed with one. Worker RPC's types omit this native method; a promise or an object
 *  made in this isolate has none. */
export function disposeRpc(crossed: RpcCrossing): void {
  if (Symbol.dispose in crossed) {
    const dispose = crossed[Symbol.dispose];

    if (typeof dispose === 'function') dispose.call(crossed);
  }
}

/** The agent's relay to its workspace: the calls whose answers own live capabilities, and the port every other crosses. */
export interface AgentWorkspaceCalls {
  session(): Promise<NimbusSessionSurface>;
  stateSession(): Promise<NimbusSessionSurface>;
  memory(): Promise<Memory>;
  program: AgentWorkspace['program'];
  /** The agent's port: its workspace's host, held across the calls of its work (design v2 §3). */
  port(): Promise<AgentWorkspacePort>;
}

/** What crosses through the held port: every call whose answer is data, not a live capability. */
export type AgentWorkspacePort = Omit<AgentWorkspace, 'session' | 'stateSession' | 'memory' | 'program'>;

/** A capability of the workspace opened for one call and let go once it settles: one held open keeps the workspace
 *  from hibernating (#69). */
function forOneCall<Capability, T>(opening: () => Promise<Capability>, run: (capability: Capability) => Promise<T>): Effect.Effect<T> {
  return Effect.suspend(() => {
    const pending = opening();

    return workspaceRpcAnswer(pending).pipe(
      Effect.flatMap(capability => workspaceRpcAnswer(run(capability))),
      Effect.ensuring(Effect.sync(() => { disposeRpc(pending); })),
    );
  });
}

/**
 * A capability of the workspace the agent holds across the calls of its work, opened by the first and let go as the
 * agent rests: one held open keeps the workspace from hibernating (#69). A call while it rests opens it for itself and
 * lets it go at its edge. One that fails lets it go, as its workspace may have reset under it, and the next opens it
 * again. `owned`: the answer holds live content its consumer reads after (a stream), so its pipeline is the consumer's
 * to release, and what it came through is kept until the agent next rests; any other answer is data, released as it
 * settles.
 */
class Held<Capability> {
  private held: Promise<Capability> | null = null;

  /** The calls on it: it is let go once the agent rests and none is left. */
  private calls = 0;

  constructor(private readonly opening: () => Promise<Capability>, private readonly resting: () => boolean) {}

  call<T>(run: (capability: Capability) => Promise<T>, owned = false): Effect.Effect<T> {
    return Effect.suspend(() => {
      this.held ??= this.opening();
      const opened = this.held;

      this.calls += 1;

      return workspaceRpcAnswer(opened).pipe(
        Effect.flatMap((capability) => (owned ? workspaceRpcAnswer(run(capability)) : workspaceRpcData(run(capability)))),
        Effect.onError(() => Effect.sync(() => {
          if (this.held === opened) this.letGo();
        })),
        Effect.ensuring(Effect.sync(() => {
          this.calls -= 1;

          if (this.resting() && this.calls === 0 && !owned) this.letGo();
        })),
      );
    });
  }

  /** The agent rests: let go now, unless a call is still on it, whose end lets it go. */
  rest(): void {
    if (this.calls === 0) this.letGo();
  }

  letGo(): void {
    const opened = this.held;

    this.held = null;

    if (opened !== null) disposeRpc(opened);
  }
}

/**
 * Nimbus asks for a synchronous session surface for each of its calls and never lets one go. Each call crosses on the
 * session the agent holds while it works: a file operation on it costs the isolate no subrequest of its 10,000, where
 * one opening a session for itself cost one (platform catalog `do.facet.subrequests`). While the agent rests, each call
 * opens the session for itself.
 */
class WorkspaceSession implements NimbusSessionSurface {
  constructor(private readonly session: Held<NimbusSessionSurface>) {}

  [Symbol.dispose](): void {}

  private call<T>(run: (session: NimbusSessionSurface) => Promise<T>, owned = false): Effect.Effect<T> {
    return this.session.call(run, owned);
  }

  _rpcReady(...args: Parameters<NimbusSessionSurface['_rpcReady']>) { return settle(this.call(session => session._rpcReady(...args))); }
  _rpcExecStream(...args: Parameters<NimbusSessionSurface['_rpcExecStream']>) { return settle(this.call(session => session._rpcExecStream(...args), true)); }
  _rpcDetachExec(...args: Parameters<NimbusSessionSurface['_rpcDetachExec']>) { return settle(this.call(session => session._rpcDetachExec(...args))); }
  _rpcStartProcess(...args: Parameters<NimbusSessionSurface['_rpcStartProcess']>) { return settle(this.call(session => session._rpcStartProcess(...args))); }
  _rpcStartProgram(...args: Parameters<NimbusSessionSurface['_rpcStartProgram']>) { return settle(this.call(session => session._rpcStartProgram(...args), true)); }
  _rpcWaitProgram(...args: Parameters<NimbusSessionSurface['_rpcWaitProgram']>) { return settle(this.call(session => session._rpcWaitProgram(...args))); }
  _rpcRunCode(...args: Parameters<NimbusSessionSurface['_rpcRunCode']>) { return settle(this.call(session => session._rpcRunCode(...args))); }
  _rpcReadFile(...args: Parameters<NimbusSessionSurface['_rpcReadFile']>) { return settle(this.call(session => session._rpcReadFile(...args))); }
  _rpcReadFileBytes(...args: Parameters<NimbusSessionSurface['_rpcReadFileBytes']>) { return settle(this.call(session => session._rpcReadFileBytes(...args))); }
  _rpcWriteFile(...args: Parameters<NimbusSessionSurface['_rpcWriteFile']>) { return settle(this.call(session => session._rpcWriteFile(...args))); }
  _rpcWriteFileIfRevision(...args: Parameters<NimbusSessionSurface['_rpcWriteFileIfRevision']>) { return settle(this.call(session => session._rpcWriteFileIfRevision(...args))); }
  _rpcStat(...args: Parameters<NimbusSessionSurface['_rpcStat']>) { return settle(this.call(session => session._rpcStat(...args))); }
  _rpcLstat(...args: Parameters<NimbusSessionSurface['_rpcLstat']>) { return settle(this.call(session => session._rpcLstat(...args))); }
  _rpcReadlink(...args: Parameters<NimbusSessionSurface['_rpcReadlink']>) { return settle(this.call(session => session._rpcReadlink(...args))); }
  _rpcReaddir(...args: Parameters<NimbusSessionSurface['_rpcReaddir']>) { return settle(this.call(session => session._rpcReaddir(...args))); }
  _rpcRename(...args: Parameters<NimbusSessionSurface['_rpcRename']>) { return settle(this.call(session => session._rpcRename(...args))); }
  _rpcChmod(...args: Parameters<NimbusSessionSurface['_rpcChmod']>) { return settle(this.call(session => session._rpcChmod(...args))); }
  _rpcFsReadRange(...args: Parameters<NimbusSessionSurface['_rpcFsReadRange']>) { return settle(this.call(session => session._rpcFsReadRange(...args))); }
  _rpcExists(...args: Parameters<NimbusSessionSurface['_rpcExists']>) { return settle(this.call(session => session._rpcExists(...args))); }
  _rpcMkdir(...args: Parameters<NimbusSessionSurface['_rpcMkdir']>) { return settle(this.call(session => session._rpcMkdir(...args))); }
  _rpcDeleteFile(...args: Parameters<NimbusSessionSurface['_rpcDeleteFile']>) { return settle(this.call(session => session._rpcDeleteFile(...args))); }
  _rpcUnlink(...args: Parameters<NimbusSessionSurface['_rpcUnlink']>) { return settle(this.call(session => session._rpcUnlink(...args))); }
  _rpcRmdir(...args: Parameters<NimbusSessionSurface['_rpcRmdir']>) { return settle(this.call(session => session._rpcRmdir(...args))); }
  _rpcAppendFile(...args: Parameters<NimbusSessionSurface['_rpcAppendFile']>) { return settle(this.call(session => session._rpcAppendFile(...args))); }
  _rpcSymlink(...args: Parameters<NimbusSessionSurface['_rpcSymlink']>) { return settle(this.call(session => session._rpcSymlink(...args))); }
  _rpcRealpath(...args: Parameters<NimbusSessionSurface['_rpcRealpath']>) { return settle(this.call(session => session._rpcRealpath(...args))); }
  _rpcTruncate(...args: Parameters<NimbusSessionSurface['_rpcTruncate']>) { return settle(this.call(session => session._rpcTruncate(...args))); }
  _rpcUtimes(...args: Parameters<NimbusSessionSurface['_rpcUtimes']>) { return settle(this.call(session => session._rpcUtimes(...args))); }
  _rpcChown(...args: Parameters<NimbusSessionSurface['_rpcChown']>) { return settle(this.call(session => session._rpcChown(...args))); }
  _rpcInstallRuntime(...args: Parameters<NimbusSessionSurface['_rpcInstallRuntime']>) { return settle(this.call(session => session._rpcInstallRuntime(...args))); }
  _rpcEnsureRuntimes(...args: Parameters<NimbusSessionSurface['_rpcEnsureRuntimes']>) { return settle(this.call(session => session._rpcEnsureRuntimes(...args))); }
  _rpcListRuntimes() { return settle(this.call(session => session._rpcListRuntimes())); }
  _rpcListProcesses() { return settle(this.call(session => session._rpcListProcesses())); }
  _rpcKillProcess(...args: Parameters<NimbusSessionSurface['_rpcKillProcess']>) { return settle(this.call(session => session._rpcKillProcess(...args))); }
  _rpcWriteProcessInput(...args: Parameters<NimbusSessionSurface['_rpcWriteProcessInput']>) { return settle(this.call(session => session._rpcWriteProcessInput(...args))); }
  _rpcEndProcessInput(...args: Parameters<NimbusSessionSurface['_rpcEndProcessInput']>) { return settle(this.call(session => session._rpcEndProcessInput(...args))); }
  _rpcResizeProcess(...args: Parameters<NimbusSessionSurface['_rpcResizeProcess']>) { return settle(this.call(session => session._rpcResizeProcess(...args))); }
  _rpcSignalProcess(...args: Parameters<NimbusSessionSurface['_rpcSignalProcess']>) { return settle(this.call(session => session._rpcSignalProcess(...args))); }
  _rpcProcessLogs(...args: Parameters<NimbusSessionSurface['_rpcProcessLogs']>) { return settle(this.call(session => session._rpcProcessLogs(...args))); }
  _rpcListTerminals() { return settle(this.call(session => session._rpcListTerminals())); }
  _rpcCloseTerminal(...args: Parameters<NimbusSessionSurface['_rpcCloseTerminal']>) { return settle(this.call(session => session._rpcCloseTerminal(...args))); }
  _rpcListPorts() { return settle(this.call(session => session._rpcListPorts())); }
  _rpcExposePort(...args: Parameters<NimbusSessionSurface['_rpcExposePort']>) { return settle(this.call(session => session._rpcExposePort(...args))); }
  _rpcExposeApp(...args: Parameters<NimbusSessionSurface['_rpcExposeApp']>) { return settle(this.call(session => session._rpcExposeApp(...args))); }
  _rpcListApps() { return settle(this.call(session => session._rpcListApps())); }
  _rpcRotateLink(...args: Parameters<NimbusSessionSurface['_rpcRotateLink']>) { return settle(this.call(session => session._rpcRotateLink(...args))); }
  _rpcRemoveApp(...args: Parameters<NimbusSessionSurface['_rpcRemoveApp']>) { return settle(this.call(session => session._rpcRemoveApp(...args))); }
  _rpcEnsureDurableApp(...args: Parameters<NimbusSessionSurface['_rpcEnsureDurableApp']>) { return settle(this.call(session => session._rpcEnsureDurableApp(...args))); }
  _rpcRemoveDurableApp(...args: Parameters<NimbusSessionSurface['_rpcRemoveDurableApp']>) { return settle(this.call(session => session._rpcRemoveDurableApp(...args))); }
  _rpcUnexposePort(...args: Parameters<NimbusSessionSurface['_rpcUnexposePort']>) { return settle(this.call(session => session._rpcUnexposePort(...args))); }
  _rpcDestroy(...args: Parameters<NimbusSessionSurface['_rpcDestroy']>) { return settle(this.call(session => session._rpcDestroy(...args))); }
}

/** The workspace's memory, opened for each call and let go at its edge: a runtime keeps this for its life. */
class ConsumedMemory implements Memory {
  constructor(private readonly opening: () => Promise<Memory>) {}

  [Symbol.dispose](): void {}

  private call<T>(run: (memory: Memory) => Promise<T>): Effect.Effect<T> {
    return forOneCall(this.opening, run);
  }

  write(...args: Parameters<Memory['write']>) { return settle(this.call(memory => memory.write(...args))); }
  append(...args: Parameters<Memory['append']>) { return settle(this.call(memory => memory.append(...args))); }
  index(...args: Parameters<Memory['index']>) { return settle(this.call(memory => memory.index(...args))); }
  search(...args: Parameters<Memory['search']>) { return settle(this.call(memory => memory.search(...args))); }
  read(...args: Parameters<Memory['read']>) { return settle(this.call(memory => memory.read(...args))); }
  chunk(...args: Parameters<Memory['chunk']>) { return settle(this.call(memory => memory.chunk(...args))); }
  tail(...args: Parameters<Memory['tail']>) { return settle(this.call(memory => memory.tail(...args))); }
}

/** The agent's workspace as its isolate calls it, held open only while the agent works. */
export interface WorkspaceClient extends AgentWorkspace, Disposable {
  /** The agent works: the port its calls open is held across them. */
  work(): void;
  /** The agent rests: its port is let go once no call is on it, and each call until it works again opens its own. */
  rest(): void;
}

/**
 * All outgoing WORKSPACE calls cross the same consumption boundary, including chat, tools, pacing and credentials. Those
 * whose answer is data cross once, through the agent's port; file operations cross on its two sessions. Each is
 * {@link Held} across the calls of its work and let go when it rests. Memory and a program's callbacks own live
 * capabilities: each opens its own host, which lets them go at its edge.
 */
export function workspaceClient(workspace: AgentWorkspaceCalls): WorkspaceClient {
  // An isolate starts at rest: what its workspace asks of it before a turn opens holds nothing open after.
  let resting = true;
  const isResting = (): boolean => resting;

  const portHeld = new Held(() => workspace.port(), isResting);
  const filePlane = new Held(() => workspace.session(), isResting);
  const statePlane = new Held(() => workspace.stateSession(), isResting);
  const held = [portHeld, filePlane, statePlane];
  const files = new WorkspaceSession(filePlane);
  const state = new WorkspaceSession(statePlane);

  /** `owned`: the answer holds live content its consumer reads after (a relayed response's body). */
  const viaPort = <T>(call: (opened: AgentWorkspacePort) => Promise<T>, owned = false): Effect.Effect<T> => portHeld.call(call, owned);

  return {
    work: () => { resting = false; },
    rest: () => {
      resting = true;

      for (const each of held) each.rest();
    },
    [Symbol.dispose]: () => {
      for (const each of held) each.letGo();
    },
    session: () => files,
    stateSession: () => state,
    memory: () => new ConsumedMemory(() => workspace.memory()),
    program: (...args) => settle(workspaceRpcAnswer(workspace.program(...args))),
    traceTurn: (...args) => settle(viaPort((port) => port.traceTurn(...args))),
    traceStream: (...args) => settle(viaPort((port) => port.traceStream(...args))),
    resume: (...args) => settle(viaPort((port) => port.resume(...args))),
    guard: (...args) => settle(viaPort((port) => port.guard(...args))),
    debit: (...args) => settle(viaPort((port) => port.debit(...args))),
    prepareTurn: (...args) => settle(viaPort((port) => port.prepareTurn(...args))),
    prepareChat: (...args) => settle(viaPort((port) => port.prepareChat(...args))),
    scaffold: () => settle(viaPort((port) => port.scaffold())),
    chatEvent: (...args) => settle(viaPort((port) => port.chatEvent(...args))),
    turnEnded: (...args) => settle(viaPort((port) => port.turnEnded(...args))),
    answerAmended: (...args) => settle(viaPort((port) => port.answerAmended(...args))),
    turnSettled: (...args) => settle(viaPort((port) => port.turnSettled(...args))),
    runSettled: (...args) => settle(viaPort((port) => port.runSettled(...args))),
    turnReport: (...args) => settle(viaPort((port) => port.turnReport(...args))),
    parentReport: (...args) => settle(viaPort((port) => port.parentReport(...args))),
    autoTitle: (...args) => settle(viaPort((port) => port.autoTitle(...args))),
    hireAdvisor: (...args) => settle(viaPort((port) => port.hireAdvisor(...args))),
    owes: (...args) => settle(viaPort((port) => port.owes(...args))),
    birthContext: (...args) => settle(viaPort((port) => port.birthContext(...args))),
    steerSkills: (...args) => settle(viaPort((port) => port.steerSkills(...args))),
    releaseForeground: (...args) => settle(viaPort((port) => port.releaseForeground(...args))),
    openWork: () => settle(viaPort((port) => port.openWork())),
    armCacheWarm: (...args) => settle(viaPort((port) => port.armCacheWarm(...args))),
    enqueueTurn: (...args) => settle(viaPort((port) => port.enqueueTurn(...args))),
    executeTool: (...args) => settle(viaPort((port) => port.executeTool(...args))),
    receipts: (...args) => settle(viaPort((port) => port.receipts(...args))),
    observe: (...args) => settle(viaPort((port) => port.observe(...args))),
    paceStep: (...args) => settle(viaPort((port) => port.paceStep(...args))),
    answerMetadata: (...args) => settle(viaPort((port) => port.answerMetadata(...args))),
    getAuth: (...args) => settle(viaPort((port) => port.getAuth(...args))),
    listCredentials: () => settle(viaPort((port) => port.listCredentials())),
    relayDevice: (...args) => settle(viaPort((port) => port.relayDevice(...args))),
    relayModelCall: (...args) => settle(viaPort((port) => port.relayModelCall(...args), true)),
    cancelModelRelay: (...args) => settle(viaPort((port) => port.cancelModelRelay(...args))),
    sayToParent: (...args) => settle(viaPort((port) => port.sayToParent(...args))),
    logActivity: (...args) => settle(viaPort((port) => port.logActivity(...args))),
    reportModelCall: (...args) => settle(viaPort((port) => port.reportModelCall(...args))),
  };
}
