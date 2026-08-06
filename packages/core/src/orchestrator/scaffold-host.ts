/**
 * The scaffold's host bridges — how an evolved scaffold reaches the model and
 * the agent's tool surface from inside the codemode sandbox. One
 * implementation for both backends (each previously carried its own copy):
 *
 *   createScaffoldLLMStream   host.llmStream — tool NAMES cross the sandbox
 *                             boundary; the host resolves them against the
 *                             live surface and runs a genuine multi-step loop.
 *   createScaffoldCallTool    host.callTool — dispatch into the live surface
 *                             by name; a throw becomes `{ error }` (the shape
 *                             buildHostProvider guarantees).
 */

import { streamText, stepCountIs, type LanguageModel, type ToolSet } from 'ai';
import type { ScaffoldRunOptions } from '../scaffold/executor.js';

export interface ScaffoldBridgeOpts {
  model: LanguageModel;
  /** The live tool surface, resolved per call so mid-turn rebuilds land. */
  tools: () => ToolSet;
  /** Step budget when the scaffold names none (cf: 50; cli: resolveMaxSteps). */
  defaultMaxSteps: number;
  /** Provider options for the scaffold's calls (cf spreads
   *  effortFor('scaffold_mutation')). `{}` when the backend adds none — safe
   *  to spread unconditionally. */
  streamOptions?: Pick<Parameters<typeof streamText>[0], 'providerOptions'>;
}

export function createScaffoldLLMStream(opts: ScaffoldBridgeOpts): ScaffoldRunOptions['llmStream'] {
  return async function* (call) {
    const all = opts.tools();
    const toolSet: ToolSet = (call.tools && call.tools.length > 0)
      ? Object.fromEntries(call.tools.filter((n) => all[n]).map((n) => [n, all[n]]))
      : all;
    const result = streamText({
      model: opts.model,
      system: call.system,
      messages: call.messages.map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant', content: m.content,
      })),
      tools: toolSet,
      stopWhen: stepCountIs(call.maxSteps ?? opts.defaultMaxSteps),
      ...(opts.streamOptions ?? {}),
    });
    for await (const chunk of result.textStream) yield chunk;
  };
}

export function createScaffoldCallTool(tools: () => ToolSet): NonNullable<ScaffoldRunOptions['callTool']> {
  return async (name, args) => {
    const t = tools()[name];
    if (!t || typeof t.execute !== 'function') return { error: `tool not found: ${name}` };
    try {
      // `args as never` is the legitimate dynamic-dispatch escape: the tool is
      // selected by string name at runtime, so its input type is unknown here.
      // The options object IS statically known — typed precisely so a future
      // required ToolCallOptions field can't silently slip through.
      const options: Parameters<NonNullable<ToolSet[string]['execute']>>[1] = {
        messages: [], toolCallId: `scaffold-${Date.now()}`,
      };
      return await t.execute(args as never, options);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
}
