/**
 * Images a tool hands the model. A native tool's carrier ({@link imageCarrier}), an eval's with its `failures` beside
 * it, reaches the model as its text and one `file` part per image, which Anthropic Messages and
 * OpenAI Responses carry inside a tool result; `providers/tool-result-images.ts` carries them on Chat Completions.
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

/** Held by a native tool's carrier alone: application data that names `output` and `images` is not one, and keeps every
 *  field. */
const IMAGE_CARRIER = 'kinu/images';

const ImageCarrierSchema = v.object({ type: v.literal(IMAGE_CARRIER), output: JsonValueSchema, images: v.array(ToolImageSchema) });

export type ImageCarrier = v.InferOutput<typeof ImageCarrierSchema>;

export function imageCarrier(output: JsonValue, images: readonly ToolImage[]): ImageCarrier {
  return { type: IMAGE_CARRIER, output, images: [...images] };
}

const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+=*)$/u;

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
      ...carrier.output.images.map((image) => ({ type: 'file' as const, data: { type: 'data' as const, data: image.data }, mediaType: image.mediaType })),
    ],
  };
}
