// Recursive Language Models — `llm.query(text, opts?)` inside codemode.
//
// Mechanism (Zhang/Kraska/Khattab, arXiv:2512.24601): the root LLM emits
// code that programmatically slices a large input and dispatches sub-LM
// calls on each slice. The root model aggregates locally before answering.
// This unlocks "context-as-variable" — the LLM treats prompt material as a
// REPL value it can grep, partition, summarize.
//
// In Kinu, the LLM-authored code inside execute_tools already runs in a
// codemode sandbox where workspace.* / sandbox.* / codemode.* are in scope.
// `llm.query(...)` joins that surface as one more provider — the LLM can
// write code like:
//
//   const log = await workspace.readFile('huge.log');
//   const chunks = log.match(/[\s\S]{1,16000}/g) ?? [];
//   const summaries = await Promise.all(chunks.map(c => llm.query(`Summarize: ${c}`)));
//   const final = await llm.query(`Synthesize: ${summaries.join('\n\n')}`);
//
// Depth budget: the SUB-call has no llm.query in scope (it's a plain
// generateText call, no sandbox). So recursion depth is bounded at 1 by
// construction — matching the paper's reference implementation. For slices
// that themselves need decomposition, the recipe is a search
// (`agents` action=swarm): its nodes run full tool loops with llm.query in
// scope, which is agent-level recursion with budgets and a settle already
// attached.

import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import * as v from 'valibot';
import type { ModelCallSink } from './events/model-call';
import { normalizeUsage } from './usage';
import { REASONING_EFFORTS, reasoningEffortOptions } from './strategy/effort';
import { parseModelSpec } from './providers/types';
import { TOOL_REACH } from './tools/registry';
import { renderThrownChain } from './obs/index';

/** A provider's host-side result before the executor validates the VM boundary
 *  as JSON. Domain objects are allowed here; functions and symbols are not. */
export type CodemodeResult = object | string | number | boolean | null | undefined;

/** A codemode sandbox provider: a named namespace of callable tools plus the
 *  TypeScript declaration the LLM sees. Both backends inject this same shape
 *  into execute_tools (the cf loader consumes `types`; the node factory
 *  treats it as optional). */
export interface CodemodeProvider {
  name: string;
  tools: Record<string, {
    description: string;
    execute: (...args: unknown[]) => Promise<CodemodeResult>;
  }>;
  types?: string;
  positionalArgs?: boolean;
}

/** The slice of a model registry the RLM provider needs — satisfied
 *  structurally by cf's AgentProviderRegistry and cli's LocalModelResolver. */
export interface RLMModelResolver {
  normalizeSpecSync(spec?: string | null): string;
  resolveModel(spec?: string | null): LanguageModel;
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
  /** Optional explicit output cap. Omitted by default. */
  maxOutputTokens?: number;
}

const QueryTextSchema = v.pipe(v.string(), v.minLength(1));
const RLMOptionsSchema: v.GenericSchema<RLMOptions> = v.object({
  model: v.optional(v.string()),
  reasoning_effort: v.optional(v.picklist(REASONING_EFFORTS)),
  system: v.optional(v.string()),
  maxOutputTokens: v.optional(v.number()),
});


/**
 * Build the codemode provider that exposes `llm.query(...)` to the sandbox.
 *
 * `reportModelCall` is where each sub-call's cost is filed, as `sandbox` spend.
 * It matters more here than at most seams: a program is free to fan out over as
 * many slices as it likes, so this is the one producer whose per-turn spend has
 * no structural bound — and until it reported, an unbounded fan-out was
 * invisible. Optional: a backend that wires no sink runs exactly as before.
 */
export function createRLMProvider(
  resolver: RLMModelResolver,
  currentSpec: () => string,
  reportModelCall?: ModelCallSink,
): CodemodeProvider {
  return {
    name: TOOL_REACH.llm.codemode,
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
        execute: async (...args) => {
          const text = v.safeParse(QueryTextSchema, args[0]);
          if (!text.success) {
            return { error: 'llm.query: first arg must be a non-empty string' };
          }
          const opts = v.safeParse(RLMOptionsSchema, args[1] ?? {});
          if (!opts.success) {
            return { error: 'llm.query: reasoning_effort must be low, medium, or high' };
          }
          const spec = opts.output.model ?? currentSpec();
          let normalizedSpec: string;
          let model: LanguageModel;
          try {
            normalizedSpec = resolver.normalizeSpecSync(spec);
            model = resolver.resolveModel(normalizedSpec);
          }
          catch (err) {
            return { error: `llm.query: model ${spec} unresolvable: ${renderThrownChain({ cause: err })}` };
          }
          const providerOptions = reasoningEffortOptions(
            opts.output.reasoning_effort ?? 'low',
            parseModelSpec(normalizedSpec).provider,
          );
          try {
            const result = await generateText({
              model,
              system: opts.output.system ?? 'You are a helpful assistant. Answer concisely and directly.',
              prompt: text.output,
              maxOutputTokens: opts.output.maxOutputTokens,
              providerOptions,
            });
            reportModelCall?.({
              source: 'sandbox',
              usage: normalizeUsage(result.totalUsage),
              spec: normalizedSpec,
              modelId: result.response.modelId,
            });
            return result.text.trim();
          } catch (err) {
            // A throw produced no usage and, as far as this seam can see, no
            // bill — reporting it would count a call that cost nothing against
            // the measured fraction.
            return { error: `llm.query: ${renderThrownChain({ cause: err })}` };
          }
        },
      },
    },
    // codemode passes args positionally to the executor fn — our execute
    // already destructures from args[0]/args[1] above.
    positionalArgs: true,
  };
}
