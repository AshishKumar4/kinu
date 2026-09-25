// See docs/EVOLUTION.md "CraftStore Lifecycle".

import * as v from 'valibot';
import type { AgentRuntime } from '../types/agent-runtime';
import { upsertCraftedTool } from './conflict';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../providers/structured';
import { EVIDENCE_BUDGETS } from '../types/evidence';
import { tolerate } from '../obs/index';

/** Head-only cut: code must stay contiguous for a rewriter (as in gepaParentSource). */
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

export async function maybeStoreCraftedTool(
  rt: AgentRuntime,
  codemodeCode: string,
  score: number,
): Promise<void> {
  // No upper size gate: the generalization call decides whether large code generalizes.
  if (codemodeCode.length < 50) return;

  const generalized = await rt.llm.complete(
    `This JavaScript code was effective (score ${score.toFixed(2)}):\n\`\`\`js\n${truncateSource(codemodeCode)}\n\`\`\`\n\n` +
    `Rewrite as a parameterized reusable function.\n` +
    `JSON shape: {"name":"snake_case","description":"one line","code":"async ({param1,param2}) => { ... }"}\n` +
    jsonObjectOnlyInstruction(),
  );

  // `tolerate` covers only the parse, so store failures are not misreported as bad JSON.
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
