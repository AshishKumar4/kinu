import type { ModelMessage, ProviderMetadata, TextStreamPart, ToolSet } from 'ai';
import * as v from 'valibot';
import type { ChatEvent } from '../chat';
import { SessionHistory } from '../session/history';
import type { MessageReference } from '../session/messages';
import { PreparedMessageUpdate } from '../session/updates';
import { JsonObjectSchema, projectJsonValue, type JsonObject } from '../utils/json';
import { encodeModelMessages } from '../session/message-codec';
import { renderThrownChain, KinuError } from '../obs/index';

interface StreamPart {
  readonly number: number;
  readonly kind: string;
  opened: boolean;
  /** The text durable so far: what the rows hold. */
  text: string;
  /** Deltas taken in but not yet written, and how many: one row per window
   *  (`COALESCE_DELTAS` or `COALESCE_BYTES`), not per token. Written ahead
   *  of the part's next non-delta update, or by the step's final text. */
  buffered: string;
  bufferedDeltas: number;
  readonly streamOrder: number;
  ended: boolean;
  startMetadata: JsonObject | null;
}

/** A streamed part's deltas reach the rows in windows. Each row is a
 *  statement on the Durable Object's storage; a reasoning model streams
 *  tokens by the ten-thousand, and one statement per token was the CPU the
 *  eval objects spent inside one turn (D23). A window is small enough that a
 *  cut turn keeps all but its last second of words. */
const COALESCE_DELTAS = 64;

const COALESCE_BYTES = 4096;

interface StreamContainer {
  readonly id: string;
  readonly role: 'assistant' | 'tool';
  readonly slot: number;
  reference: MessageReference | null;
  readonly parts: Map<string, StreamPart>;
}

/** One write against one part: which container holds it, the part's stable key
 *  within that container, the native descriptor and the content this write
 *  carries. `delta` is null for a write that is a start, an end or a metadata
 *  stamp rather than content. */
interface PartPublication {
  readonly container: StreamContainer;
  readonly key: string;
  readonly descriptor: JsonObject;
  readonly delta: string | null;
  readonly providerMetadata?: ProviderMetadata;
  /** This write finishes the part. */
  readonly end?: boolean;
  /** The row belongs in the model's context. False for the UI-only frames
   *  (step boundaries, sources), which are recorded but never sent back. */
  readonly working?: boolean;
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
        await this.publish({ container: this.ui, key: 'step-start', descriptor: { type: 'step-start' }, delta: null, working: false });

        return;
      case 'source': {
        const source: JsonObject = part.sourceType === 'url'
          ? { type: 'source-url', sourceId: part.id, url: part.url }
          : { type: 'source-document', sourceId: part.id, mediaType: part.mediaType, title: part.title };

        if (part.title !== undefined) source.title = part.title;
        await this.publish({ container: this.ui, key: `source:${part.id}`, descriptor: source, delta: null, providerMetadata: part.providerMetadata, working: false });

        return;
      }

      case 'text-start': {
        const pending = this.reserve(this.assistant, `text:${part.id}`, 'text');

        if (part.providerMetadata !== undefined) pending.startMetadata = v.parse(JsonObjectSchema, projectJsonValue({ value: part.providerMetadata }));

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
        let output: JsonObject;

        if (part.type === 'tool-error') {
          output = { type: 'error-text', value: renderThrownChain({ cause: part.error }) };
        } else if (v.is(v.string(), part.output)) {
          output = { type: 'text', value: part.output };
        } else {
          output = { type: 'json', value: projectJsonValue({ value: part.output }) };
        }

        await this.publish({
          container: part.providerExecuted ? this.assistant : this.tool, key: `result:${part.toolCallId}`,
          descriptor: { type: 'tool-result', toolCallId: part.toolCallId, toolName: part.toolName, output },
          delta: null, providerMetadata: part.providerMetadata,
        });

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

      // Lifecycle evidence and the input-streaming frames are not
      // model-message parts.
      case 'abort':
      case 'error':
      case 'finish':
      case 'finish-step':
      case 'raw':
      case 'start':
      case 'tool-input-delta':
      case 'tool-input-end':
      case 'tool-input-start':
      case 'tool-output-denied':
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
      await this.publish({ container: this.assistant, key: kind, descriptor: { type: kind }, delta: event.delta });
    } else if (event.type === 'tool-call') {
      await this.publish({ container: this.assistant, key: `call:${event.toolCallId}`, descriptor: { type: 'tool-call', toolCallId: event.toolCallId, toolName: event.toolName, input: event.args }, delta: null });
    } else if (event.type === 'tool-result') {
      const output = event.success ? { type: 'text', value: event.result } : { type: 'error-text', value: event.error ?? event.result };
      await this.publish({ container: this.tool, key: `result:${event.toolCallId}`, descriptor: { type: 'tool-result', toolCallId: event.toolCallId, toolName: event.toolName, output }, delta: null });
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
    const part: StreamPart = { number: container.parts.size, kind, streamOrder: this.sourceOrder++, opened: false, text: '', buffered: '', bufferedDeltas: 0, ended: false, startMetadata: null };
    container.parts.set(key, part);

    return part;
  }

  private async publish(publication: PartPublication): Promise<void> {
    const { container, key, descriptor, providerMetadata } = publication;
    const end = publication.end ?? false;
    const working = publication.working ?? true;
    const kind = v.parse(v.string(), descriptor.type);
    const part = this.reserve(container, key, kind);
    let delta = publication.delta;

    // A plain delta on an open text part joins the window; the window is
    // written when full. Anything else the part records — its end, its
    // metadata — writes what the window holds first, in the same statement.
    if (delta !== null && part.opened && !end && providerMetadata === undefined && (kind === 'text' || kind === 'reasoning')) {
      part.buffered += delta;
      part.bufferedDeltas += 1;

      if (part.bufferedDeltas < COALESCE_DELTAS && part.buffered.length < COALESCE_BYTES) return;
      delta = null;
    }

    if (part.buffered.length > 0) {
      delta = part.buffered + (delta ?? '');
      part.buffered = '';
      part.bufferedDeltas = 0;
    }

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

    const current = container.reference;

    const write = (reference: MessageReference): MessageReference => part.opened
      ? this.history.messages.append(reference.messageId, reference.sequence, updates)
      : this.history.messages.addPart(reference, { number: part.number, kind, reply, streamOrder: part.streamOrder }, updates);

    if (current !== null) {
      // The message is already in the context: a delta extends it under the
      // same fence and moves no membership. Minting a revision per delta made
      // a streamed answer cost deltas times context entries in row traffic
      // (measured 2026-09-21: 2,002 revisions for one 2,000-delta answer) and
      // was what the eval objects spent `do.cpu_ms_per_invocation` on (D23).
      container.reference = this.history.extendOutput(this.turnId, this.epoch, () => write(current));
    } else {
      const empty = await this.history.messages.prepareParts(container.role, [], {}, container.id);
      const selected = this.history.context.selected();

      if (selected === null) throw new KinuError('missing', 'stream has no selected context');
      this.history.context.commit(selected, 'output', this.turnId, entries => {
        const reference = write(this.history.messages.insert(empty, working ? 'output' : 'render', { requestId: this.requestId, slot: this.nativeProducer ? container.slot : this.step * 3 + container.slot }));
        container.reference = reference;

        if (!working) return entries;
        const existing = entries.find(entry => entry.messageId === container.id);

        return existing === undefined
          ? [...entries, { ...reference, entryId: container.id, position: entries.length }]
          : entries.map(entry => entry.messageId === container.id ? { ...entry, ...reference } : entry);
      }, () => this.history.assertEpoch(this.turnId, this.epoch));
    }

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
          await this.publish({ container, key, descriptor, delta: v.is(v.string(), text) ? text : null,
            providerMetadata: providerOptions === undefined ? undefined : v.parse(ProviderMetadataSchema, providerOptions) });
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

        if (container.reference === null) throw new KinuError('missing', 'final response lost its working selection');
        const current = container.reference;
        container.reference = this.history.extendOutput(this.turnId, this.epoch, () => this.history.messages.append(container.id, current.sequence, updates));
      }

      if (container.reference !== null) {
        const selected = this.history.context.selected();

        if (selected === null) throw new KinuError('missing', 'final response has no selected context');
        const sealed = container.reference;
        // ONE revision per finished step: the cutoff the context holds for
        // this message moves from the sequence it joined at to its final one.
        this.history.context.commit(selected, 'output', this.turnId, entries => {
          this.history.messages.seal(sealed);

          return entries.map(entry => entry.messageId === container.id ? { ...entry, ...sealed } : entry);
        }, () => this.history.assertEpoch(this.turnId, this.epoch));
        await this.history.messages.bindSource(message, container.reference);
      }
    }

    this.completedMessageCount = cumulative.length;
  }
}
