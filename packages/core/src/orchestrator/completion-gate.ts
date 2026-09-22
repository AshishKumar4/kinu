/**
 * One-shot runs (`kinu exec`, `kinu run`) do not end on the model's say-so: once per task, the
 * harness shows state it read itself and requires a second claim. Fires on what the turn did,
 * never on what it said; never fires without an observation.
 */

import type { CompletionGateRecord } from '../events/types';
import type { VFS } from '../types/primitives';
import type { ExecOutcome } from '../execution/exec-result';
import { formatExecResult } from '../execution/exec-result';
import { clampToolResult } from '../tools/clamp';
import { diagnostics, renderThrownChain } from '../obs/index';

/** `kinuEvent` on the gate's turn; the turn pump recognises the confirming turn by it. */
export const COMPLETION_GATE_EVENT = 'completion_gate';

/** The model must never read a harness check as something the user typed. */
export const COMPLETION_GATE_HEADER =
  '[Runtime check — a mechanical gate from Kinu, not written by the user.]';

/** Read-only probes. A failing `git status` is dropped: it describes the probe, not the deliverable. */
export const COMPLETION_PROBE_COMMANDS = ['pwd', 'ls -la', 'git status --short'] as const;

/** The echo re-anchors the model; the full task is already in history. */
export const COMPLETION_TASK_ECHO_MAX_CHARS = 2_000;

/** Null when nothing could be read; the caller must then not gate. */
export async function observeCompletionState(deps: {
  exec: (command: string) => Promise<ExecOutcome>;
  vfs?: VFS;
}): Promise<string | null> {
  const blocks: string[] = [];

  for (const command of COMPLETION_PROBE_COMMANDS) {
    let outcome: ExecOutcome;

    try {
      outcome = await deps.exec(command);
    } catch (error) {
      // Named so a gate that saw nothing never reads as one that never looked.
      diagnostics.event('completion.probe_skipped', {
        command, error: renderThrownChain({ cause: error }),
      });
      continue;
    }

    if (command.startsWith('git ') && (outcome.exitCode ?? 0) !== 0) continue;
    blocks.push(`$ ${command}\n${formatExecResult(outcome).trim()}`);
  }

  if (blocks.length === 0) return null;

  return clampToolResult(blocks.join('\n\n'), { vfs: deps.vfs });
}

export function completionGateText(opts: { task: string; observed: string }): string {
  return `${COMPLETION_GATE_HEADER}

This run ends after your next reply and its result is graded exactly as it stands then. No later turn can correct it.

The task you were given:
${truncate(opts.task, COMPLETION_TASK_ECHO_MAX_CHARS)}

The state of your working directory right now, read by the harness after you stopped:

${opts.observed}

Check it against what the task actually asked for — the files it named, the output format it specified, anything it said must not be left behind. If everything is there, say so in one line and stop. If anything is missing or wrong, fix it now.`;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n[… ${text.length - maxChars} chars of the task omitted; it is in full above in this conversation]`;
}

export interface TurnCompletionFacts {
  readonly completed: boolean;
  readonly toolCalls: number;
}

/** Per-session; {@link arm} is called only on the one-shot surface. */
export class CompletionGate {
  private armed = false;
  private fired = false;
  private settled = false;
  private record: CompletionGateRecord | null = null;
  private taskText = '';

  /** Question asked, no answer yet; advisor/review.ts (`gate-open`) holds its note meanwhile. */
  get open(): boolean {
    return this.fired && !this.settled;
  }

  /** Holds the task: the turn that trips the gate (e.g. a job's wake turn) may not be the one given it. */
  arm(task: string): void {
    this.armed = true;
    this.fired = false;
    this.settled = false;
    this.record = null;
    this.taskText = task;
  }

  get task(): string {
    return this.taskText;
  }

  /** No tool calls or a terminal failure means nothing to gate. */
  shouldGate(facts: TurnCompletionFacts): boolean {
    return this.armed && !this.fired && facts.completed && facts.toolCalls > 0;
  }

  fire(): void {
    this.fired = true;
  }

  settle(facts: { toolCalls: number }): void {
    this.settled = true;
    this.record = { converted: facts.toolCalls > 0 };
  }

  /** Returns the record once. */
  take(): CompletionGateRecord | null {
    const record = this.record;
    this.record = null;

    return record;
  }
}
