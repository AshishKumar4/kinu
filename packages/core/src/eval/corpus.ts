// JSONL, one EvalCase per line; `#` lines are comments.
import * as v from 'valibot';
import { EvalBudgetSchema, type EvalCase } from './types';
import { JsonObjectSchema } from '../utils/json';

// Strict so an undeclared field fails loudly instead of vanishing; list every EvalCase field.
const CaseSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  task: v.pipe(v.string(), v.minLength(1)),
  rubric: v.optional(v.string()),
  reference: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),
  env: v.optional(v.string()),
  params: v.optional(JsonObjectSchema),
  budget: v.optional(EvalBudgetSchema),
});

export function parseCorpus(jsonl: string): EvalCase[] {
  const lines = jsonl.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const out: EvalCase[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    let parsed: unknown;

    try { parsed = JSON.parse(lines[i]); }
    catch (error) {
      throw new Error(`Eval corpus line ${i + 1}: invalid JSON`, { cause: error });
    }

    const result = v.safeParse(CaseSchema, parsed);

    if (!result.success) {
      throw new Error(`Eval corpus line ${i + 1}: ${result.issues.map(x => x.message).join('; ')}`);
    }

    if (seen.has(result.output.id)) {
      throw new Error(`Eval corpus line ${i + 1}: duplicate id "${result.output.id}"`);
    }

    seen.add(result.output.id);
    out.push(result.output);
  }

  return out;
}
