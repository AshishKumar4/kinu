/** A tool output carrying images: `{ output, images }`, the output as JSON and each image as base64. */
import * as v from 'valibot';
import { JsonValueSchema } from '../utils/json';

export interface ToolImage {
  readonly mediaType: string;
  /** Base64. */
  readonly data: string;
}

const ToolImageSchema = v.object({ mediaType: v.string(), data: v.string() });

export const ImageCarrierSchema = v.object({ output: JsonValueSchema, images: v.array(ToolImageSchema) });

export type ImageCarrier = v.InferOutput<typeof ImageCarrierSchema>;
