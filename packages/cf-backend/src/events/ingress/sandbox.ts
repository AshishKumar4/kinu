/**
 * Sandbox ingress — process lifecycle + file-watch callbacks from the
 * sandbox SDK → ProcessDone / FileChanged events.
 *
 * When the agent calls `sandbox.exec(cmd, {mode: 'background', notify_when})`
 * the orchestrator records a `process_watch` trigger that captures the
 * head's trust at launch (so the resulting events inherit it — closing
 * the trust-elevation hole).
 *
 * The sandbox SDK doesn't push notifications by itself in this codebase.
 * The orchestrator polls process status via a periodic alarm and emits
 * ProcessDone when a watched process has exited.
 */

import {
  type EventLog, type ProcessDonePayload, type FileChangedPayload,
  type TrustLevel,
} from '@proteus/core';

export interface SandboxIngressDeps {
  log: EventLog;
}

export interface ProcessExitObservation {
  process_id: string;
  command: string;
  exit_code: number;
  stdout_excerpt: string;
  stderr_excerpt: string;
  duration_ms: number;
  /** Trust of the head that launched this process. Captured at launch
   *  time and persisted on the process_watch trigger row. */
  launching_head_trust: TrustLevel;
}

/** Publish a ProcessDone event for an observed process exit. */
export function publishProcessDone(
  deps: SandboxIngressDeps,
  obs: ProcessExitObservation,
  now: number,
): { event_id: string; admitted: boolean } {
  const payload: ProcessDonePayload = {
    process_id: obs.process_id,
    command: obs.command,
    exit_code: obs.exit_code,
    stdout_excerpt: obs.stdout_excerpt,
    stderr_excerpt: obs.stderr_excerpt,
    duration_ms: obs.duration_ms,
  };
  const { id, admitted } = deps.log.publish({
    descriptor: {
      ingress: 'sandbox_cb',
      variant: 'process_done',
      payload,
      launching_head_trust: obs.launching_head_trust,
    },
    now,
  });
  return { event_id: id, admitted };
}

export interface FileChangeObservation {
  path: string;
  change: 'created' | 'modified' | 'deleted';
  size?: number;
  launching_head_trust: TrustLevel;
}

/** Publish a FileChanged event for an observed VFS change. */
export function publishFileChange(
  deps: SandboxIngressDeps,
  obs: FileChangeObservation,
  now: number,
): { event_id: string; admitted: boolean } {
  const payload: FileChangedPayload = {
    path: obs.path,
    change: obs.change,
    size: obs.size,
  };
  const { id, admitted } = deps.log.publish({
    descriptor: {
      ingress: 'file_watch',
      variant: 'file_changed',
      payload,
      launching_head_trust: obs.launching_head_trust,
    },
    now,
  });
  return { event_id: id, admitted };
}
