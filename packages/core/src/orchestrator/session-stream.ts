import type { ModelMessage, ProviderMetadata, TextStreamPart, ToolSet } from 'ai';
import * as v from 'valibot';
import type { ChatEvent } from '../chat';
import { SessionHistory } from '../session/history';
import type { MessageReference, StoredPart, StreamPartInput, PreparedContent } from '../session/messages';
import type { SessionPayload } from '../session/payload';
import { isParsedJsonObject, jsonObjectElements, projectJsonValue, type JsonObject } from '../utils/json';
import { encodeModelMessage } from '../session/message-codec';
import { diagnostics, renderThrownChain, KinuError } from '../obs/index';

interface StreamPart {
  readonly number: number;
  readonly kind: string;
  opened: boolean;
  /** Written ahead of the part's next non-delta update, or dropped by the step's seal, which writes the final text whole. */
  buffered: string;
  bufferedDeltas: number;
  bufferedBytes: number;
  readonly streamOrder: number;
  startMetadata: JsonObject | null;
}

/** Deltas reach the row in windows, not per token (D23). */
const COALESCE_DELTAS = 64;

/** UTF-8 bytes, what the row takes; not UTF-16 units. */
const COALESCE_BYTES = 4096;

const utf8 = new TextEncoder();

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
}>;

const LIFECYCLE_PARTS: ReadonlySet<string> = new Set<LifecyclePart['type']>([
  'start', 'finish-step', 'finish', 'abort', 'error', 'raw',
  'tool-input-start', 'tool-input-delta', 'tool-input-end', 'tool-output-denied',
]);

function isLifecyclePart(part: TextStreamPart<ToolSet>): part is LifecyclePart {
  return LIFECYCLE_PARTS.has(part.type);
}

const STREAM_DIVERGED = 'session.stream_final_diverged';

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
  /** Writers run one at a time in arrival order, so two cannot reach one container's seal together. */
  private queue: Promise<void> = Promise.resolve();
  private readonly calls = new Map<string, { messageId: string; part: number }>();
  private sourceOrder = 0;
  private requestId: string;
  private assistant: StreamContainer;
  private tool: StreamContainer;
  private ui: StreamContainer;

  constructor(private readonly history: SessionHistory, private readonly turnId: string, private readonly epoch: number) {
    this.requestId = `${turnId}:${epoch}:admission`;
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

  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op);
    // A failure is the caller's, delivered through `run`, and never poisons the queue.
    this.queue = Promise.allSettled([run]).then(() => undefined);

    return run;
  }

  nativePart(part: TextStreamPart<ToolSet>): Promise<void> {
    this.nativeProducer = true;

    if (isLifecyclePart(part)) return Promise.resolve();

    return this.exclusive(() => this.writePart(part));
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
          ? { type: 'error-text', value: renderThrownChain({ cause: part.error }) }
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

  nativeStep(messages: readonly ModelMessage[]): Promise<void> {
    this.nativeProducer = true;

    return this.exclusive(async () => {
      await this.finishStep(messages);
      await this.nextStep();
    });
  }

  /** Scaffold-authored ChatEvents have no native stream; their explicit calls retain the same pairing rule. */
  observe(event: ChatEvent): Promise<void> {
    if (this.nativeProducer) return Promise.resolve();

    return this.exclusive(() => this.observeScaffold(event));
  }

  private async observeScaffold(event: ChatEvent): Promise<void> {
    if (event.type === 'text-delta' || event.type === 'reasoning-delta') {
      const kind = event.type === 'text-delta' ? 'text' : 'reasoning';
      await this.publish({ container: this.assistant, key: kind, descriptor: { type: kind }, delta: event.delta });
    } else if (event.type === 'tool-call') {
      await this.publish({ container: this.assistant, key: `call:${event.toolCallId}`, descriptor: { type: 'tool-call', toolCallId: event.toolCallId, toolName: event.toolName, input: event.args }, delta: null });
    } else if (event.type === 'tool-result') {
      const output = event.success ? { type: 'text', value: event.result } : { type: 'error-text', value: event.error ?? event.result };
      await this.publish({ container: this.tool, key: `result:${event.toolCallId}`, descriptor: { type: 'tool-result', toolCallId: event.toolCallId, toolName: event.toolName, output }, delta: null });
    } else if (event.type === 'step-finish') {
      await this.finishStep(event.responseMessages);
      await this.nextStep();
    } else if (event.type === 'done') {
      await this.finishStep(event.responseMessages);
    }
  }


  private container(role: 'assistant' | 'tool', slot = role === 'assistant' ? 0 : 1): StreamContainer {
    return { id: `${this.requestId}:${this.nativeProducer ? slot : this.step * 3 + slot}`, role, slot, reference: null, working: slot !== 2, sealed: false, parts: new Map() };
  }

  /** A container streamed into without a final message still commits what it holds. */
  private async nextStep(): Promise<void> {
    for (const container of [this.assistant, this.tool, this.ui]) await this.sealOpen(container);
    this.step += 1;
    this.sourceOrder = 0;
    this.assistant = this.container('assistant');
    this.tool = this.container('tool');
    this.ui = this.container('assistant', 2);
  }

  private reserve(container: StreamContainer, key: string, kind: string): StreamPart {
    const existing = container.parts.get(key);

    if (existing !== undefined) return existing;
    const part: StreamPart = { number: container.parts.size, kind, streamOrder: this.sourceOrder++, opened: false, buffered: '', bufferedDeltas: 0, bufferedBytes: 0, startMetadata: null };
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

    if (part.opened) replaced = metadata === undefined ? null : await this.history.messages.prepareMetadata(container.id, part.number, metadata);
    else {
      const native: JsonObject = { ...descriptor };
      const options = metadata ?? part.startMetadata;

      if (options !== null && options !== undefined) native.providerOptions = options;
      const prepared = await this.history.messages.prepareDescriptor(native);
      opening = { partNo: part.number, kind, streamOrder: part.streamOrder, descriptor: prepared.descriptor };

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

    part.opened = true;

    if (kind === 'tool-call' && callId.success) this.calls.set(callId.output, { messageId: container.id, part: part.number });
  }

  /** Plain deltas on an open text part join the window; anything else flushes it first. A trailing high surrogate is held back. */
  private window(part: StreamPart, delta: string | null, joins: boolean, end: boolean): string | null {
    let pending = delta;

    if (joins && pending !== null) {
      part.buffered += pending;
      part.bufferedDeltas += 1;
      part.bufferedBytes += utf8.encode(pending).byteLength;

      if (part.bufferedDeltas < COALESCE_DELTAS && part.bufferedBytes < COALESCE_BYTES) return null;
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
      container.reference = this.history.messages.open(container.role, container.id, container.working ? 'output' : 'render', { requestId: this.requestId, slot: this.nativeProducer ? container.slot : this.step * 3 + container.slot });
      write?.();
    });
  }

  /** One revision per sealed model-facing message, in the same transaction under the epoch fence. */
  private sealContainer(container: StreamContainer, content: PreparedContent, envelope?: JsonObject): void {
    if (!container.working) {
      this.fenced(() => this.history.messages.seal(container.id, content, envelope));
      container.sealed = true;

      return;
    }

    const selected = this.history.context.selected();

    if (selected === null) throw new KinuError('missing', 'stream has no selected context');
    this.history.context.commit(selected, { cause: 'output', turnId: this.turnId, assertEpoch: () => this.history.assertEpoch(this.turnId, this.epoch), mutate: entries => {
      this.history.messages.seal(container.id, content, envelope);

      if (entries.some(entry => entry.messageId === container.id)) return entries;

      return [...entries, { messageId: container.id, entryId: container.id, position: entries.length }];
    } });
    container.sealed = true;
  }

  private async finishStep(cumulative: readonly ModelMessage[]): Promise<void> {
    const produced = cumulative.slice(this.completedMessageCount);

    for (const message of produced) {
      if (message.role !== 'assistant' && message.role !== 'tool') throw new KinuError('bad_input', 'a model response contains an input role');
      const container = message.role === 'assistant' ? this.assistant : this.tool;
      const { role: _role, content, ...envelope } = encodeModelMessage(message);
      const finalParts = jsonObjectElements(content);

      if (finalParts === null) throw new KinuError('io', 'a final native message holds no list of parts');

      if (container.reference === null && finalParts.length === 0) continue;

      // Settled before its step finished: what streamed is the record, with no source to bind.
      if (container.sealed) continue;
      const parts = await this.reconcile(container, finalParts);
      const sealed = await this.history.messages.prepareContent(parts);

      if (container.reference === null) this.openContainer(container);
      this.sealContainer(container, sealed, envelope);
      await this.history.messages.bindSource(message, { messageId: container.id });
    }

    this.completedMessageCount = cumulative.length;
  }

  /** Paired by {@link partIdentity}: the final message decides order and content; a streamed part it omits is kept in place. Disagreement is {@link STREAM_DIVERGED}, never a throw. */
  private async reconcile(container: StreamContainer, finalParts: readonly JsonObject[]): Promise<StoredPart[]> {
    const streamed = container.reference === null ? [] : await this.openParts(container) ?? [];
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

  /** In-memory windows are written first. Null once sealed. */
  private async openParts(container: StreamContainer): Promise<readonly StoredPart[] | null> {
    for (const part of container.parts.values()) {
      if (part.buffered.length === 0) continue;
      const window = part.buffered;
      part.buffered = '';
      part.bufferedDeltas = 0;
      part.bufferedBytes = 0;
      this.fenced(() => this.history.messages.streamAppend(container.id, part.number, window));
    }

    return this.history.messages.openParts(container.id);
  }

  private async sealOpen(container: StreamContainer): Promise<void> {
    if (container.reference === null || container.sealed) return;
    const parts = await this.openParts(container);

    if (parts === null) {
      container.sealed = true;

      return;
    }

    this.sealContainer(container, await this.history.messages.prepareContent(parts));
  }

  settle(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.history.epochCurrent(this.turnId, this.epoch)) return;

      for (const container of [this.assistant, this.tool, this.ui]) await this.sealOpen(container);
    });
  }
}
