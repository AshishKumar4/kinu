/**
 * Images in tool results, per model and wire API.
 * - Anthropic Messages and OpenAI Responses carry an image inside a tool result.
 * - Chat Completions has none in a tool message: `@ai-sdk/openai-compatible` 2.x and `@ai-sdk/openai`'s chat model
 *   send a `content` tool output as its JSON text, a screenshot as some 140,000 characters of base64. There, as
 *   oh-my-pi does (packages/ai/src/providers/openai-completions.ts:2589-2660), the tool message keeps the text and
 *   one user message after the batch of tool results carries the images.
 * - A model that takes no image (its accepted media, `attachment-sanitizer.ts`) gets a note in the image's place,
 *   and so does a Chat Completions model whose media the caller does not know.
 * - A Claude model refuses a request of more than 20 images if any is over 3,000 px a side, on every route to it
 *   (`provider.anthropic.full_size_images`, `provider.anthropic.many_image_edge`): in such a request each image over the
 *   bound is a note naming its size, and the rest go as they came, so a request repeats the last one's prefix
 *   (owner's workspace, 2026-11-08: one oversized screenshot refused every later turn of the chat). The turn's own
 *   screenshots rotate earlier, at a few (compaction's step images); this is the provider's bound, not that policy.
 */
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
import type { LanguageModelV4Message, LanguageModelV4ToolResultOutput, SharedV4FileData } from '@ai-sdk/provider';
import * as v from 'valibot';
import { PLATFORM_LIMITS } from '../platform-limits';
import { base64ToBytes } from '../utils/base64';
import { rasterImage } from '../utils/raster-image';
import { splitSpec } from './types';
import { TOOL_IMAGES_OPENING } from '../utils/prompt-sections';
import type { ModelInputModality } from './types';

/** `LanguageModelV4.provider` ends with the wire API: `anthropic.messages`, `openai.responses`, `<name>.chat`. */
const IMAGE_CARRYING_APIS = ['.messages', '.responses'];

const OMITTED = '[image omitted: this model takes no image input]';

const ATTACHED = '(image attached in the next message)';

const FULL_SIZE_IMAGES = PLATFORM_LIMITS['provider.anthropic.full_size_images'].value;

const MANY_IMAGE_EDGE = PLATFORM_LIMITS['provider.anthropic.many_image_edge'].value;

type ContentItem = Extract<LanguageModelV4ToolResultOutput, { type: 'content' }>['value'][number];

type ImageItem = Extract<ContentItem, { type: 'file' }>;

/** A file entry whose media type names an image, in full (`image/png`) or as its top-level segment (`image`). */
function isImage(item: ContentItem): item is ImageItem {
  return item.type === 'file' && (item.mediaType === 'image' || item.mediaType.startsWith('image/'));
}

/** A user message's file part, or a tool result's content item, that is an image. */
function isImagePart(part: { readonly type: string; readonly mediaType?: string }): boolean {
  return part.type === 'file' && part.mediaType !== undefined && (part.mediaType === 'image' || part.mediaType.startsWith('image/'));
}

function imagesIn(message: LanguageModelV4Message): number {
  if (message.role === 'user') return message.content.filter(isImagePart).length;

  if (message.role !== 'tool') return 0;

  return message.content.reduce((sum, part) => sum + (part.type === 'tool-result' && part.output.type === 'content' ? part.output.value.filter(isImage).length : 0), 0);
}

/** What a call knows of each image still in its prompt: its longer side (null where its header names none), and whether
 *  a request left it out. Carried to the next request only for images it still holds, so no payload a step retired
 *  stays reachable here (D103); an image left out stays out while the call holds it, so the prompt's prefix does not
 *  flip as the turn's screenshots rotate across the bound. */
interface Seen {
  readonly edge: number | null;
  readonly out: boolean;
}

interface ImageEdges {
  readonly last: ReadonlyMap<string | Uint8Array, Seen>;
  readonly now: Map<string | Uint8Array, Seen>;
  /** The request carries more images than Claude takes at full size. */
  readonly many: boolean;
}

/** Whether an image part goes as a note, and its longer side; null for any other part. */
function decide(data: SharedV4FileData, edges: ImageEdges): Seen | null {
  if (data.type !== 'data') return null;
  const last = edges.last.get(data.data);
  const edge = last === undefined ? longerSide(data.data) : last.edge;
  const seen = { edge, out: last?.out === true || (edges.many && edge !== null && edge > MANY_IMAGE_EDGE) };

  edges.now.set(data.data, seen);

  return seen;
}

function longerSide(payload: string | Uint8Array): number | null {
  const image = rasterImage(typeof payload === 'string' ? base64ToBytes(payload) : payload);

  return image === null ? null : Math.max(image.width, image.height);
}

type UserPart = Extract<LanguageModelV4Message, { role: 'user' }>['content'][number];

/** The longer side of an image part that goes as a note; null for any part that goes as it came. */
function overBound(part: UserPart | ContentItem, edges: ImageEdges): number | null {
  if (part.type !== 'file' || !isImagePart(part)) return null;
  const seen = decide(part.data, edges);

  return seen?.out === true ? seen.edge : null;
}

function leftOut(edge: number) {
  return { type: 'text' as const, text: `[an image ${String(edge)} px on its longer side, left out: Claude takes at most ${String(MANY_IMAGE_EDGE)} px a side in a request of more than ${String(FULL_SIZE_IMAGES)} images]` };
}

/** `prompt` with each image over Claude's many-image bound a note, where it carries more images than Claude takes at
 *  full size; unchanged messages stay the same objects. */
function fittedForClaude(prompt: LanguageModelV4Message[], edges: ImageEdges): LanguageModelV4Message[] {
  if (!edges.many && ![...edges.last.values()].some((seen) => seen.out)) return prompt;

  return prompt.map((message): LanguageModelV4Message => {
    if (message.role === 'user') {
      const content = message.content.map((part) => {
        const edge = overBound(part, edges);

        return edge === null ? part : leftOut(edge);
      });

      return content.every((part, at) => part === message.content[at]) ? message : { ...message, content };
    }

    if (message.role !== 'tool') return message;

    const content = message.content.map((part) => {
      if (part.type !== 'tool-result' || part.output.type !== 'content') return part;
      const items = part.output.value;

      const value = items.map((item) => {
        const edge = overBound(item, edges);

        return edge === null ? item : leftOut(edge);
      });

      return value.every((item, at) => item === items[at]) ? part : { ...part, output: { type: 'content' as const, value } };
    });

    return content.every((part, at) => part === message.content[at]) ? message : { ...message, content };
  });
}

function carriesImage(message: LanguageModelV4Message): boolean {
  return message.role === 'tool'
    && message.content.some((part) => part.type === 'tool-result' && part.output.type === 'content' && part.output.value.some(isImage));
}

/** Each image a note: the model cannot see it on any API. */
function withoutImages(message: LanguageModelV4Message): LanguageModelV4Message {
  if (message.role !== 'tool') return message;

  return {
    ...message,
    content: message.content.map((part) => (part.type !== 'tool-result' || part.output.type !== 'content'
      ? part
      : { ...part, output: { type: 'content', value: part.output.value.map((item) => (isImage(item) ? { type: 'text', text: OMITTED } : item)) } })),
  };
}

/**
 * Chat Completions: each tool message as text, and, where the model takes images, its images in one user message
 * after the batch; otherwise a note in each image's place.
 */
function chatToolResults(prompt: LanguageModelV4Message[], moveImages: boolean): LanguageModelV4Message[] {
  // Every call passes the whole prompt here; one with no image in a tool result goes on as it came.
  if (!prompt.some(carriesImage)) return prompt;
  const out: LanguageModelV4Message[] = [];
  let pending: ImageItem[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    out.push({
      role: 'user',
      content: [
        { type: 'text', text: TOOL_IMAGES_OPENING },
        ...pending.map((image) => ({ type: 'file' as const, data: image.data, mediaType: image.mediaType })),
      ],
    });
    pending = [];
  };

  for (const message of prompt) {
    if (message.role !== 'tool') {
      flush();
      out.push(message);
      continue;
    }

    const content = message.content.map((part): typeof part => {
      if (part.type !== 'tool-result' || part.output.type !== 'content') return part;
      const images = part.output.value.filter(isImage);

      if (images.length === 0) return part;

      if (moveImages) pending.push(...images);
      const texts = part.output.value.flatMap((item) => (item.type === 'text' ? [item.text] : []));
      const note = moveImages ? ATTACHED : images.map(() => OMITTED).join('\n');

      return { ...part, output: { type: 'text', value: [...texts, note].join('\n') } };
    });

    // An unchanged message stays the same object, so a provider's per-message conversion is reused across steps.
    out.push(content.every((part, index) => part === message.content[index]) ? message : { ...message, content });
  }

  flush();

  return out;
}

/** A Claude model, on whatever route serves it: Anthropic's Messages wire, Anthropic's own provider, a model whose author
 *  (the segment before its name: `openrouter/anthropic/…`, `workers-ai/@cf/anthropic/…`) is Anthropic, or a bare
 *  `claude-…` id, Anthropic's own naming, as a catalog provider serves it (`opencode-go/claude-haiku-5-5`). */
function servesClaude(spec: string | undefined, provider: string): boolean {
  if (provider.endsWith('.messages')) return true;
  const parts = spec === undefined ? null : splitSpec(spec);

  if (parts === null) return false;

  if (parts.provider === 'anthropic' || parts.provider === 'claude') return true;
  const segments = parts.modelId.split('/');

  return segments.length > 1 ? segments.at(-2) === 'anthropic' : /^claude-/iu.test(parts.modelId);
}

/** `prompt` with its tool results' images as the wire API and the model's media take them. */
function toolResultsSeen(prompt: LanguageModelV4Message[], carries: boolean, accepts: ReadonlySet<ModelInputModality> | undefined): LanguageModelV4Message[] {
  if (!carries) return chatToolResults(prompt, accepts?.has('image') === true);

  return accepts === undefined || accepts.has('image') ? prompt : prompt.map(withoutImages);
}

/** `accepts` undefined: the caller does not know the model's media, so only an image-carrying API sends one. */
export function toolImages(accepts: ReadonlySet<ModelInputModality> | undefined, spec?: string): LanguageModelMiddleware {
  let sizes: ReadonlyMap<string | Uint8Array, Seen> = new Map();

  return {
    specificationVersion: 'v4',
    transformParams: async ({ params, model }) => {
      const carries = IMAGE_CARRYING_APIS.some((api) => model.provider.endsWith(api));

      const seen = toolResultsSeen(params.prompt, carries, accepts);
      const edges: ImageEdges = { last: sizes, now: new Map(), many: seen.reduce((sum, message) => sum + imagesIn(message), 0) > FULL_SIZE_IMAGES };
      const prompt = servesClaude(spec, model.provider) ? fittedForClaude(seen, edges) : seen;

      sizes = edges.now;

      return prompt === params.prompt ? params : { ...params, prompt };
    },
  };
}

/**
 * `model` as it sends a tool result's images. The registry wraps every model knowing nothing of its media; a turn
 * that knows them (`AttachmentPolicy.accepts`) wraps it again outside, and that wrapper decides first.
 */
export function withToolResultImages(model: LanguageModel, accepts?: ReadonlySet<ModelInputModality>, spec?: string): LanguageModel {
  if (v.is(v.string(), model) || model.specificationVersion === 'v2') return model;

  return wrapLanguageModel({ model, middleware: toolImages(accepts, spec) });
}
