/**
 * The images a stored chat part carries, in one order: the chat is drawn with each image named by its place in that
 * order, and the media read finds it by the same walk. Bytes never ride a history read: a long computer-use turn held
 * hundreds of screenshots, inline, in one message (70 MB on staging, 2026-10-19), past every RPC and frame limit.
 */
import * as v from 'valibot';
import { isJsonObject, type JsonObject, type JsonValue } from '../utils/json';
import { imageDataUrl, readDataUrl } from '../utils/data-url';

/** A stored image: its media type and its bytes, base64. */
export interface StoredImage {
  readonly mediaType: string;
  readonly data: string;
}

/** Where an image is kept: the stored message part that carries it, and its place among that part's images. */
export interface MediaRef {
  readonly messageId: string;
  readonly partNo: number;
  readonly index: number;
}

/** The address a client fetches an image from, minted by the host that serves it. */
export type MediaUrl = (ref: MediaRef) => string;

/** For a reader that serves no image: each named by where it is kept, which nothing fetches. */
export const keptMediaName: MediaUrl = (ref) => `kinu-media:${ref.messageId}/${String(ref.partNo)}/${String(ref.index)}`;

const InlineImageSchema = v.object({ mediaType: v.string(), data: v.string() });

/** A native tool's carrier, as `types/tool-images.ts` writes it. */
const CarrierSchema = v.object({ type: v.literal('kinu/images'), output: v.unknown(), images: v.array(InlineImageSchema) });

/** An image in a tool result the model was handed (`imageModelOutput`): `{ type: 'file', data: { type: 'data' } }`. */
const ModelFileSchema = v.object({ type: v.literal('file'), mediaType: v.string(), data: v.object({ type: v.literal('data'), data: v.string() }) });

/** `walk`'s visitor: an image in, the address that stands in its place out. */
type Visit = (image: StoredImage, index: number) => string;

/** `value` with each image it carries replaced by the address `visit` gives for it, visited in the one order: a data URL
 *  by the address, a carrier's image by `{ mediaType, url }`, a model file part by one with a `url` for its data. */
export function walkImages(value: JsonValue, visit: Visit): JsonValue {
  let index = 0;

  const take = (image: StoredImage): string => visit(image, index++);

  const walk = (node: JsonValue): JsonValue => {
    if (typeof node === 'string') {
      const image = imageDataUrl(node);

      return image === null ? node : take(image);
    }

    if (Array.isArray(node)) return node.map(walk);

    if (node === null || !isJsonObject(node)) return node;
    // Each shape is asked only of a node that names itself one: a failed parse formats an issue for every node it refuses.
    const carrier = node.type === 'kinu/images' ? v.safeParse(CarrierSchema, node) : null;

    if (carrier?.success === true) {
      const output = walk(node.output ?? null);

      return { ...node, output, images: carrier.output.images.map((image) => ({ mediaType: image.mediaType, url: take(image) })) };
    }

    const file = node.type === 'file' ? v.safeParse(ModelFileSchema, node) : null;

    if (file?.success === true) return { type: 'file', mediaType: file.output.mediaType, url: take({ mediaType: file.output.mediaType, data: file.output.data.data }) };

    return Object.fromEntries(Object.entries(node).map(([key, member]) => [key, walk(member)]));
  };

  return walk(value);
}

/** The images `value` carries, in the order {@link walkImages} visits them. */
export function imagesIn(value: JsonValue): StoredImage[] {
  const images: StoredImage[] = [];

  walkImages(value, (image) => {
    images.push(image);

    return '';
  });

  return images;
}

/** A stored attachment's carrier as one image, when it holds its bytes: `$binary`, a data URL, or bare base64. */
export function attachmentImage(part: JsonObject): StoredImage | null {
  const carrier = part.data ?? part.image;
  const mediaType = v.is(v.string(), part.mediaType) ? part.mediaType : 'application/octet-stream';
  const binary = v.safeParse(v.object({ $binary: v.string() }), carrier);

  if (binary.success) return { mediaType, data: binary.output.$binary };

  if (!v.is(v.string(), carrier)) return null;
  const url = readDataUrl(carrier);

  if (url !== null && url.base64) return { mediaType: url.mediaType, data: url.data };

  return /^(https?:|\/)/u.test(carrier) ? null : { mediaType, data: carrier };
}
