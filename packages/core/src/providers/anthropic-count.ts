/**
 * Anthropic's pre-request token count (`POST /v1/messages/count_tokens`), mirroring the SDK's converter.
 * An unrepresentable part reports `unsupported` rather than drop: an under-count is unsafe for admission.
 */

import type {
  AssistantModelMessage, FilePart, ImagePart, ToolResultPart, UserModelMessage,
} from 'ai';
import { asSchema, convertToBase64 } from '@ai-sdk/provider-utils';
import { Effect, Result } from 'effect';
import * as v from 'valibot';
import { settle } from '../obs/effect';
import type { CountableRequest, InputTokenCount } from './input-tokens';
import type { ProviderDeps } from './types';
import { createAuthedFetch } from './util';
import { JsonValueSchema, type JsonValue } from '../utils/json';
import { untagged } from '../utils/file-data';
import { toolDescription } from '../utils/tool-description';

/** The AI SDK Anthropic package's wire version, so raw POSTs (count, warm) share its API contract. */
export const ANTHROPIC_VERSION = '2023-06-01';

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

interface Unrepresentable { readonly reason: string }

type Converted<T> = Effect.Effect<T, Unrepresentable>;

const unrepresentable = (reason: string): Converted<never> => Effect.fail({ reason });

const CountResponseSchema = v.looseObject({ input_tokens: v.number() });

const ReasoningMetadataSchema = v.looseObject({
  anthropic: v.looseObject({
    signature: v.optional(v.string()),
    redactedData: v.optional(v.string()),
  }),
});

/** A count-body source, or null when not exactly representable (Anthropic needs a full media type beside base64; ai 7
 *  also takes a top-level one, `image`, and leaves the rest to the adapter). */
function countSource(tagged: FilePart['data'] | ImagePart['image'], spelled: string | undefined): Base64Source | UrlSource | null {
  const data = untagged(tagged);
  const mediaType = spelled?.includes('/') === true ? spelled : undefined;

  if (data === null) return null;

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

  // A bare string payload is already base64, as the wire request reads it.
  return { type: 'base64', media_type: mediaType, data };
}

function toolResultBlock(part: ToolResultPart): Converted<CountBlock> {
  const output = part.output;

  switch (output.type) {
    case 'text':
    case 'error-text':
      return Effect.succeed({ type: 'tool_result', tool_use_id: part.toolCallId, content: output.value });
    case 'content': {
      const blocks: CountBlock[] = [];

      for (const item of output.value) {
        if (item.type !== 'text') return unrepresentable(`a tool result content part of type "${item.type}"`);
        blocks.push({ type: 'text', text: item.text });
      }

      return Effect.succeed({ type: 'tool_result', tool_use_id: part.toolCallId, content: blocks });
    }

    // No default: a part type the SDK adds later must fail the build, not be miscounted.
    case 'json':
    case 'error-json':
    case 'execution-denied':
      return Effect.succeed({
        type: 'tool_result',
        tool_use_id: part.toolCallId,
        content: JSON.stringify('value' in output ? output.value : output) ?? '',
      });
  }
}

function userBlocks(content: UserModelMessage['content']): Converted<CountBlock[]> {
  if (!Array.isArray(content)) return Effect.succeed([{ type: 'text', text: content }]);
  const blocks: CountBlock[] = [];

  for (const part of content) {
    switch (part.type) {
      case 'text':
        blocks.push({ type: 'text', text: part.text });
        break;
      case 'image':
      case 'file': {
        // ai 7 spells an image as a file of an image media type, and the Anthropic adapter sends it as one.
        const image = part.type === 'image' || part.mediaType.split('/')[0] === 'image';
        const source = countSource(part.type === 'image' ? part.image : part.data, part.mediaType);

        if (!source) return unrepresentable(`${image ? 'an image' : 'a file'} part this count body cannot represent exactly`);
        blocks.push({ type: image ? 'image' : 'document', source });
        break;
      }
      // No default: a new SDK part type must fail the build rather than count as zero.
    }
  }

  return Effect.succeed(blocks);
}

function assistantBlocks(content: AssistantModelMessage['content']): Converted<CountBlock[]> {
  return Effect.gen(function* () {
    if (!Array.isArray(content)) return [{ type: 'text', text: content }];
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
          blocks.push(yield* toolResultBlock(part));
          break;
        }

        case 'file': {
          const source = countSource(part.data, part.mediaType);

          if (!source) return yield* unrepresentable('an assistant file part this count body cannot represent exactly');
          blocks.push({ type: 'document', source });
          break;
        }

        // A pending approval, or a part with no count block, is refused so the caller falls back rather than count a
        // body it did not send.
        case 'tool-approval-request':
        case 'custom':
        case 'reasoning-file':
          return yield* unrepresentable(`an assistant content part of type "${part.type}"`);
      }
    }

    return blocks;
  });
}

function toCountBody(modelId: string, request: CountableRequest): Converted<CountBody> {
  return Effect.gen(function* () {
    const messages: CountMessage[] = [];
    const systemParts = request.system ? [request.system] : [];

    for (const message of request.messages) {
      switch (message.role) {
        case 'system': {
          // Anthropic accepts only leading system messages; a later one is reported, not counted.
          if (messages.length > 0) return yield* unrepresentable('a system message after a conversation message');
          systemParts.push(message.content);
          break;
        }

        case 'user': {
          messages.push({ role: 'user', content: yield* userBlocks(message.content) });
          break;
        }

        case 'assistant': {
          messages.push({ role: 'assistant', content: yield* assistantBlocks(message.content) });
          break;
        }

        case 'tool': {
          const blocks: CountBlock[] = [];

          for (const part of message.content) {
            if (part.type !== 'tool-result') continue;
            blocks.push(yield* toolResultBlock(part));
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
        return yield* unrepresentable(`a provider-defined tool ("${name}") whose definition the count body cannot carry`);
      }

      const entry: NonNullable<CountBody['tools']>[number] = {
        name,
        input_schema: yield* Effect.promise(async () => asSchema(tool.inputSchema).jsonSchema),
      };

      const description = toolDescription(tool);

      if (description !== undefined) entry.description = description;
      tools.push(entry);
    }

    if (tools.length > 0) body.tools = tools;

    return body;
  });
}

/**
 * Count the assembled request through Anthropic's endpoint. Throws when it cannot answer;
 * `countRequestInputTokens` then reports the request uncounted.
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
  return settle(Effect.gen(function* () {
    const converted = yield* Effect.result(toCountBody(input.modelId, input.request));

    if (Result.isFailure(converted)) {
      return {
        kind: 'unsupported',
        provider: input.providerId,
        reason: `the request carries ${converted.failure.reason}, which the count endpoint's body cannot represent exactly`,
      };
    }

    const authedFetch = createAuthedFetch(input.deps, {
      provider: input.providerId,
      credKey: input.credKey,
      missingCredentialError: input.missingCredentialError,
    });

    const response = yield* Effect.promise(() => authedFetch(`${input.baseURL}/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify(converted.success),
    }));

    if (!response.ok) {
      return yield* Effect.die(new Error(`count_tokens answered ${response.status}: ${(yield* Effect.promise(() => response.text())).slice(0, 400)}`));
    }

    const parsed = v.parse(CountResponseSchema, yield* Effect.promise(() => response.json()));

    return { kind: 'counted', tokens: parsed.input_tokens };
  }));
}
