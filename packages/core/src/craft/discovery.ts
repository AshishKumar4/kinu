/**
 * CraftStore tool discovery — extract reusable patterns from winning branches.
 *
 * Architecture reference: docs/EVOLUTION.md — "CraftStore Lifecycle"
 */

import * as v from 'valibot';
import type { AgentRuntime } from '../types/agent-runtime';
import { upsertCraftedTool } from './conflict';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured';
import { EVIDENCE_BUDGETS } from '../prompts/evidence-window';
import { tolerate } from '../obs/index';

/** Head-only cut with a named omission — code must stay contiguous for a
 *  rewriter (same rationale as gepaParentSource). */
function truncateSource(code: string): string {
  return code.length <= EVIDENCE_BUDGETS.assertionCode
    ? code
    : `${code.slice(0, EVIDENCE_BUDGETS.assertionCode)}\n// [... ${code.length - EVIDENCE_BUDGETS.assertionCode} chars omitted — generalize what is shown]`;
}

const CRAFTABLE_LANGUAGES: ReadonlySet<string> = new Set(['javascript', 'typescript']);
const GeneralizedToolSchema = v.object({
  name: v.optional(v.string()),
  description: v.optional(v.string()),
  code: v.optional(v.string()),
});

/** Crafted tools execute inside codemode and therefore must be JS-family source. */
export function isCraftable(language: string | null): boolean {
  return language !== null && CRAFTABLE_LANGUAGES.has(language);
}

/**
 * When a branch scores high (>0.8) and used codemode, try to generalize
 * the code into a reusable crafted tool.
 */
export async function maybeStoreCraftedTool(
  rt: AgentRuntime,
  codemodeCode: string,
  score: number,
): Promise<void> {
  // Too small to encode a pattern (trivial one-liners). There is no upper
  // gate: whether a winning branch's code generalizes is a semantic question
  // the generalization call below answers — a 1500-char size ceiling was a
  // proxy that silently excluded every substantial win from the craft loop.
  // The prompt budget is the same contiguous-code window the GEPA rewriter
  // uses (a rewrite of code with a hole comes back with a hole).
  if (codemodeCode.length < 50) return;

  // Ask LLM to generalize the pattern
  const generalized = await rt.llm.complete(
    `This JavaScript code was effective (score ${score.toFixed(2)}):\n\`\`\`js\n${truncateSource(codemodeCode)}\n\`\`\`\n\n` +
    `Rewrite as a parameterized reusable function.\n` +
    `JSON shape: {"name":"snake_case","description":"one line","code":"async ({param1,param2}) => { ... }"}\n` +
    jsonObjectOnlyInstruction(),
  );

  // Only the model's own output is allowed to be unusable here. The store write
  // below used to sit inside the same catch as this parse, so a tool that failed
  // to persist was reported as "the LLM returned invalid JSON" and the craft
  // loop looked like it had simply declined to generalize.
  const extracted = tolerate(() => extractJsonObject(generalized), 'malformed-input');
  if (extracted === undefined) return;
  const parsed = v.parse(GeneralizedToolSchema, extracted);
  if (!parsed.name || !parsed.code) return;

  await upsertCraftedTool(rt, {
    name: parsed.name,
    description: parsed.description ?? '',
    code: parsed.code,
    score,
  });
}
