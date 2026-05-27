// Eval corpus loader — JSONL format. One EvalCase per line.
//
// Standard shape:
//   {"id": "math-001", "task": "What is 17 * 23?", "reference": "391",
//    "tags": ["math", "trivial"]}
import * as v from 'valibot';
import type { EvalCase } from './types.js';

const CaseSchema = v.object({
  id: v.string(),
  task: v.string(),
  rubric: v.optional(v.string()),
  reference: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),
});

export function parseCorpus(jsonl: string): EvalCase[] {
  const lines = jsonl.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const out: EvalCase[] = [];
  for (let i = 0; i < lines.length; i++) {
    let parsed: unknown;
    try { parsed = JSON.parse(lines[i]); }
    catch (err) { throw new Error(`Eval corpus line ${i + 1}: invalid JSON: ${(err as Error).message}`); }
    const result = v.safeParse(CaseSchema, parsed);
    if (!result.success) {
      throw new Error(`Eval corpus line ${i + 1}: ${result.issues.map(x => x.message).join('; ')}`);
    }
    out.push(result.output);
  }
  return out;
}
