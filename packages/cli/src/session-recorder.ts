import type { SessionEvent } from '@proteus/cli-backend';
import type { CliSession } from './session.js';

export function recordCliSessionEvent(
  session: CliSession | undefined,
  event: SessionEvent,
  backend: 'local' | 'cloud' = 'local',
): void {
  if (!session) return;

  switch (event.type) {
    case 'tool-call':
      session.append('tool_call', { toolName: event.toolName, args: event.args, backend });
      break;
    case 'tool-result':
      session.append('tool_result', { toolName: event.toolName, result: event.result, backend });
      break;
    case 'turn-end':
      session.append('assistant', {
        text: event.turn.assistantResponse,
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
    case 'evolution':
    case 'broadcast':
      break;
  }
}
