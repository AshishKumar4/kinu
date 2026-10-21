/**
 * A generate answered from the model's own stream, for a provider whose wire streams every call (the ChatGPT plan): the
 * one reading of its stream parts, whether the stack collects them under its silence bound or the model is called alone.
 */
import type {
  LanguageModelV4Content, LanguageModelV4GenerateResult, LanguageModelV4Reasoning, LanguageModelV4ResponseMetadata, LanguageModelV4StreamResult,
  LanguageModelV4StreamPart, LanguageModelV4Text, SharedV4Warning,
} from '@ai-sdk/provider';
import { APICallError, type LanguageModelMiddleware } from 'ai';
import { Effect } from 'effect';
import { settle } from '../../obs/index';

type Block = LanguageModelV4Text | LanguageModelV4Reasoning;

/** The stream read to its end: text and reasoning joined per block, other content as it came, usage and finish from the
 *  `finish` part. Its error part, or an end without a finish, is the call's failure. */
export function generateFromStream(answer: LanguageModelV4StreamResult): Promise<LanguageModelV4GenerateResult> {
  return settle(collected(answer));
}

function isBlock(entry: LanguageModelV4Content): entry is Block {
  return entry.type === 'text' || entry.type === 'reasoning';
}

/** The content so far, `part` added: a block's start opens one at its own place, its deltas grow it until its end, and
 *  every other content part is kept as it came. `open` is where each open block's id sits; a provider reuses an id once
 *  its block has ended (the OpenAI-compatible adapter's `txt-0` as text and reasoning alternate). */
function addContent(content: LanguageModelV4Content[], open: Map<string, number>, part: LanguageModelV4StreamPart): void {
  if (part.type === 'text-start' || part.type === 'reasoning-start') {
    open.set(part.id, content.length);
    content.push({ type: part.type === 'text-start' ? 'text' : 'reasoning', text: '', ...(part.providerMetadata !== undefined && { providerMetadata: part.providerMetadata }) });
  } else if (part.type === 'text-delta' || part.type === 'reasoning-delta') {
    const at = open.get(part.id);
    const block = at === undefined ? undefined : content[at];

    if (at !== undefined && block !== undefined && isBlock(block)) content[at] = { ...block, text: block.text + part.delta };
  } else if (part.type === 'text-end' || part.type === 'reasoning-end') open.delete(part.id);
  else if (part.type === 'tool-call' || part.type === 'tool-result' || part.type === 'file' || part.type === 'reasoning-file'
    || part.type === 'source' || part.type === 'custom' || part.type === 'tool-approval-request') content.push(part);
}

function collected(answer: LanguageModelV4StreamResult): Effect.Effect<LanguageModelV4GenerateResult> {
  return Effect.gen(function* () {
    const content: LanguageModelV4Content[] = [];
    const open = new Map<string, number>();
    const reader = answer.stream.getReader();
    let warnings: SharedV4Warning[] = [];
    let metadata: LanguageModelV4ResponseMetadata = {};

    for (let next = yield* Effect.promise(() => reader.read()); !next.done; next = yield* Effect.promise(() => reader.read())) {
      const part = next.value;

      if (part.type === 'error' || part.type === 'finish') yield* Effect.promise(() => reader.cancel());

      if (part.type === 'error') return yield* Effect.die(part.error);

      if (part.type === 'finish') {
        return {
          content, finishReason: part.finishReason, usage: part.usage, warnings,
          ...(part.providerMetadata !== undefined && { providerMetadata: part.providerMetadata }),
          ...(answer.request !== undefined && { request: answer.request }),
          response: { ...answer.response, ...metadata },
        };
      }

      if (part.type === 'stream-start') warnings = part.warnings;
      else if (part.type === 'response-metadata') metadata = { id: part.id, timestamp: part.timestamp, modelId: part.modelId };
      else addContent(content, open, part);
    }

    return yield* Effect.die(new APICallError({ message: 'the stream ended without its finish', url: 'stream', requestBodyValues: undefined, isRetryable: true }));
  });
}

/** A model whose generate is its stream collected. */
export const streamedGenerate: LanguageModelMiddleware = {
  specificationVersion: 'v4',
  wrapGenerate: async ({ doStream }) => generateFromStream(await doStream()),
};
