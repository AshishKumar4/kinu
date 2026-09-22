import type { ModelMessage, ProviderMetadata, TextStreamPart, ToolSet } from 'ai';
import * as v from 'valibot';
import type { ChatEvent } from '../chat';
import { SessionHistory } from '../session/history';
import type { MessageReference, StoredPart, StreamPartInput, PreparedContent } from '../session/messages';
import type { SessionPayload } from '../session/payload';
import { JsonObjectSchema, projectJsonValue, type JsonObject } from '../utils/json';
import { encodeModelMessages } from '../session/message-codec';
import { renderThrownChain, KinuError } from '../obs/index';

interface StreamPart {
  readonly number: number;
  readonly kind: string;
  opened: boolean;
  /** Deltas taken in but not yet written, and how many: one statement per
   *  window (`COALESCE_DELTAS` or `COALESCE_BYTES`), not per token. Written
   *  ahead of the part's next non-delta update, or dropped by the step's seal,
   *  which writes the final text whole. */
  buffered: string;
  bufferedDeltas: number;
  bufferedBytes: number;
  readonly streamOrder: number;
  startMetadata: JsonObject | null;
}

/** A streamed part's deltas reach its row in windows. Each statement runs on
 *  the Durable Object's storage, and a reasoning model streams tokens by the
 *  ten-thousand (D23 measured one statement per token as the CPU of one
 *  turn). A window is small enough that a cut turn keeps all but its last
 *  second of words. */
const COALESCE_DELTAS = 64;

/** UTF-8 bytes of the window, what the row takes; not UTF-16 units. */
const COALESCE_BYTES = 4096;

const utf8 = new TextEncoder();

interface StreamContainer {
  readonly id: string;
  readonly role: 'assistant' | 'tool';
  readonly slot: number;
  reference: MessageReference | null;
  /** Model-facing: joins the working context when it seals. A render-only
   *  container never does. */
  readonly working: boolean;
  sealed: boolean;
  readonly parts: Map<string, StreamPart>;
}

/** Native SDK order is assistant then non-provider tool results (ai 6.0.214 toResponseMessages).
 * Content updates preserve those containers; final conversion does not mint another tool call. */
export class SessionStream {
  private step = 0;
  private completedMessageCount = 0;
  private nativeProducer = false;
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

  async nativePart(part: TextStreamPart<ToolSet>): Promise<void> {
    this.nativeProducer = true;

    switch (part.type) {
      case 'start-step':
        await this.publish(this.ui, 'step-start', { type: 'step-start' }, null);

        return;
      case 'source': {
        const source: JsonObject = part.sourceType === 'url'
          ? { type: 'source-url', sourceId: part.id, url: part.url }
          : { type: 'source-document', sourceId: part.id, mediaType: part.mediaType, title: part.title };

        if (part.title !== undefined) source.title = part.title;
        await this.publish(this.ui, `source:${part.id}`, source, null, part.providerMetadata);

        return;
      }

      case 'text-start': {
        const pending = this.reserve(this.assistant, `text:${part.id}`, 'text');

        if (part.providerMetadata !== undefined) pending.startMetadata = v.parse(JsonObjectSchema, projectJsonValue({ value: part.providerMetadata }));

        return;
      }

      case 'reasoning-start':
        await this.publish(this.assistant, `reasoning:${part.id}`, { type: 'reasoning' }, '', part.providerMetadata);

        return;
      case 'text-delta':
      case 'reasoning-delta': {
        const kind = part.type === 'text-delta' ? 'text' : 'reasoning';
        await this.publish(this.assistant, `${kind}:${part.id}`, { type: kind }, part.text, part.providerMetadata);

        return;
      }

      case 'text-end':
      case 'reasoning-end': {
        const kind = part.type === 'text-end' ? 'text' : 'reasoning';
        const key = `${kind}:${part.id}`;

        if (this.assistant.parts.get(key)?.opened) await this.publish(this.assistant, key, { type: kind }, null, part.providerMetadata, true);

        return;
      }

      case 'tool-call': {
        const input = part.invalid && !v.is(v.record(v.string(), v.unknown()), part.input) ? {} : projectJsonValue({ value: part.input });
        const descriptor: JsonObject = { type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input };

        if (part.providerExecuted !== undefined) descriptor.providerExecuted = part.providerExecuted;
        await this.publish(this.assistant, `call:${part.toolCallId}`, descriptor, null, part.providerMetadata);

        return;
      }

      case 'tool-result':
      case 'tool-error': {
        const output = part.type === 'tool-error'
          ? { type: 'error-text', value: renderThrownChain({ cause: part.error }) }
          : v.is(v.string(), part.output) ? { type: 'text', value: part.output } : { type: 'json', value: projectJsonValue({ value: part.output }) };

        await this.publish(part.providerExecuted ? this.assistant : this.tool, `result:${part.toolCallId}`,
          { type: 'tool-result', toolCallId: part.toolCallId, toolName: part.toolName, output }, null, part.providerMetadata);

        return;
      }

      case 'file':
        await this.publish(this.assistant, `file:${this.assistant.parts.size}`, { type: 'file', data: part.file.base64, mediaType: part.file.mediaType }, null, part.providerMetadata);

        return;
      case 'tool-approval-request': {
        const descriptor: JsonObject = { type: 'tool-approval-request', approvalId: part.approvalId, toolCallId: part.toolCall.toolCallId };

        if (part.signature !== undefined) descriptor.signature = part.signature;
        await this.publish(this.assistant, `approval:${part.approvalId}`, descriptor, null);

        return;
      }

      default:
        // Source/UI frames and lifecycle evidence are not model-message parts.
        return;
    }
  }

  async nativeStep(messages: readonly ModelMessage[]): Promise<void> {
    this.nativeProducer = true;
    await this.finishStep(messages);
    await this.nextStep();
  }

  /** Scaffold-authored ChatEvents have no native stream; their explicit calls retain the same pairing rule. */
  async observe(event: ChatEvent): Promise<void> {
    if (this.nativeProducer) return;

    if (event.type === 'text-delta' || event.type === 'reasoning-delta') {
      const kind = event.type === 'text-delta' ? 'text' : 'reasoning';
      await this.publish(this.assistant, kind, { type: kind }, event.delta);
    } else if (event.type === 'tool-call') {
      await this.publish(this.assistant, `call:${event.toolCallId}`, { type: 'tool-call', toolCallId: event.toolCallId, toolName: event.toolName, input: event.args }, null);
    } else if (event.type === 'tool-result') {
      const output = event.success ? { type: 'text', value: event.result } : { type: 'error-text', value: event.error ?? event.result };
      await this.publish(this.tool, `result:${event.toolCallId}`, { type: 'tool-result', toolCallId: event.toolCallId, toolName: event.toolName, output }, null);
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

  /** Every container of the step seals before the next step's replace it:
   *  a step the model ended without a final message for a container it
   *  streamed into (a cancelled reasoning step) still commits what it holds. */
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

  private async publish(container: StreamContainer, key: string, descriptor: JsonObject, delta: string | null,
    providerMetadata?: ProviderMetadata, end = false): Promise<void> {
    const kind = v.parse(v.string(), descriptor.type);
    const part = this.reserve(container, key, kind);
    const joins = part.opened && !end && providerMetadata === undefined && (kind === 'text' || kind === 'reasoning');
    const text = this.window(part, delta, joins, end);

    if (text === null && providerMetadata === undefined && !end && part.opened) return;

    const callId = v.safeParse(v.string(), descriptor.toolCallId);
    const metadata = providerMetadata === undefined ? undefined : v.parse(JsonObjectSchema, projectJsonValue({ value: providerMetadata }));
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

  /** The text this update writes. A plain delta on an open text part joins
   *  the window and writes nothing until the window is full; anything else
   *  the part records — its end, its metadata — writes what the window holds
   *  first, in the same statement. A window ending in a high surrogate holds
   *  that unit back for the next one: the row takes the window as one UTF-8
   *  string, and half a pair has no encoding. */
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

  /** One transaction under the turn's epoch fence. */
  private fenced<T>(write: () => T): T {
    return this.history.atomic(() => {
      this.history.assertEpoch(this.turnId, this.epoch);

      return write();
    });
  }

  /** The container's message row, open. It joins the working context only
   *  when it seals: a context revision names immutable content, never a
   *  message a stream is still extending. */
  private openContainer(container: StreamContainer, write?: () => void): void {
    this.fenced(() => {
      container.reference = this.history.messages.open(container.role, container.id, container.working ? 'output' : 'render', { requestId: this.requestId, slot: this.nativeProducer ? container.slot : this.step * 3 + container.slot });
      write?.();
    });
  }

  /** ONE revision per sealed model-facing message: the seal and the
   *  membership land in the same transaction under the epoch fence. */
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
      const encoded = v.parse(v.array(JsonObjectSchema), JSON.parse(encodeModelMessages([message])))[0];

      if (encoded === undefined) throw new KinuError('io', 'missing final native message');
      const { role: _role, content, ...envelope } = encoded;
      const finalParts = v.parse(v.array(JsonObjectSchema), content);

      if (container.reference === null && finalParts.length === 0) continue;
      const opened = [...container.parts.values()].filter(part => part.opened).sort((a, b) => a.number - b.number);

      const parts: StoredPart[] = finalParts.map((native, index) => {
        const type = v.parse(v.string(), native.type);
        const prior = opened[index];

        if (prior !== undefined && prior.kind !== type) throw new KinuError('io', 'native final part order differs from its recorded stream');
        const callId = v.safeParse(v.string(), native.toolCallId);
        const call = type === 'tool-result' && callId.success ? this.calls.get(callId.output) : undefined;

        if (type === 'tool-call' && callId.success) this.calls.set(callId.output, { messageId: container.id, part: index });

        return { partNo: index, kind: type, streamOrder: prior?.streamOrder ?? this.sourceOrder++, replyTo: call === undefined ? null : { messageId: call.messageId, partNo: call.part }, value: native };
      });

      const sealed = await this.history.messages.prepareContent(parts);

      if (container.reference === null) this.openContainer(container);
      this.sealContainer(container, sealed, envelope);
      await this.history.messages.bindSource(message, { messageId: container.id });
    }

    this.completedMessageCount = cumulative.length;
  }

  /** A container the step did not seal from a final message seals from what
   *  its stream holds, buffered tail included: the render-only container
   *  every step, and every container of a step or turn that ended early. */
  private async sealOpen(container: StreamContainer): Promise<void> {
    if (container.reference === null || container.sealed) return;

    for (const part of container.parts.values()) {
      if (part.buffered.length === 0) continue;
      const window = part.buffered;
      part.buffered = '';
      part.bufferedDeltas = 0;
      part.bufferedBytes = 0;
      this.fenced(() => this.history.messages.streamAppend(container.id, part.number, window));
    }

    const parts = await this.history.messages.openParts(container.id);

    if (parts === null) {
      container.sealed = true;

      return;
    }

    this.sealContainer(container, await this.history.messages.prepareContent(parts));
  }

  /** The turn ended, however it ended: what streamed is sealed as it stands. */
  async settle(): Promise<void> {
    if (!this.history.epochCurrent(this.turnId, this.epoch)) return;

    for (const container of [this.assistant, this.tool, this.ui]) await this.sealOpen(container);
  }
}
