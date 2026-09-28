/**
 * Images in tool results, per wire API. Anthropic Messages and OpenAI Responses carry an image inside a tool
 * result. Chat Completions has no image in a tool message: `@ai-sdk/openai-compatible` 2.x and `@ai-sdk/openai`'s
 * chat model send a `content` tool output as its JSON text, so a screenshot would reach the model as some 140,000
 * characters of base64. On those APIs each image part becomes a note naming what was left out.
 */
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
import type { LanguageModelV3Message } from '@ai-sdk/provider';
import * as v from 'valibot';

/** `LanguageModelV3.provider` ends with the wire API: `anthropic.messages`, `openai.responses`, `<name>.chat`. */
const IMAGE_CARRYING_APIS = ['.messages', '.responses'];

const OMITTED = '[image omitted: this model\'s API carries no image in a tool result]';

function withoutToolImages(message: LanguageModelV3Message): LanguageModelV3Message {
  if (message.role !== 'tool') return message;

  return {
    ...message,
    content: message.content.map((part) => {
      if (part.type !== 'tool-result' || part.output.type !== 'content') return part;

      return {
        ...part,
        output: {
          type: 'content',
          value: part.output.value.map((item) => (item.type === 'image-data' || item.type === 'image-url' || item.type === 'image-file-id'
            ? { type: 'text', text: OMITTED }
            : item)),
        },
      };
    }),
  };
}

const toolImagesAsText: LanguageModelMiddleware = {
  specificationVersion: 'v3',
  transformParams: async ({ params, model }) => (IMAGE_CARRYING_APIS.some((api) => model.provider.endsWith(api))
    ? params
    : { ...params, prompt: params.prompt.map(withoutToolImages) }),
};

/** Every resolved model, so no provider path sends an image its API would flatten into text. */
export function withToolResultImages(model: LanguageModel): LanguageModel {
  if (v.is(v.string(), model) || model.specificationVersion !== 'v3') return model;

  return wrapLanguageModel({ model, middleware: toolImagesAsText });
}
