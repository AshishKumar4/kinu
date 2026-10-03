/**
 * Core's {@link ChatTransport} over the SDK's `cf_agent_*` protocol, one room per actor tag. It writes no
 * row; the loop does, and the answer's one durable copy is the loop's `stream_parts`. A tab that reconnects
 * mid-turn is replayed the chunks this relay sent for the turn in progress, over the SDK's documented resume
 * handshake (RESUME_REQUEST, RESUMING, ACK, replay frames, replayComplete). A turn an ended activation left
 * open is re-driven by a later one under a request id that activation mints, so RESUMING names the turn too:
 * the client whose message opened it follows the turn there. A tab that reconnects before the re-drive opens
 * is told the turn is pending (STREAM_PENDING, the SDK's #1784 frame) and told it is resuming once it opens.
 */
import type { Connection } from 'agents';
import {
  MessageType, StreamAccumulator,
  parseProtocolMessage, reconcileMessages, sanitizeMessage, sendIfOpen,
  type ChatProtocolEvent,
} from 'agents/chat';
import type { UIMessage, UIMessageChunk } from 'ai';
import * as v from 'valibot';
import {
  isWorkMode, INTERRUPTED_TURN,
  type ChatTransport, type ObservedCall, type PromptFile, type SendLanding, type SessionEvent, type WorkMode,
} from '@kinu.run/core';
import { Cause, Effect } from 'effect';
import { diagnostics, KinuError, refusalOf, settle, toKinuError } from '@kinu.run/core/obs';

export type ChatSocket = Pick<Connection, 'id'>;

/** `resumes` is false for a wire whose turns stream live only: a hosted actor's tab reads its partial from the
 *  transcript. A resuming wire says whether a turn is owed that has not opened in this activation: the one an ended
 *  activation left open, or an acknowledged send. */
export type ChatWire = ChatWireBase & ({ readonly resumes: false } | { readonly resumes: true; turnOwed(): boolean });

interface ChatWireBase {
  broadcast(message: string, exclude?: string[]): void;
  /** The handshake asks by id before it replays to a replacement. */
  getConnection(id: string): Connection | undefined;
  history(limit?: number): Promise<UIMessage[]>;
  /** A durable row or an accepted send's reservation: the hook resends its whole list per request. */
  admitted(id: string): Promise<boolean>;
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
  /** The id of the message that opened the turn: durable, where `requestId` is this activation's alone. */
  readonly turnId: string;
  /** Requests of the other messages a rerun carried, answered when it closes. */
  readonly carried: readonly string[];
  /** Renewed per provider call against the turn's parts, so the answer stays one message under one id. */
  accumulator: StreamAccumulator;
  readonly open: OpenParts;
  /** Every chunk body this turn relayed, in order: a reconnecting tab's replay. Dropped with the turn. */
  readonly relayed: string[];
  /** The relay broke before the stream ended, so the accumulated parts are not the answer. */
  broken: boolean;
  /** Why the turn failed, sent as the frame that ends it. */
  failure: string | null;
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

/** A frame's newest messages; the pane pages older rows from storage. */
const TRANSCRIPT_WINDOW = 60;

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
  /** Tabs told a stream is resuming and not yet acknowledged: live chunks skip them until their replay. */
  private readonly pendingResume = new Set<string>();
  /** Tabs told an owed turn is pending, each with the probe it asked under: told it is resuming when it opens. */
  private readonly parked = new Map<string, { readonly connection: Connection; readonly probeId: string | undefined }>();
  private readonly requests = new Map<string, string>();
  private live: LiveStream | null = null;

  constructor(private readonly wire: ChatWire) {}

  /** The turn a reconnecting tab can be replayed, or null. */
  private get resumable(): LiveStream | null {
    return this.wire.resumes ? this.live : null;
  }

  /** The connect frame is the pane's only seed, so a socket opening mid-turn gets the current window. */
  async onConnect(connection: Connection): Promise<void> {
    const history = await this.wire.history(TRANSCRIPT_WINDOW);

    this.announce(connection);
    sendIfOpen(connection, transcriptFrame(history));
  }

  onClose(connection: ChatSocket): void {
    this.pendingResume.delete(connection.id);
    this.parked.delete(connection.id);
  }

  /** Told proactively on connect and again on the tab's own request; the client acknowledges once. False when no
   *  turn streams here and none is owed. */
  private announce(connection: Connection, probeId?: string): boolean {
    const live = this.resumable;

    if (live !== null) {
      this.notifyResuming(connection, live, probeId);

      return true;
    }

    const { wire } = this;

    if (!wire.resumes || !wire.turnOwed()) return false;
    this.parked.set(connection.id, { connection, probeId });
    sendIfOpen(connection, JSON.stringify({ type: MessageType.CF_AGENT_STREAM_PENDING, ...(probeId !== undefined && { probeId }) }));

    return true;
  }

  private notifyResuming(connection: Connection, live: LiveStream, probeId: string | undefined): void {
    const frame = { type: MessageType.CF_AGENT_STREAM_RESUMING, id: live.requestId, turnId: live.turnId, ...(probeId !== undefined && { probeId }) };

    if (sendIfOpen(connection, JSON.stringify(frame))) this.pendingResume.add(connection.id);
  }

  /** The loop went idle without opening the turn a parked tab waits on: nothing is resuming. */
  quiet(): void {
    for (const { connection, probeId } of this.parked.values()) {
      sendIfOpen(connection, JSON.stringify({ type: MessageType.CF_AGENT_STREAM_RESUME_NONE, reason: 'idle', probeId }));
    }

    this.parked.clear();
  }

  /** What this relay sent for the turn, then `replayComplete`; the live chunks that follow continue it. */
  private replay(connection: Connection, requestId: string): void {
    this.pendingResume.delete(connection.id);
    const live = this.resumable;

    const frame = (fields: { body: string; replayComplete?: true; done: boolean }): string =>
      JSON.stringify({ type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: requestId, replay: true, ...fields });

    // A request that is no longer live settles; its answer is in the transcript frame.
    if (live === null || live.requestId !== requestId) {
      sendIfOpen(connection, frame({ body: '', done: true }));

      return;
    }

    for (const body of live.relayed) {
      if (!sendIfOpen(connection, frame({ body, done: false }))) return;
    }

    sendIfOpen(connection, frame({ body: '', done: false, replayComplete: true }));
  }

  onMessage(connection: Connection, raw: string): Promise<boolean> {
    const event = parseProtocolMessage(raw);

    if (event === null) return Promise.resolve(false);

    return settle(Effect.as(this.handle(connection, event), true));
  }

  private handle(connection: Connection, event: ChatProtocolEvent): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      switch (event.type) {
        case 'stream-resume-request':
          // `idle` is load-bearing: the hook keeps waiting on a probe answered with anything weaker.
          if (!this.announce(connection, event.probeId)) {
            sendIfOpen(connection, JSON.stringify({ type: MessageType.CF_AGENT_STREAM_RESUME_NONE, reason: 'idle', probeId: event.probeId }));
          }

          return;

        case 'stream-resume-ack':
          this.replay(connection, event.id);

          return;

        case 'chat-request': {
          if (event.init.method === 'POST') yield* this.admitChatRequest(event.id, event.init.body);

          return;
        }

        case 'cancel':
          this.wire.interrupt();

          return;

        case 'clear': {
          this.pendingResume.clear();
          yield* Effect.promise(async () => this.wire.clear());
          this.wire.broadcast(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }), [connection.id]);

          return;
        }

        case 'tool-result':
        case 'tool-approval':
        case 'messages':
          diagnostics.event('chat.protocol_frame_ignored', { frame: event.type });
      }
    });
  }

  /** One send per message the loop does not hold (`reconcileMessages`); answered only once the landing is decided.
   *  Every request ends in exactly one terminal frame: its turn's, or this method's, whatever failed. */
  private admitChatRequest(requestId: string, body: string | undefined): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const parsed = body === undefined ? null : v.safeParse(v.pipe(v.string(), v.parseJson(), ChatRequestBodySchema), body);

      if (parsed === null || !parsed.success || parsed.output.trigger === 'regenerate-message') {
        this.done(requestId);

        return;
      }

      // A message that opens a turn hands the request to it: that turn's `turn-end` closes it. Every other
      // taken message, a splice or the one that failed, gives its mapping back.
      let opener: string | null = null;
      const taken: string[] = [];
      const release = (): void => { for (const id of taken) if (id !== opener) this.requests.delete(id); };

      const messages = parsed.output.messages;

      const refused = yield* Effect.catchCause(Effect.gen({ self: this }, function* () {
        // The client resends only its window, so reconcile against the window.
        const storedMessages = yield* Effect.promise(async () => this.wire.history(TRANSCRIPT_WINDOW));

        const unseen = reconcileMessages(messages, storedMessages, sanitizeMessage).filter((message) => message.role === 'user');

        for (const message of unseen) {
          if (yield* Effect.promise(async () => this.wire.admitted(message.id))) continue;
          this.requests.set(message.id, requestId);
          taken.push(message.id);

          if ((yield* Effect.promise(async () => this.wire.send({ ...chatInput(message), id: message.id }))) === 'turn') opener = message.id;
        }

        return false;
      }), (failed) => {
        const cause = Cause.squash(failed);
        release();

        if (opener === null) this.done(requestId, { error: refusalOf(cause instanceof KinuError ? cause : toKinuError({ doing: 'taking a chat message', cause, otherwise: 'io' })).error });

        // The loop refused and wrote nothing; anything else is a fault its caller must see.
        return cause instanceof KinuError ? Effect.succeed(true) : Effect.die(new Error('the loop failed to take a client message', { cause }));
      });

      if (refused) return;
      release();

      if (opener === null) this.done(requestId, taken.length === 0 ? {} : { landed: 'mid-turn' });
    });
  }

  private done(requestId: string, extra: { landed?: SendLanding; error?: string } = {}): void {
    this.wire.broadcast(doneFrame(requestId, extra));
  }

  /** The stream answers under the admitting request (`turnId` is the opening row id), else under an id minted here:
   *  a turn this activation re-drives or opened itself, which a client follows by `turnId`. */
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

    this.releaseWaiters();

    const live: LiveStream = {
      requestId, turnId: turn.turnId, carried, accumulator: new StreamAccumulator({ messageId: turn.messageId }), open: new OpenParts(), relayed: [], broken: false, failure: null,
    };

    this.live = live;

    for (const { connection, probeId } of this.parked.values()) this.notifyResuming(connection, live, probeId);
    this.parked.clear();

    if (turn.userTurn) this.wire.broadcast(transcriptFrame(await this.wire.history(TRANSCRIPT_WINDOW)));
  }

  /** The answer row is durable before this. */
  async closeTurn(): Promise<void> {
    const live = this.live;

    if (live === null) return;
    this.live = null;

    const history = await this.wire.history(TRANSCRIPT_WINDOW);

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

        // Their resume names this stream: its own terminal frame, with the error, settles it.
        this.pendingResume.clear();
        live.failure = event.message;

        return;
      }

      case 'broadcast':
        this.wire.broadcast(JSON.stringify(event.event));

        return;

      // The walk-back moved the durable head; every tab needs the stored transcript.
      case 'history-reverted':
        this.wire.broadcast(transcriptFrame(await this.wire.history(TRANSCRIPT_WINDOW)));

        return;

      case 'text-delta':
      case 'reasoning-delta':
      case 'tool-call':
      case 'tool-result':
      case 'evolution':
      case 'background':
      case 'run-event':
    }
  }

  /** Held for a reconnecting tab and broadcast; a continuation renews from the turn's parts, keeping one answer id. */
  observe(stream: ReadableStream<UIMessageChunk>, call: ObservedCall): Promise<void> {
    const live = this.live;

    if (live === null) return Promise.resolve();

    if (call.index > 0) {
      live.accumulator = new StreamAccumulator({
        messageId: live.accumulator.messageId,
        continuation: true,
        existingParts: live.accumulator.parts,
        ...(live.accumulator.metadata !== undefined && { existingMetadata: live.accumulator.metadata }),
      });
    }

    return settle(Effect.catchCause(Effect.promise(() => this.relay(live, stream)), (failed) => Effect.sync(() => {
      this.degradeRelay(live, toKinuError({
        doing: 'relaying the answer stream to the connected clients', cause: Cause.squash(failed), otherwise: 'io',
      }));
    })));
  }

  private async relay(live: LiveStream, stream: ReadableStream<UIMessageChunk>): Promise<void> {
    for await (const chunk of stream) {
      // The provider's own words: the sender's chat would keep them as its error, and the turn's classified
      // failure follows as the frame that ends it.
      if (chunk.type === 'error') continue;
      live.accumulator.applyChunk(chunk);

      if (!live.open.admits(chunk)) {
        this.degradeRelay(live, toKinuError({
          doing: 'relaying the answer stream to the connected clients',
          cause: new KinuError('io', `the model stream carried a ${chunk.type} continuing a part this relay never saw open`),
          otherwise: 'io',
        }));

        return;
      }

      // The row id on every `start`: a missing or SDK-minted one draws the answer twice.
      if (chunk.type === 'start') chunk.messageId = live.accumulator.messageId;

      const body = JSON.stringify(chunk);

      if (this.wire.resumes) live.relayed.push(body);

      // A joining tab reads it in its replay; sent now, it would run ahead of the parts the replay opens.
      this.wire.broadcast(JSON.stringify({ type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: live.requestId, body, done: false }), this.pendingResume.size === 0 ? undefined : [...this.pendingResume]);
    }
  }

  /** A tab told to resume a stream that will not grow again hears it end, so its resume settles. */
  private releaseWaiters(): void {
    const stale = this.live?.requestId ?? null;

    for (const id of this.pendingResume) {
      const connection = this.wire.getConnection(id);

      if (stale !== null && connection !== undefined) sendIfOpen(connection, doneFrame(stale, {}));
    }

    this.pendingResume.clear();
  }

  /** The relay broke, not the turn: the tab gets our classification, diagnostics the SDK's words. */
  private degradeRelay(live: LiveStream, error: KinuError): void {
    diagnostics.failure('chat.stream_observe_failed', error);
    live.broken = true;
    this.pendingResume.clear();
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
    private readonly wireFor: (actorId: string) => ChatWire | null,
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
