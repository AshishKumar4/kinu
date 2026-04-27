/**
 * CraftStore tool discovery — extract reusable patterns from winning branches.
 *
 * Architecture reference: final-architecture.md §6
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import { upsertCraftedTool } from './conflict.js';

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
    `Rewrite as a parameterized reusable function. Return ONLY JSON:\n` +
    `{"name":"snake_case","description":"one line","code":"async ({param1,param2}) => { ... }"}`,
  );

  try {
    // Find valid JSON by trying from each { position (handles nested braces in code field)
    let parsed: { name?: string; description?: string; code?: string } = {};
    const startIdx = generalized.indexOf('{');
    if (startIdx >= 0) {
      for (let end = generalized.length; end > startIdx; end--) {
        if (generalized[end - 1] === '}') {
          try { parsed = JSON.parse(generalized.slice(startIdx, end)); break; }
          catch { continue; }
        }
      }
    }
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
