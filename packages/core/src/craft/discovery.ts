/**
 * CraftStore tool discovery — extract reusable patterns from winning branches.
 *
 * Architecture reference: final-architecture.md §6
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import { upsertCraftedTool } from './conflict.js';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured.js';

/**
 * When a branch scores high (>0.8) and used codemode, try to generalize
 * the code into a reusable crafted tool.
 */
export async function maybeStoreCraftedTool(
  rt: AgentRuntime,
  codemodeCode: string,
  score: number,
): Promise<void> {
  // Size filters: too small (trivial) or too large (task-specific)
  if (codemodeCode.length < 50 || codemodeCode.length > 1500) return;

  // Ask LLM to generalize the pattern
  const generalized = await rt.llm.complete(
    `This JavaScript code was effective (score ${score.toFixed(2)}):\n\`\`\`js\n${codemodeCode}\n\`\`\`\n\n` +
    `Rewrite as a parameterized reusable function.\n` +
    `JSON shape: {"name":"snake_case","description":"one line","code":"async ({param1,param2}) => { ... }"}\n` +
    jsonObjectOnlyInstruction(),
  );

  try {
    const parsed = extractJsonObject(generalized) as { name?: string; description?: string; code?: string };
    if (!parsed.name || !parsed.code) return;

    await upsertCraftedTool(rt, {
      name: parsed.name,
      description: parsed.description ?? '',
      code: parsed.code,
      score,
    });
  } catch {
    // LLM returned invalid JSON — skip, don't crash
  }
}
