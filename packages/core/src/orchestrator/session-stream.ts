import type { ModelMessage, ProviderMetadata, TextStreamPart, ToolSet } from 'ai';
import * as v from 'valibot';
import type { ChatEvent } from '../chat';
import { SessionHistory } from './session-history';
import type { MessageReference } from './session-messages';
import { PreparedMessageUpdate } from './session-updates';
import { JsonObjectSchema, projectJsonValue, type JsonObject } from '../utils/json';
import { encodeModelMessages } from '../prompting/message-codec';
import { renderThrownChain, KinuError } from '../obs/index';

interface StreamPart {
  readonly number: number;
  readonly kind: string;
  opened: boolean;
  text: string;
  readonly streamOrder: number;
  ended: boolean;
  startMetadata: JsonObject | null;
}

interface StreamContainer {
  readonly id: string;
  readonly role: 'assistant' | 'tool';
  readonly slot: number;
  reference: MessageReference | null;
  readonly parts: Map<string, StreamPart>;
}

/** Provider metadata as the SDK types it: one JSON object per provider name. */
const ProviderMetadataSchema = v.record(v.string(), JsonObjectSchema);

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
        await this.publish(this.ui, 'step-start', { type: 'step-start' }, null, undefined, false, false);

        return;
      case 'source': {
        const source: JsonObject = part.sourceType === 'url'
          ? { type: 'source-url', sourceId: part.id, url: part.url }
          : { type: 'source-document', sourceId: part.id, mediaType: part.mediaType, title: part.title };

        if (part.title !== undefined) source.title = part.title;
        await this.publish(this.ui, `source:${part.id}`, source, null, part.providerMetadata, false, false);

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
    this.nextStep();
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
      this.nextStep();
    } else if (event.type === 'done') {
      await this.finishStep(event.responseMessages);
    }
  }


  private container(role: 'assistant' | 'tool', slot = role === 'assistant' ? 0 : 1): StreamContainer {
    return { id: `${this.requestId}:${this.nativeProducer ? slot : this.step * 3 + slot}`, role, slot, reference: null, parts: new Map() };
  }

  private nextStep(): void {
    this.step += 1;
    this.sourceOrder = 0;
    this.assistant = this.container('assistant');
    this.tool = this.container('tool');
    this.ui = this.container('assistant', 2);
  }

  private reserve(container: StreamContainer, key: string, kind: string): StreamPart {
    const existing = container.parts.get(key);

    if (existing !== undefined) return existing;
    const part: StreamPart = { number: container.parts.size, kind, streamOrder: this.sourceOrder++, opened: false, text: '', ended: false, startMetadata: null };
    container.parts.set(key, part);

    return part;
  }

  private async publish(container: StreamContainer, key: string, descriptor: JsonObject, delta: string | null,
    providerMetadata?: ProviderMetadata, end = false, working = true): Promise<void> {
    const kind = v.parse(v.string(), descriptor.type);
    const part = this.reserve(container, key, kind);
    const updates: PreparedMessageUpdate[] = [];
    const callId = v.safeParse(v.string(), descriptor.toolCallId);
    const reply = kind === 'tool-result' && callId.success ? this.calls.get(callId.output) ?? null : null;
    const native = { ...descriptor };

    if (!part.opened && part.startMetadata !== null) native.providerOptions = part.startMetadata;

    if (reply !== null) { delete native.toolCallId; delete native.toolName; }

    if (!part.opened) updates.push(await PreparedMessageUpdate.prepare({ part: part.number, operation: 'open', value: native }, this.history.messages.payloads));

    if (delta !== null) updates.push(await PreparedMessageUpdate.prepare({ part: part.number, operation: 'append', value: delta }, this.history.messages.payloads));

    if (providerMetadata !== undefined) updates.push(await PreparedMessageUpdate.prepare({ part: part.number, operation: 'metadata', value: { providerOptions: projectJsonValue({ value: providerMetadata }) } }, this.history.messages.payloads));

    if (end) updates.push(await PreparedMessageUpdate.prepare({ part: part.number, operation: 'content-end' }, this.history.messages.payloads));
    const empty = container.reference === null ? await this.history.messages.prepareParts(container.role, [], {}, container.id) : null;
    const selected = this.history.context.selected();

    if (selected === null) throw new KinuError('missing', 'stream has no selected context');
    this.history.context.commit(selected, 'output', this.turnId, entries => {
      let reference = container.reference;

      if (reference === null && empty !== null) reference = this.history.messages.insert(empty, working ? 'output' : 'render', { requestId: this.requestId, slot: this.nativeProducer ? container.slot : this.step * 3 + container.slot });

      if (reference === null) throw new KinuError('io', 'stream container was not prepared');
      reference = part.opened
        ? this.history.messages.append(reference.messageId, reference.sequence, updates)
        : this.history.messages.addPart(reference, { number: part.number, kind, reply, streamOrder: part.streamOrder }, updates);
      container.reference = reference;

      if (!working) return entries;
      const existing = entries.find(entry => entry.messageId === container.id);

      return existing === undefined
        ? [...entries, { ...reference, entryId: container.id, position: entries.length }]
        : entries.map(entry => entry.messageId === container.id ? { ...entry, ...reference } : entry);
    }, () => this.history.assertEpoch(this.turnId, this.epoch));
    part.opened = true;

    if (end) part.ended = true;

    if (delta !== null) part.text += delta;

    if (kind === 'tool-call' && callId.success) this.calls.set(callId.output, { messageId: container.id, part: part.number });
  }

  private async finishStep(cumulative: readonly ModelMessage[]): Promise<void> {
    if (cumulative.length === 0) return;
    const produced = cumulative.slice(this.completedMessageCount);

    for (const message of produced) {
      if (message.role !== 'assistant' && message.role !== 'tool') throw new KinuError('bad_input', 'a model response contains an input role');
      const container = message.role === 'assistant' ? this.assistant : this.tool;
      const encoded = v.parse(v.array(JsonObjectSchema), JSON.parse(encodeModelMessages([message])))[0];

      if (encoded === undefined) throw new KinuError('io', 'missing final native message');
      const finalParts = v.parse(v.array(JsonObjectSchema), encoded.content);
      const opened = [...container.parts.entries()].filter(([, part]) => part.opened).sort((a, b) => a[1].number - b[1].number);
      const recorded = new Map((container.reference === null ? [] : await this.history.messages.materializeParts(container.reference)).map(part => [part.partNo, part.value]));

      for (const [index, native] of finalParts.entries()) {
        const type = v.parse(v.string(), native.type);
        const prior = opened[index];
        const key = prior?.[0] ?? `final:${index}`;

        if (prior === undefined) {
          const { text, providerOptions, ...descriptor } = native;
          await this.publish(container, key, descriptor, v.is(v.string(), text) ? text : null, providerOptions === undefined ? undefined : v.parse(ProviderMetadataSchema, providerOptions));
          continue;
        }

        if (prior[1].kind !== type) throw new KinuError('io', 'native final part order differs from its recorded stream');
        const updates: PreparedMessageUpdate[] = [];
        const part = prior[1];

        if (v.is(v.string(), native.text) && native.text !== part.text) {
          const operation = !part.ended && native.text.startsWith(part.text) ? 'append' : 'replace-content';
          const value = operation === 'append' ? native.text.slice(part.text.length) : native.text;
          updates.push(await PreparedMessageUpdate.prepare({ part: part.number, operation, value }, this.history.messages.payloads));
        }

        const previous = recorded.get(part.number);

        if (native.output !== undefined && JSON.stringify(previous?.output) !== JSON.stringify(native.output)) updates.push(await PreparedMessageUpdate.prepare({ part: part.number, operation: 'replace-content', value: { output: native.output } }, this.history.messages.payloads));

        if (JSON.stringify(previous?.providerOptions) !== JSON.stringify(native.providerOptions)) {
          const metadata: JsonObject = {};

          if (native.providerOptions !== undefined) metadata.providerOptions = native.providerOptions;
          updates.push(await PreparedMessageUpdate.prepare({ part: part.number, operation: 'metadata', value: metadata }, this.history.messages.payloads));
        }

        if (updates.length === 0) continue;
        const selected = this.history.context.selected();

        if (selected === null || container.reference === null) throw new KinuError('missing', 'final response lost its working selection');
        const current = container.reference;
        this.history.context.commit(selected, 'output', this.turnId, entries => {
          const reference = this.history.messages.append(container.id, current.sequence, updates);
          container.reference = reference;

          return entries.map(entry => entry.messageId === container.id ? { ...entry, ...reference } : entry);
        }, () => this.history.assertEpoch(this.turnId, this.epoch));
      }

      if (container.reference !== null) {
        const selected = this.history.context.selected();

        if (selected === null) throw new KinuError('missing', 'final response has no selected context');
        const sealed = container.reference;
        this.history.context.commit(selected, 'output', this.turnId, entries => {
          this.history.messages.seal(sealed);

          return entries;
        }, () => this.history.assertEpoch(this.turnId, this.epoch));
        await this.history.messages.bindSource(message, container.reference);
      }
    }

    this.completedMessageCount = cumulative.length;
  }
}
