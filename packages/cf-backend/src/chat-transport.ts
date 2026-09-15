/**
 * The hosted root's chat transport: core's {@link ChatTransport} over the
 * Agents SDK's chat protocol, composed from the SDK's own exports.
 *
 * Inbound, it is the `cf_agent_*` protocol the React hook speaks
 * (`parseProtocolMessage`): a chat request becomes the transcript's user row
 * and one `ChatSession.send`; a cancel is an interrupt; a resume request or
 * ack runs the SDK's {@link ResumeHandshake} over the SDK's
 * {@link ResumableStream} store. Outbound, it is the loop's events and the
 * model stream: each UIMessage chunk of a turn's answer is stored for resume
 * and broadcast as a `cf_agent_use_chat_response` frame under the request that
 * started the turn, accumulated into the assistant row the transcript store
 * persists ({@link StreamAccumulator}), and closed with the `done` frame the
 * hook waits on.
 *
 * What it deliberately does not carry from Think: the stall watchdog (no
 * elapsed deadline ends a turn here), the client-tool continuation lanes (no
 * Kinu client tool exists), the session token-estimate frame (no client reads
 * it), and chat-fiber recovery — an interrupted turn continues from the loop's
 * own step ledger, not from a fiber snapshot.
 */
import type { Connection } from 'agents';
import {
  ContinuationState, MessageType, ResumableStream, ResumeHandshake, StreamAccumulator,
  parseProtocolMessage, reconcileMessages, sanitizeMessage, sendIfOpen,
  type ChatProtocolEvent,
} from 'agents/chat';
import type { SessionMessage } from 'agents/experimental/memory/session';
import type { UIMessage, UIMessageChunk } from 'ai';
import * as v from 'valibot';
import {
  PARTIAL_FLUSH_EVERY, isWorkMode, JsonObjectSchema, TURN_AUTHOR_METADATA_KEY,
  type ChatTransport, type JsonObject, type PromptFile, type SendLanding, type SessionEvent, type SqlExecutor, type WorkMode,
} from '@kinu.run/core';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';

/** What the transport asks of the actor: the connection set, and the loop.
 *  A connection is the SDK's: its resume handshake takes the full type. */
export interface ChatWire {
  readonly sql: SqlExecutor;
  broadcast(message: string, exclude?: string[]): void;
  getConnection(id: string): Connection | undefined;
  /** The transcript as the client should see it, oldest first — the SDK
   *  session's own rows, which the SDK's clients render as UI messages. */
  history(): SessionMessage[];
  /** Persist one incoming user message where the loop will find it. */
  admitMessage(message: UIMessage): void;
  /** The driver API the request maps onto. */
  send(input: { readonly text: string; readonly files: readonly PromptFile[]; readonly id: string; readonly mode: WorkMode }): Promise<SendLanding>;
  interrupt(): void;
  clear(): Promise<void>;
}

/** A message as the hook sends it: the SDK's UIMessage, admitted by its
 *  three load-bearing fields — the reconciler and the store read the rest. */
const UIMessageSchema = v.custom<UIMessage>((value) =>
  v.is(v.object({ id: v.string(), role: v.picklist(['user', 'assistant', 'system']), parts: v.array(v.unknown()) }), value));

/** The body of a `chat-request` frame: the hook's messages and trigger. */
const ChatRequestBodySchema = v.object({
  messages: v.array(UIMessageSchema),
  trigger: v.optional(v.string()),
});

/** The parts and metadata the loop reads off a user message. */
const ChatInputSchema = v.object({
  parts: v.array(v.looseObject({
    type: v.string(), text: v.optional(v.string()), url: v.optional(v.string()),
    mediaType: v.optional(v.string()), filename: v.optional(v.string()),
  })),
  metadata: v.optional(v.looseObject({ kinuMode: v.optional(v.string()) })),
});

interface LiveStream {
  readonly requestId: string;
  readonly streamId: string;
  readonly accumulator: StreamAccumulator;
  chunksSinceFlush: number;
  hasFlushedContent: boolean;
  /** The transcript spent this answer before `turn-end` closed the stream. */
  taken: boolean;
}

/**
 * Think's durability rule for the chunk store, kept exactly: a settled tool
 * result flushes at once; the first content chunk flushes; after that every
 * {@link PARTIAL_FLUSH_EVERY} chunks — the same cadence the loop's partial
 * ledger row follows, so a reconnecting client and a continuing turn read the
 * same amount of the interrupted answer.
 */
function flushesNow(chunk: UIMessageChunk, chunksSinceFlush: number, hasFlushedContent: boolean): boolean {
  if (chunk.type === 'tool-output-available' || chunk.type === 'tool-output-error' || chunk.type === 'tool-output-denied') return true;

  return (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-input-available')
    && (!hasFlushedContent || chunksSinceFlush >= PARTIAL_FLUSH_EVERY);
}

export class ChatWireTransport implements ChatTransport {
  private readonly resumable: ResumableStream;
  private readonly handshake: ResumeHandshake;
  private readonly pendingResume = new Set<string>();
  private readonly continuation = new ContinuationState<Connection>();
  /** The request each admitted user turn answers under, by its opening row's id. */
  private readonly requests = new Map<string, string>();
  private live: LiveStream | null = null;
  /** Answers whose stream closed before the transcript took them, by message
   *  id. The loop persists the row BEFORE it emits `turn-end`, so production
   *  reads the live accumulator; this holds the other order. */
  private readonly answers = new Map<string, UIMessage>();

  constructor(private readonly wire: ChatWire) {
    this.resumable = new ResumableStream(wire.sql);
    this.handshake = new ResumeHandshake({
      responseMessageType: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      resumableStream: this.resumable,
      continuation: this.continuation,
      pendingResumeConnections: this.pendingResume,
      pendingChatTerminal: () => Promise.resolve(null),
      // An orphaned stream is the loop's to continue from its ledger, never a
      // row this transport reconstructs from chunks.
      persistOrphanedStream: () => Promise.resolve(),
      isConnectionPresent: (id) => wire.getConnection(id) !== undefined,
    });
  }

  /** The answer the transcript persists under this id, once. */
  answer(id: string): UIMessage | null {
    const message = this.streamed(id);

    if (message !== null) {
      this.answers.delete(id);

      if (this.live?.accumulator.messageId === id) this.live.taken = true;
    }

    return message;
  }

  /** The same answer, read without spending it: the roster declares the
   *  turn-end announcement over it before the transcript persists it. The
   *  stream has finished by then, so the live accumulator IS the answer. */
  streamed(id: string): UIMessage | null {
    const live = this.live;

    if (live !== null && live.accumulator.messageId === id && live.accumulator.parts.length > 0) return live.accumulator.toMessage();

    return this.answers.get(id) ?? null;
  }

  // ── Connections ─────────────────────────────────────────────────────

  onConnect(connection: Connection): void {
    if (this.resumable.hasActiveStream()) {
      this.handshake.notifyStreamResuming(connection);

      return;
    }

    sendIfOpen(connection, JSON.stringify({ type: MessageType.CF_AGENT_CHAT_MESSAGES, messages: this.wire.history() }));
  }

  onClose(connection: Connection): void {
    this.pendingResume.delete(connection.id);
    this.continuation.releaseConnection(connection.id);
  }

  /** Handle one socket frame if it is chat protocol; false when it is not. */
  async onMessage(connection: Connection, raw: string): Promise<boolean> {
    const event = parseProtocolMessage(raw);

    if (event === null) return false;
    await this.handle(connection, event);

    return true;
  }

  private async handle(connection: Connection, event: ChatProtocolEvent): Promise<void> {
    switch (event.type) {
      case 'stream-resume-request':
        await this.handshake.handleResumeRequest(connection, event.probeId);

        return;

      case 'stream-resume-ack':
        await this.handshake.handleResumeAck(connection, event.id);

        return;

      case 'chat-request': {
        if (event.init.method === 'POST') await this.admitChatRequest(connection, event.id, event.init.body);

        return;
      }

      case 'cancel':
        this.wire.interrupt();

        return;

      case 'clear': {
        this.resumable.clearAll();
        this.pendingResume.clear();
        await this.wire.clear();
        this.wire.broadcast(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }), [connection.id]);

        return;
      }

      case 'tool-result':
      case 'tool-approval':
      case 'messages':
        // No Kinu client tool exists and the transcript is server-authoritative.
        diagnostics.event('chat.protocol_frame_ignored', { frame: event.type });
    }
  }

  /**
   * The chat request: the hook's messages reconciled against what is stored
   * (`reconcileMessages`, the SDK's own rule for what is new), each new user
   * message persisted before the loop hears of it, then ONE send per fresh
   * message. A regenerate carries nothing new and is answered as done.
   */
  private async admitChatRequest(connection: Connection, requestId: string, body: string | undefined): Promise<void> {
    const parsed = body === undefined ? null : v.safeParse(v.pipe(v.string(), v.parseJson(), ChatRequestBodySchema), body);

    if (parsed === null || !parsed.success || parsed.output.trigger === 'regenerate-message') {
      this.done(requestId);

      return;
    }

    const stored = this.wire.history();
    // SAFETY: a stored row IS the UIMessage the SDK persisted — its session
    // provider writes `{ id, role, parts, metadata }` from a UIMessage and
    // reads it back unchanged; the SDK's own agent hands `getHistory()` rows
    // to `reconcileMessages` the same way (Think, `_readMessagesFromStorage`).
    const storedMessages = stored as UIMessage[];

    const fresh = reconcileMessages(parsed.output.messages, storedMessages, sanitizeMessage)
      .filter((message) => message.role === 'user' && !stored.some((row) => row.id === message.id));

    if (fresh.length === 0) {
      this.done(requestId);

      return;
    }

    let landed: SendLanding = 'mid-turn';

    for (const message of fresh) {
      const input = chatInput(message);
      this.requests.set(message.id, requestId);

      // The row the client's message becomes carries the same facts a message
      // sent any other way does — the operator's authorship and its mode —
      // so a reader finds one shape whichever transport carried it.
      const carried: JsonObject = v.safeParse(JsonObjectSchema, message.metadata).success
        ? v.parse(JsonObjectSchema, message.metadata)
        : {};

      this.wire.admitMessage({
        ...message,
        metadata: { ...carried, kinuMode: input.mode, [TURN_AUTHOR_METADATA_KEY]: 'operator' },
      });
      this.wire.broadcast(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_MESSAGES, messages: this.wire.history() }), [connection.id]);
      landed = await this.wire.send({ ...input, id: message.id });
    }

    // A splice answers at once, with where it landed; a turn answers when its
    // own `turn-end` closes the request it was admitted under.
    if (landed === 'mid-turn') this.done(requestId, { landed });
  }

  private done(requestId: string, extra: { landed?: SendLanding; error?: string } = {}): void {
    this.wire.broadcast(JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: requestId, body: extra.error ?? '', done: true,
      ...(extra.error !== undefined && { error: true }), ...(extra.landed !== undefined && { landed: extra.landed }),
    }));
  }

  // ── The loop's events ───────────────────────────────────────────────

  deliver(event: SessionEvent): void {
    switch (event.type) {
      case 'turn-start': {
        // A user turn answers under the request that admitted it; a harness
        // turn (a wake, a rerun) under an id of its own, as Think minted one.
        const requestId = this.requests.get(event.turnId) ?? crypto.randomUUID();
        this.requests.delete(event.turnId);

        const streamId = this.resumable.start(requestId, { messageId: event.messageId });

        this.live = { requestId, streamId, accumulator: new StreamAccumulator({ messageId: event.messageId }), chunksSinceFlush: 0, hasFlushedContent: false, taken: false };

        return;
      }

      case 'turn-end': {
        const live = this.live;

        if (live === null) return;
        this.live = null;

        if (!live.taken && live.accumulator.parts.length > 0) this.answers.set(live.accumulator.messageId, live.accumulator.toMessage());

        this.resumable.complete(live.streamId);
        this.pendingResume.clear();
        this.done(live.requestId);
        this.wire.broadcast(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_MESSAGES, messages: this.wire.history() }));

        return;
      }

      case 'error': {
        const live = this.live;

        if (live === null) return;

        this.resumable.markError(live.streamId);
        this.wire.broadcast(JSON.stringify({
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: live.requestId, body: event.message, done: false, error: true,
        }));

        return;
      }

      case 'broadcast':
        this.wire.broadcast(JSON.stringify(event.event));

        return;

      case 'text-delta':
      case 'tool-call':
      case 'tool-result':
      case 'evolution':
      case 'background':
      case 'run-event':
        // The answer's chunks reach the client from the model stream below;
        // the side channels have no wire frame on this backend.
    }
  }

  // ── The model stream ────────────────────────────────────────────────

  /**
   * One turn's UIMessage chunks, from the SDK's own stream conversion, each
   * stored for resume and broadcast under the live request. Runs beside the
   * loop's own consumption of the same result; the loop settles the turn once
   * this has drained, so the answer row carries every part the client saw.
   */
  async observe(stream: ReadableStream<UIMessageChunk>): Promise<void> {
    const live = this.live;

    if (live === null) return;

    try {
      for await (const chunk of stream) {
        const { action } = live.accumulator.applyChunk(chunk);

        // The client builds the streamed message under the id the row is
        // persisted under, as Think stamped it: a provider that emits no
        // `start.messageId` would otherwise leave the tab with two copies.
        if (chunk.type === 'start' && action?.type === 'start' && action.messageId === undefined) chunk.messageId = live.accumulator.messageId;

        const body = JSON.stringify(chunk);
        this.resumable.storeChunk(live.streamId, body);
        live.chunksSinceFlush += 1;

        if (flushesNow(chunk, live.chunksSinceFlush, live.hasFlushedContent)) {
          this.resumable.flushBuffer();
          live.chunksSinceFlush = 0;
          live.hasFlushedContent = true;
        }

        this.wire.broadcast(JSON.stringify({ type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: live.requestId, body, done: false }));
      }
    } catch (cause) {
      diagnostics.failure('chat.stream_observe_failed', toKinuError({
        doing: 'relaying the answer stream to the connected clients', cause, otherwise: 'io',
      }));
    }
  }
}

/** The loop's input for one client message: its text, its files, its mode. */
function chatInput(message: UIMessage) {
  const { parts, metadata } = v.parse(ChatInputSchema, message);
  const text = parts.flatMap((part) => part.type === 'text' ? [part.text ?? ''] : []).join('');

  const files: PromptFile[] = parts.flatMap((part) => part.type === 'file' && part.url !== undefined
    ? [{ filename: part.filename ?? 'attachment', mediaType: part.mediaType ?? 'application/octet-stream', url: part.url }]
    : []);

  const mode = metadata?.kinuMode;

  const chosen: WorkMode = mode !== undefined && isWorkMode(mode) ? mode : 'build';

  return { text, files, mode: chosen };
}
