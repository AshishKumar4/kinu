import * as v from 'valibot';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import {
  ChatResponseFrameSchema, JsonValueSchema, READS_CHANGED_EVENT, parseJsonValue, terminalChatError, type JsonValue, type WorkMode,
} from '../../packages/core/src/index';
import { tolerate } from '../../packages/core/src/obs/index';
import { CloudTurnStream } from '../../packages/cli/src/cloud-turn-stream';
import { createUserUiMessage, type AgentSendResult, type AgentTurnResult } from '../../packages/cli/src/agent-client';

/**
 * The WebSocket constructor as BUN implements it, whose second argument may be
 * the standard `protocols` OR an options object carrying per-handshake
 * `headers` (bun-types: `Bun.WebSocketOptions`, bun.d.ts:4283).
 *
 * Spelled here because the AMBIENT global in a project that also loads
 * `@types/node` is undici's, and undici's constructor takes protocols only
 * (@types/node/web-globals/fetch.d.ts:66) — measured: `new WebSocket(url,
 * {headers})` fails to compile under `tests/tsconfig.json` with
 * `'headers' does not exist in type 'string[]'`. Headers are not a convenience
 * here: they are the ONLY way to authenticate this upgrade as the web plane,
 * since the query-parameter path is the CLI ticket's (server.ts:198) and a
 * cookie is a header too. Both vitest tiers run under `bun --bun`
 * (evals/vitest.config.ts, vitest.first-run.config.ts), so the implementation
 * behind the global is Bun's.
 */
type BunWebSocketConstructor = new (
  url: string,
  options?: string | readonly string[] | { readonly headers: Readonly<Record<string, string>> },
) => WebSocket;

// Parsed rather than asserted: the value is checked to BE the runtime's global
// constructor, and the type is the one bun-types declares for it
// (`Bun.WebSocketOptions`), which only WIDENS the ambient signature — it contains
// `string | string[]` verbatim and adds the headers object.
export const HEADER_WEBSOCKET = v.parse(
  v.custom<BunWebSocketConstructor>((value) => value === globalThis.WebSocket, 'the global WebSocket constructor'),
  globalThis.WebSocket,
);

// ── The frames, as data ─────────────────────────────────────────────

/**
 * The frame that starts a turn, exactly as the web client's transport puts it on
 * the socket: a request id, and an `init` whose body is the AI-SDK chat request.
 *
 * `trigger: 'submit-message'` is the SDK's own value for a user send, and the
 * message is built by `createUserUiMessage` — the shipped constructor, so the
 * UIMessage shape cannot drift from what the DO parses. It carries the request's
 * own id: a turn a later activation re-opens is announced by that id.
 *
 * NO `oneShot`. That flag makes each prompt an `independent_task`
 * (actor-agent.ts:470-478), which is the CLI's one-shot contract and the exact
 * opposite of what this harness measures: a MULTI-TURN trajectory, where turn
 * two is a follow-up on turn one and the completion gate may grade the previous
 * answer. The web chat sends no such flag either, which is the point.
 */
export function encodeChatRequest(input: {
  readonly requestId: string;
  readonly text: string;
  /** Plan confines the turn to the tools Plan permits, as the composer's Plan does; absent is Build. */
  readonly mode?: WorkMode;
}): string {
  return JSON.stringify({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
    id: input.requestId,
    init: {
      method: 'POST',
      body: JSON.stringify({
        messages: [createUserUiMessage(input.requestId, input.text, [], input.mode === undefined ? {} : { kinuMode: input.mode })],
        trigger: 'submit-message',
      }),
    },
  });
}

/** One `{type:'rpc', id, method, args}` frame — the shape the agents-SDK client
 *  sends for a callable method, which is what `useKinu`'s `rpc()` wrapper is
 *  bound to (`bindRpc` in hooks/use-chat-owner.ts). The type word is a literal because the
 *  SDK exports no constant for it. */
export function encodeRpcRequest(input: {
  readonly requestId: string;
  readonly method: string;
  readonly args: readonly JsonValue[];
}): string {
  return JSON.stringify({
    type: 'rpc', id: input.requestId, method: input.method, args: [...input.args],
  });
}

/** A turn frame, as core reads it, for the send it answers. */
export type PublicResponseFrame = Omit<v.InferOutput<typeof ChatResponseFrameSchema>, 'type' | 'id'> & { readonly id: string };

/** What one decoded socket frame is. `other` is not an error: the DO fans
 *  broadcasts (branch status, head activity, mcts progress) down the same
 *  socket, and a session that treated an unread broadcast as a fault would fail
 *  on the product working. */
export type PublicFrame =
  | { readonly kind: 'response'; readonly frame: PublicResponseFrame }
  | {
      readonly kind: 'rpc';
      readonly id: string;
      readonly result: JsonValue;
      /** The reply's failure text, or null when it succeeded. */
      readonly error: string | null;
    }
  /** The DO announcing a stream for `id` it keeps from this socket until acked: its live chunks are the workspace
   *  working. */
  | { readonly kind: 'resuming'; readonly id: string }
  /** The live reads a write in the workspace moved (`reads_changed`), sent at the end of the tick that wrote: before
   *  the answer to any call that arrived after the write. Names are kept as sent, so a read a newer build adds still
   *  counts. */
  | { readonly kind: 'reads'; readonly reads: readonly string[] }
  | { readonly kind: 'other'; readonly type: string };

const FrameSchema = v.object({
  type: v.string(),
  id: v.optional(v.string()),
  /** An RPC reply's `error` is the failure itself, a string or a structured value; a turn frame's is read as core
   *  reads it, below. */
  error: v.optional(JsonValueSchema),
  success: v.optional(v.boolean()),
  result: v.optional(JsonValueSchema),
  reads: v.optional(v.array(v.string())),
});

/**
 * Decode one frame off the wire.
 *
 * Returns null for anything that is not a JSON object with a `type` — a frame
 * this session drops rather than a failure, exactly as the shipped client drops
 * unparseable text (cloud-agent-client.ts:1063-1080). Everything it DOES
 * recognise is narrowed field by field, so a frame that grew a field is read the
 * same way and a frame that lost one is a decode miss rather than an
 * `undefined` threaded into a turn.
 */
export function decodeFrame(data: SocketPayload): PublicFrame | null {
  const parsed = decodeSocketJson(data);

  if (parsed === undefined) return null;
  const frame = v.safeParse(FrameSchema, parsed);

  if (!frame.success) return null;
  const { type, id } = frame.output;

  if (type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE) {
    const response = v.safeParse(ChatResponseFrameSchema, parsed);

    if (!response.success || response.output.id === undefined) return { kind: 'other', type };
    const { body, done, error, landed, replay, reason } = response.output;

    return { kind: 'response', frame: { id: response.output.id, body, done, error, landed, replay, reason } };
  }

  // A REPLY, told from a request by the field the producer always sets. The
  // agents SDK answers every callable with `success: true|false`
  // (agents/dist/index.js:912-926) and a request carries `method`/`args` and no
  // `success` at all (dist/client.js:242-247) — so keying on `success` is what
  // stops this session reading its OWN outbound frame, or an echo of one, as a
  // refused call.
  if (type === 'rpc' && id !== undefined && frame.output.success !== undefined) {
    const detail = v.safeParse(v.string(), frame.output.error);
    const refusal = detail.success ? detail.output : 'the workspace RPC failed';

    return {
      kind: 'rpc',
      id,
      result: frame.output.result ?? null,
      error: frame.output.success ? null : refusal,
    };
  }

  if (type === CHAT_MESSAGE_TYPES.STREAM_RESUMING && id !== undefined) return { kind: 'resuming', id };

  if (type === READS_CHANGED_EVENT && frame.output.reads !== undefined) return { kind: 'reads', reads: frame.output.reads };

  return { kind: 'other', type };
}

/** What a socket frame arrives as: text, or the bytes a binary frame carried.
 *  Both spellings are handled for the reason the shipped client handles them
 *  (cloud-agent-client.ts:1063-1074) — the transport chooses, not the caller. */
export type SocketPayload = string | ArrayBuffer | Uint8Array;

/**
 * One frame's JSON, or `undefined` when the payload is not JSON at all.
 *
 * `tolerate` with the `malformed-input` class, which is the shipped rule for
 * this exact boundary: a frame this session cannot read is a frame it DROPS, and
 * anything that is not a parse failure still throws. A bare `catch` here would
 * turn a real fault into the same value an unreadable broadcast produces.
 */
function socketText(data: SocketPayload): string | null {
  const text = v.safeParse(v.string(), data);

  if (text.success) return text.output;
  const bytes = v.safeParse(v.instance(Uint8Array), data);

  if (bytes.success) return new TextDecoder().decode(bytes.output);
  const buffer = v.safeParse(v.instance(ArrayBuffer), data);

  if (buffer.success) return new TextDecoder().decode(buffer.output);

  return null;
}

export function decodeSocketJson(data: SocketPayload): JsonValue | undefined {
  const decoded = socketText(data);

  if (decoded === null) return undefined;

  return tolerate(() => parseJsonValue(decoded), 'malformed-input');
}

/** What a send resolves to: the turn it opened, or the absorbing run's id
 *  when the done frame answered `mid-turn` — the run whose close the case's
 *  observation window is open until. */
export type PublicSendResult =
  | { readonly landed: 'mid-turn'; readonly absorbedBy: string | null }
  | ({ readonly landed: 'turn' } & AgentTurnResult);

/** The recorder's settled value is the wire's own result — what the send's
 *  done frame SAID — before the absorbing run's close is known. */
export type PublicTurn = AgentSendResult;

export interface PublicTurnRecorder {
  /** Feed one response frame. */
  apply(frame: PublicResponseFrame): void;
  /** End a turn its socket dropped: the answer its turn recorded, if any, and whether the turn ended in error. */
  finish(answer: string | null, hadError: boolean): void;
  /** The send's settled result, or null while it is still open. */
  settled(): PublicTurn | null;
  /** The runtime's refusal of the send at its door, in its own words: no turn ran, so none settles. */
  refusal(): Error | null;
}

/**
 * A turn under construction, over the shipped accumulator.
 *
 * The pure seam this module is tested through: a suite can hand it recorded
 * frames and assert the turn that comes out — the text, the tool calls paired to
 * their outputs and the step count — with no socket and no deployment.
 */
export function recordPublicTurn(): PublicTurnRecorder {
  let settled: PublicTurn | null = null;
  let refusal: Error | null = null;

  const stream = new CloudTurnStream(() => {}, {
    resolve: (result) => { settled = result; },
    reject: (refused) => { refusal = refused; },
  });

  return {
    apply(frame) {
      if (settled !== null || refusal !== null) return;

      if (frame.error === true) {
        const ended = terminalChatError({ ...frame, type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE });

        // Refused at the door, the send was never admitted: it fails as the shipped client fails it, as a send.
        if (ended?.refused === true) stream.refused(ended.body);
        else stream.settle(true);

        return;
      }

      stream.apply(frame.body);

      // The done frame is the DO's verdict on WHERE the send landed. A
      // mid-turn answer opens no stream of its own — `settle` would mint a
      // turn record out of nothing, and the caller would hold a zero-step
      // turn beside the absorbing run that actually answered.
      if (frame.done === true) {
        if (frame.landed === 'mid-turn') stream.landedMidTurn();
        else stream.settle();
      }
    },
    finish(answer, hadError) {
      if (answer !== null) stream.finish(answer);
      stream.settle(hadError);
    },
    settled: () => settled,
    refusal: () => refusal,
  };
}

/** A turn frame's body is one AI SDK UI message chunk; the chunks of a tool call's run carry its id. */
const ChunkTypeSchema = v.object({ type: v.string(), toolCallId: v.optional(v.string()), preliminary: v.optional(v.boolean()) });

/** A chunk as far as hearing needs it: its type, and the call it belongs to. */
export type HeardChunk = v.InferOutput<typeof ChunkTypeSchema>;

/** One frame as a socket heard it: its chunk, and whether it is live output rather than a replay of what was sent. */
export type HeardFrame = { readonly live: boolean; readonly chunk: HeardChunk | null };

function chunkOf(body: string | undefined): HeardChunk | null {
  const chunk = body === undefined ? null : v.safeParse(ChunkTypeSchema, decodeSocketJson(body));

  return chunk?.success === true ? chunk.output : null;
}

/**
 * The streams one socket hears, and the tool calls each has started and not ended. A call runs from its input to its
 * last output; one parked for a person's approval is not running. A replay sends a stream again from its start, so the
 * calls it leaves running are the stream's; a stream's `done` ends them all.
 */
export class HeardStreams {
  private readonly calls = new Map<string, Set<string>>();

  /** Hear one frame of `stream`. */
  hear(stream: string, frame: PublicResponseFrame): HeardFrame {
    const chunk = chunkOf(frame.body);

    if (chunk?.toolCallId !== undefined) {
      const running = this.calls.get(stream) ?? new Set<string>();

      if (chunk.type === 'tool-input-available') running.add(chunk.toolCallId);
      else if ((chunk.type.startsWith('tool-output-') && chunk.preliminary !== true) || chunk.type === 'tool-approval-request') running.delete(chunk.toolCallId);
      this.calls.set(stream, running);
    }

    if (frame.done === true) this.calls.delete(stream);

    return { live: frame.replay !== true, chunk };
  }

  running(): string[] {
    return [...this.calls.values()].flatMap((running) => [...running]);
  }
}

