/**
 * The chat rooms of one workspace object: core's {@link ChatTransport} over the Agents
 * SDK's `cf_agent_*` chat protocol. The transport writes no row: the loop is the one
 * writer and decides where a message lands.
 * One room per addressed actor, chosen by the socket's `actorConnectionTag`. A hosted
 * actor's room has no resume store: {@link ResumableStream} keeps one active stream per
 * database, so a second store would read the root's live turn as the actor's.
 */
import type { Connection } from 'agents';
import {
  ContinuationState, MessageType, ResumableStream, ResumeHandshake, StreamAccumulator,
  parseProtocolMessage, reconcileMessages, sanitizeMessage, sendIfOpen,
  type ChatProtocolEvent,
} from 'agents/chat';
import type { UIMessage, UIMessageChunk } from 'ai';
import * as v from 'valibot';
import {
  partialFlushCadence, type PartialFlushCadence, type PartialFlushSignal, isWorkMode, INTERRUPTED_TURN,
  type ChatTransport, type ObservedCall, type PromptFile, type SendLanding, type SessionEvent, type SqlExecutor, type WorkMode,
} from '@kinu.run/core';
import { diagnostics, KinuError, refusalOf, toKinuError } from '@kinu.run/core/obs';

/** The frame paths take the whole `Connection` because the SDK's `ResumeHandshake` declares it. */
export type ChatSocket = Pick<Connection, 'id'>;

export interface ChatWire {
  /** Null for a wire whose turns stream live only (hosted actors; see header). */
  readonly sql: SqlExecutor | null;
  broadcast(message: string, exclude?: string[]): void;
  /** The handshake asks by id before it replays to a replacement. */
  getConnection(id: string): ChatSocket | undefined;
  history(): Promise<UIMessage[]>;
  /** A durable row or an accepted send's reservation: the hook resends its whole list per request. */
  admitted(id: string): boolean;
  /** Rejects when the loop refuses the message: nothing was written and no turn ran. */
  send(input: { readonly text: string; readonly files: readonly PromptFile[]; readonly id: string; readonly mode: WorkMode }): Promise<SendLanding>;
  interrupt(): void;
  clear(): Promise<void>;
}

export interface ChatRoom {
  onConnect(connection: Connection): Promise<void>;
  onClose(connection: ChatSocket): void;
  onMessage(connection: Connection, raw: string): Promise<boolean>;
}

const UIMessageSchema = v.custom<UIMessage>((value) =>
  v.is(v.object({ id: v.string(), role: v.picklist(['user', 'assistant', 'system']), parts: v.array(v.unknown()) }), value));

const ChatRequestBodySchema = v.object({
  messages: v.array(UIMessageSchema),
  trigger: v.optional(v.string()),
});

const ChatInputSchema = v.object({
  parts: v.array(v.looseObject({
    type: v.string(), text: v.optional(v.string()), url: v.optional(v.string()),
    mediaType: v.optional(v.string()), filename: v.optional(v.string()),
  })),
  metadata: v.optional(v.looseObject({ kinuMode: v.optional(v.string()) })),
});

interface LiveStream {
  readonly requestId: string;
  /** Requests of the other messages a rerun carried, answered when it closes. */
  readonly carried: readonly string[];
  readonly streamId: string;
  /** Renewed per provider call against the turn's parts, so the answer stays one message under one id. */
  accumulator: StreamAccumulator;
  readonly open: OpenParts;
  readonly cadence: PartialFlushCadence;
  taken: boolean;
  /** The relay broke before the stream ended, so the accumulated parts are not the answer. */
  broken: boolean;
  /** Why the turn failed, sent as the frame that ends it. */
  failure: string | null;
}

/** A chunk's meaning to the loop's `partialFlushCadence`, so reconnects and continuations read the same amount. */
function flushSignal(chunk: UIMessageChunk): PartialFlushSignal {
  if (chunk.type === 'tool-output-available' || chunk.type === 'tool-output-error' || chunk.type === 'tool-output-denied') return 'settled';

  return chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-input-available' ? 'content' : 'none';
}

/**
 * Part ids seen opened, mirroring the client's reader: `ai`'s `processUIMessageStream` throws
 * on a delta for a part it never saw open, ending the tab's answer. Text/reasoning ids reset
 * on `finish-step`; tool call ids never do.
 */
class OpenParts {
  private readonly step = new Set<string>();
  private readonly calls = new Set<string>();

  admits(chunk: UIMessageChunk): boolean {
    if (chunk.type === 'text-start' || chunk.type === 'reasoning-start') {
      this.step.add(`${chunk.type === 'text-start' ? 'text' : 'reasoning'}:${chunk.id}`);

      return true;
    }

    if (chunk.type === 'text-delta' || chunk.type === 'text-end') return this.step.has(`text:${chunk.id}`);

    if (chunk.type === 'reasoning-delta' || chunk.type === 'reasoning-end') return this.step.has(`reasoning:${chunk.id}`);

    if (chunk.type === 'finish-step') {
      this.step.clear();

      return true;
    }

    if (chunk.type === 'tool-input-start' || chunk.type === 'tool-input-available' || chunk.type === 'tool-input-error') {
      this.calls.add(chunk.toolCallId);

      return true;
    }

    return chunk.type !== 'tool-input-delta' || this.calls.has(chunk.toolCallId);
  }
}

function transcriptFrame(history: readonly UIMessage[]): string {
  return JSON.stringify({ type: MessageType.CF_AGENT_CHAT_MESSAGES, messages: history });
}

/** `error` and `landed` only when they are facts: the client paints a present `undefined` key as a failure. */
function doneFrame(requestId: string, extra: { landed?: SendLanding; error?: string }): string {
  return JSON.stringify({
    type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: requestId, body: extra.error ?? '', done: true,
    ...(extra.error !== undefined && { error: true }), ...(extra.landed !== undefined && { landed: extra.landed }),
  });
}

export class ChatWireTransport implements ChatTransport, ChatRoom {
  /** Built on first use: `getCallableMethods` evaluates this getter on a bare prototype, and
   *  touching storage there would break the whole RPC surface. */
  private _resume: { readonly resumable: ResumableStream; readonly handshake: ResumeHandshake } | null = null;
  private readonly pendingResume = new Set<string>();
  private readonly continuation = new ContinuationState<Connection>();
  private readonly requests = new Map<string, string>();
  private live: LiveStream | null = null;
  /** Answers whose stream closed before the transcript took them. Production persists before
   *  `turn-end`; this holds the other order. */
  private readonly answers = new Map<string, UIMessage>();

  constructor(private readonly wire: ChatWire) {}

  private get resume(): { readonly resumable: ResumableStream; readonly handshake: ResumeHandshake } | null {
    if (this._resume !== null) return this._resume;
    const sql = this.wire.sql;

    if (sql === null) return null;
    const resumable = new ResumableStream(sql);

    return this._resume = {
      resumable,
      handshake: new ResumeHandshake({
        responseMessageType: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        resumableStream: resumable,
        continuation: this.continuation,
        pendingResumeConnections: this.pendingResume,
        pendingChatTerminal: () => Promise.resolve(null),
        // An orphaned stream is the loop's to continue from its ledger.
        persistOrphanedStream: () => Promise.resolve(),
        isConnectionPresent: (id) => this.wire.getConnection(id) !== undefined,
      }),
    };
  }

  answer(id: string): UIMessage | null {
    const message = this.streamed(id);

    if (message !== null) {
      this.answers.delete(id);

      if (this.live?.accumulator.messageId === id) this.live.taken = true;
    }

    return message;
  }

  /** Read without spending: the roster declares turn-end over it before the transcript persists it. */
  streamed(id: string): UIMessage | null {
    const live = this.live;

    if (live !== null && !live.broken && live.accumulator.messageId === id && live.accumulator.parts.length > 0) return live.accumulator.toMessage();

    return this.answers.get(id) ?? null;
  }

  /** A socket opening mid-turn also reads the current transcript: seed and connect are separate fetches. */
  async onConnect(connection: Connection): Promise<void> {
    const resume = this.resume;
    const history = await this.wire.history();

    if (resume !== null && resume.resumable.hasActiveStream()) resume.handshake.notifyStreamResuming(connection);
    sendIfOpen(connection, transcriptFrame(history));
  }

  onClose(connection: ChatSocket): void {
    this.pendingResume.delete(connection.id);
    this.continuation.releaseConnection(connection.id);
  }

  async onMessage(connection: Connection, raw: string): Promise<boolean> {
    const event = parseProtocolMessage(raw);

    if (event === null) return false;
    await this.handle(connection, event);

    return true;
  }

  private async handle(connection: Connection, event: ChatProtocolEvent): Promise<void> {
    switch (event.type) {
      case 'stream-resume-request': {
        const resume = this.resume;

        // `idle` is load-bearing: the hook keeps waiting on a probe answered with anything weaker.
        if (resume === null) {
          sendIfOpen(connection, JSON.stringify({ type: MessageType.CF_AGENT_STREAM_RESUME_NONE, reason: 'idle', probeId: event.probeId }));

          return;
        }

        await resume.handshake.handleResumeRequest(connection, event.probeId);

        return;
      }

      case 'stream-resume-ack':
        await this.resume?.handshake.handleResumeAck(connection, event.id);

        return;

      case 'chat-request': {
        if (event.init.method === 'POST') await this.admitChatRequest(event.id, event.init.body);

        return;
      }

      case 'cancel':
        this.wire.interrupt();

        return;

      case 'clear': {
        this.resume?.resumable.clearAll();
        this.pendingResume.clear();
        await this.wire.clear();
        this.wire.broadcast(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }), [connection.id]);

        return;
      }

      case 'tool-result':
      case 'tool-approval':
      case 'messages':
        diagnostics.event('chat.protocol_frame_ignored', { frame: event.type });
    }
  }

  /** One send per message the loop does not hold (`reconcileMessages`); answered only once the landing is decided. */
  private async admitChatRequest(requestId: string, body: string | undefined): Promise<void> {
    const parsed = body === undefined ? null : v.safeParse(v.pipe(v.string(), v.parseJson(), ChatRequestBodySchema), body);

    if (parsed === null || !parsed.success || parsed.output.trigger === 'regenerate-message') {
      this.done(requestId);

      return;
    }

    const storedMessages = await this.wire.history();

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
        // The loop refused and wrote nothing; close the request with the refusal so the hook's send
        // rejects instead of waiting on a turn-end that never comes.
        if (!(cause instanceof KinuError)) throw new Error('the loop failed to take a client message', { cause });
        this.requests.delete(message.id);
        this.done(requestId, { error: refusalOf(cause).error });

        return;
      }
    }

    // A spliced message is answered by the absorbing turn's stream; an opening message's id is
    // the turn id, so its `turn-end` closes the request.
    if (landed === 'mid-turn') {
      for (const message of fresh) this.requests.delete(message.id);
      this.done(requestId, { landed });
    }
  }

  private done(requestId: string, extra: { landed?: SendLanding; error?: string } = {}): void {
    this.wire.broadcast(doneFrame(requestId, extra));
  }

  /** The stream answers under the admitting request (`turnId` is the opening row id), else a minted id. */
  async openTurn(turn: { readonly turnId: string; readonly messageId: string; readonly userTurn: boolean; readonly carried: readonly string[] }): Promise<void> {
    const requestId = this.requests.get(turn.turnId) ?? crypto.randomUUID();
    this.requests.delete(turn.turnId);
    const carried: string[] = [];

    for (const id of turn.carried) {
      const request = this.requests.get(id);

      if (request === undefined) continue;
      this.requests.delete(id);
      carried.push(request);
    }

    const streamId = this.resume?.resumable.start(requestId, { messageId: turn.messageId }) ?? requestId;

    this.live = { requestId, carried, streamId, accumulator: new StreamAccumulator({ messageId: turn.messageId }), open: new OpenParts(), cadence: partialFlushCadence(), taken: false, broken: false, failure: null };

    if (turn.userTurn) this.wire.broadcast(transcriptFrame(await this.wire.history()));
  }

  /** The answer row is durable before this. */
  async closeTurn(): Promise<void> {
    const live = this.live;

    if (live === null) return;
    this.live = null;

    if (!live.taken && !live.broken && live.accumulator.parts.length > 0) this.answers.set(live.accumulator.messageId, live.accumulator.toMessage());
    const history = await this.wire.history();

    this.resume?.resumable.complete(live.streamId);
    this.pendingResume.clear();
    this.done(live.requestId, live.failure === null ? {} : { error: live.failure });

    for (const request of live.carried) this.done(request);
    this.wire.broadcast(transcriptFrame(history));
  }

  async deliver(event: SessionEvent): Promise<void> {
    switch (event.type) {
      case 'turn-start':
        await this.openTurn({ turnId: event.turnId, messageId: event.messageId, userTurn: event.kind === 'user', carried: event.carried });

        return;

      case 'turn-end':
        await this.closeTurn();

        return;

      case 'error': {
        const live = this.live;

        if (live === null) return;

        // A Stop is not a failure: an `error` frame here makes the SDK client paint an error card.
        if (event.message === INTERRUPTED_TURN) return;

        this.resume?.resumable.markError(live.streamId);
        live.failure = event.message;

        return;
      }

      case 'broadcast':
        this.wire.broadcast(JSON.stringify(event.event));

        return;

      // The walk-back moved the durable head; every tab needs the stored transcript.
      case 'history-reverted':
        this.wire.broadcast(transcriptFrame(await this.wire.history()));

        return;

      case 'text-delta':
      case 'tool-call':
      case 'tool-result':
      case 'evolution':
      case 'background':
      case 'run-event':
    }
  }

  /**
   * One provider call's UIMessage chunks, stored for resume and broadcast. The loop settles
   * the turn after this drains. A continuation call renews the accumulator seeded with the
   * turn's parts, so a second `start` cannot rename the answer.
   */
  async observe(stream: ReadableStream<UIMessageChunk>, call: ObservedCall): Promise<void> {
    const live = this.live;

    if (live === null) return;

    if (call.index > 0) {
      live.accumulator = new StreamAccumulator({
        messageId: live.accumulator.messageId,
        continuation: true,
        existingParts: live.accumulator.parts,
        ...(live.accumulator.metadata !== undefined && { existingMetadata: live.accumulator.metadata }),
      });
    }

    try {
      for await (const chunk of stream) {
        // The provider's own words: the sender's chat would keep them as its error, and the turn's classified
        // failure follows as the frame that ends it.
        if (chunk.type === 'error') continue;
        const { action } = live.accumulator.applyChunk(chunk);

        if (!live.open.admits(chunk)) {
          this.degradeRelay(live, toKinuError({
            doing: 'relaying the answer stream to the connected clients',
            cause: new KinuError('io', `the model stream carried a ${chunk.type} continuing a part this relay never saw open`),
            otherwise: 'io',
          }));

          return;
        }

        // Stamp the persisted row id: a provider emitting no `start.messageId` leaves the tab two copies.
        if (chunk.type === 'start' && action?.type === 'start' && action.messageId === undefined) chunk.messageId = live.accumulator.messageId;

        const body = JSON.stringify(chunk);
        const resume = this.resume;

        if (resume !== null) {
          resume.resumable.storeChunk(live.streamId, body);

          if (live.cadence.flushes(flushSignal(chunk))) resume.resumable.flushBuffer();
        }

        this.wire.broadcast(JSON.stringify({ type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: live.requestId, body, done: false }));
      }
    } catch (cause) {
      this.degradeRelay(live, toKinuError({
        doing: 'relaying the answer stream to the connected clients', cause, otherwise: 'io',
      }));
    }
  }

  /** The relay broke; the turn did not. The tab gets our classification; the SDK's words go to diagnostics. */
  private degradeRelay(live: LiveStream, error: KinuError): void {
    diagnostics.failure('chat.stream_observe_failed', error);
    live.broken = true;
    this.resume?.resumable.markError(live.streamId);
    this.wire.broadcast(JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: live.requestId, body: refusalOf(error).error, done: false, error: true,
    }));
  }
}

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

/**
 * Which room serves this socket, keyed by the actor tag so hibernation restores it.
 * An actor no longer hosted resolves to no room; never fall back to the root's.
 */
export class ActorChatRooms {
  private readonly hosted = new Map<string, ChatWireTransport>();

  constructor(
    private readonly root: () => ChatWireTransport,
    private readonly wireFor: (name: string) => ChatWire | null,
  ) {}

  for(actor: string | null): ChatWireTransport | null {
    if (actor === null) return this.root();

    return this.hostedRoom(actor);
  }

  hostedRoom(actor: string): ChatWireTransport | null {
    const held = this.hosted.get(actor);

    if (held !== undefined) return held;
    const wire = this.wireFor(actor);

    if (wire === null) return null;
    const room = new ChatWireTransport(wire);
    this.hosted.set(actor, room);

    return room;
  }
}
