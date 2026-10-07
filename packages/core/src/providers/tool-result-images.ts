/**
 * Images in tool results, per model and wire API.
 * - Anthropic Messages and OpenAI Responses carry an image inside a tool result.
 * - Chat Completions has none in a tool message: `@ai-sdk/openai-compatible` 2.x and `@ai-sdk/openai`'s chat model
 *   send a `content` tool output as its JSON text, a screenshot as some 140,000 characters of base64. There, as
 *   oh-my-pi does (packages/ai/src/providers/openai-completions.ts:2589-2660), the tool message keeps the text and
 *   one user message after the batch of tool results carries the images.
 * - A model that takes no image (its accepted media, `attachment-sanitizer.ts`) gets a note in the image's place,
 *   and so does a Chat Completions model whose media the caller does not know.
 */
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
import type { LanguageModelV4Message, LanguageModelV4ToolResultOutput } from '@ai-sdk/provider';
import * as v from 'valibot';
import type { ModelInputModality } from './types';

/** `LanguageModelV4.provider` ends with the wire API: `anthropic.messages`, `openai.responses`, `<name>.chat`. */
const IMAGE_CARRYING_APIS = ['.messages', '.responses'];

const OMITTED = '[image omitted: this model takes no image input]';

const ATTACHED = '(image attached in the next message)';

type ContentItem = Extract<LanguageModelV4ToolResultOutput, { type: 'content' }>['value'][number];

type ImageItem = Extract<ContentItem, { type: 'file' }>;

/** A file entry whose media type names an image, in full (`image/png`) or as its top-level segment (`image`). */
function isImage(item: ContentItem): item is ImageItem {
  return item.type === 'file' && (item.mediaType === 'image' || item.mediaType.startsWith('image/'));
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
function chatToolResults(prompt: readonly LanguageModelV4Message[], moveImages: boolean): LanguageModelV4Message[] {
  const out: LanguageModelV4Message[] = [];
  let pending: ImageItem[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    out.push({
      role: 'user',
      content: [
        { type: 'text', text: 'Attached image(s) from tool result:' },
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

/** `accepts` undefined: the caller does not know the model's media, so only an image-carrying API sends one. */
export function toolImages(accepts: ReadonlySet<ModelInputModality> | undefined): LanguageModelMiddleware {
  return {
    specificationVersion: 'v4',
    transformParams: async ({ params, model }) => {
      const carries = IMAGE_CARRYING_APIS.some((api) => model.provider.endsWith(api));

      if (!carries) return { ...params, prompt: chatToolResults(params.prompt, accepts?.has('image') === true) };

      return accepts === undefined || accepts.has('image') ? params : { ...params, prompt: params.prompt.map(withoutImages) };
    },
  };
}

/**
 * `model` as it sends a tool result's images. The registry wraps every model knowing nothing of its media; a turn
 * that knows them (`AttachmentPolicy.accepts`) wraps it again outside, and that wrapper decides first.
 */
export function withToolResultImages(model: LanguageModel, accepts?: ReadonlySet<ModelInputModality>): LanguageModel {
  if (v.is(v.string(), model) || model.specificationVersion === 'v2') return model;

  return wrapLanguageModel({ model, middleware: toolImages(accepts) });
}
