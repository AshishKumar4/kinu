/**
 * The chat-error decision, as a function of the frames that arrive.
 *
 * Extracted from `use-kinu`'s raw `onMessage` handler because it is the half
 * that can be WRONG. The handler's other job — calling `setChatError` — is
 * React plumbing that a test can only look at; this is a rule about which
 * frames mean "the turn failed" and which of those are the server re-serving an
 * old failure, and it has a right and a wrong answer for every input.
 *
 * It lived inline, which meant the only way to check it was to read the
 * handler's source text and assert the expression string. That test could not
 * fail on an inverted comparison, a dropped `done` check, or a set that was
 * never populated — it passed as long as the characters were present. This
 * module is the same rule with those bugs reachable.
 *
 * WHY THE DISCRIMINATOR EXISTS. The server retains its last terminal record
 * until a later turn supersedes it (agents SDK `_replayTerminalOnAck`), so a
 * workspace whose last turn failed re-serves that failure to every client that
 * connects, forever. Measured on `sunlit-stone-4a20`: a turn that ended
 * 2026-08-17T19:08:41Z still answers a resume ACK with
 * `{"body":"Unauthorized","done":true,"error":true}`. The card called it "the
 * last turn" as though it had just happened. It IS the last turn — it is just
 * not recent, and a card that cannot say so misdates the workspace.
 *
 * The discriminator is the server's own: it announces the pending record's
 * request id in a `cf_agent_stream_resuming` frame and only then replays the
 * terminal for that same id. An id this connection saw announced is a replay;
 * anything else is this session's turn failing live.
 */

/** A turn that ended without an answer, and whether the server is REPLAYING an
 *  older one rather than reporting this session's.
 *
 *  The distinction is the whole difference between "your turn just failed" and
 *  "the last thing that happened here failed, some time ago". */
export interface ChatTurnError {
  body: string;
  replayed: boolean;
}

/** What the body says when the server sent a terminal error and no text. */
export const UNKNOWN_TURN_FAILURE = 'The turn failed with an unknown error.';

/**
 * The frame fields this rule reads. Structural on purpose: the canonical
 * `SocketMessageSchema` variant carries these and the rule needs nothing else,
 * so a frame type gaining a field does not reach here.
 */
export interface TerminalFrame {
  readonly type: string;
  readonly error?: boolean | undefined;
  readonly done?: boolean | undefined;
  readonly body?: string | undefined;
  readonly id?: string | undefined;
}

/**
 * A frame's chat-error state, or null when the frame is not a terminal error.
 *
 * BOTH `error` and `done` are required, and that is not defensive: a streaming
 * chunk that failed mid-flight arrives with `error` set and `done` absent, and
 * the live channel (`useAgentChat`'s own `error`) already owns that one. Folding
 * it in here too would draw the card twice for one failure.
 *
 * A frame with no `id` is never a replay. It cannot be: the discriminator is
 * membership in the announced set, and an absent id is in no set — reading it
 * as a replay would silently backdate every failure a server sent without one.
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
