/**
 * Images a tool hands the model. A native tool's carrier (`types/tool-images.ts` imageCarrier), an eval's with its `failures` beside
 * it, reaches the model as its text and one `file` part per image, which Anthropic Messages and
 * OpenAI Responses carry inside a tool result; `providers/tool-result-images.ts` carries them on Chat Completions.
 */
import type { ToolResultOutput } from '@ai-sdk/provider-utils';
import * as v from 'valibot';
import { isJsonObject, JsonValueSchema, type JsonValue } from '../utils/json';
import { ImageCarrierSchema, type ToolImage } from '../types/tool-images';
import { imageDataUrl } from '../utils/data-url';

export interface TakenImages {
  /** Images become `[image N]`; a nested carrier becomes its own output. */
  readonly value: JsonValue;
  readonly images: readonly ToolImage[];
}

export function takeImages(value: JsonValue): TakenImages {
  const images: ToolImage[] = [];

  const walk = (node: JsonValue): JsonValue => {
    // A native tool's carrier nested in a program's result.
    const carrier = v.safeParse(ImageCarrierSchema, node);

    if (carrier.success) {
      images.push(...carrier.output.images);

      return walk(carrier.output.output);
    }

    const text = v.safeParse(v.string(), node);

    if (text.success) {
      const image = imageDataUrl(text.output);

      if (image === null) return node;
      images.push(image);

      return `[image ${images.length}]`;
    }

    if (Array.isArray(node)) return node.map(walk);

    if (node === null || !isJsonObject(node)) return node;

    return Object.fromEntries(Object.entries(node).map(([key, member]) => [key, walk(member)]));
  };

  const taken = walk(value);

  return { value: images.length === 0 ? value : taken, images };
}

/** The `toModelOutput` of a tool whose output may be an {@link ImageCarrier}; anything else as the SDK sends it. */
export function imageModelOutput({ output }: { readonly output: unknown }): ToolResultOutput {
  const carrier = v.safeParse(ImageCarrierSchema, output);

  if (!carrier.success) {
    const text = v.safeParse(v.string(), output);
    const json = v.safeParse(JsonValueSchema, output ?? null);

    return text.success ? { type: 'text', value: text.output } : { type: 'json', value: json.success ? json.output : null };
  }

  const inner = v.safeParse(v.string(), carrier.output.output);
  const text = inner.success ? inner.output : JSON.stringify(carrier.output.output);

  return {
    type: 'content',
    value: [
      { type: 'text', text },
      ...carrier.output.images.map((image) => ({ type: 'file' as const, data: { type: 'data' as const, data: image.data }, mediaType: image.mediaType })),
    ],
  };
}
