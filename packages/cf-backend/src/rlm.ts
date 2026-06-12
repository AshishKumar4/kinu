// Recursive Language Models — `llm.query(text, opts?)` inside codemode.
//
// Mechanism (Zhang/Kraska/Khattab, arXiv:2512.24601): the root LLM emits
// code that programmatically slices a large input and dispatches sub-LM
// calls on each slice. The root model aggregates locally before answering.
// This unlocks "context-as-variable" — the LLM treats prompt material as a
// REPL value it can grep, partition, summarize.
//
// In Proteus, the LLM-authored code inside execute_tools already runs in a
// codemode sandbox where workspace.* / sandbox.* / codemode.* are in scope.
// `llm.query(...)` joins that surface as one more provider — the LLM can
// write code like:
//
//   const chunks = await workspace.readChunks('huge.log', { tokens: 4000 });
//   const summaries = await Promise.all(chunks.map(c => llm.query(`Summarize: ${c}`)));
//   const final = await llm.query(`Synthesize: ${summaries.join('\n\n')}`);
//
// Depth budget: the SUB-call has no llm.query in scope (it's a plain
// generateText call, no sandbox). So recursion depth is bounded at 1 by
// construction — matching the paper's reference implementation.

import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import type { AgentProviderRegistry } from './providers/agent-registry.js';

/** A codemode sandbox provider: a named namespace of callable tools plus the
 *  TypeScript declaration the LLM sees. This is the shape `createCodeTool`
 *  consumes (NOT core's `ResolvedProvider`, which is the executor-side
 *  `{name, fns}` form). */
export interface CodemodeProvider {
  name: string;
  types: string;
  tools: Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>;
  positionalArgs?: boolean;
}

export interface RLMOptions {
  /** Override model for this query (e.g. `openrouter/anthropic/claude-3.5-sonnet`).
   *  Falls back to the agent's currently-configured model. */
  model?: string;
  /** Workers AI native: `'low' | 'medium' | 'high'` controls hidden thinking
   *  budget on reasoning-capable models (Kimi K2.6, GLM-4, GPT-OSS).
   *  Default 'low' for sub-calls (cheap fan-out). */
  reasoning_effort?: 'low' | 'medium' | 'high';
  /** Override system prompt. Default: a small "answer concisely" prefix. */
  system?: string;
  /** Max output tokens. Default 1024. */
  maxOutputTokens?: number;
}

/** Build the codemode provider that exposes `llm.query(...)` to the sandbox. */
export function createRLMProvider(
  registry: AgentProviderRegistry,
  currentSpec: () => string,
): CodemodeProvider {
  return {
    name: 'llm',
    types: 'export declare const llm: {\n' +
           '  /** Recursive LM call. Bounded depth=1 (sub-call has no llm.query in scope). */\n' +
           '  query(text: string, opts?: {\n' +
           '    model?: string;\n' +
           '    reasoning_effort?: "low" | "medium" | "high";\n' +
           '    system?: string;\n' +
           '    maxOutputTokens?: number;\n' +
           '  }): Promise<string>;\n' +
           '};\n',
    tools: {
      query: {
        description: 'Recursive language model call. Spawns a flat LLM call on the given text. ' +
                     'Useful for divide-and-conquer over large inputs: chunk, llm.query each, aggregate.',
        execute: async (...args: unknown[]) => {
          const text = args[0] as string;
          const opts = (args[1] ?? {}) as RLMOptions;
          if (typeof text !== 'string' || !text) {
            return { error: 'llm.query: first arg must be a non-empty string' };
          }
          const spec = opts.model ?? currentSpec();
          let model: LanguageModel;
          try { model = registry.resolveModel(registry.normalizeSpecSync(spec)); }
          catch (err) {
            return { error: `llm.query: model ${spec} unresolvable: ${(err as Error).message}` };
          }
          try {
            const { text: out } = await generateText({
              model,
              system: opts.system ?? 'You are a helpful assistant. Answer concisely and directly.',
              prompt: text,
              maxOutputTokens: opts.maxOutputTokens ?? 1024,
              ...(opts.reasoning_effort
                ? { providerOptions: { 'workers-ai': { reasoning_effort: opts.reasoning_effort } } }
                : {}),
            });
            return out.trim();
          } catch (err) {
            return { error: `llm.query: ${(err as Error).message}` };
          }
        },
      },
    },
    // codemode passes args positionally to the executor fn — our execute
    // already destructures from args[0]/args[1] above.
    positionalArgs: true,
  };
}
