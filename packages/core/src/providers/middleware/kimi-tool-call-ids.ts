/**
 * Kimi K2's earlier tool calls under the ids its chat template is trained on. Kimi names a call `functions.<tool>:<n>`,
 * `n` counting every call in the conversation, and its server reads a call back only in that shape. Sent the history
 * under ours (replay normalization's `kinu-i-<n>`), it often ends a step with its calls unparsed: Workers AI generates
 * them, streams nothing for them and finishes `stop` with no tool call (staging 66d34db8d, 2026-10-23: a bakery page's
 * main ended on narration in 3 of 3 runs). Replayed against kimi-k2.6 with that turn's request, 5 of 15 answers under
 * our ids carried their calls, each other one counting hundreds of completion tokens it never sent; under Kimi's, 10 of
 * 10 did. Only the request is renumbered: the turn pairs results by its own keys.
 */
import type { LanguageModelMiddleware } from 'ai';
import type { LanguageModelV4, LanguageModelV4Prompt } from '@ai-sdk/provider';

/** Kimi K2 by its id, on any route: `@cf/moonshotai/kimi-k2.6`, `kimi-k2.5`, `moonshotai/kimi-k2-thinking`. */
function servesKimi(model: LanguageModelV4): boolean {
  return model.modelId.toLowerCase().includes('kimi-k2');
}

/** Every tool call and result in `prompt` under `functions.<tool>:<n>`, numbered in the order the calls were made. */
function kimiNumberedPrompt(prompt: LanguageModelV4Prompt): LanguageModelV4Prompt {
  const ids = new Map<string, string>();

  const kimiId = (id: string, toolName: string): string => {
    const known = ids.get(id);

    if (known !== undefined) return known;
    const numbered = `functions.${toolName}:${String(ids.size)}`;
    ids.set(id, numbered);

    return numbered;
  };

  return prompt.map((message) => {
    if (message.role === 'assistant') {
      return {
        ...message,
        content: message.content.map((part) => (part.type === 'tool-call' || part.type === 'tool-result'
          ? { ...part, toolCallId: kimiId(part.toolCallId, part.toolName) }
          : part)),
      };
    }

    if (message.role === 'tool') {
      return {
        ...message,
        content: message.content.map((part) => (part.type === 'tool-result' ? { ...part, toolCallId: kimiId(part.toolCallId, part.toolName) } : part)),
      };
    }

    return message;
  });
}

export const kimiToolCallIds: LanguageModelMiddleware = {
  specificationVersion: 'v4',
  transformParams: async ({ params, model }) => (servesKimi(model) ? { ...params, prompt: kimiNumberedPrompt(params.prompt) } : params),
};
