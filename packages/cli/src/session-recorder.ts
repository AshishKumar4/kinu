import type { AgentClientEvent, AgentClientMode } from './agent-client.js';
import type { CliSession } from './session.js';

/**
 * Records an AgentClientEvent stream to the JSONL terminal log, preserving the
 * CHRONOLOGICAL interleaving of assistant text and tool calls. Both backend
 * clients route their event stream through one recorder instance, so entry
 * shapes — and ordering — never drift.
 *
 * The model streams text-deltas, tool-calls, and tool-results interleaved
 * (text → tool → text → tool). Recording one consolidated `assistant` entry at
 * turn-end would regroup all text after all tools on reload. Instead we buffer
 * text-deltas and flush an `assistant` entry at each tool boundary (and at
 * turn-end), so the JSONL replays in true order.
 */
export class SessionRecorder {
  private pendingText = '';

  constructor(private readonly backend: AgentClientMode) {}

  record(session: CliSession, event: AgentClientEvent): void {
    switch (event.type) {
      case 'turn-start':
        // A turn never starts mid-segment, but reset defensively so a dropped
        // turn-end can't bleed text into the next turn.
        this.pendingText = '';
        break;
      case 'text-delta':
        this.pendingText += event.delta;
        break;
      case 'tool-call':
        this.flushText(session);
        session.append('tool_call', { toolName: event.toolName, args: event.args, backend: this.backend });
        break;
      case 'tool-result':
        session.append('tool_result', { toolName: event.toolName, result: event.result, backend: this.backend });
        break;
      case 'turn-end':
        // turn.text is the authoritative full text; use it as the trailing
        // segment when nothing streamed (no deltas), otherwise the streamed
        // buffer already holds exactly the trailing text after the last tool.
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
        break;
    }
  }

  /**
   * Persist the buffered text segment as an `assistant` entry and clear it.
   * `finalText`, when given (turn-end), is the trailing text used only when the
   * buffer is empty (no streamed deltas) so a mid-turn flush keeps exactly what
   * streamed up to the tool boundary.
   */
  private flushText(session: CliSession, finalText?: string, meta?: Record<string, unknown>): void {
    const text = this.pendingText || (finalText ?? '');
    this.pendingText = '';
    if (!text.trim()) return;
    session.append('assistant', { text, backend: this.backend, ...meta });
  }
}
