import type { ModelMessage, ProviderMetadata, TextStreamPart, ToolSet } from 'ai';
import * as v from 'valibot';
import type { ChatEvent, StepRecord } from '../chat';
import { SessionHistory } from '../session/history';
import type { ClaimFence, MessageReference, StoredPart, StreamPartInput, PreparedContent } from '../session/messages';
import type { SessionPayload } from '../session/payload';
import { isParsedJsonObject, jsonObjectElements, projectJsonValue, type JsonObject } from '../utils/json';
import { encodeModelMessage } from '../session/message-codec';
import { diagnostics, KinuError } from '../obs/index';
import { toolErrorOutput } from '../tools/outcome';
import { serialQueue } from '@kinu.run/agent-utils';
import { flushSignal, partialFlushCadence, type PartialFlushSignal } from './flush-cadence';

/** Reasoning reaches the row in windows, not per token (D23): a reasoning model streams tens of thousands. */
const REASONING_WINDOW_DELTAS = 64;

/** UTF-8 bytes, what the row takes; not UTF-16 units. */
const REASONING_WINDOW_BYTES = 4096;

const utf8 = new TextEncoder();

interface StreamPart {
  readonly number: number;
  readonly kind: string;
  opened: boolean;
  /** Native descriptor and all text witnessed by this stream, independent of its durable windows. */
  descriptor: JsonObject;
  text: string;
  /** Written at the part's next non-delta update, the cadence's flush (text), a full window (reasoning), or seal. */
  buffered: string;
  bufferedDeltas: number;
  bufferedBytes: number;
  readonly streamOrder: number;
  startMetadata: JsonObject | null;
}

function toolOutput(output: { readonly value: unknown }): JsonObject {
  if (v.is(v.string(), output.value)) return { type: 'text', value: output.value };

  return { type: 'json', value: projectJsonValue(output) };
}

function metadataObject(metadata: ProviderMetadata): JsonObject {
  const projected = projectJsonValue({ value: metadata });

  if (!isParsedJsonObject(projected)) throw new KinuError('bad_input', 'provider metadata is not an object');

  return projected;
}

/** Tool parts pair on the call id; text and reasoning pair on kind plus ordinal, never array index. */
function partIdentity(kind: string, native: JsonObject, ordinals: Map<string, number>): string {
  const callId = v.safeParse(v.string(), native.toolCallId);

  if (callId.success && (kind === 'tool-call' || kind === 'tool-result')) return `${kind}:${callId.output}`;
  const ordinal = ordinals.get(kind) ?? 0;
  ordinals.set(kind, ordinal + 1);

  return `${kind}#${ordinal}`;
}

/** An empty reasoning part is not evidence of thinking. */
function streamedContent(part: StoredPart): boolean {
  if (part.kind !== 'text' && part.kind !== 'reasoning') return true;

  return v.is(v.string(), part.value.text) && part.value.text.length > 0;
}

/** Stream parts that never enter the durable record. A new kind must be placed here or given an arm. */
type LifecyclePart = Extract<TextStreamPart<ToolSet>, { type:
  | 'start'
  | 'finish-step'
  | 'finish'
  | 'abort'
  | 'error'
  | 'raw'
  | 'tool-input-start'
  | 'tool-input-delta'
  | 'tool-input-end'
  | 'tool-output-denied'
  | 'tool-approval-response'
  | 'reasoning-file'
  | 'custom'
}>;

const LIFECYCLE_PARTS: ReadonlySet<string> = new Set<LifecyclePart['type']>([
  'start', 'finish-step', 'finish', 'abort', 'error', 'raw',
  'tool-input-start', 'tool-input-delta', 'tool-input-end', 'tool-output-denied',
  'tool-approval-response', 'reasoning-file', 'custom',
]);

function isLifecyclePart(part: TextStreamPart<ToolSet>): part is LifecyclePart {
  return LIFECYCLE_PARTS.has(part.type);
}

const STREAM_DIVERGED = 'session.stream_final_diverged';

interface DurableCall {
  readonly held: ReturnType<typeof Promise.withResolvers<void>>;
  awaited: boolean;
  failed: { readonly reason: unknown } | null;
}

interface StreamContainer {
  readonly id: string;
  readonly role: 'assistant' | 'tool';
  readonly slot: number;
  reference: MessageReference | null;
  /** Joins the working context when it seals; a render-only container never does. */
  readonly working: boolean;
  sealed: boolean;
  readonly parts: Map<string, StreamPart>;
}

interface PublishedPart {
  readonly container: StreamContainer;
  readonly key: string;
  readonly descriptor: JsonObject;
  readonly delta: string | null;
  readonly providerMetadata?: ProviderMetadata;
  /** The window flushes and the row is ended. */
  readonly end?: boolean;
}

/** Native SDK order is assistant then non-provider tool results (ai 6.0.214 toResponseMessages).
 * Content updates preserve those containers; final conversion does not mint another tool call. */
export class SessionStream {
  private step = 0;
  private completedMessageCount = 0;
  private nativeProducer = false;
  private terminal = false;
  private failedRecord = false;
  /** Writers run one at a time in arrival order, so two cannot reach one container's seal together. */
  private readonly exclusive = serialQueue();
  private readonly calls = new Map<string, { messageId: string; part: number }>();
  /** Text reaches the row at the first content event, then every ten, and at each settled tool result; a crash
   *  loses at most one cadence interval of text. */
  private readonly cadence = partialFlushCadence();
  private readonly claim: ClaimFence;
  private readonly durableCalls = new Map<string, DurableCall>();
  private sourceOrder = 0;
  private requestId: string;
  private assistant: StreamContainer;
  private tool: StreamContainer;
  private ui: StreamContainer;

  constructor(private readonly history: SessionHistory, private readonly turnId: string, private readonly epoch: number) {
    this.requestId = `${turnId}:${epoch}:admission`;
    this.claim = { turnId, epoch, assert: () => this.history.assertEpoch(turnId, epoch) };
    this.assistant = this.container('assistant');
    this.tool = this.container('tool');
    this.ui = this.container('assistant', 2);
  }

  beginRequest(requestId: string, stepIndex: number): void {
    this.nativeProducer = true;
    this.requestId = requestId;
    this.sourceOrder = 0;

    if (stepIndex === 0) this.completedMessageCount = 0;
    this.assistant = this.container('assistant');
    this.tool = this.container('tool');
    this.ui = this.container('assistant', 2);
  }

  nativePart(part: TextStreamPart<ToolSet>): Promise<void> {
    this.nativeProducer = true;
    const signal = flushSignal(part);

    if (isLifecyclePart(part)) return signal === 'none' ? Promise.resolve() : this.exclusive(async () => { this.tick(signal); });

    return this.witnessCall(part.type === 'tool-call' ? part.toolCallId : null, this.exclusive(async () => {
      await this.writePart(part);
      this.tick(signal);
    }));
  }

  /** At the cadence's flush, every text window the step holds is written. */
  private tick(signal: PartialFlushSignal): void {
    if (!this.cadence.flushes(signal)) return;

    for (const part of this.assistant.parts.values()) {
      const text = part.kind !== 'text' || part.buffered === '' ? null : this.window(part, null, false, false);

      if (text !== null && text !== '') this.history.atomic(() => this.history.messages.streamAppend(this.assistant.id, part.number, text, this.claim));
    }
  }

  /** Resolves once the call's part is durable. */
  durable(callId: string, signal?: AbortSignal): Promise<void> {
    const call = this.durableCall(callId);

    call.awaited = true;

    if (call.failed !== null) call.held.reject(call.failed.reason);
    const aborted = (): void => { call.held.reject(signal?.reason); };

    signal?.addEventListener('abort', aborted, { once: true });

    return call.held.promise.finally(() => { signal?.removeEventListener('abort', aborted); });
  }

  private durableCall(callId: string): DurableCall {
    const call = this.durableCalls.get(callId) ?? { held: Promise.withResolvers<void>(), awaited: false, failed: null };

    this.durableCalls.set(callId, call);

    return call;
  }

  private async witnessCall(callId: string | null, write: Promise<void>): Promise<void> {
    if (callId === null) return await write;
    const call = this.durableCall(callId);
    const [outcome] = await Promise.allSettled([write]);

    if (outcome?.status === 'fulfilled') {
      call.held.resolve();

      return;
    }

    call.failed = { reason: outcome?.reason };

    if (call.awaited) call.held.reject(outcome?.reason);

    return await write;
  }

  private async writePart(part: Exclude<TextStreamPart<ToolSet>, LifecyclePart>): Promise<void> {
    switch (part.type) {
      case 'start-step':
        await this.publish({ container: this.ui, key: 'step-start', descriptor: { type: 'step-start' }, delta: null });

        return;
      case 'source': {
        const source: JsonObject = part.sourceType === 'url'
          ? { type: 'source-url', sourceId: part.id, url: part.url }
          : { type: 'source-document', sourceId: part.id, mediaType: part.mediaType, title: part.title };

        if (part.title !== undefined) source.title = part.title;
        await this.publish({ container: this.ui, key: `source:${part.id}`, descriptor: source, delta: null, providerMetadata: part.providerMetadata });

        return;
      }

      case 'text-start': {
        const pending = this.reserve(this.assistant, `text:${part.id}`, 'text');

        if (part.providerMetadata !== undefined) pending.startMetadata = metadataObject(part.providerMetadata);

        return;
      }

      case 'reasoning-start':
        await this.publish({ container: this.assistant, key: `reasoning:${part.id}`, descriptor: { type: 'reasoning' }, delta: '', providerMetadata: part.providerMetadata });

        return;
      case 'text-delta':
      case 'reasoning-delta': {
        const kind = part.type === 'text-delta' ? 'text' : 'reasoning';
        await this.publish({ container: this.assistant, key: `${kind}:${part.id}`, descriptor: { type: kind }, delta: part.text, providerMetadata: part.providerMetadata });

        return;
      }

      case 'text-end':
      case 'reasoning-end': {
        const kind = part.type === 'text-end' ? 'text' : 'reasoning';
        const key = `${kind}:${part.id}`;

        if (this.assistant.parts.get(key)?.opened) await this.publish({ container: this.assistant, key, descriptor: { type: kind }, delta: null, providerMetadata: part.providerMetadata, end: true });

        return;
      }

      case 'tool-call': {
        const input = part.invalid && !v.is(v.record(v.string(), v.unknown()), part.input) ? {} : projectJsonValue({ value: part.input });
        const descriptor: JsonObject = { type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input };

        if (part.providerExecuted !== undefined) descriptor.providerExecuted = part.providerExecuted;
        await this.publish({ container: this.assistant, key: `call:${part.toolCallId}`, descriptor, delta: null, providerMetadata: part.providerMetadata });

        return;
      }

      case 'tool-result':
      case 'tool-error': {
        const output = part.type === 'tool-error'
          ? toolErrorOutput({ cause: part.error })
          : toolOutput({ value: part.output });

        await this.publish({ container: part.providerExecuted ? this.assistant : this.tool, key: `result:${part.toolCallId}`,
          descriptor: { type: 'tool-result', toolCallId: part.toolCallId, toolName: part.toolName, output }, delta: null, providerMetadata: part.providerMetadata });

        return;
      }

      case 'file':
        await this.publish({ container: this.assistant, key: `file:${this.assistant.parts.size}`, descriptor: { type: 'file', data: part.file.base64, mediaType: part.file.mediaType }, delta: null, providerMetadata: part.providerMetadata });

        return;
      case 'tool-approval-request': {
        const descriptor: JsonObject = { type: 'tool-approval-request', approvalId: part.approvalId, toolCallId: part.toolCall.toolCallId };

        if (part.signature !== undefined) descriptor.signature = part.signature;
        await this.publish({ container: this.assistant, key: `approval:${part.approvalId}`, descriptor, delta: null });

        return;
      }

    }
  }

  nativeStep(record: StepRecord, rows?: () => void | (() => void)): Promise<void> {
    this.nativeProducer = true;

    return this.exclusive(async () => {
      if (this.terminal) return;

      let committed = false;

      try {
        await this.sealStep(record.messages, rows);
        committed = true;
      } finally { if (!committed) this.failedRecord = true; }

      this.nextStep();
    });
  }

  /** Scaffold-authored ChatEvents have no native stream; their explicit calls retain the same pairing rule. */
  observe(event: ChatEvent): Promise<void> {
    if (event.source === 'native') return Promise.resolve();

    return this.witnessCall(event.type === 'tool-call' ? event.toolCallId : null, this.exclusive(() => this.observeScaffold(event)));
  }

  private async observeScaffold(event: ChatEvent): Promise<void> {
    if (this.nativeProducer) {
      // A native step the program cut off seals first: its messages and the program's never share an output slot.
      if ([this.assistant, this.tool, this.ui].some(container => container.reference !== null)) await this.sealStep(null);
      this.nativeProducer = false;
      this.nextStep();
    }

    if (event.type === 'text-delta' || event.type === 'reasoning-delta') {
      const kind = event.type === 'text-delta' ? 'text' : 'reasoning';
      await this.publish({ container: this.assistant, key: kind, descriptor: { type: kind }, delta: event.delta });
      this.tick('content');
    } else if (event.type === 'tool-call') {
      await this.publish({ container: this.assistant, key: `call:${event.toolCallId}`, descriptor: { type: 'tool-call', toolCallId: event.toolCallId, toolName: event.toolName, input: event.args }, delta: null });
      this.tick('content');
    } else if (event.type === 'tool-result') {
      const output = event.success ? { type: 'text', value: event.result } : toolErrorOutput({ cause: event.error ?? event.result }, event);
      await this.publish({ container: this.tool, key: `result:${event.toolCallId}`, descriptor: { type: 'tool-result', toolCallId: event.toolCallId, toolName: event.toolName, output }, delta: null });
      this.tick('settled');
    } else if (event.type === 'step-finish') {
      await this.sealStep(event.responseMessages);
      this.nextStep();
    } else if (event.type === 'done') {
      await this.sealStep(event.responseMessages);
    }
  }


  private container(role: 'assistant' | 'tool', slot = role === 'assistant' ? 0 : 1): StreamContainer {
    const outputSlot = this.step * 3 + slot;

    return { id: `${this.requestId}:${outputSlot}`, role, slot: outputSlot, reference: null, working: slot !== 2, sealed: false, parts: new Map() };
  }

  private nextStep(): void {
    this.cadence.reset();
    this.step += 1;
    this.sourceOrder = 0;
    this.assistant = this.container('assistant');
    this.tool = this.container('tool');
    this.ui = this.container('assistant', 2);
  }

  private reserve(container: StreamContainer, key: string, kind: string): StreamPart {
    const existing = container.parts.get(key);

    if (existing !== undefined) return existing;
    const part: StreamPart = { number: container.parts.size, kind, streamOrder: this.sourceOrder++, opened: false, descriptor: { type: kind }, text: '', buffered: '', bufferedDeltas: 0, bufferedBytes: 0, startMetadata: null };
    container.parts.set(key, part);

    return part;
  }

  private async publish(update: PublishedPart): Promise<void> {
    const { container, key, descriptor, delta, providerMetadata, end = false } = update;
    const kind = v.parse(v.string(), descriptor.type);
    const part = this.reserve(container, key, kind);
    const joins = part.opened && !end && providerMetadata === undefined && (kind === 'text' || kind === 'reasoning');
    const text = this.window(part, delta, joins, end);

    if (text === null && providerMetadata === undefined && !end && part.opened) return;

    const callId = v.safeParse(v.string(), descriptor.toolCallId);
    const metadata = providerMetadata === undefined ? undefined : metadataObject(providerMetadata);
    let opening: StreamPartInput | null = null;
    let replaced: SessionPayload | null = null;

    let native = part.descriptor;

    if (part.opened) {
      if (metadata !== undefined) {
        native = { ...native, providerOptions: metadata };
        replaced = await this.history.messages.prepareDescriptor(native);
      }
    } else {
      native = { ...descriptor };
      const options = metadata ?? part.startMetadata;

      if (options !== null && options !== undefined) native.providerOptions = options;
      opening = { partNo: part.number, kind, streamOrder: part.streamOrder, descriptor: await this.history.messages.prepareDescriptor(native) };

      if (text !== null) opening.text = text;
    }

    const write = (): void => {
      if (opening !== null) this.history.messages.streamOpenPart(container.id, opening);
      else if (text !== null) this.history.messages.streamAppend(container.id, part.number, text);

      if (replaced !== null) this.history.messages.streamMetadata(container.id, part.number, replaced);

      if (end) this.history.messages.streamEnd(container.id, part.number);
    };

    if (container.reference !== null) this.fenced(write);
    else this.openContainer(container, write);

    part.descriptor = native;
    part.opened = true;

    if (kind === 'tool-call' && callId.success) this.calls.set(callId.output, { messageId: container.id, part: part.number });
  }

  /** Plain deltas on an open text part join the window; anything else flushes it first. A trailing high surrogate is held back. */
  private window(part: StreamPart, delta: string | null, joins: boolean, end: boolean): string | null {
    if (delta !== null) part.text += delta;
    let pending = delta;

    if (joins && pending !== null) {
      part.buffered += pending;
      part.bufferedDeltas += 1;
      part.bufferedBytes += utf8.encode(pending).byteLength;

      if (part.kind === 'text' || (part.bufferedDeltas < REASONING_WINDOW_DELTAS && part.bufferedBytes < REASONING_WINDOW_BYTES)) return null;
      pending = null;
    }

    let text = part.buffered + (pending ?? '');
    part.buffered = '';
    part.bufferedDeltas = 0;
    part.bufferedBytes = 0;

    if (!end && text.length > 0) {
      const last = text.charCodeAt(text.length - 1);

      if (last >= 0xd800 && last <= 0xdbff) {
        part.buffered = text.slice(-1);
        part.bufferedDeltas = 1;
        part.bufferedBytes = utf8.encode(part.buffered).byteLength;
        text = text.slice(0, -1);
      }
    }

    if (text !== '') return text;

    return pending !== null && !part.opened ? '' : null;
  }

  private fenced<T>(write: () => T): T {
    return this.history.atomic(() => {
      this.history.assertEpoch(this.turnId, this.epoch);

      return write();
    });
  }

  /** Joins the working context only when sealed: a revision names immutable content. */
  private openContainer(container: StreamContainer, write?: () => void): void {
    this.fenced(() => {
      container.reference = this.history.messages.open(container.role, container.id, container.working ? 'output' : 'render', { requestId: this.requestId, slot: container.slot });
      write?.();
    });
  }

  /** One revision per sealed model-facing message, in the same transaction under the epoch fence. */
  private sealContainer(container: StreamContainer, content: PreparedContent, envelope: JsonObject = {}): void {
    if (!container.working) {
      this.fenced(() => this.history.messages.seal(container.id, content, envelope));

      return;
    }

    const selected = this.history.context.selected();

    if (selected === null) throw new KinuError('missing', 'stream has no selected context');
    this.history.context.commit(selected, { cause: 'output', turnId: this.turnId, assertEpoch: () => this.history.assertEpoch(this.turnId, this.epoch), mutate: entries => {
      this.history.messages.seal(container.id, content, envelope);

      if (entries.some(entry => entry.messageId === container.id)) return entries;

      return [...entries, { messageId: container.id, entryId: container.id, position: entries.length }];
    } });
  }

  /** Prepare content first; seals and rows publish in one fenced commit. */
  private async sealStep(cumulative: readonly ModelMessage[] | null, rows?: () => void | (() => void)): Promise<void> {
    const seals: (() => void)[] = [];
    const bind: (() => void)[] = [];
    const finals = new Set<StreamContainer>();

    for (const message of cumulative?.slice(this.completedMessageCount) ?? []) {
      if (message.role !== 'assistant' && message.role !== 'tool') throw new KinuError('bad_input', 'a model response contains an input role');
      const container = message.role === 'assistant' ? this.assistant : this.tool;
      const { role: _role, content, ...envelope } = encodeModelMessage(message);
      const finalParts = jsonObjectElements(content);

      if (finalParts === null) throw new KinuError('io', 'a final native message holds no list of parts');

      if (container.reference === null && finalParts.length === 0) continue;

      // Settled before its step finished: what streamed is the record, with no source to bind.
      if (container.sealed) continue;
      finals.add(container);
      const parts = this.reconcile(container, finalParts);
      const sealed = await this.history.messages.prepareContent(parts);

      seals.push(() => {
        if (container.reference === null) this.openContainer(container);
        this.sealContainer(container, sealed, envelope);
      });
      bind.push(() => this.history.messages.bindSource(message, { messageId: container.id }, { ...envelope, role: message.role, content: parts.map(part => part.value) }));
    }

    // A container streamed into without a final message still commits what it holds.
    for (const container of [this.assistant, this.tool, this.ui]) {
      if (container.reference === null || container.sealed || finals.has(container)) continue;
      const content = await this.history.messages.prepareContent(this.openParts(container));
      seals.push(() => { this.sealContainer(container, content); });
    }

    const containers = [this.assistant, this.tool, this.ui];
    const references = containers.map((container) => container.reference);
    let committed = false;
    let publish: void | (() => void);

    try {
      publish = this.fenced(() => {
        const recorded = rows?.();

        for (const seal of seals) seal();

        return recorded;
      });
      committed = true;
    } finally {
      if (!committed) for (const [index, container] of containers.entries()) container.reference = references[index] ?? null;
    }

    for (const container of finals) container.sealed = true;

    for (const container of containers) if (container.reference !== null) container.sealed = true;

    for (const remember of bind) remember();
    publish?.();

    if (cumulative !== null) this.completedMessageCount = cumulative.length;
  }

  /** Paired by {@link partIdentity}: the final message decides order and content; a streamed part it omits is kept in place. Disagreement is {@link STREAM_DIVERGED}, never a throw. */
  private reconcile(container: StreamContainer, finalParts: readonly JsonObject[]): StoredPart[] {
    const streamed = this.openParts(container);
    const witnessed = new Map<string, StoredPart>();
    const streamOrdinals = new Map<string, number>();

    for (const part of [...streamed].sort((a, b) => a.streamOrder - b.streamOrder)) {
      witnessed.set(partIdentity(part.kind, part.value, streamOrdinals), part);
    }

    const finalOrdinals = new Map<string, number>();
    const paired = new Set<string>();
    let reordered = false;
    let lastOrder = -1;

    const finals = finalParts.map(native => {
      const kind = v.parse(v.string(), native.type);
      const identity = partIdentity(kind, native, finalOrdinals);
      const prior = witnessed.get(identity);

      if (prior === undefined) return { kind, value: native, streamOrder: null };
      paired.add(identity);

      if (prior.streamOrder < lastOrder) reordered = true;
      lastOrder = prior.streamOrder;

      return { kind, value: native, streamOrder: prior.streamOrder };
    });

    const kept = [...witnessed]
      .filter(([identity, part]) => !paired.has(identity) && streamedContent(part))
      .map(([, part]) => part)
      .sort((a, b) => a.streamOrder - b.streamOrder);

    if (kept.length > 0 || reordered) {
      diagnostics.event(STREAM_DIVERGED, { messageId: container.id, kept: kept.length, reordered, finalParts: finalParts.length });
    }

    const merged: { kind: string; value: JsonObject; streamOrder: number | null }[] = [];
    let at = 0;

    for (const final of finals) {
      while (at < kept.length && final.streamOrder !== null && (kept[at]?.streamOrder ?? 0) < final.streamOrder) {
        const orphan = kept[at++];

        if (orphan !== undefined) merged.push({ kind: orphan.kind, value: orphan.value, streamOrder: orphan.streamOrder });
      }

      merged.push(final);
    }

    while (at < kept.length) {
      const orphan = kept[at++];

      if (orphan !== undefined) merged.push({ kind: orphan.kind, value: orphan.value, streamOrder: orphan.streamOrder });
    }

    return merged.map((part, index) => {
      const callId = v.safeParse(v.string(), part.value.toolCallId);
      const call = part.kind === 'tool-result' && callId.success ? this.calls.get(callId.output) : undefined;

      if (part.kind === 'tool-call' && callId.success) this.calls.set(callId.output, { messageId: container.id, part: index });

      return { partNo: index, kind: part.kind, streamOrder: part.streamOrder ?? this.sourceOrder++,
        replyTo: call === undefined ? null : { messageId: call.messageId, partNo: call.part }, value: part.value };
    });
  }

  /** Flushes durable windows before building the seal input from the parts this stream opened. */
  private openParts(container: StreamContainer): StoredPart[] {
    const parts: StoredPart[] = [];

    for (const part of container.parts.values()) {
      if (!part.opened) continue;

      if (part.buffered.length > 0) {
        const window = part.buffered;
        part.buffered = '';
        part.bufferedDeltas = 0;
        part.bufferedBytes = 0;
        this.history.atomic(() => this.history.messages.streamAppend(container.id, part.number, window, this.claim));
      }

      const value = { ...part.descriptor };

      if (part.kind === 'text' || part.kind === 'reasoning' || part.text !== '') value.text = part.text;
      parts.push({ partNo: part.number, kind: part.kind, streamOrder: part.streamOrder, replyTo: null, value });
    }

    return parts;
  }

  /** Seals unclosed output with its rows. */
  settle(): Promise<void> {
    return this.exclusive(async () => {
      if (this.terminal) return;

      this.terminal = true;

      if (this.failedRecord || [this.assistant, this.tool, this.ui].every(container => container.reference === null || container.sealed)) return;

      if (!this.history.epochCurrent(this.turnId, this.epoch)) return;

      await this.sealStep(null);
    });
  }
}
