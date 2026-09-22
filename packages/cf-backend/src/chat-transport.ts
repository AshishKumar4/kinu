/**
 * The chat rooms of one workspace object.
 *
 * The root's is {@link ChatWireTransport}: core's {@link ChatTransport} over the
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
 *
 * ── ONE ROOM PER ADDRESSED ACTOR ─────────────────────────────────────────
 *
 * A workspace is ONE Durable Object, so every pane's socket lands on this
 * object and `broadcast` reaches all of them. Which actor a socket addressed
 * is its `/actor/<name>` path, recorded as a connection tag
 * (`actorConnectionTag`). {@link ActorChatRooms} is the one place that turns a
 * connection into the room that serves it, and each room is given a wire whose
 * recipient set, transcript and driver are that actor's — so no frame builder
 * here ever asks whose actor it is.
 *
 * A hosted actor's room is the same transport over that actor's own wire, with
 * one measured difference: no resume store. The SDK's {@link ResumableStream}
 * keeps ONE active stream per database (`cf_ai_chat_stream_chunks`, restored in
 * its constructor), so a second store over this object's tables would read the
 * root's live turn as the actor's. A hosted turn therefore streams live and,
 * across a reconnect, lands as its transcript row at turn end.
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

/** What the transport asks of the actor: the connection set, and the loop.
 *  A connection is the SDK's: its resume handshake takes the full type. */
export interface ChatWire {
  /** The resume store's database; null for a wire whose turns stream live
   *  only (the header says why a hosted actor's is). */
  readonly sql: SqlExecutor | null;
  broadcast(message: string, exclude?: string[]): void;
  getConnection(id: string): Connection | undefined;
  /** The transcript as the client should see it, oldest first — the SDK
   *  session's own rows, which the SDK's clients render as UI messages. */
  history(): Promise<UIMessage[]>;
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

/** Where one socket's chat frames go. Both rooms answer it, and
 *  {@link ActorChatRooms} is what picks between them. */
export interface ChatRoom {
  onConnect(connection: Connection): Promise<void>;
  onClose(connection: Connection): void;
  /** Handle one socket frame if it is chat protocol; false when it is not. */
  onMessage(connection: Connection, raw: string): Promise<boolean>;
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
  /** The requests of the other messages this turn carried — a rerun runs
   *  every leftover as one turn — answered when it closes. */
  readonly carried: readonly string[];
  readonly streamId: string;
  /** The SDK's reconstruction of the answer. ONE PER PROVIDER CALL — a
   *  continuation renews it against the parts the turn already holds, so the
   *  object never reads a second stream on the first stream's state while the
   *  answer stays one message under one id. */
  accumulator: StreamAccumulator;
  /** What the client's own reader would have open by now — see {@link OpenParts}. */
  readonly open: OpenParts;
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

/**
 * The part ids this relay has seen OPENED, mirroring the state the client's
 * own stream reader keeps.
 *
 * The reader (`ai`'s `processUIMessageStream`) THROWS on a continuation of a
 * part it never saw open — `Received text-delta for missing text part with ID
 * "…"`, the same for `reasoning-delta`, `reasoning-end`, `text-end`, and
 * `Received tool-input-delta for missing tool call with ID "…"` — and that
 * throw ends the tab's whole answer, which is how an owner sees an unexplained
 * tool-call error (#15) and reasoning that appears and then vanishes (#14).
 * The SDK's SERVER-side builder is forgiving about all of it, so the relay
 * cannot learn this from the accumulator: it has to keep the reader's rule.
 *
 * `text`/`reasoning` ids are scoped to the STEP, because the reader clears
 * `activeTextParts` and `activeReasoningParts` on every `finish-step`; tool
 * call ids are not, because it never clears `partialToolCalls`.
 */
class OpenParts {
  private readonly step = new Set<string>();
  private readonly calls = new Set<string>();

  /** Take this chunk in, and answer whether the client could follow it. */
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

/** The frame a tab draws its whole transcript from: the seed one socket reads
 *  on connect, and the redraw every socket reads when the conversation moved
 *  outside its own stream (a turn opening, a turn closing, a walk-back). */
function transcriptFrame(history: readonly UIMessage[]): string {
  return JSON.stringify({ type: MessageType.CF_AGENT_CHAT_MESSAGES, messages: history });
}

/**
 * The frame that CLOSES one chat request, as both rooms send it: the hook's
 * send resolves on it and stops waiting for a stream.
 *
 * `error` and `landed` are present only when they are facts — an absent key
 * and a key holding `undefined` read differently to the client, which treats
 * the first as "the request finished" and would paint the second as a failure.
 */
function doneFrame(requestId: string, extra: { landed?: SendLanding; error?: string }): string {
  return JSON.stringify({
    type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: requestId, body: extra.error ?? '', done: true,
    ...(extra.error !== undefined && { error: true }), ...(extra.landed !== undefined && { landed: extra.landed }),
  });
}

export class ChatWireTransport implements ChatTransport, ChatRoom {
  /** The SDK's chunk store and the resume handshake over it, built on FIRST
   *  USE rather than in the constructor: the store declares its table as it
   *  is built, and this transport is reached through a getter on the actor
   *  that the SDK's own callable enumeration (`getCallableMethods`) evaluates
   *  against a bare prototype with no storage behind it. A transport that
   *  touched storage to exist would turn that enumeration into an SQL error
   *  and take the whole RPC surface with it. */
  private _resume: { readonly resumable: ResumableStream; readonly handshake: ResumeHandshake } | null = null;
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
        // An orphaned stream is the loop's to continue from its ledger, never a
        // row this transport reconstructs from chunks.
        persistOrphanedStream: () => Promise.resolve(),
        isConnectionPresent: (id) => this.wire.getConnection(id) !== undefined,
      }),
    };
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
  async onConnect(connection: Connection): Promise<void> {
    const resume = this.resume;
    const history = await this.wire.history();

    if (resume !== null && resume.resumable.hasActiveStream()) resume.handshake.notifyStreamResuming(connection);
    sendIfOpen(connection, transcriptFrame(history));
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
      case 'stream-resume-request': {
        const resume = this.resume;

        // `idle` is load-bearing: the hook keeps waiting on a probe answered
        // with anything weaker.
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
        // No Kinu client tool exists and the transcript is server-authoritative.
        diagnostics.event('chat.protocol_frame_ignored', { frame: event.type });
    }
  }

  /**
   * The chat request: the hook's messages reconciled against what is stored
   * (`reconcileMessages`, the SDK's own rule for what is new), then ONE send
   * per message the loop does not already hold, each under the id the client
   * renders it by. The loop decides the landing and writes the row; this
   * answers the request accordingly, and only once the landing is decided —
   * the request is the client's one question about the message, and the
   * turn that answers it is not known at admission. A regenerate carries
   * nothing new and is answered as done.
   */
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

    // A message the running turn read is answered by that turn: the request
    // is spent with the landing, and the absorbing turn's own stream is where
    // the reply goes. A message that opened a turn — at once, or as the rerun
    // of words the running turn ended before reading — kept its id as that
    // turn's id, so the turn streamed under this request and its `turn-end`
    // closed it; a rerun that carried other leftovers named them at its open,
    // and their requests closed with it too.
    if (landed === 'mid-turn') {
      for (const message of fresh) this.requests.delete(message.id);
      this.done(requestId, { landed });
    }
  }

  private done(requestId: string, extra: { landed?: SendLanding; error?: string } = {}): void {
    this.wire.broadcast(doneFrame(requestId, extra));
  }

  // ── The loop's events ───────────────────────────────────────────────

  /**
   * One turn opens: its stream answers under the request that admitted the
   * message (`turnId` is the opening row's id), else under a minted id — a
   * wake, a rerun, a delegated turn. The entry is deleted either way: a
   * steer's own id is the turn id of its rerun, and a rerun that carries
   * other leftovers takes their requests with it, to answer at its close. A
   * user turn's opening row is durable before this, so every tab reads the
   * transcript with it.
   */
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

    this.live = { requestId, carried, streamId, accumulator: new StreamAccumulator({ messageId: turn.messageId }), open: new OpenParts(), cadence: partialFlushCadence(), taken: false, broken: false };

    if (turn.userTurn) this.wire.broadcast(transcriptFrame(await this.wire.history()));
  }

  /** The turn's answer row is durable before this: the done frame and the
   *  transcript broadcast read the finished turn's rows. */
  async closeTurn(): Promise<void> {
    const live = this.live;

    if (live === null) return;
    this.live = null;

    if (!live.taken && !live.broken && live.accumulator.parts.length > 0) this.answers.set(live.accumulator.messageId, live.accumulator.toMessage());
    const history = await this.wire.history();

    this.resume?.resumable.complete(live.streamId);
    this.pendingResume.clear();
    this.done(live.requestId);

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

        // A Stop is the operator's own act, not a failure: the abort chunk
        // the model stream carried is the whole report, and an `error` frame
        // here is what the SDK's client surfaces as the stream's error (the
        // hook painted an error card on every Stop after the switch).
        if (event.message === INTERRUPTED_TURN) return;

        this.resume?.resumable.markError(live.streamId);
        this.wire.broadcast(JSON.stringify({
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: live.requestId, body: event.message, done: false, error: true,
        }));

        return;
      }

      case 'broadcast':
        this.wire.broadcast(JSON.stringify(event.event));

        return;

      // The walk-back moved the durable head, so what each tab holds is a
      // conversation that no longer exists. The stored transcript reaches all
      // of them over the same frame a turn's close sends.
      case 'history-reverted':
        this.wire.broadcast(transcriptFrame(await this.wire.history()));

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
   * One PROVIDER CALL's UIMessage chunks, from the SDK's own stream
   * conversion, each stored for resume and broadcast under the live request.
   * Runs beside the loop's own consumption of the same result; the loop
   * settles the turn once this has drained, so the answer row carries every
   * part the client saw.
   *
   * A turn can take a second call — an answer the provider cut at its output
   * limit is continued — and each call is its own SDK stream. The accumulator
   * is renewed for it, seeded with what the turn already holds: the object
   * reads one stream, as it is built to, and the answer stays one message
   * under the id the row is persisted with, which a second stream's `start`
   * would otherwise rename.
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
        const { action } = live.accumulator.applyChunk(chunk);

        if (!live.open.admits(chunk)) {
          this.degradeRelay(live, toKinuError({
            doing: 'relaying the answer stream to the connected clients',
            cause: new KinuError('io', `the model stream carried a ${chunk.type} continuing a part this relay never saw open`),
            otherwise: 'io',
          }));

          return;
        }

        // The client builds the streamed message under the id the row is
        // persisted under, as Think stamped it: a provider that emits no
        // `start.messageId` would otherwise leave the tab with two copies.
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

  /**
   * The relay broke; the turn did not.
   *
   * The loop consumes its own copy of the stream and commits the answer from
   * it. Three things read the relay as if it were the answer — the accumulator
   * the transcript would persist, the chunk store a reconnect replays, and the
   * tab watching the request — so each is told, here, that it is not.
   *
   * The tab reads OUR classification of what broke and never a raw sentence
   * from underneath: the SDK's own words for a chunk it could not take belong
   * on the diagnostics record, where the cause chain is kept whole, not in a
   * chat bubble telling an operator to send a different kind of chunk.
   */
  private degradeRelay(live: LiveStream, error: KinuError): void {
    diagnostics.failure('chat.stream_observe_failed', error);
    live.broken = true;
    this.resume?.resumable.markError(live.streamId);
    this.wire.broadcast(JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: live.requestId, body: refusalOf(error).error, done: false, error: true,
    }));
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

/**
 * WHICH ROOM SERVES THIS SOCKET — the one decision that keeps a workspace's
 * panes apart on a shared object.
 *
 * Keyed by the connection's actor tag, so a socket restored from hibernation
 * resolves the same room it opened on. A tag naming an actor this workspace no
 * longer hosts resolves to NO room, and the caller refuses the frame rather
 * than falling back to the root's — a dismissed actor's pane must not become a
 * second window onto the workspace's own chat.
 */
export class ActorChatRooms {
  private readonly hosted = new Map<string, ChatWireTransport>();

  constructor(
    private readonly root: () => ChatWireTransport,
    private readonly wireFor: (name: string) => ChatWire | null,
  ) {}

  /** The room a connection addressed, or null when it named an actor this
   *  workspace does not host. */
  for(actor: string | null): ChatWireTransport | null {
    if (actor === null) return this.root();

    return this.hostedRoom(actor);
  }

  /** That actor's transport if one is already open, or one built now — the
   *  same wire the root's chat rides, over that actor's own transcript. */
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
