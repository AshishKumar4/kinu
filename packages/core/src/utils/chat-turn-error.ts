/**
 * Chat-error decision per frame. A frame that ends a chat response in failure is the turn's, unless it carries the
 * runtime's refusal `reason` (`actor-agent.ts`, refusing a resume, a request or a connect): then the tab was refused,
 * in the runtime's own words. Kinu's transport never re-serves an older turn's failure.
 */

/** A turn that ended without an answer, or the runtime refusing this tab. */
export interface ChatTurnError {
  body: string;
  refused: boolean;
}

const UNKNOWN_TURN_FAILURE = 'The turn failed with an unknown error.';

export interface TerminalFrame {
  readonly type: string;
  readonly error?: boolean | undefined;
  readonly done?: boolean | undefined;
  readonly body?: string | undefined;
  readonly reason?: string | undefined;
}

/** Null unless both `error` and `done` are set: a mid-stream error is owned by `useAgentChat`'s live channel. */
export function terminalChatError(frame: TerminalFrame): ChatTurnError | null {
  if (frame.type !== 'cf_agent_use_chat_response') return null;

  if (frame.error !== true || frame.done !== true) return null;

  return { body: frame.body?.trim() ? frame.body : UNKNOWN_TURN_FAILURE, refused: frame.reason !== undefined };
}
