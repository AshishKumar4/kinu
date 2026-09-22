import type { AgentClientEvent, AgentClientMode } from './agent-client';
import type { CliSession } from './session';

interface AssistantTurnMetadata {
  steps: number;
  durationMs: number;
  hadError: boolean;
}

/** Flushes buffered text at each tool boundary so the JSONL replays text and tools in order. */
export class SessionRecorder {
  private pendingText = '';

  constructor(private readonly backend: AgentClientMode) {}

  record(session: CliSession, event: AgentClientEvent): void {
    switch (event.type) {
      case 'turn-start':
        // Defensive: a dropped turn-end must not bleed text into the next turn.
        this.pendingText = '';
        break;
      case 'text-delta':
        this.pendingText += event.delta;
        break;
      case 'tool-call':
        this.flushText(session);
        session.append('tool_call', { toolName: event.toolName, toolCallId: event.toolCallId, args: event.args, backend: this.backend });
        break;
      case 'tool-result':
        session.append('tool_result', {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          result: event.result,
          success: event.success,
          backend: this.backend,
        });
        break;
      case 'turn-end':
        // turn.text only when nothing streamed.
        this.flushText(session, event.turn.text, {
          steps: event.turn.steps,
          durationMs: event.turn.durationMs,
          hadError: event.turn.hadError,
        });
        break;
      case 'error':
        this.pendingText = '';
        session.append('error', { message: event.message, backend: this.backend });
        break;
      case 'step-finish':
      case 'evolution':
      case 'broadcast':
      case 'run-event':
      case 'background':
        break;
    }
  }

  /** `finalText` is used only when the buffer is empty. */
  private flushText(session: CliSession, finalText?: string, meta?: AssistantTurnMetadata): void {
    const text = this.pendingText || (finalText ?? '');
    this.pendingText = '';

    if (!text.trim()) return;
    session.append('assistant', { text, backend: this.backend, ...meta });
  }
}
