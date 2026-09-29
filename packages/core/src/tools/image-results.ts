/**
 * Images a tool hands the model. A tool output `{ output, images }` reaches the model as its text and one image
 * part per image (AI SDK v6 `image-data`), which Anthropic Messages and OpenAI Responses carry inside a tool
 * result. Chat Completions has no image in a tool message; `providers/tool-result-images.ts` names the omission.
 */
import type { ToolResultOutput } from '@ai-sdk/provider-utils';
import * as v from 'valibot';
import { isJsonObject, JsonValueSchema, type JsonValue } from '../utils/json';

export interface ToolImage {
  readonly mediaType: string;
  /** Base64. */
  readonly data: string;
}

const ToolImageSchema = v.object({ mediaType: v.string(), data: v.string() });

const ImageCarrierSchema = v.object({ output: JsonValueSchema, images: v.array(ToolImageSchema) });

export type ImageCarrier = v.InferOutput<typeof ImageCarrierSchema>;

const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+=*)$/u;

export interface TakenImages {
  /** The output with each image data URL replaced by `[image N]`. */
  readonly value: JsonValue;
  readonly images: readonly ToolImage[];
}

export function takeImages(value: JsonValue): TakenImages {
  const images: ToolImage[] = [];

  const walk = (node: JsonValue): JsonValue => {
    const text = v.safeParse(v.string(), node);

    if (text.success) {
      const match = IMAGE_DATA_URL.exec(text.output);

      if (match === null) return node;
      images.push({ mediaType: match[1], data: match[2] });

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
      ...carrier.output.images.map((image) => ({ type: 'image-data' as const, data: image.data, mediaType: image.mediaType })),
    ],
  };
}
