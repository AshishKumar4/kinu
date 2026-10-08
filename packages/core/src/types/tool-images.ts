/** A native tool's output carrying images: its output as JSON and each image as base64. */
import * as v from 'valibot';
import { JsonValueSchema, type JsonValue } from '../utils/json';

export interface ToolImage {
  readonly mediaType: string;
  /** Base64. */
  readonly data: string;
}

const ToolImageSchema = v.object({ mediaType: v.string(), data: v.string() });

/** Held by a native tool's carrier alone: application data that names `output` and `images` is not one, and keeps every
 *  field. */
const IMAGE_CARRIER = 'kinu/images';

export const ImageCarrierSchema = v.object({ type: v.literal(IMAGE_CARRIER), output: JsonValueSchema, images: v.array(ToolImageSchema) });

export type ImageCarrier = v.InferOutput<typeof ImageCarrierSchema>;

export function imageCarrier(output: JsonValue, images: readonly ToolImage[]): ImageCarrier {
  return { type: IMAGE_CARRIER, output, images: [...images] };
}
