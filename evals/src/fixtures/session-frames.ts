/**
 * WHAT THE DEPLOYMENT SENDS A PUBLIC SESSION'S SOCKET, as data: `{type, id, body, done}` envelopes
 * whose `body` is one JSON-encoded AI-SDK UI-message-stream chunk. Transcribed from the producers
 * that emit them:
 *   · live chunk      `@cloudflare/think` dist/think.js:6682-6689 —
 *                     `body: JSON.stringify(streamChunk), done: false`
 *   · terminal        think.js:6375-6379 — `body: '', done: true`
 *   · error terminal  think.js:6361-6366 — `done: true, error: true`, with the message in `body`
 *   · replay chunk    `agents` dist/chat/index.js:666-675 — the same frame with `replay: true`,
 *                     resent from chunk zero on every resume ack
 *
 * WHY A TRANSCRIPTION IS EVIDENCE HERE, and what pins it. A fixture copied from a producer rots the
 * day the producer changes, so it is held to the shipped declarations BY THE COMPILER: every frame
 * `type` is `CHAT_MESSAGE_TYPES.*`, so a rename in the agents SDK fails this file rather than
 * producing frames a session waits for forever; and every chunk is typed `UIMessageChunk`, the AI
 * SDK's own union, so a chunk kind that is renamed, or a required field that appears, is a type
 * error here. A dated capture pins the past; these pin the CURRENT producers.
 *
 * THE CHUNK LIST IS DELIBERATELY WIDER THAN WHAT THE DECODER READS.
 * `CloudTurnStream` consumes five chunk kinds (text-delta, tool-input-available,
 * tool-output-available, tool-output-error, finish-step); a real turn also
 * carries `start`, `start-step`, `text-start`, `text-end`, `finish` and, on a
 * reasoning model, the reasoning trio. They are here so the wiring suite proves
 * the session IGNORES them rather than proving nothing about them — a decoder
 * that threw on an unread chunk would fail on the product working.
 */
import type { UIMessageChunk } from 'ai';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';

/** The request id the frames below belong to. One value, so a test that mixes
 *  two turns has to say so. */
export const FIXTURE_REQUEST_ID = 'turn-1-a1b2c3';

/**
 * A file-producing turn, chunk by chunk: the model calls `file` with a write,
 * the tool answers, the step closes, and the model then says what it did.
 *
 * The tool output is a STRING because that is what the `file` tool returns and
 * what `CloudTurnStream` stringifies into a turn's `toolCalls[].result`; a
 * structured output would exercise the JSON branch of the same decode, which the
 * failing turn below covers.
 */
export const FILE_TURN_CHUNKS: readonly UIMessageChunk[] = [
  { type: 'start' },
  { type: 'start-step' },
  {
    type: 'tool-input-available',
    toolCallId: 'call-1',
    toolName: 'file',
    input: { action: 'write', path: 'note.txt', content: 'public session ok' },
  },
  { type: 'tool-output-available', toolCallId: 'call-1', output: 'Wrote note.txt' },
  { type: 'finish-step' },
  { type: 'start-step' },
  { type: 'text-start', id: 'msg-1' },
  { type: 'text-delta', id: 'msg-1', delta: 'Wrote ' },
  { type: 'text-delta', id: 'msg-1', delta: 'note.txt.' },
  { type: 'text-end', id: 'msg-1' },
  { type: 'finish-step' },
  { type: 'finish' },
];

/**
 * A turn whose tool FAILED and was then retried — the shape the recovery case
 * measures.
 *
 * `tool-output-error` is the chunk a tool that threw produces, and the decoder
 * has to pair it with the call it belongs to by id: a failure attributed to the
 * wrong call is worse than an unattributed one, because it reads as a different
 * tool being broken.
 */
export const RECOVERY_TURN_CHUNKS: readonly UIMessageChunk[] = [
  { type: 'start' },
  { type: 'start-step' },
  {
    type: 'tool-input-available',
    toolCallId: 'call-1',
    toolName: 'shell',
    input: { command: 'bun test broken.test.ts' },
  },
  { type: 'tool-output-error', toolCallId: 'call-1', errorText: 'Error (exit 1)\n1 fail' },
  { type: 'finish-step' },
  { type: 'start-step' },
  {
    type: 'tool-input-available',
    toolCallId: 'call-2',
    toolName: 'shell',
    input: { command: 'bun test broken.test.ts' },
  },
  { type: 'tool-output-available', toolCallId: 'call-2', output: { ok: true, passed: 1 } },
  { type: 'finish-step' },
  { type: 'text-start', id: 'msg-1' },
  { type: 'text-delta', id: 'msg-1', delta: 'Fixed it.' },
  { type: 'text-end', id: 'msg-1' },
  { type: 'finish' },
];

/** One live streaming frame, as a producer puts it on the wire. */
export function chatChunkFrame(input: {
  readonly requestId: string;
  readonly chunk: UIMessageChunk;
  readonly replay?: boolean;
}): string {
  return JSON.stringify({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
    id: input.requestId,
    body: JSON.stringify(input.chunk),
    done: false,
    replay: input.replay === true ? true : undefined,
  });
}

/** The frame that ends a turn cleanly: empty body, `done`. */
export function chatTerminalFrame(input: {
  readonly requestId: string;
  readonly replay?: boolean;
  readonly landed?: 'mid-turn' | 'turn';
}): string {
  return JSON.stringify({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
    id: input.requestId,
    body: '',
    done: true,
    landed: input.landed,
    replay: input.replay === true ? true : undefined,
  });
}

/** The frame that ends a turn with the DO's own failure text. */
export function chatErrorFrame(input: {
  readonly requestId: string;
  readonly message: string;
}): string {
  return JSON.stringify({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
    id: input.requestId,
    body: input.message,
    done: true,
    error: true,
  });
}

/** A whole turn's frames, in production order. */
export function chatTurnFrames(input: {
  readonly requestId: string;
  readonly chunks: readonly UIMessageChunk[];
  readonly replay?: boolean;
}): readonly string[] {
  const replay = input.replay === true;

  return [
    ...input.chunks.map((chunk) => chatChunkFrame({ requestId: input.requestId, chunk, replay })),
    chatTerminalFrame({ requestId: input.requestId, replay }),
  ];
}

/** The DO announcing it holds a resumable stream for `requestId`. */
export function streamResumingFrame(requestId: string): string {
  return JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUMING, id: requestId });
}

/** One `{type:'rpc'}` reply, in the two shapes the socket carries: an answered
 *  call and a refused one. The type word is the agents-SDK client's own
 *  (dist/client.js:242-247), which exports no constant for it. */
export function rpcReplyFrame(input: {
  readonly requestId: string;
  readonly result?: unknown;
  readonly error?: string;
}): string {
  return input.error === undefined
    ? JSON.stringify({ type: 'rpc', id: input.requestId, success: true, result: input.result })
    : JSON.stringify({ type: 'rpc', id: input.requestId, success: false, error: input.error });
}

/** A broadcast this session does not read — the DO fans several down the same
 *  socket, and a session that treated one as a fault would fail on the product
 *  working. */
export const BROADCAST_FRAME = JSON.stringify({
  type: 'branch_status', status: 'running', branchId: 'head-1', task: 'a branch',
});
