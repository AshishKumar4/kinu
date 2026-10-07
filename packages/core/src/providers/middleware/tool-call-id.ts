/** Tool-call ids keyed to the response that minted them (`tool-call-id.ts`): native and positional ids repeat across a turn's responses. */
import type { LanguageModelV4Content, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { generateId, type LanguageModelMiddleware } from 'ai';
import { toolCallIdFor } from '../tool-call-id';

type Rekey = (id: string) => string;

export function toolCallIdMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: 'v4',
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      const rekey = responseKeys();

      return { ...result, content: result.content.map((part) => rekeyedContent(part, rekey)) };
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      const rekey = responseKeys();

      const rekeying = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(part, controller) {
          controller.enqueue(rekeyedPart(part, rekey));
        },
      });

      return { ...result, stream: result.stream.pipeThrough(rekeying) };
    },
  };
}

/** One scope per response; a call's input deltas and its result keep the key its first part got. */
function responseKeys(): Rekey {
  const scope = `call-${generateId()}`;
  const keys = new Map<string, string>();

  return (id) => {
    const known = keys.get(id);

    if (known !== undefined) return known;
    const key = toolCallIdFor({ scope, native: id, index: keys.size });
    keys.set(id, key);

    return key;
  };
}

function rekeyedPart(part: LanguageModelV4StreamPart, rekey: Rekey): LanguageModelV4StreamPart {
  if (part.type === 'tool-input-start' || part.type === 'tool-input-delta' || part.type === 'tool-input-end') {
    return { ...part, id: rekey(part.id) };
  }

  return part.type === 'tool-call' || part.type === 'tool-result' || part.type === 'tool-approval-request'
    ? { ...part, toolCallId: rekey(part.toolCallId) }
    : part;
}

function rekeyedContent(part: LanguageModelV4Content, rekey: Rekey): LanguageModelV4Content {
  return part.type === 'tool-call' || part.type === 'tool-result' || part.type === 'tool-approval-request'
    ? { ...part, toolCallId: rekey(part.toolCallId) }
    : part;
}
