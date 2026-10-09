import { Effect } from 'effect';
import { settle } from '@kinu.run/core/obs';
import type { Memory } from '@kinu.run/core';
import type { NimbusSessionSurface } from '@nimbus-sh/sdk/sandbox';
import type { AgentWorkspace } from './agent-turn';

/** 2026-10-09, workerd 2026-09-30, jobs 20261009183355-6c5db02f / 20261009183400-d64f3c13:
 * awaiting a rejected RpcPromise leaves its pipeline open; disposing that promise closes the relay's Tail as ok.
 * Fulfilled answers can own live stubs or streams, so their disposer belongs to the consumer, not this adapter. */
export function workspaceRpcAnswer<T>(pending: Promise<T>): Promise<T> {
  return settle(Effect.promise(() => pending).pipe(Effect.onError(() => Effect.sync(() => {
    // Worker RPC's Promise type omits this native method; ordinary in-isolate promises have no pipeline to release.
    if (Symbol.dispose in pending) {
      const dispose = pending[Symbol.dispose];

      if (typeof dispose === 'function') dispose.call(pending);
    }
  }))));
}

export interface AgentWorkspaceCalls extends Omit<AgentWorkspace, 'session' | 'stateSession' | 'memory'> {
  session(): Promise<NimbusSessionSurface>;
  stateSession(): Promise<NimbusSessionSurface>;
  memory(): Promise<Memory>;
}

/** Nimbus opens a synchronous session surface; its methods first consume the factory's own RpcPromise. */
class WorkspaceSession implements NimbusSessionSurface {
  constructor(private readonly pending: Promise<NimbusSessionSurface>) {}

  private call<T>(run: (session: NimbusSessionSurface) => Promise<T>): Promise<T> {
    return workspaceRpcAnswer(this.pending).then(session => workspaceRpcAnswer(run(session)));
  }

  _rpcReady(...args: Parameters<NimbusSessionSurface['_rpcReady']>) { return this.call(session => session._rpcReady(...args)); }
  _rpcExecStream(...args: Parameters<NimbusSessionSurface['_rpcExecStream']>) { return this.call(session => session._rpcExecStream(...args)); }
  _rpcStartProcess(...args: Parameters<NimbusSessionSurface['_rpcStartProcess']>) { return this.call(session => session._rpcStartProcess(...args)); }
  _rpcRunCode(...args: Parameters<NimbusSessionSurface['_rpcRunCode']>) { return this.call(session => session._rpcRunCode(...args)); }
  _rpcReadFile(...args: Parameters<NimbusSessionSurface['_rpcReadFile']>) { return this.call(session => session._rpcReadFile(...args)); }
  _rpcReadFileBytes(...args: Parameters<NimbusSessionSurface['_rpcReadFileBytes']>) { return this.call(session => session._rpcReadFileBytes(...args)); }
  _rpcWriteFile(...args: Parameters<NimbusSessionSurface['_rpcWriteFile']>) { return this.call(session => session._rpcWriteFile(...args)); }
  _rpcStat(...args: Parameters<NimbusSessionSurface['_rpcStat']>) { return this.call(session => session._rpcStat(...args)); }
  _rpcLstat(...args: Parameters<NimbusSessionSurface['_rpcLstat']>) { return this.call(session => session._rpcLstat(...args)); }
  _rpcReaddir(...args: Parameters<NimbusSessionSurface['_rpcReaddir']>) { return this.call(session => session._rpcReaddir(...args)); }
  _rpcRename(...args: Parameters<NimbusSessionSurface['_rpcRename']>) { return this.call(session => session._rpcRename(...args)); }
  _rpcChmod(...args: Parameters<NimbusSessionSurface['_rpcChmod']>) { return this.call(session => session._rpcChmod(...args)); }
  _rpcFsReadRange(...args: Parameters<NimbusSessionSurface['_rpcFsReadRange']>) { return this.call(session => session._rpcFsReadRange(...args)); }
  _rpcExists(...args: Parameters<NimbusSessionSurface['_rpcExists']>) { return this.call(session => session._rpcExists(...args)); }
  _rpcMkdir(...args: Parameters<NimbusSessionSurface['_rpcMkdir']>) { return this.call(session => session._rpcMkdir(...args)); }
  _rpcDeleteFile(...args: Parameters<NimbusSessionSurface['_rpcDeleteFile']>) { return this.call(session => session._rpcDeleteFile(...args)); }
  _rpcInstallRuntime(...args: Parameters<NimbusSessionSurface['_rpcInstallRuntime']>) { return this.call(session => session._rpcInstallRuntime(...args)); }
  _rpcEnsureRuntimes(...args: Parameters<NimbusSessionSurface['_rpcEnsureRuntimes']>) { return this.call(session => session._rpcEnsureRuntimes(...args)); }
  _rpcListRuntimes() { return this.call(session => session._rpcListRuntimes()); }
  _rpcListProcesses() { return this.call(session => session._rpcListProcesses()); }
  _rpcKillProcess(...args: Parameters<NimbusSessionSurface['_rpcKillProcess']>) { return this.call(session => session._rpcKillProcess(...args)); }
  _rpcWriteProcessInput(...args: Parameters<NimbusSessionSurface['_rpcWriteProcessInput']>) { return this.call(session => session._rpcWriteProcessInput(...args)); }
  _rpcEndProcessInput(...args: Parameters<NimbusSessionSurface['_rpcEndProcessInput']>) { return this.call(session => session._rpcEndProcessInput(...args)); }
  _rpcResizeProcess(...args: Parameters<NimbusSessionSurface['_rpcResizeProcess']>) { return this.call(session => session._rpcResizeProcess(...args)); }
  _rpcSignalProcess(...args: Parameters<NimbusSessionSurface['_rpcSignalProcess']>) { return this.call(session => session._rpcSignalProcess(...args)); }
  _rpcProcessLogs(...args: Parameters<NimbusSessionSurface['_rpcProcessLogs']>) { return this.call(session => session._rpcProcessLogs(...args)); }
  _rpcListPorts() { return this.call(session => session._rpcListPorts()); }
  _rpcExposePort(...args: Parameters<NimbusSessionSurface['_rpcExposePort']>) { return this.call(session => session._rpcExposePort(...args)); }
  _rpcExposeApp(...args: Parameters<NimbusSessionSurface['_rpcExposeApp']>) { return this.call(session => session._rpcExposeApp(...args)); }
  _rpcListApps() { return this.call(session => session._rpcListApps()); }
  _rpcRotateLink(...args: Parameters<NimbusSessionSurface['_rpcRotateLink']>) { return this.call(session => session._rpcRotateLink(...args)); }
  _rpcRemoveApp(...args: Parameters<NimbusSessionSurface['_rpcRemoveApp']>) { return this.call(session => session._rpcRemoveApp(...args)); }
  _rpcEnsureDurableApp(...args: Parameters<NimbusSessionSurface['_rpcEnsureDurableApp']>) { return this.call(session => session._rpcEnsureDurableApp(...args)); }
  _rpcRemoveDurableApp(...args: Parameters<NimbusSessionSurface['_rpcRemoveDurableApp']>) { return this.call(session => session._rpcRemoveDurableApp(...args)); }
  _rpcUnexposePort(...args: Parameters<NimbusSessionSurface['_rpcUnexposePort']>) { return this.call(session => session._rpcUnexposePort(...args)); }
  _rpcDestroy(...args: Parameters<NimbusSessionSurface['_rpcDestroy']>) { return this.call(session => session._rpcDestroy(...args)); }
}

class ConsumedMemory implements Memory {
  constructor(private readonly pending: Promise<Memory>) {}

  private call<T>(run: (memory: Memory) => Promise<T>): Promise<T> {
    return workspaceRpcAnswer(this.pending).then(memory => workspaceRpcAnswer(run(memory)));
  }

  write(...args: Parameters<Memory['write']>) { return this.call(memory => memory.write(...args)); }
  append(...args: Parameters<Memory['append']>) { return this.call(memory => memory.append(...args)); }
  index(...args: Parameters<Memory['index']>) { return this.call(memory => memory.index(...args)); }
  search(...args: Parameters<Memory['search']>) { return this.call(memory => memory.search(...args)); }
  read(...args: Parameters<Memory['read']>) { return this.call(memory => memory.read(...args)); }
  tail(...args: Parameters<Memory['tail']>) { return this.call(memory => memory.tail(...args)); }
}

/** All outgoing WORKSPACE calls cross the same consumption boundary, including chat, tools, pacing and credentials. */
export function workspaceClient(workspace: AgentWorkspaceCalls): AgentWorkspace {
  return {
    session: () => new WorkspaceSession(workspace.session()),
    stateSession: () => new WorkspaceSession(workspace.stateSession()),
    memory: () => new ConsumedMemory(workspace.memory()),
    program: (...args) => workspaceRpcAnswer(workspace.program(...args)),
    traceTurn: (...args) => workspaceRpcAnswer(workspace.traceTurn(...args)),
    traceStream: (...args) => workspaceRpcAnswer(workspace.traceStream(...args)),
    resume: (...args) => workspaceRpcAnswer(workspace.resume(...args)),
    guard: (...args) => workspaceRpcAnswer(workspace.guard(...args)),
    debit: (...args) => workspaceRpcAnswer(workspace.debit(...args)),
    prepareTurn: (...args) => workspaceRpcAnswer(workspace.prepareTurn(...args)),
    bindProfile: (...args) => workspaceRpcAnswer(workspace.bindProfile(...args)),
    prepareChat: (...args) => workspaceRpcAnswer(workspace.prepareChat(...args)),
    chatEvent: (...args) => workspaceRpcAnswer(workspace.chatEvent(...args)),
    turnEnded: (...args) => workspaceRpcAnswer(workspace.turnEnded(...args)),
    owedReport: (...args) => workspaceRpcAnswer(workspace.owedReport(...args)),
    parentReport: (...args) => workspaceRpcAnswer(workspace.parentReport(...args)),
    autoTitle: (...args) => workspaceRpcAnswer(workspace.autoTitle(...args)),
    hireAdvisor: (...args) => workspaceRpcAnswer(workspace.hireAdvisor(...args)),
    owes: (...args) => workspaceRpcAnswer(workspace.owes(...args)),
    birthContext: (...args) => workspaceRpcAnswer(workspace.birthContext(...args)),
    steerSkills: (...args) => workspaceRpcAnswer(workspace.steerSkills(...args)),
    advise: (...args) => workspaceRpcAnswer(workspace.advise(...args)),
    enqueueTurn: (...args) => workspaceRpcAnswer(workspace.enqueueTurn(...args)),
    executeTool: (...args) => workspaceRpcAnswer(workspace.executeTool(...args)),
    observe: (...args) => workspaceRpcAnswer(workspace.observe(...args)),
    paceStep: (...args) => workspaceRpcAnswer(workspace.paceStep(...args)),
    answerMetadata: (...args) => workspaceRpcAnswer(workspace.answerMetadata(...args)),
    getAuth: (...args) => workspaceRpcAnswer(workspace.getAuth(...args)),
    listCredentials: () => workspaceRpcAnswer(workspace.listCredentials()),
    relayDevice: (...args) => workspaceRpcAnswer(workspace.relayDevice(...args)),
    relayModelCall: (...args) => workspaceRpcAnswer(workspace.relayModelCall(...args)),
    cancelModelRelay: (...args) => workspaceRpcAnswer(workspace.cancelModelRelay(...args)),
    sayToParent: (...args) => workspaceRpcAnswer(workspace.sayToParent(...args)),
    reportModelCall: (...args) => workspaceRpcAnswer(workspace.reportModelCall(...args)),
    reportModelOperation: (...args) => workspaceRpcAnswer(workspace.reportModelOperation(...args)),
  };
}
