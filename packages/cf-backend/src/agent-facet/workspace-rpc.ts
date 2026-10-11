import { Effect } from 'effect';
import { settle } from '@kinu.run/core/obs';
import type { Memory } from '@kinu.run/core';
import type { NimbusSessionSurface } from '@nimbus-sh/sdk/sandbox';
import type { AgentWorkspace } from './agent-turn';

/** 2026-10-09, workerd 2026-09-30, jobs 20261009183355-6c5db02f / 20261009183400-d64f3c13:
 * awaiting a rejected RpcPromise leaves its pipeline open; disposing that promise closes the relay's Tail as ok.
 * Fulfilled answers can own live stubs or streams, so their disposer belongs to the consumer, not this adapter. */
function workspaceRpcAnswer<T>(pending: Promise<T>): Effect.Effect<T> {
  return Effect.promise(() => pending).pipe(Effect.onError(() => Effect.sync(() => disposeWorkspaceRpc(pending))));
}

function disposeWorkspaceRpc<T>(pending: Promise<T>): void {
  // Worker RPC's Promise type omits this native method; ordinary in-isolate promises have no pipeline to release.
  if (Symbol.dispose in pending) {
    const dispose = pending[Symbol.dispose];

    if (typeof dispose === 'function') dispose.call(pending);
  }
}

export interface AgentWorkspaceCalls extends Omit<AgentWorkspace, 'session' | 'stateSession' | 'memory'> {
  session(): Promise<NimbusSessionSurface>;
  stateSession(): Promise<NimbusSessionSurface>;
  memory(): Promise<Memory>;
  /** The agent's port: its workspace's host, held across calls (design v2 §3). */
  port(): Promise<AgentWorkspacePort>;
}

/** What crosses through the held port: every call whose answer is data, not a live capability. */
export type AgentWorkspacePort = Omit<AgentWorkspaceCalls, 'session' | 'stateSession' | 'memory' | 'program' | 'port'>;

/** Nimbus opens a synchronous session surface; its methods first consume the factory's own RpcPromise. */
class WorkspaceSession implements NimbusSessionSurface {
  constructor(private readonly pending: Promise<NimbusSessionSurface>) {}

  [Symbol.dispose](): void { disposeWorkspaceRpc(this.pending); }

  private call<T>(run: (session: NimbusSessionSurface) => Promise<T>): Effect.Effect<T> {
    return workspaceRpcAnswer(this.pending).pipe(Effect.flatMap(session => workspaceRpcAnswer(run(session))));
  }

  _rpcReady(...args: Parameters<NimbusSessionSurface['_rpcReady']>) { return settle(this.call(session => session._rpcReady(...args))); }
  _rpcExecStream(...args: Parameters<NimbusSessionSurface['_rpcExecStream']>) { return settle(this.call(session => session._rpcExecStream(...args))); }
  _rpcStartProcess(...args: Parameters<NimbusSessionSurface['_rpcStartProcess']>) { return settle(this.call(session => session._rpcStartProcess(...args))); }
  _rpcRunCode(...args: Parameters<NimbusSessionSurface['_rpcRunCode']>) { return settle(this.call(session => session._rpcRunCode(...args))); }
  _rpcReadFile(...args: Parameters<NimbusSessionSurface['_rpcReadFile']>) { return settle(this.call(session => session._rpcReadFile(...args))); }
  _rpcReadFileBytes(...args: Parameters<NimbusSessionSurface['_rpcReadFileBytes']>) { return settle(this.call(session => session._rpcReadFileBytes(...args))); }
  _rpcWriteFile(...args: Parameters<NimbusSessionSurface['_rpcWriteFile']>) { return settle(this.call(session => session._rpcWriteFile(...args))); }
  _rpcStat(...args: Parameters<NimbusSessionSurface['_rpcStat']>) { return settle(this.call(session => session._rpcStat(...args))); }
  _rpcLstat(...args: Parameters<NimbusSessionSurface['_rpcLstat']>) { return settle(this.call(session => session._rpcLstat(...args))); }
  _rpcReaddir(...args: Parameters<NimbusSessionSurface['_rpcReaddir']>) { return settle(this.call(session => session._rpcReaddir(...args))); }
  _rpcRename(...args: Parameters<NimbusSessionSurface['_rpcRename']>) { return settle(this.call(session => session._rpcRename(...args))); }
  _rpcChmod(...args: Parameters<NimbusSessionSurface['_rpcChmod']>) { return settle(this.call(session => session._rpcChmod(...args))); }
  _rpcFsReadRange(...args: Parameters<NimbusSessionSurface['_rpcFsReadRange']>) { return settle(this.call(session => session._rpcFsReadRange(...args))); }
  _rpcExists(...args: Parameters<NimbusSessionSurface['_rpcExists']>) { return settle(this.call(session => session._rpcExists(...args))); }
  _rpcMkdir(...args: Parameters<NimbusSessionSurface['_rpcMkdir']>) { return settle(this.call(session => session._rpcMkdir(...args))); }
  _rpcDeleteFile(...args: Parameters<NimbusSessionSurface['_rpcDeleteFile']>) { return settle(this.call(session => session._rpcDeleteFile(...args))); }
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

class ConsumedMemory implements Memory {
  constructor(private readonly pending: Promise<Memory>) {}

  [Symbol.dispose](): void { disposeWorkspaceRpc(this.pending); }

  private call<T>(run: (memory: Memory) => Promise<T>): Effect.Effect<T> {
    return workspaceRpcAnswer(this.pending).pipe(Effect.flatMap(memory => workspaceRpcAnswer(run(memory))));
  }

  write(...args: Parameters<Memory['write']>) { return settle(this.call(memory => memory.write(...args))); }
  append(...args: Parameters<Memory['append']>) { return settle(this.call(memory => memory.append(...args))); }
  index(...args: Parameters<Memory['index']>) { return settle(this.call(memory => memory.index(...args))); }
  search(...args: Parameters<Memory['search']>) { return settle(this.call(memory => memory.search(...args))); }
  read(...args: Parameters<Memory['read']>) { return settle(this.call(memory => memory.read(...args))); }
  chunk(...args: Parameters<Memory['chunk']>) { return settle(this.call(memory => memory.chunk(...args))); }
  tail(...args: Parameters<Memory['tail']>) { return settle(this.call(memory => memory.tail(...args))); }
}

/**
 * All outgoing WORKSPACE calls cross the same consumption boundary, including chat, tools, pacing and credentials. Those
 * whose answer is data cross once, through the agent's port, held across them; one that fails lets the port go, as its
 * workspace may have reset under it, and the next opens it again. A session, memory or a program's callbacks own live
 * capabilities: each opens its own host, which lets them go at its edge.
 */
export function workspaceClient(workspace: AgentWorkspaceCalls): AgentWorkspace {
  let held: Promise<AgentWorkspacePort> | null = null;

  const viaPort = <T>(call: (port: AgentWorkspacePort) => Promise<T>): Promise<T> => {
    held ??= workspace.port();
    const opened = held;

    return settle(workspaceRpcAnswer(opened).pipe(
      Effect.flatMap((port) => workspaceRpcAnswer(call(port))),
      Effect.onError(() => Effect.sync(() => {
        if (held !== opened) return;
        held = null;
        disposeWorkspaceRpc(opened);
      })),
    ));
  };

  return {
    session: () => new WorkspaceSession(workspace.session()),
    stateSession: () => new WorkspaceSession(workspace.stateSession()),
    memory: () => new ConsumedMemory(workspace.memory()),
    program: (...args) => settle(workspaceRpcAnswer(workspace.program(...args))),
    traceTurn: (...args) => viaPort((port) => port.traceTurn(...args)),
    traceStream: (...args) => viaPort((port) => port.traceStream(...args)),
    resume: (...args) => viaPort((port) => port.resume(...args)),
    guard: (...args) => viaPort((port) => port.guard(...args)),
    debit: (...args) => viaPort((port) => port.debit(...args)),
    prepareTurn: (...args) => viaPort((port) => port.prepareTurn(...args)),
    bindProfile: (...args) => viaPort((port) => port.bindProfile(...args)),
    prepareChat: (...args) => viaPort((port) => port.prepareChat(...args)),
    chatEvent: (...args) => viaPort((port) => port.chatEvent(...args)),
    turnEnded: (...args) => viaPort((port) => port.turnEnded(...args)),
    turnSettled: (...args) => viaPort((port) => port.turnSettled(...args)),
    owedReport: (...args) => viaPort((port) => port.owedReport(...args)),
    parentReport: (...args) => viaPort((port) => port.parentReport(...args)),
    autoTitle: (...args) => viaPort((port) => port.autoTitle(...args)),
    hireAdvisor: (...args) => viaPort((port) => port.hireAdvisor(...args)),
    owes: (...args) => viaPort((port) => port.owes(...args)),
    birthContext: (...args) => viaPort((port) => port.birthContext(...args)),
    steerSkills: (...args) => viaPort((port) => port.steerSkills(...args)),
    openWork: () => viaPort((port) => port.openWork()),
    noteModelRequest: (...args) => viaPort((port) => port.noteModelRequest(...args)),
    armCacheWarm: (...args) => viaPort((port) => port.armCacheWarm(...args)),
    advise: (...args) => viaPort((port) => port.advise(...args)),
    runEnded: (...args) => viaPort((port) => port.runEnded(...args)),
    enqueueTurn: (...args) => viaPort((port) => port.enqueueTurn(...args)),
    executeTool: (...args) => viaPort((port) => port.executeTool(...args)),
    observe: (...args) => viaPort((port) => port.observe(...args)),
    paceStep: (...args) => viaPort((port) => port.paceStep(...args)),
    answerMetadata: (...args) => viaPort((port) => port.answerMetadata(...args)),
    getAuth: (...args) => viaPort((port) => port.getAuth(...args)),
    listCredentials: () => viaPort((port) => port.listCredentials()),
    relayDevice: (...args) => viaPort((port) => port.relayDevice(...args)),
    relayModelCall: (...args) => viaPort((port) => port.relayModelCall(...args)),
    cancelModelRelay: (...args) => viaPort((port) => port.cancelModelRelay(...args)),
    sayToParent: (...args) => viaPort((port) => port.sayToParent(...args)),
    logActivity: (...args) => viaPort((port) => port.logActivity(...args)),
    reportModelCall: (...args) => viaPort((port) => port.reportModelCall(...args)),
    reportModelOperation: (...args) => viaPort((port) => port.reportModelOperation(...args)),
  };
}
