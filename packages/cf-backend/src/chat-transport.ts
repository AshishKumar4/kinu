/**
 * The hosted root's chat transport: core's {@link ChatTransport} over the
 * Agents SDK's chat protocol, composed from the SDK's own exports.
 *
 * Inbound, it is the `cf_agent_*` protocol the React hook speaks
 * (`parseProtocolMessage`): a chat request is one `ChatSession.send` per
 * message the client has not sent before; a cancel is an interrupt; a resume
 * request or ack runs the SDK's {@link ResumeHandshake} over the SDK's
 * {@link ResumableStream} store. Outbound, it is the loop's events and the
 * model stream: each UIMessage chunk of a turn's answer is stored for resume
 * and broadcast as a `cf_agent_use_chat_response` frame under the request that
 * started the turn, accumulated into the assistant row the transcript store
 * persists ({@link StreamAccumulator}), and closed with the `done` frame the
 * hook waits on.
 *
 * THE TRANSPORT WRITES NO ROW. The loop is the one writer of a user row, and
 * it decides where a message lands before anything is durable: a message
 * that opens a turn is that turn's opening row, written by the loop at the
 * turn's start; a message spliced into a running turn is written by the drain
 * that lands it, with the stamps that say which step it landed in; a message
 * the loop refuses leaves nothing behind. A row this transport wrote ahead of
 * that decision was a second writer of the same fact, and the two disagreed —
 * about the stamps, about a rerun, about a refusal.
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
  partialFlushCadence, type PartialFlushCadence, type PartialFlushSignal, isWorkMode,
  type ChatTransport, type PromptFile, type SendLanding, type SessionEvent, type SqlExecutor, type WorkMode,
} from '@kinu.run/core';
import { diagnostics, KinuError, refusalOf, renderThrownChain, toKinuError } from '@kinu.run/core/obs';

/** What the transport asks of the actor: the connection set, and the loop.
 *  A connection is the SDK's: its resume handshake takes the full type. */
export interface ChatWire {
  readonly sql: SqlExecutor;
  broadcast(message: string, exclude?: string[]): void;
  getConnection(id: string): Connection | undefined;
  /** The transcript as the client should see it, oldest first — the SDK
   *  session's own rows, which the SDK's clients render as UI messages. */
  history(): SessionMessage[];
  /** Whether the loop already holds a message under this id — a durable row,
   *  or the reservation an accepted send keeps until its row lands. The hook
   *  sends its whole message list with every request, so a message sent
   *  while an earlier one is still landing arrives beside it, and only the
   *  loop knows the earlier one was taken. */
  admitted(id: string): boolean;
  /** The driver API the request maps onto. Rejects when the loop refuses the
   *  message — nothing was written and no turn ran. */
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
  readonly cadence: PartialFlushCadence;
  /** The transcript spent this answer before `turn-end` closed the stream. */
  taken: boolean;
  /** The relay broke before the stream ended: the parts accumulated so far
   *  stop where it broke, so they are not the answer and no reader gets them. */
  broken: boolean;
}

/**
 * What a wire chunk means to the loop's own flush cadence
 * (`partialFlushCadence`): a settled tool result, content, or nothing. The
 * cadence itself is the loop's, so a reconnecting client and a continuing
 * turn read the same amount of the interrupted answer.
 */
function flushSignal(chunk: UIMessageChunk): PartialFlushSignal {
  if (chunk.type === 'tool-output-available' || chunk.type === 'tool-output-error' || chunk.type === 'tool-output-denied') return 'settled';

  return chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-input-available' ? 'content' : 'none';
}

export class ChatWireTransport implements ChatTransport {
  /** The SDK's chunk store and the resume handshake over it, built on FIRST
   *  USE rather than in the constructor: the store declares its table as it
   *  is built, and this transport is reached through a getter on the actor
   *  that the SDK's own callable enumeration (`getCallableMethods`) evaluates
   *  against a bare prototype with no storage behind it. A transport that
   *  touched storage to exist would turn that enumeration into an SQL error
   *  and take the whole RPC surface with it. */
  private _resumable: ResumableStream | null = null;
  private _handshake: ResumeHandshake | null = null;
  private readonly pendingResume = new Set<string>();
  private readonly continuation = new ContinuationState<Connection>();
  /** The request each admitted user turn answers under, by its opening row's id. */
  private readonly requests = new Map<string, string>();
  private live: LiveStream | null = null;
  /** Answers whose stream closed before the transcript took them, by message
   *  id. The loop persists the row BEFORE it emits `turn-end`, so production
   *  reads the live accumulator; this holds the other order. */
  private readonly answers = new Map<string, UIMessage>();

  constructor(private readonly wire: ChatWire) {}

  private get resumable(): ResumableStream {
    return this._resumable ??= new ResumableStream(this.wire.sql);
  }

  private get handshake(): ResumeHandshake {
    return this._handshake ??= new ResumeHandshake({
      responseMessageType: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      resumableStream: this.resumable,
      continuation: this.continuation,
      pendingResumeConnections: this.pendingResume,
      pendingChatTerminal: () => Promise.resolve(null),
      // An orphaned stream is the loop's to continue from its ledger, never a
      // row this transport reconstructs from chunks.
      persistOrphanedStream: () => Promise.resolve(),
      isConnectionPresent: (id) => this.wire.getConnection(id) !== undefined,
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

    if (live !== null && !live.broken && live.accumulator.messageId === id && live.accumulator.parts.length > 0) return live.accumulator.toMessage();

    return this.answers.get(id) ?? null;
  }

  // ── Connections ─────────────────────────────────────────────────────

  /** A socket that opens while a turn is running is told what is resuming
   *  AND reads the transcript as it is now: the seed and the socket connect
   *  are separate fetches, and a turn that started between them would
   *  otherwise leave the tab without the opening row until the turn ends. */
  onConnect(connection: Connection): void {
    if (this.resumable.hasActiveStream()) {
      this.handshake.notifyStreamResuming(connection);
      sendIfOpen(connection, JSON.stringify({ type: MessageType.CF_AGENT_CHAT_MESSAGES, messages: this.wire.history() }));

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
        if (event.init.method === 'POST') await this.admitChatRequest(event.id, event.init.body);

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
   * (`reconcileMessages`, the SDK's own rule for what is new), then ONE send
   * per message the loop does not already hold, each under the id the client
   * renders it by. The loop decides the landing and writes the row; this
   * answers the request accordingly. A regenerate carries nothing new and is
   * answered as done.
   */
  private async admitChatRequest(requestId: string, body: string | undefined): Promise<void> {
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
      .filter((message) => message.role === 'user' && !this.wire.admitted(message.id));

    if (fresh.length === 0) {
      this.done(requestId);

      return;
    }

    let landed: SendLanding = 'mid-turn';

    for (const message of fresh) {
      this.requests.set(message.id, requestId);

      try {
        landed = await this.wire.send({ ...chatInput(message), id: message.id });
      } catch (cause) {
        // The loop REFUSED the message — nothing to say, another driver holds
        // the conversation, a plan turn this surface cannot review — and wrote
        // nothing. A refusal is the loop's own classified error; anything
        // else is a fault in the send itself and is not the client's to read
        // as a refusal. The request is closed with the refusal: the hook's
        // send rejects with it instead of waiting on a turn-end that will
        // never come.
        if (!(cause instanceof KinuError)) throw new Error('the loop failed to take a client message', { cause });
        this.requests.delete(message.id);
        this.done(requestId, { error: refusalOf(cause).error });

        return;
      }
    }

    // A splice answers at once, with where it landed, and the request is
    // spent: a message the splice could not place reruns as a turn of its
    // own, and that turn answers under an id of its own like any harness turn.
    // A message that opened a turn answers when that turn's own `turn-end`
    // closes the request it was admitted under.
    if (landed === 'mid-turn') {
      for (const message of fresh) this.requests.delete(message.id);
      this.done(requestId, { landed });
    }
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
        // The entry is DELETED either way: a steer's own id is the turn id
        // of its rerun, so a turn whose admission names a different id fails
        // through to a minted id — and that entry is the leak finding 10
        // names.
        const requestId = this.requests.get(event.turnId) ?? crypto.randomUUID();
        this.requests.delete(event.turnId);

        const streamId = this.resumable.start(requestId, { messageId: event.messageId });

        this.live = { requestId, streamId, accumulator: new StreamAccumulator({ messageId: event.messageId }), cadence: partialFlushCadence(), taken: false, broken: false };

        // The turn's opening row is on disk before this event: every tab
        // reads the transcript with the operator's message in it, under the id
        // the sender's own hook already renders it by.
        if (event.kind === 'user') this.wire.broadcast(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_MESSAGES, messages: this.wire.history() }));

        return;
      }

      case 'turn-end': {
        // The turn's answer row is durable BEFORE this event — the commit
        // lands inside `runTurn`, and the roster settle only follows it — so
        // the client's done frame and transcript broadcast read the finished
        // turn's rows, whatever the detached terminal tail still owes.
        const live = this.live;

        if (live === null) return;
        this.live = null;

        if (!live.taken && !live.broken && live.accumulator.parts.length > 0) this.answers.set(live.accumulator.messageId, live.accumulator.toMessage());

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

        if (live.cadence.flushes(flushSignal(chunk))) this.resumable.flushBuffer();

        this.wire.broadcast(JSON.stringify({ type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: live.requestId, body, done: false }));
      }
    } catch (cause) {
      // The turn goes on: the loop consumes its own copy of the stream and
      // commits the answer from it. What broke is the RELAY, and three things
      // read the relay as if it were the answer — the accumulator the
      // transcript would persist, the chunk store a reconnect replays, and
      // the tab watching the request — so each is told, here, that it is not.
      diagnostics.failure('chat.stream_observe_failed', toKinuError({
        doing: 'relaying the answer stream to the connected clients', cause, otherwise: 'io',
      }));
      live.broken = true;
      this.resumable.markError(live.streamId);
      this.wire.broadcast(JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: live.requestId, body: renderThrownChain({ cause }), done: false, error: true,
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
