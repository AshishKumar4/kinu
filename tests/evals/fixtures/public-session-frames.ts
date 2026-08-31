/**
 * WHAT THE DEPLOYMENT SENDS A PUBLIC SESSION, as data.
 *
 * Two vocabularies, one file, because a public session reads exactly two things
 * off the deployment and both are producer-owned:
 *
 *   1. THE CHAT FRAMES. `{type, id, body, done}` envelopes whose `body` is one
 *      JSON-encoded AI-SDK UI-message-stream chunk. Transcribed from the
 *      producers that emit them:
 *        · live chunk      `@cloudflare/think` dist/think.js:6682-6689 —
 *                          `body: JSON.stringify(streamChunk), done: false`
 *        · terminal        think.js:6375-6379 — `body: '', done: true`
 *        · error terminal  think.js:6361-6366 — `done: true, error: true`,
 *                          with the message in `body`
 *        · replay chunk    `agents` dist/chat/index.js:666-675 — the same frame
 *                          with `replay: true`, resent from chunk zero on every
 *                          resume ack
 *   2. THE RUN EVENTS. Rows exactly as `GET /api/workspaces/:name/runs/:id/events`
 *      serves them: the whole stamped event, which is what the route returns
 *      (run-events-routes.ts:118) and what the recorder stores
 *      (events/recorder.ts:330-333).
 *
 * WHY A TRANSCRIPTION IS EVIDENCE HERE, and what pins it. A fixture copied from
 * a producer rots the day the producer changes, which is the objection this file
 * has to answer rather than dodge. Both halves are held to the shipped
 * declarations BY THE COMPILER:
 *
 *   · every frame `type` is `CHAT_MESSAGE_TYPES.*`, so a rename in the agents
 *     SDK fails this file rather than producing frames a session waits for
 *     forever;
 *   · every chunk is typed `UIMessageChunk` — the AI SDK's own union — so a
 *     chunk kind that is renamed, or a required field that appears, is a type
 *     error here;
 *   · every event is typed `RunEvent` — core's canonical union, the same
 *     declaration `parseStoredRunEvent` validates against — so a payload this
 *     file could invent but the product could never write does not compile.
 *
 * That is the strongest claim available without a live deployment, and it is a
 * genuinely different claim from "these bytes came off staging on some date": a
 * dated capture pins the past, and these pin the CURRENT producers.
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

import type { RunEvent } from '../../../packages/core/src/index';

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
    toolName: 'run',
    input: { command: 'bun test broken.test.ts' },
  },
  { type: 'tool-output-error', toolCallId: 'call-1', errorText: 'Error (exit 1)\n1 fail' },
  { type: 'finish-step' },
  { type: 'start-step' },
  {
    type: 'tool-input-available',
    toolCallId: 'call-2',
    toolName: 'run',
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
}): string {
  return JSON.stringify({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
    id: input.requestId,
    body: '',
    done: true,
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

const TIMESTAMP = '2026-08-30T12:00:00.000Z';

/**
 * A two-turn trajectory as the public events route serves it: a file written, a
 * command that failed, the same command run clean, an edit that landed, and a
 * completion gate that found nothing left to do.
 *
 * Every count here is load-bearing for the wiring suite's scoring assertions,
 * so each is stated once:
 *   · four `tool_call_end` rows, of which ONE failed — `bun test` exiting 1 is
 *     an ordinary successful tool result whose text begins `Error (exit 1)`
 *     (execution/exec-result.ts:116), which is exactly the failure a scorer
 *     reading the transport discriminator alone would miss;
 *   · one `file_edit` row, 2 attempts / 1 applied, so `edit_landing` has a real
 *     denominator and a rate below 1;
 *   · one `completion_gate` row with `converted: false` — the HONEST outcome,
 *     since a conversion means the gate caught a premature completion claim;
 *   · two `turn_end` rows, so `ledgerTotalsFromEvents` sees a multi-turn
 *     episode rather than a single turn.
 */
export const LEDGER_EVENTS: readonly RunEvent[] = [
  { type: 'run_start', runId: 'run-1', eventIndex: 0, timestamp: TIMESTAMP, agentId: 'eval-public' },
  { type: 'turn_start', runId: 'run-1', eventIndex: 1, timestamp: TIMESTAMP, turnIndex: 0 },
  {
    type: 'tool_call_end', runId: 'run-1', eventIndex: 2, timestamp: TIMESTAMP,
    name: 'file', toolCallId: 'call-1',
    args: { action: 'write', path: 'note.txt' }, result: 'Wrote note.txt', durationMs: 12,
  },
  {
    type: 'tool_call_end', runId: 'run-1', eventIndex: 3, timestamp: TIMESTAMP,
    name: 'run', toolCallId: 'call-2',
    args: { command: 'bun test broken.test.ts' },
    result: 'Error (exit 1)\n--- stderr ---\n1 fail', durationMs: 900,
  },
  { type: 'step_finish', runId: 'run-1', eventIndex: 4, timestamp: TIMESTAMP, stepIndex: 0, reason: 'tool-calls' },
  {
    type: 'turn_end', runId: 'run-1', eventIndex: 5, timestamp: TIMESTAMP, turnIndex: 0,
    usage: { input: 1_200, output: 300 },
  },
  { type: 'turn_start', runId: 'run-1', eventIndex: 6, timestamp: TIMESTAMP, turnIndex: 1 },
  {
    type: 'tool_call_end', runId: 'run-1', eventIndex: 7, timestamp: TIMESTAMP,
    name: 'file', toolCallId: 'call-3',
    args: { action: 'edit', path: 'broken.ts' }, result: 'Applied 1 edit', durationMs: 20,
  },
  {
    type: 'file_edit', runId: 'run-1', eventIndex: 8, timestamp: TIMESTAMP,
    attempts: 2, applied: 1, failures: { not_found: 1 }, recoveredPaths: 1, abandonedPaths: 0,
  },
  {
    type: 'tool_call_end', runId: 'run-1', eventIndex: 9, timestamp: TIMESTAMP,
    name: 'run', toolCallId: 'call-4',
    args: { command: 'bun test broken.test.ts' }, result: '1 pass, 0 fail', durationMs: 850,
  },
  { type: 'completion_gate', runId: 'run-1', eventIndex: 10, timestamp: TIMESTAMP, converted: false },
  { type: 'step_finish', runId: 'run-1', eventIndex: 11, timestamp: TIMESTAMP, stepIndex: 1, reason: 'stop' },
  {
    type: 'turn_end', runId: 'run-1', eventIndex: 12, timestamp: TIMESTAMP, turnIndex: 1,
    usage: { input: 1_500, output: 220 },
  },
  { type: 'run_end', runId: 'run-1', eventIndex: 13, timestamp: TIMESTAMP, reason: 'completed' },
];

/**
 * A DEGENERATE trajectory: a turn closed and the agent did nothing.
 *
 * The shape the harness has to REFUSE rather than score. It is not hypothetical —
 * a recorded bench run produced fourteen of these in a row, every one "ungraded
 * (no follow-up) | 0 tool calls | 1 steps", and their mean gain of -0.2 was read
 * as a measurement.
 */
export const DEGENERATE_EVENTS: readonly RunEvent[] = [
  { type: 'run_start', runId: 'run-2', eventIndex: 0, timestamp: TIMESTAMP, agentId: 'eval-public' },
  { type: 'turn_start', runId: 'run-2', eventIndex: 1, timestamp: TIMESTAMP, turnIndex: 0 },
  { type: 'turn_end', runId: 'run-2', eventIndex: 2, timestamp: TIMESTAMP, turnIndex: 0 },
  { type: 'run_end', runId: 'run-2', eventIndex: 3, timestamp: TIMESTAMP, reason: 'completed' },
];
