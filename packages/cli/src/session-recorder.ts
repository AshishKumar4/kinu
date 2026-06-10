import type { AgentClientEvent, AgentClientMode } from './agent-client.js';
import type { CliSession } from './session.js';

/** Record one AgentClientEvent to the JSONL terminal log. Both backend clients
 *  route their event stream through this, so entry shapes never drift. */
export function recordAgentClientEvent(
  session: CliSession,
  event: AgentClientEvent,
  backend: AgentClientMode,
): void {
  switch (event.type) {
    case 'tool-call':
      session.append('tool_call', { toolName: event.toolName, args: event.args, backend });
      break;
    case 'tool-result':
      session.append('tool_result', { toolName: event.toolName, result: event.result, backend });
      break;
    case 'turn-end':
      session.append('assistant', {
        text: event.turn.text,
        steps: event.turn.steps,
        durationMs: event.turn.durationMs,
        hadError: event.turn.hadError,
        backend,
      });
      break;
    case 'error':
      session.append('error', { message: event.message, backend });
      break;
    case 'turn-start':
    case 'text-delta':
    case 'step-finish':
    case 'evolution':
    case 'broadcast':
      break;
  }
}
