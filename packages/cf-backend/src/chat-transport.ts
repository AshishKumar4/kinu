/**
 * Core's {@link ChatTransport} over the SDK's `cf_agent_*` protocol, one room per actor tag. It writes no
 * row; the loop does. A tab that joins a turn in progress is replayed it over the SDK's documented resume
 * handshake (RESUME_REQUEST, RESUMING, ACK, replay frames, replayComplete): the steps its agent's ledger recorded
 * before this room opened the turn, restated, then this relay's chunks. A turn an ended activation left open is
 * re-driven by a later one under a request id that activation mints. A tab that reconnects before the re-drive opens
 * is told the turn is pending (STREAM_PENDING, the SDK's #1784 frame) and told it is resuming once it opens. Where a
 * send ended is asked of the workspace (`awaitSend`), never read off this stream.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Connection } from 'agents';
import {
  MessageType,
  parseProtocolMessage, sendIfOpen,
  type ChatProtocolEvent,
} from 'agents/chat';
import type { UIMessage, UIMessageChunk } from 'ai';
import { Effect } from 'effect';
import * as v from 'valibot';
import {
  INTERRUPTED_TURN, JsonObjectSchema, JsonValueSchema, PROVIDER_WAIT_PART, ProviderWaitSchema, SendMetadataSchema, sentWords, STEP_CUT_CHUNK,
  TRANSCRIPT_WINDOW, UIMessageSchema, type SentWords, type ChatTransport, type JsonObject, type OwedIntent, type PromptFile, type SendLanding, type SendState, type SessionEvent, type TurnReplies,
} from '@kinu.run/core';
import { attempt, attemptInItsWords, diagnostics, KinuError, refusalOf, settle, toKinuError } from '@kinu.run/core/obs';

export type ChatSocket = Pick<Connection, 'id' | 'send' | 'readyState' | 'close'>;

/** The socket frame whose handling is running (client-socket-gate.ts), told once a step it started has taken its place
 *  in a room's order. */
export const framePlacing = new AsyncLocalStorage<() => void>();

/** A tab whose replay could not be read is closed with this and redials: 1013, Try Again Later (RFC 6455 §7.4.1). */
const REPLAY_RETRY_CODE = 1013;

/** One step as a replay restates it: its parts, drawn. */
export const DrawnStepSchema = v.array(JsonObjectSchema);

/** Every room replays a joiner the open turn: the steps its ledger recorded before the room opened it, then the
 *  relay's chunks. */
export interface ChatWire {
  /** A turn this activation has not opened yet: the one an ended activation left open, or an acknowledged send. Asked of
   *  the agent's own isolate, which re-opens such a turn when it starts, before it has told this room. */
  turnOwed(): Promise<boolean>;
  /** The first `before` finished steps of run `runId` as its agent's ledger records them, drawn, a step at a time; a
   *  recorded step never changes, so the run may have closed since. Fewer only when the ledger holds fewer. */
  steps(runId: string, before: number): AsyncIterable<readonly JsonObject[]>;
  broadcast(message: string, exclude?: string[]): void;
  /** The handshake asks by id before it replays to a replacement. */
  getConnection(id: string): ChatSocket | undefined;
  history(limit?: number): Promise<UIMessage[]>;
  /** Of `ids`, in order, those the agent holds neither as a durable row nor as an accepted send's reservation: the hook
   *  resends its whole list per request, and the agent keeps each message under the id its tab gave it. */
  unseen(ids: readonly string[]): Promise<readonly string[]>;
  /** Each slate `agent.ask` reply: told where its message's card is shown, fed that turn's text deltas, and told when
   *  the turn ends. */
  readonly replies?: Pick<TurnReplies, 'card' | 'feed' | 'ended'>;
  /** The open turn's first answer text reached the room: told once a turn, as the text streams in. */
  firstText?(): void;
  /** Rejects when the loop refuses the message: nothing was written and no turn ran. `admitted` is told once the words
   *  are owed to the agent, where a Stop reaches them, ahead of where they land. */
  send(input: SentWords & { readonly id: string }, admitted: () => void): Promise<SendLanding>;
  /** The owner's Retry of the newest turn, whose newest message they saw is `messageId`, as an intent (D6): the turn its
   *  agent reopened, which tells its end; owed when the crossing did not reach the agent, whose wake delivers it. */
  retry(messageId: string): Promise<{ readonly turnId: string } | OwedIntent>;
  /** Settles once the Stop has reached the agent: what was sent before it is stopped. */
  interrupt(): Promise<void>;
  /** Where a send stands, from its durable facts; `awaitSend` once it is settled or none. */
  sendState(id: string): Promise<SendState>;
  awaitSend(id: string): Promise<SendState>;
}

interface ChatRoom {
  onConnect(connection: ChatSocket): Promise<void>;
  onClose(connection: Pick<ChatSocket, 'id'>): void;
  onMessage(connection: ChatSocket, raw: string): Promise<boolean>;
}

const ChatRequestBodySchema = v.object({
  messages: v.array(UIMessageSchema),
  trigger: v.optional(v.string()),
});

const ChatInputSchema = v.object({
  parts: v.array(v.looseObject({
    type: v.string(), text: v.optional(v.string()), url: v.optional(v.string()),
    mediaType: v.optional(v.string()), filename: v.optional(v.string()),
  })),
  metadata: v.optional(v.unknown()),
});

interface RelayedChunk {
  readonly step: number;
  readonly type: string;
  readonly body: string;
}

const RelayedDeltaSchema = v.variant('type', [
  v.looseObject({ type: v.picklist(['text-delta', 'reasoning-delta']), id: v.string(), delta: v.string() }),
  v.looseObject({ type: v.literal('tool-input-delta'), toolCallId: v.string(), inputTextDelta: v.string() }),
]);

const MERGED_DELTA_TYPES: ReadonlySet<string> = new Set(['text-delta', 'reasoning-delta', 'tool-input-delta']);

/**
 * A finished step's deltas, merged per part. A late tab replays the step whole either way and draws the same answer; a
 * chunk per token kept the turn's every token as its own frame for the turn's life, and replayed them one by one.
 */
function compactStep(relayed: RelayedChunk[], step: number): void {
  let from = relayed.length;

  while (from > 0 && relayed[from - 1]?.step === step) from -= 1;
  const merged: RelayedChunk[] = [];
  const runs: { readonly type: string; readonly part: string; readonly chunk: v.InferOutput<typeof RelayedDeltaSchema>; text: string }[] = [];

  const flush = (): void => {
    for (const run of runs.splice(0)) {
      const chunk = run.chunk.type === 'tool-input-delta' ? { ...run.chunk, inputTextDelta: run.text } : { ...run.chunk, delta: run.text };

      merged.push({ step, type: run.type, body: JSON.stringify(chunk) });
    }
  };

  for (const entry of relayed.slice(from)) {
    const parsed = MERGED_DELTA_TYPES.has(entry.type) ? v.safeParse(RelayedDeltaSchema, JSON.parse(entry.body)) : null;

    if (parsed?.success !== true) {
      flush();
      merged.push(entry);
      continue;
    }

    const chunk = parsed.output;
    const part = chunk.type === 'tool-input-delta' ? chunk.toolCallId : chunk.id;
    const text = chunk.type === 'tool-input-delta' ? chunk.inputTextDelta : chunk.delta;
    const run = runs.at(-1);

    if (run?.type === chunk.type && run.part === part) {
      run.text += text;
      continue;
    }

    flush();
    runs.push({ type: chunk.type, part, chunk, text });
  }

  flush();
  relayed.splice(from, relayed.length - from, ...merged);
}

interface LiveStream {
  readonly requestId: string;
  readonly turnId: string;
  /** The run whose ledger holds the steps before `firstStep`. */
  readonly runId: string;
  /** Requests of the other messages a rerun carried, and a Retry answered after it opened: each answered when it closes. */
  readonly carried: string[];
  /** The answer's row id, on every provider call's `start`, so the answer stays one message. */
  readonly messageId: string;
  readonly open: OpenParts;
  /** Every chunk this turn relayed, in order, with its step: the steps finished before it, each with its deltas merged
   *  per part once it ends (`compactStep`). Dropped with the turn. */
  readonly relayed: RelayedChunk[];
  /** The step this room opened it at: an isolate that ended finished the steps before, and only its ledger holds them. */
  readonly firstStep: number;
  /** Steps whose last chunk went out, those before this activation included. */
  finished: number;
  /** Tabs already replayed it: told again by their own probe, they are not held back again. */
  readonly joined: Set<string>;
  /** The relay broke before the stream ended, so the accumulated parts are not the answer. */
  broken: boolean;
  /** Why the turn failed, sent as the frame that ends it. */
  failure: string | null;
  /** Its first answer text went out. */
  spoke: boolean;
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

/** `owed`: an owner's intent the request carried, on its way to the agent's wake. */
function doneFrame(requestId: string, extra: { landed?: SendLanding; error?: string; owed?: string }): string {
  return JSON.stringify({
    type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: requestId, body: extra.error ?? '', done: true,
    ...(extra.error !== undefined && { error: true }), ...(extra.landed !== undefined && { landed: extra.landed }),
    ...(extra.owed !== undefined && { owed: extra.owed }),
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
  /** Tabs told a stream is resuming whose replay has not gone out, each with its hold: live chunks skip them until it has.
   *  A socket keeps its hold however often it is told, so the replay it acked releases it; a socket redialled under the
   *  same id takes a hold of its own, which the closed one's replay never releases. */
  private readonly pendingResume = new Map<string, number>();

  /** Holds taken so far, each hold's number. */
  private holds = 0;
  /** Tabs told an owed turn is pending, each with the probe it asked under: told it is resuming when it opens. */
  private readonly parked = new Map<string, { readonly connection: ChatSocket; readonly probeId: string | undefined }>();
  private readonly requests = new Map<string, string>();
  private live: LiveStream | null = null;
  /** Turns this room has opened, so an answer awaited across one knows a turn came and went. */
  private opened = 0;

  /**
   * Sends and Stops in the order their tabs sent them: a Stop stops what was sent before it, and what is sent after it is
   * taken once the Stop has reached the agent. A send holds the order until its words are owed to the agent, never to
   * its landing. Staging, 2026-10-14: a Stop 113 ms after a new chat's opening reached the agent first, so the opening
   * ran and took the next send as a steer.
   */
  private intake: Promise<void> = Promise.resolve();

  constructor(readonly wire: ChatWire) {}

  /** Runs `step` after every step before it has released the order; it releases on its `release`, or on its end. */
  private inOrder(step: (release: () => void) => Promise<void>): Promise<void> {
    const held = Promise.withResolvers<void>();
    const before = this.intake;

    this.intake = before.then(() => held.promise);
    framePlacing.getStore()?.();

    return before.then(() => step(held.resolve)).finally(held.resolve);
  }

  /** The owner's Stop in its place in the order: `stop`, the wire's whole interrupt unless the caller stops the rest itself. */
  interrupt(stop: () => Promise<void> = () => this.wire.interrupt()): Promise<void> {
    return this.inOrder(stop);
  }

  /** The connect frame is the pane's only seed, so a socket opening mid-turn gets the current window. */
  async onConnect(connection: ChatSocket): Promise<void> {
    const history = await this.wire.history(TRANSCRIPT_WINDOW);

    await this.announce(connection);
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
  private async announce(connection: ChatSocket, probeId?: string): Promise<boolean> {
    const opened = this.opened;

    if (this.live === null && !await this.wire.turnOwed()) return false;
    const { live } = this;

    // The owed turn may have opened here while its isolate answered, and ended too: then nothing is pending.
    if (live === null && this.opened !== opened) return false;

    if (live !== null) {
      this.notifyResuming(connection, live, probeId);

      return true;
    }

    this.parked.set(connection.id, { connection, probeId });
    sendIfOpen(connection, JSON.stringify({ type: MessageType.CF_AGENT_STREAM_PENDING, ...(probeId !== undefined && { probeId }) }));

    return true;
  }

  private notifyResuming(connection: ChatSocket, live: LiveStream, probeId: string | undefined): void {
    const frame = { type: MessageType.CF_AGENT_STREAM_RESUMING, id: live.requestId, ...(probeId !== undefined && { probeId }) };

    if (sendIfOpen(connection, JSON.stringify(frame)) && !live.joined.has(connection.id) && !this.pendingResume.has(connection.id)) {
      this.pendingResume.set(connection.id, ++this.holds);
    }
  }

  /** Releases `id`'s hold if it is still `hold`: a replay never releases the hold a redial under its id took since. */
  private release(id: string, hold: number | undefined): void {
    if (this.pendingResume.get(id) === hold) this.pendingResume.delete(id);
  }

  quiet(): void {
    for (const { connection, probeId } of this.parked.values()) {
      sendIfOpen(connection, JSON.stringify({ type: MessageType.CF_AGENT_STREAM_RESUME_NONE, reason: 'idle', probeId }));
    }

    this.parked.clear();
  }

  /** The steps before the room opened the turn, restated from its agent's ledger as each is read, then the relay's
   *  chunks, cut markers among them; later live chunks follow. The tab is held from the live chunks until its replay is
   *  complete, so none runs ahead of the parts the replay opens. A ledger that cannot be read, or holds fewer steps than
   *  the turn opened at, leaves the replay unfinished: the tab is told to reconnect and ask again, never that it holds
   *  the turn. */
  replay(connection: ChatSocket, requestId: string): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      const { live } = this;
      const hold = this.pendingResume.get(connection.id);

      const frame = (fields: { body: string; replayComplete?: true; done: boolean }): string =>
        JSON.stringify({ type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: requestId, replay: true, ...fields });

      // A request that is no longer live settles; its answer is in the transcript frame.
      if (live === null || live.requestId !== requestId) {
        this.release(connection.id, hold);
        sendIfOpen(connection, frame({ body: '', done: true }));

        return;
      }

      // Before anything is replayed, the relay's first chunk opens the message live.
      const opened = frame({ body: JSON.stringify({ type: 'start', messageId: live.messageId }), done: false });

      // A turn this room opened at its first step relayed every step itself.
      if (live.firstStep > 0) {
        const restated = yield* attempt({ doing: "replaying a re-opened turn's finished steps from its agent's ledger", otherwise: 'unavailable' }, async () => {
          let step = 0;

          for await (const parts of this.wire.steps(live.runId, live.firstStep)) {
            // Ended or replaced while its ledger answered: what ended it told the tabs it held.
            if (this.live !== live) return 'stopped';

            if (step === 0 && !sendIfOpen(connection, opened)) return 'stopped';

            for (const chunk of restatedChunks(parts, step)) if (!sendIfOpen(connection, frame({ body: JSON.stringify(chunk), done: false }))) return 'stopped';
            step += 1;
          }

          return step === live.firstStep ? 'restated' : { short: step };
        }).pipe(Effect.catch((failure) => Effect.succeed({ failure })));

        if (restated === 'stopped' || this.live !== live) return;

        if (restated !== 'restated') {
          const failure = 'failure' in restated
            ? restated.failure
            : new KinuError('missing', `the ledger of run ${live.runId} holds ${String(restated.short)} of the ${String(live.firstStep)} steps the turn re-opened at`);

          diagnostics.failure('chat.replay_steps_unread', failure);
          this.release(connection.id, hold);
          // The tab redials and asks again; it never hears a replay it did not get whole.
          connection.close(REPLAY_RETRY_CODE, "the turn's earlier steps could not be read; reconnect to resume");

          return;
        }
      } else if (live.relayed.length > 0 && !sendIfOpen(connection, opened)) return;

      for (const { type, body } of live.relayed) {
        if (type !== 'start' && !sendIfOpen(connection, frame({ body, done: false }))) return;
      }

      // A socket that closed while the ledger answered never gets here, and leaves alone the hold its redial under the same
      // id took.
      if (!sendIfOpen(connection, frame({ body: '', done: false, replayComplete: true }))) return;
      this.release(connection.id, hold);
      live.joined.add(connection.id);
    }));
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
        if (!await this.announce(connection, event.probeId)) {
          sendIfOpen(connection, JSON.stringify({ type: MessageType.CF_AGENT_STREAM_RESUME_NONE, reason: 'idle', probeId: event.probeId }));
        }

        return;

      case 'stream-resume-ack':
        await this.replay(connection, event.id);

        return;

      case 'chat-request': {
        if (event.init.method === 'POST') await this.inOrder((admitted) => this.admitChatRequest(event.id, event.init.body, admitted));

        return;
      }

      case 'cancel':
        await this.interrupt();

        return;

      // The SDK's clear is a frame with no answer; Main's Clear is the `clearConversation` RPC, refused while a turn runs.
      case 'clear':
      case 'tool-result':
      case 'tool-approval':
      case 'messages':
        diagnostics.event('chat.protocol_frame_ignored', { frame: event.type });
    }
  }

  /** One send per message the loop does not hold, asked by id in one crossing; answered only once the landing is decided.
   *  Every request ends in exactly one terminal frame: its turn's, or this method's, whatever failed. */
  private async admitChatRequest(requestId: string, body: string | undefined, admitted: () => void): Promise<void> {
    const parsed = body === undefined ? null : v.safeParse(v.pipe(v.string(), v.parseJson(), ChatRequestBodySchema), body);

    if (parsed === null || !parsed.success) {
      this.done(requestId);

      return;
    }

    if (parsed.output.trigger === 'regenerate-message') {
      admitted();
      await this.retryRequest(requestId, parsed.output.messages);

      return;
    }

    // A message that opens a turn hands the request to it: that turn's `turn-end` closes it. Every other
    // taken message, a splice or the one that failed, gives its mapping back.
    let opener: string | null = null;
    const taken: string[] = [];
    const release = (): void => { for (const id of taken) if (id !== opener) this.requests.delete(id); };

    try {
      const asked = parsed.output.messages.filter((message) => message.role === 'user');
      const unseen = new Set(await this.wire.unseen([...new Set(asked.map((message) => message.id))]));

      for (const message of asked) {
        if (!unseen.delete(message.id)) continue;
        this.requests.set(message.id, requestId);
        taken.push(message.id);

        if (await this.wire.send({ ...chatInput(message), id: message.id }, admitted) === 'turn') opener = message.id;
      }
    } catch (cause) {
      release();
      const refused = cause instanceof KinuError ? cause : toKinuError({ doing: 'taking a chat message', cause, otherwise: 'io' });
      // A Stop handed the words back, which is no failure: the request ends plainly, and its tab reads where they went
      // from the send itself (`awaitSend`).
      const handedBack = refused.code === 'cancelled';

      if (opener === null) this.done(requestId, handedBack ? {} : { error: refusalOf(refused).error });

      // The loop refused and wrote nothing; anything else is a fault its caller must see.
      if (!handedBack && !(cause instanceof KinuError)) throw new Error('the loop failed to take a client message', { cause });

      return;
    }

    release();

    if (opener === null) this.done(requestId, taken.length === 0 ? {} : { landed: 'mid-turn' });
  }

  /** The Retry of the newest turn the client shows: its stream answers under this request once the agent takes it. */
  retryRequest(requestId: string, shown: readonly UIMessage[]): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      const newestAsked = (messages: readonly UIMessage[]): string | undefined => [...messages].reverse().find((message) => message.role === 'user')?.id;
      const messageId = newestAsked(shown) ?? newestAsked(yield* attemptInItsWords('io', () => this.wire.history(TRANSCRIPT_WINDOW)));

      if (messageId === undefined) return this.done(requestId, { error: 'There is no message to retry.' });

      const retried = yield* attemptInItsWords('io', () => this.wire.retry(messageId)).pipe(Effect.catch((failure) => Effect.sync(() => {
        diagnostics.failure('chat.retry_refused', failure);
        this.done(requestId, { error: refusalOf(failure).error });

        return null;
      })));

      if (retried === null) return;

      // Owed to the agent's wake: the request ends here, and the turn, once it opens, is followed as any it opens itself.
      if ('owed' in retried) return this.done(requestId, { owed: retried.owed });

      // The turn it reopened answers this request: from its open, or, opened already, at its end.
      if (this.live?.turnId === retried.turnId) this.live.carried.push(requestId);
      else this.requests.set(retried.turnId, requestId);
    }));
  }

  private done(requestId: string, extra: { landed?: SendLanding; error?: string; owed?: string } = {}): void {
    this.wire.broadcast(doneFrame(requestId, extra));
  }

  /** The stream answers under the admitting request (`turnId` is the opening row id), else under an id minted here:
   *  a turn this activation re-drives or opened itself, which a tab follows by the resume it is told of. */
  async openTurn(turn: {
    readonly turnId: string; readonly runId: string; readonly messageId: string; readonly userTurn: boolean; readonly carried: readonly string[];
    readonly finishedSteps: number;
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

    // One agent runs one turn at a time: a turn opening ended the one before, whose end may be told after this.
    if (this.live !== null && this.live.turnId !== turn.turnId) this.endStream(this.live);
    this.releaseWaiters();

    const live: LiveStream = {
      requestId, turnId: turn.turnId, runId: turn.runId, carried, messageId: turn.messageId, open: new OpenParts(), relayed: [],
      firstStep: turn.finishedSteps, finished: turn.finishedSteps, joined: new Set(), broken: false, failure: null, spoke: false,
    };

    this.live = live;
    this.opened += 1;

    for (const { connection, probeId } of this.parked.values()) this.notifyResuming(connection, live, probeId);
    this.parked.clear();

    if (turn.userTurn) this.wire.broadcast(transcriptFrame(await this.wire.history(TRANSCRIPT_WINDOW)));
  }

  /**
   * The answer row is durable before this. A turn that ends before this room opened it releases the tabs waiting on it.
   * `window`: the transcript's newest {@link TRANSCRIPT_WINDOW} messages as `turnId` ended, told with its end by the
   * agent that holds them. A turn told ended after the next one opened was ended by that opening: its window now would
   * drop the answer streaming in.
   */
  closeTurn(turnId: string, window: readonly UIMessage[]): void {
    const live = this.live;

    if (live === null) {
      this.quiet();

      return;
    }

    if (live.turnId !== turnId) return;
    this.endStream(live);
    this.wire.broadcast(transcriptFrame(window));
  }

  private endStream(live: LiveStream): void {
    this.live = null;
    this.wire.replies?.ended(live.turnId, live.failure);
    this.pendingResume.clear();
    this.done(live.requestId, live.failure === null ? {} : { error: live.failure });

    for (const request of live.carried) this.done(request);
  }

  /** An answer stamped after its end: its tabs are shown the window again, unless a turn is live, whose end carries it
   *  (a window sent mid-turn would drop the answer streaming in). */
  answerAmended(window: readonly UIMessage[]): void {
    if (this.live === null) this.wire.broadcast(transcriptFrame(window));
  }

  /** A turn whose agent did not live to tell its end: its window read from the agent's transcript. */
  async closeLostTurn(turnId: string): Promise<void> {
    this.closeTurn(turnId, this.live?.turnId === turnId ? await this.wire.history(TRANSCRIPT_WINDOW) : []);
  }

  async deliver(event: SessionEvent): Promise<void> {
    switch (event.type) {
      case 'turn-start':
        await this.openTurn({
          turnId: event.turnId, runId: event.runId, messageId: event.messageId, userTurn: event.kind === 'user', carried: event.carried,
          finishedSteps: event.finishedSteps,
        });

        return;

      case 'step-cut': {
        const live = this.live;

        if (live === null) return;
        const chunk: UIMessageChunk = { type: STEP_CUT_CHUNK, data: { stepIndex: event.stepIndex }, transient: true };
        const body = JSON.stringify(chunk);

        live.relayed.push({ step: live.finished, type: chunk.type, body });
        this.wire.broadcast(JSON.stringify({ type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: live.requestId, body, done: false }),
          this.pendingResume.size === 0 ? undefined : [...this.pendingResume.keys()]);

        return;
      }

      case 'error': {
        const live = this.live;

        if (live === null) return;

        // A Stop is not a failure: an `error` frame here makes the SDK client paint an error card. A reply ends on it.
        if (event.message === INTERRUPTED_TURN) {
          this.wire.replies?.ended(live.turnId, event.message);

          return;
        }

        // Their resume names this stream: its own terminal frame, with the error, settles it.
        this.pendingResume.clear();
        live.failure = event.message;

        return;
      }

      case 'broadcast':
        // A message lands where the agent's isolate shows its card: the turn running here then (a slate's ask among them).
        this.wire.replies?.card(event.event, this.live?.turnId ?? null);
        this.wire.broadcast(JSON.stringify(event.event));

        return;

      // The walk-back moved the durable head; every tab needs the stored transcript.
      case 'history-reverted':
        this.wire.broadcast(transcriptFrame(await this.wire.history(TRANSCRIPT_WINDOW)));

        return;

      // A turn's end is told with its transcript window (`closeTurn`), never as a bare event.
      case 'turn-end':
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

        // The turn's wait on its provider, from its isolate (`TurnWaits`): told to the room as a notice, kept in no answer.
        if (chunk.type === PROVIDER_WAIT_PART) {
          this.wire.broadcast(JSON.stringify({ type: 'provider_wait', ...v.parse(ProviderWaitSchema, chunk.data) }));
          continue;
        }

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

        const body = JSON.stringify(chunk);

        live.relayed.push({ step: live.finished, type: chunk.type, body });

        // A joining tab reads it in its replay; sent now, it would run ahead of the parts the replay opens.
        this.wire.broadcast(JSON.stringify({ type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: live.requestId, body, done: false }), this.pendingResume.size === 0 ? undefined : [...this.pendingResume.keys()]);

        if (chunk.type === 'finish-step') {
          compactStep(live.relayed, live.finished);
          live.finished += 1;
        }

        if (chunk.type === 'text-delta') {
          if (!live.spoke) this.wire.firstText?.();
          live.spoke = true;
          this.wire.replies?.feed(live.turnId, chunk.delta);
        }
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

    for (const id of this.pendingResume.keys()) {
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

/** A client's message as the words it sends, in Build unless it names a mode; metadata no client writes names nothing. */
function chatInput(message: UIMessage): SentWords {
  const { parts, metadata } = v.parse(ChatInputSchema, message);
  const text = parts.flatMap((part) => part.type === 'text' ? [part.text ?? ''] : []).join('');

  const files: PromptFile[] = parts.flatMap((part) => part.type === 'file' && part.url !== undefined
    ? [{ filename: part.filename ?? 'attachment', mediaType: part.mediaType ?? 'application/octet-stream', url: part.url }]
    : []);

  const send = v.safeParse(SendMetadataSchema, metadata);
  const words = sentWords(text, files, send.success ? send.output : undefined);

  return { ...words, mode: words.mode ?? 'build' };
}

/**
 * Which room serves this socket, keyed by the actor tag so hibernation restores it.
 * An actor no longer hosted resolves to no room; never fall back to the root's.
 */
export class ActorChatRooms {
  private readonly hosted = new Map<string, ChatWireTransport>();

  /** Main's turns speak into the root's room, which its own tabs hear. */
  constructor(
    private readonly main: string,
    private readonly root: () => ChatWireTransport,
    private readonly wireFor: (actorId: string) => ChatWire | null,
  ) {}

  for(actor: string | null): ChatWireTransport | null {
    if (actor === null) return this.root();

    return this.hostedRoom(actor);
  }

  hostedRoom(actor: string): ChatWireTransport | null {
    if (actor === this.main) return this.root();
    // Asked every time: a room kept for an actor dismissed since would feed its retired loop.
    const wire = this.wireFor(actor);

    if (wire === null) {
      this.hosted.delete(actor);

      return null;
    }

    const held = this.hosted.get(actor);

    if (held !== undefined) return held;
    const room = new ChatWireTransport(wire);
    this.hosted.set(actor, room);

    return room;
  }
}
