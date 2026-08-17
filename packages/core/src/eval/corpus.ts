// Eval corpus loader — JSONL format. One EvalCase per line.
//
// Standard shape:
//   {"id": "math-001", "task": "What is 17 * 23?", "reference": "391",
//    "tags": ["math", "trivial"]}
import * as v from 'valibot';
import type { EvalCase } from './types.js';
import { JsonObjectSchema } from '../utils/json.js';

// `v.object` STRIPS keys it does not declare rather than rejecting them, so a
// field missing from this schema is not a loud error — it silently vanishes
// between the JSONL and the case. Every field EvalCase carries must therefore
// appear here.
const CaseSchema = v.object({
  id: v.string(),
  task: v.string(),
  rubric: v.optional(v.string()),
  reference: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),
  env: v.optional(v.string()),
  params: v.optional(JsonObjectSchema),
});

export function parseCorpus(jsonl: string): EvalCase[] {
  const lines = jsonl.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const out: EvalCase[] = [];
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
    out.push(result.output);
  }
  return out;
}
