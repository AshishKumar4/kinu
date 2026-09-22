/**
 * Chat-error decision per frame. The server re-serves its last terminal record (agents SDK `_replayTerminalOnAck`),
 * so a terminal for an id announced in `cf_agent_stream_resuming` is a replay; anything else failed live.
 */

/** A turn that ended without an answer, and whether the server is replaying an older one. */
export interface ChatTurnError {
  body: string;
  replayed: boolean;
}

const UNKNOWN_TURN_FAILURE = 'The turn failed with an unknown error.';

export interface TerminalFrame {
  readonly type: string;
  readonly error?: boolean | undefined;
  readonly done?: boolean | undefined;
  readonly body?: string | undefined;
  readonly id?: string | undefined;
}

/**
 * Null unless both `error` and `done` are set: a mid-stream error is owned by `useAgentChat`'s live channel.
 * A frame with no `id` is never a replay.
 */
export function terminalChatError(
  frame: TerminalFrame,
  announcedResumes: ReadonlySet<string>,
): ChatTurnError | null {
  if (frame.type !== 'cf_agent_use_chat_response') return null;

  if (frame.error !== true || frame.done !== true) return null;

  return {
    body: frame.body?.trim() ? frame.body : UNKNOWN_TURN_FAILURE,
    replayed: frame.id !== undefined && announcedResumes.has(frame.id),
  };
}
