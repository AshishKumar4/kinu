/**
 * Core's {@link ChatTransport} over the SDK's `cf_agent_*` protocol, one room per actor tag. It writes no
 * row; the loop does. A tab that joins a turn in progress is replayed it over the SDK's documented resume
 * handshake (RESUME_REQUEST, RESUMING, ACK, replay frames, replayComplete): the steps the ledger records,
 * restated, then this relay's chunks after them. A turn an ended activation left open is re-driven by a later
 * one under a request id that activation mints, so RESUMING names the turn too: the client whose message opened
 * it follows the turn there. A tab that reconnects before the re-drive opens is told the turn is pending
 * (STREAM_PENDING, the SDK's #1784 frame) and told it is resuming once it opens.
 */
import type { Connection } from 'agents';
import {
  MessageType,
  parseProtocolMessage, reconcileMessages, sanitizeMessage, sendIfOpen,
  type ChatProtocolEvent,
} from 'agents/chat';
import type { UIMessage, UIMessageChunk } from 'ai';
import { Effect } from 'effect';
import * as v from 'valibot';
import {
  isWorkMode, INTERRUPTED_TURN, JsonValueSchema,
  type ChatTransport, type JsonObject, type PromptFile, type SendLanding, type SessionEvent, type WorkMode,
} from '@kinu.run/core';
import { attemptInItsWords, diagnostics, KinuError, refusalOf, settle, toKinuError } from '@kinu.run/core/obs';

export type ChatSocket = Pick<Connection, 'id' | 'send' | 'readyState'>;

/** Every room replays a joiner the open turn: the steps its ledger records, then the relay's chunks after them. */
export interface ChatWire {
  /** A turn this activation has not opened yet: the one an ended activation left open, or an acknowledged send. */
  turnOwed(): boolean;
  /** The open turn's finished steps as its ledger records them, drawn. */
  steps(): readonly (readonly JsonObject[])[];
  /** How many there are, without drawing them. */
  recordedSteps(): number;
  broadcast(message: string, exclude?: string[]): void;
  /** The handshake asks by id before it replays to a replacement. */
  getConnection(id: string): ChatSocket | undefined;
  history(limit?: number): Promise<UIMessage[]>;
  /** A durable row or an accepted send's reservation: the hook resends its whole list per request. */
  admitted(id: string): Promise<boolean>;
  /** Rejects when the loop refuses the message: nothing was written and no turn ran. */
  send(input: { readonly text: string; readonly files: readonly PromptFile[]; readonly id: string; readonly mode: WorkMode }): Promise<SendLanding>;
  retry(claim: (turnId: string) => void): Promise<SendLanding>;
  interrupt(): void;
}

export interface ChatRoom {
  onConnect(connection: ChatSocket): Promise<void>;
  onClose(connection: Pick<ChatSocket, 'id'>): void;
  onMessage(connection: ChatSocket, raw: string): Promise<boolean>;
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
  /** The answer's row id, on every provider call's `start`, so the answer stays one message. */
  readonly messageId: string;
  readonly open: OpenParts;
  /** The chunks a replay sends after the recorded steps, with their step: the steps finished before them. */
  relayed: { readonly step: number; readonly type: string; readonly body: string }[];
  /** Steps whose last chunk went out, those before this activation included. */
  finished: number;
  /** Tabs already replayed it: told again by their own probe, they are not held back again. */
  readonly joined: Set<string>;
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

const RestatedTextSchema = v.looseObject({ type: v.picklist(['text', 'reasoning']), text: v.string() });

const RestatedFileSchema = v.looseObject({ type: v.literal('file'), url: v.string(), mediaType: v.string() });

const RestatedToolSchema = v.looseObject({
  type: v.pipe(v.string(), v.startsWith('tool-')), toolCallId: v.string(),
  state: v.picklist(['input-available', 'output-available', 'output-error']),
  input: v.optional(JsonValueSchema), output: v.optional(JsonValueSchema), errorText: v.optional(v.string()),
});

/** A recorded step as the chunks that draw it, ids named for its step and place so no live id meets one. Parts
 *  other than text, reasoning, tool and file wait for the commit's transcript frame. */
function restatedChunks(parts: readonly JsonObject[], step: number): UIMessageChunk[] {
  const chunks: UIMessageChunk[] = [{ type: 'start-step' }];

  for (const [place, part] of parts.entries()) {
    const id = `restated:${String(step)}:${String(place)}`;
    const text = v.safeParse(RestatedTextSchema, part);
    const file = v.safeParse(RestatedFileSchema, part);
    const tool = v.safeParse(RestatedToolSchema, part);

    if (text.success && text.output.type === 'text') {
      chunks.push({ type: 'text-start', id }, { type: 'text-delta', id, delta: text.output.text }, { type: 'text-end', id });
    } else if (text.success) {
      chunks.push({ type: 'reasoning-start', id }, { type: 'reasoning-delta', id, delta: text.output.text }, { type: 'reasoning-end', id });
    } else if (file.success) {
      chunks.push({ type: 'file', url: file.output.url, mediaType: file.output.mediaType });
    } else if (tool.success) {
      const { toolCallId, state, input, output, errorText } = tool.output;
      chunks.push({ type: 'tool-input-available', toolCallId, toolName: tool.output.type.slice('tool-'.length), input: input ?? null });

      if (state === 'output-available') chunks.push({ type: 'tool-output-available', toolCallId, output: output ?? null });
      else if (state === 'output-error') chunks.push({ type: 'tool-output-error', toolCallId, errorText: errorText ?? '' });
    }
  }

  chunks.push({ type: 'finish-step' });

  return chunks;
}

export class ChatWireTransport implements ChatTransport, ChatRoom {
  /** Tabs told a stream is resuming and not yet acknowledged: live chunks skip them until their replay. */
  private readonly pendingResume = new Set<string>();
  /** Tabs told an owed turn is pending, each with the probe it asked under: told it is resuming when it opens. */
  private readonly parked = new Map<string, { readonly connection: ChatSocket; readonly probeId: string | undefined }>();
  private readonly requests = new Map<string, string>();
  private live: LiveStream | null = null;

  constructor(private readonly wire: ChatWire) {}

  /** The connect frame is the pane's only seed, so a socket opening mid-turn gets the current window. */
  async onConnect(connection: ChatSocket): Promise<void> {
    const history = await this.wire.history(TRANSCRIPT_WINDOW);

    this.announce(connection);
    sendIfOpen(connection, transcriptFrame(history));
  }

  /** A socket redialled under the same id is a new joiner: what the closed one was replayed is not its own. */
  onClose(connection: Pick<ChatSocket, 'id'>): void {
    this.pendingResume.delete(connection.id);
    this.parked.delete(connection.id);
    this.live?.joined.delete(connection.id);
  }

  /** Told proactively on connect and again on the tab's own request; the client acknowledges once. False when no
   *  turn streams here and none is owed. */
  private announce(connection: ChatSocket, probeId?: string): boolean {
    const { live } = this;

    if (live !== null) {
      this.notifyResuming(connection, live, probeId);

      return true;
    }

    if (!this.wire.turnOwed()) return false;
    this.parked.set(connection.id, { connection, probeId });
    sendIfOpen(connection, JSON.stringify({ type: MessageType.CF_AGENT_STREAM_PENDING, ...(probeId !== undefined && { probeId }) }));

    return true;
  }

  private notifyResuming(connection: ChatSocket, live: LiveStream, probeId: string | undefined): void {
    const frame = { type: MessageType.CF_AGENT_STREAM_RESUMING, id: live.requestId, turnId: live.turnId, ...(probeId !== undefined && { probeId }) };

    if (sendIfOpen(connection, JSON.stringify(frame)) && !live.joined.has(connection.id)) this.pendingResume.add(connection.id);
  }

  quiet(): void {
    for (const { connection, probeId } of this.parked.values()) {
      sendIfOpen(connection, JSON.stringify({ type: MessageType.CF_AGENT_STREAM_RESUME_NONE, reason: 'idle', probeId }));
    }

    this.parked.clear();
  }

  /** Cut markers precede recorded replacements; later live chunks follow. */
  private replay(connection: ChatSocket, requestId: string): void {
    this.pendingResume.delete(connection.id);
    const { wire, live } = this;

    const frame = (fields: { body: string; replayComplete?: true; done: boolean; restated?: true }): string =>
      JSON.stringify({ type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: requestId, replay: true, ...fields });

    // A request that is no longer live settles; its answer is in the transcript frame.
    if (live === null || live.requestId !== requestId) {
      sendIfOpen(connection, frame({ body: '', done: true }));

      return;
    }

    live.joined.add(connection.id);

    const recorded = wire.steps();
    const restated = Math.min(recorded.length, live.finished);
    const frames: string[] = [];
    const cuts = new Map<number, string[]>();

    for (const { step, type, body } of live.relayed) {
      if (step >= restated || type !== 'data-kinu-step-cut') continue;
      const before = cuts.get(step) ?? [];
      before.push(frame({ body, done: false }));
      cuts.set(step, before);
    }

    // Before anything is replayed, the relay's first chunk opens the message live.
    if (restated > 0 || live.relayed.length > 0) frames.push(frame({ body: JSON.stringify({ type: 'start', messageId: live.messageId }), done: false }));

    for (const [step, parts] of recorded.slice(0, restated).entries()) {
      frames.push(...(cuts.get(step) ?? []));

      for (const chunk of restatedChunks(parts, step)) frames.push(frame({ body: JSON.stringify(chunk), done: false, restated: true }));
    }

    for (const { step, type, body } of live.relayed) {
      if (step >= restated && type !== 'start') frames.push(frame({ body, done: false }));
    }

    frames.push(frame({ body: '', done: false, replayComplete: true }));

    for (const sent of frames) {
      if (!sendIfOpen(connection, sent)) return;
    }
  }

  async onMessage(connection: ChatSocket, raw: string): Promise<boolean> {
    const event = parseProtocolMessage(raw);

    if (event === null) return false;
    await this.handle(connection, event);

    return true;
  }

  private async handle(connection: ChatSocket, event: ChatProtocolEvent): Promise<void> {
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
        if (event.init.method === 'POST') await this.admitChatRequest(event.id, event.init.body);

        return;
      }

      case 'cancel':
        this.wire.interrupt();

        return;

      // The SDK's clear is a frame with no answer; Main's Clear is the `clearConversation` RPC, refused while a turn runs.
      case 'clear':
      case 'tool-result':
      case 'tool-approval':
      case 'messages':
        diagnostics.event('chat.protocol_frame_ignored', { frame: event.type });
    }
  }

  /** One send per message the loop does not hold (`reconcileMessages`); answered only once the landing is decided.
   *  Every request ends in exactly one terminal frame: its turn's, or this method's, whatever failed. */
  private async admitChatRequest(requestId: string, body: string | undefined): Promise<void> {
    const parsed = body === undefined ? null : v.safeParse(v.pipe(v.string(), v.parseJson(), ChatRequestBodySchema), body);

    if (parsed === null || !parsed.success) {
      this.done(requestId);

      return;
    }

    if (parsed.output.trigger === 'regenerate-message') {
      await this.retryRequest(requestId);

      return;
    }

    // A message that opens a turn hands the request to it: that turn's `turn-end` closes it. Every other
    // taken message, a splice or the one that failed, gives its mapping back.
    let opener: string | null = null;
    const taken: string[] = [];
    const release = (): void => { for (const id of taken) if (id !== opener) this.requests.delete(id); };

    try {
      // The client resends only its window, so reconcile against the window.
      const storedMessages = await this.wire.history(TRANSCRIPT_WINDOW);

      const unseen = reconcileMessages(parsed.output.messages, storedMessages, sanitizeMessage).filter((message) => message.role === 'user');

      for (const message of unseen) {
        if (await this.wire.admitted(message.id)) continue;
        this.requests.set(message.id, requestId);
        taken.push(message.id);

        if (await this.wire.send({ ...chatInput(message), id: message.id }) === 'turn') opener = message.id;
      }
    } catch (cause) {
      release();

      if (opener === null) this.done(requestId, { error: refusalOf(cause instanceof KinuError ? cause : toKinuError({ doing: 'taking a chat message', cause, otherwise: 'io' })).error });

      // The loop refused and wrote nothing; anything else is a fault its caller must see.
      if (!(cause instanceof KinuError)) throw new Error('the loop failed to take a client message', { cause });

      return;
    }

    release();

    if (opener === null) this.done(requestId, taken.length === 0 ? {} : { landed: 'mid-turn' });
  }

  retryRequest(requestId: string): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      let claimed: string | null = null;

      const landing = yield* attemptInItsWords('io', () => this.wire.retry((turnId) => {
        claimed = turnId;
        this.requests.set(turnId, requestId);
      })).pipe(Effect.catch((failure) => Effect.sync(() => {
        diagnostics.failure('chat.retry_refused', failure);

        if (claimed !== null) this.requests.delete(claimed);
        this.done(requestId, { error: refusalOf(failure).error });

        return null;
      })));

      if (landing === null || landing === 'turn') return;

      if (claimed !== null) this.requests.delete(claimed);
      this.done(requestId, { landed: 'mid-turn' });
    }));
  }

  private done(requestId: string, extra: { landed?: SendLanding; error?: string } = {}): void {
    this.wire.broadcast(doneFrame(requestId, extra));
  }

  /** The stream answers under the admitting request (`turnId` is the opening row id), else under an id minted here:
   *  a turn this activation re-drives or opened itself, which a client follows by `turnId`. */
  async openTurn(turn: {
    readonly turnId: string; readonly messageId: string; readonly userTurn: boolean; readonly carried: readonly string[]; readonly finishedSteps: number;
  }): Promise<void> {
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
      requestId, turnId: turn.turnId, carried, messageId: turn.messageId, open: new OpenParts(), relayed: [],
      finished: turn.finishedSteps, joined: new Set(), broken: false, failure: null,
    };

    this.live = live;

    for (const { connection, probeId } of this.parked.values()) this.notifyResuming(connection, live, probeId);
    this.parked.clear();

    if (turn.userTurn) this.wire.broadcast(transcriptFrame(await this.wire.history(TRANSCRIPT_WINDOW)));
  }

  /** The answer row is durable before this. A turn that ends before this room opened it releases the tabs waiting on it. */
  async closeTurn(): Promise<void> {
    const live = this.live;

    if (live === null) {
      this.quiet();

      return;
    }

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
        await this.openTurn({
          turnId: event.turnId, messageId: event.messageId, userTurn: event.kind === 'user', carried: event.carried, finishedSteps: event.finishedSteps,
        });

        return;

      case 'step-cut': {
        const live = this.live;

        if (live === null) return;
        const chunk: UIMessageChunk = { type: 'data-kinu-step-cut', data: { stepIndex: event.stepIndex }, transient: true };
        const body = JSON.stringify(chunk);

        live.relayed.push({ step: live.finished, type: chunk.type, body });
        this.wire.broadcast(JSON.stringify({ type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: live.requestId, body, done: false }),
          this.pendingResume.size === 0 ? undefined : [...this.pendingResume]);

        return;
      }

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
  async observe(stream: ReadableStream<UIMessageChunk>): Promise<void> {
    const live = this.live;

    if (live === null) return;

    try {
      for await (const chunk of stream) {
        // The provider's own words: the sender's chat would keep them as its error, and the turn's classified
        // failure follows as the frame that ends it.
        if (chunk.type === 'error') continue;

        if (!live.open.admits(chunk)) {
          this.degradeRelay(live, toKinuError({
            doing: 'relaying the answer stream to the connected clients',
            cause: new KinuError('io', `the model stream carried a ${chunk.type} continuing a part this relay never saw open`),
            otherwise: 'io',
          }));

          return;
        }

        // The row id on every `start`: a missing or SDK-minted one draws the answer twice.
        if (chunk.type === 'start') chunk.messageId = live.messageId;

        // A replay restates every recorded step from the ledger; of those it reads only their cut markers here.
        if (chunk.type === 'start-step') {
          const restated = Math.min(this.wire.recordedSteps(), live.finished);
          live.relayed = live.relayed.filter((entry) => entry.step >= restated || entry.type === 'data-kinu-step-cut');
        }

        const body = JSON.stringify(chunk);

        live.relayed.push({ step: live.finished, type: chunk.type, body });

        // A joining tab reads it in its replay; sent now, it would run ahead of the parts the replay opens.
        this.wire.broadcast(JSON.stringify({ type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: live.requestId, body, done: false }), this.pendingResume.size === 0 ? undefined : [...this.pendingResume]);

        if (chunk.type === 'finish-step') live.finished += 1;
      }
    } catch (cause) {
      this.degradeRelay(live, toKinuError({
        doing: 'relaying the answer stream to the connected clients', cause, otherwise: 'io',
      }));
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
