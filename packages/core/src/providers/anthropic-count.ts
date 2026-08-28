/**
 * Anthropic's pre-request token count — the one active provider that publishes
 * one (`POST /v1/messages/count_tokens`, the same structured input the Messages
 * API takes, answering `{ "input_tokens": N }`).
 *
 * Anthropic's own documentation calls the result an estimate that "might differ
 * by a small amount" from what creating the message bills, and says counts may
 * include tokens Anthropic adds for system optimisations. That is still the
 * provider's own tokenizer over the provider's own structured input, which is
 * the most authoritative answer obtainable BEFORE submission — and it is a
 * different kind of number from a character heuristic, which knows nothing
 * about the tokenizer at all.
 *
 * The conversion below is this module's own, because the AI SDK's Anthropic
 * package does not export its message converter. It mirrors that converter's
 * decisions where they change what is counted, and the mirroring is deliberate
 * rather than incidental:
 *
 *  • unsigned reasoning parts are DROPPED, exactly as the real request drops
 *    them (the vendor emits a `thinking` block only when the part carries an
 *    anthropic signature, and a `redacted_thinking` block for redacted data) —
 *    counting text the request will not send would over-report;
 *  • tool results ride a USER message, as Anthropic requires;
 *  • a part this cannot represent is never dropped silently: the count comes
 *    back `unsupported` naming it, because a dropped part under-reports by its
 *    whole cost and an under-report is the one error admission cannot survive.
 */

import type {
  AssistantModelMessage, DataContent, ToolResultPart, UserModelMessage,
} from 'ai';
import { asSchema, convertToBase64 } from '@ai-sdk/provider-utils';
import * as v from 'valibot';
import type { CountableRequest, InputTokenCount } from './input-tokens';
import type { ProviderDeps } from './types';
import { createAuthedFetch } from './util';
import { JsonValueSchema, type JsonValue } from '../utils/json';

/** The wire version the AI SDK's Anthropic package sends, so the count is taken
 *  under the same API contract as the request it is about. */
const ANTHROPIC_VERSION = '2023-06-01';

interface Base64Source { type: 'base64'; media_type: string; data: string }
interface UrlSource { type: 'url'; url: string }
interface TextSource { type: 'text'; media_type: 'text/plain'; data: string }

type CountBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: Base64Source | UrlSource }
  | { type: 'document'; source: Base64Source | UrlSource | TextSource }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: JsonValue }
  | { type: 'tool_result'; tool_use_id: string; content: string | CountBlock[] };

interface CountMessage { role: 'user' | 'assistant'; content: CountBlock[] }

interface CountBody {
  model: string;
  system?: string;
  messages: CountMessage[];
  tools?: Array<{ name: string; description?: string; input_schema: unknown }>;
}

/**
 * Either a converted piece of the count body, or the reason no exact count of
 * this request exists.
 *
 * One shape for every step of the conversion, and a DISCRIMINATED one: the
 * failure reason used to ride back as a bare string, which made the callers
 * read a representation (`typeof x === 'string'`) where they needed a
 * contract — and a tool result whose content legitimately IS a string would
 * have been read as a failure.
 */
type Converted<T> = { ok: true; value: T } | { ok: false; reason: string };

const CountResponseSchema = v.looseObject({ input_tokens: v.number() });

/** The anthropic namespace of a part's provider options, as the reasoning
 *  branch reads it — the same two fields the vendor's converter reads. */
const ReasoningMetadataSchema = v.looseObject({
  anthropic: v.looseObject({
    signature: v.optional(v.string()),
    redactedData: v.optional(v.string()),
  }),
});

/** An `image`/`file` part as a count-body source, or null when the part cannot
 *  be represented exactly: Anthropic requires a media type beside base64 data,
 *  and a data URL whose payload is percent-encoded rather than base64 would
 *  have to be re-encoded here to say anything true about it. */
function countSource(data: DataContent | URL, mediaType: string | undefined): Base64Source | UrlSource | null {
  // `DataContent | URL` is a typed union, so it is discriminated by what each
  // member IS — a URL, a byte buffer, or the string payload that remains.
  if (data instanceof URL) return { type: 'url', url: data.toString() };
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
    if (!mediaType) return null;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return { type: 'base64', media_type: mediaType, data: convertToBase64(bytes) };
  }
  const dataUrl = /^data:([^;,]+);base64,/.exec(data);
  if (dataUrl?.[1]) {
    return { type: 'base64', media_type: dataUrl[1], data: data.slice(dataUrl[0].length) };
  }
  if (data.startsWith('data:')) return null;
  if (URL.canParse(data) && !mediaType) return { type: 'url', url: data };
  if (!mediaType) return null;
  // A bare string payload is base64 already — `convertToBase64` returns a
  // string unchanged, and this is the same reading the wire request takes.
  return { type: 'base64', media_type: mediaType, data };
}

function toolResultBlock(part: ToolResultPart): Converted<CountBlock> {
  const output = part.output;
  switch (output.type) {
    case 'text':
    case 'error-text':
      return { ok: true, value: { type: 'tool_result', tool_use_id: part.toolCallId, content: output.value } };
    case 'content': {
      const blocks: CountBlock[] = [];
      for (const item of output.value) {
        if (item.type !== 'text') return { ok: false, reason: `a tool result content part of type "${item.type}"` };
        blocks.push({ type: 'text', text: item.text });
      }
      return { ok: true, value: { type: 'tool_result', tool_use_id: part.toolCallId, content: blocks } };
    }
    default:
      // `json`, `error-json`, `execution-denied` and anything the SDK adds
      // later: the vendor serialises the value, and so does the wire.
      return {
        ok: true,
        value: {
          type: 'tool_result',
          tool_use_id: part.toolCallId,
          content: JSON.stringify('value' in output ? output.value : output) ?? '',
        },
      };
  }
}

function userBlocks(content: UserModelMessage['content']): Converted<CountBlock[]> {
  // A user message's content is a string or an array of parts. Discriminated on
  // the array, which is the shape the loop below needs anyway.
  if (!Array.isArray(content)) return { ok: true, value: [{ type: 'text', text: content }] };
  const blocks: CountBlock[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        blocks.push({ type: 'text', text: part.text });
        break;
      case 'image': {
        const source = countSource(part.image, part.mediaType);
        if (!source) return { ok: false, reason: 'an image part this count body cannot represent exactly' };
        blocks.push({ type: 'image', source });
        break;
      }
      case 'file': {
        const source = countSource(part.data, part.mediaType);
        if (!source) return { ok: false, reason: 'a file part this count body cannot represent exactly' };
        blocks.push({ type: 'document', source });
        break;
      }
      // No default: the user content union is text/image/file, and a part the
      // SDK adds later must fail the build here rather than be counted as zero.
    }
  }
  return { ok: true, value: blocks };
}

function assistantBlocks(content: AssistantModelMessage['content']): Converted<CountBlock[]> {
  if (!Array.isArray(content)) return { ok: true, value: [{ type: 'text', text: content }] };
  const blocks: CountBlock[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        blocks.push({ type: 'text', text: part.text });
        break;
      case 'reasoning': {
        const parsed = v.safeParse(ReasoningMetadataSchema, part.providerOptions);
        const meta = parsed.success ? parsed.output.anthropic : undefined;
        if (meta?.signature !== undefined) {
          blocks.push({ type: 'thinking', thinking: part.text, signature: meta.signature });
        } else if (meta?.redactedData !== undefined) {
          blocks.push({ type: 'redacted_thinking', data: meta.redactedData });
        }
        break;
      }
      case 'tool-call': {
        const parsed = v.safeParse(JsonValueSchema, part.input);
        blocks.push({
          type: 'tool_use',
          id: part.toolCallId,
          name: part.toolName,
          input: parsed.success ? parsed.output : null,
        });
        break;
      }
      case 'tool-result': {
        const block = toolResultBlock(part);
        if (!block.ok) return block;
        blocks.push(block.value);
        break;
      }
      case 'file': {
        const source = countSource(part.data, part.mediaType);
        if (!source) return { ok: false, reason: 'an assistant file part this count body cannot represent exactly' };
        blocks.push({ type: 'document', source });
        break;
      }
      default:
        return { ok: false, reason: `an assistant content part of type "${part.type}"` };
    }
  }
  return { ok: true, value: blocks };
}

async function toCountBody(modelId: string, request: CountableRequest): Promise<Converted<CountBody>> {
  const messages: CountMessage[] = [];
  const systemParts = request.system ? [request.system] : [];

  for (const message of request.messages) {
    switch (message.role) {
      case 'system': {
        // Anthropic takes the system prompt out of band. The vendor collects
        // LEADING system messages and refuses one that follows a conversation
        // message, so a request holding that is a request the provider itself
        // will not accept — reported rather than counted.
        if (messages.length > 0) return { ok: false, reason: 'a system message after a conversation message' };
        systemParts.push(message.content);
        break;
      }
      case 'user': {
        const blocks = userBlocks(message.content);
        if (!blocks.ok) return blocks;
        messages.push({ role: 'user', content: blocks.value });
        break;
      }
      case 'assistant': {
        const blocks = assistantBlocks(message.content);
        if (!blocks.ok) return blocks;
        messages.push({ role: 'assistant', content: blocks.value });
        break;
      }
      case 'tool': {
        const blocks: CountBlock[] = [];
        for (const part of message.content) {
          if (part.type !== 'tool-result') continue;
          const block = toolResultBlock(part);
          if (!block.ok) return block;
          blocks.push(block.value);
        }
        messages.push({ role: 'user', content: blocks });
        break;
      }
    }
  }

  const body: CountBody = { model: modelId, messages };
  if (systemParts.length > 0) body.system = systemParts.join('\n\n');

  const tools: NonNullable<CountBody['tools']> = [];
  for (const [name, tool] of Object.entries(request.tools ?? {})) {
    if (tool === undefined) continue;
    if (tool.type === 'provider') {
      return { ok: false, reason: `a provider-defined tool ("${name}") whose definition the count body cannot carry` };
    }
    const entry: NonNullable<CountBody['tools']>[number] = {
      name,
      input_schema: await asSchema(tool.inputSchema).jsonSchema,
    };
    if (tool.description !== undefined) entry.description = tool.description;
    tools.push(entry);
  }
  if (tools.length > 0) body.tools = tools;

  return { ok: true, value: body };
}

/**
 * Count the assembled request through Anthropic's own endpoint.
 *
 * Throws when the endpoint cannot answer (no credential, transport failure, a
 * body it refuses): `countRequestInputTokens` records that and reports the
 * request as uncounted, because a preflight must not become a new way for the
 * turn to fail.
 */
export async function countAnthropicInputTokens(input: {
  modelId: string;
  deps: ProviderDeps;
  request: CountableRequest;
  providerId: string;
  baseURL: string;
  credKey: string;
  missingCredentialError: string;
}): Promise<InputTokenCount> {
  const converted = await toCountBody(input.modelId, input.request);
  if (!converted.ok) {
    return {
      kind: 'unsupported',
      provider: input.providerId,
      reason: `the request carries ${converted.reason}, which the count endpoint's body cannot represent exactly`,
    };
  }

  const authedFetch = createAuthedFetch(input.deps, {
    credKey: input.credKey,
    missingCredentialError: input.missingCredentialError,
  });
  const response = await authedFetch(`${input.baseURL}/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION },
    body: JSON.stringify(converted.value),
  });
  if (!response.ok) {
    throw new Error(`count_tokens answered ${response.status}: ${(await response.text()).slice(0, 400)}`);
  }
  const parsed = v.parse(CountResponseSchema, await response.json());
  return { kind: 'counted', tokens: parsed.input_tokens };
}
