/**
 * GEPA Merge operator — Appendix F of the paper.
 *
 * The paper's Merge picks two candidates with complementary strengths
 * (different lineages, distinct per-instance winners) and constructs a
 * child that combines the best version of each module from each parent.
 *
 * Kinu's primary GEPA target is the scaffold source — a single file,
 * not a multi-module system. The paper's structural Merge (pick module
 * `j` from lineage A, module `k` from lineage B) doesn't apply directly.
 * The honest analogue for single-file artifacts is **reflective merge**:
 * hand both candidates + their per-instance score vectors to the
 * reflection LM and ask it to synthesise a hybrid that keeps each
 * parent's specialty.
 *
 * Triggering rule (matches the paper's spirit): merge is attempted only
 * when the pool contains a complementary pair — two candidates each best
 * on at least one instance and each NOT strictly dominating the other.
 * Random or aggregate-greedy pair selection is rejected; merging two
 * similar candidates is wasteful.
 */

import type {
  GepaCandidate, EvalInstance, ReflectionLM,
} from './types';
import { renderInput, truncate } from './text';
import { stripMarkdownFences } from '../../prompts/structured';

export interface MergePair {
  a: GepaCandidate;
  b: GepaCandidate;
  /** Instance ids where `a` strictly outperforms `b`. */
  aDominates: string[];
  /** Instance ids where `b` strictly outperforms `a`. */
  bDominates: string[];
}

/** Find a complementary pair in the pool — two candidates that are each best
 *  on some instances and neither strictly dominates the other. Returns null
 *  if no such pair exists. */
export function findComplementaryPair(
  pool: ReadonlyArray<GepaCandidate>,
  instanceIds: ReadonlyArray<string>,
  random: () => number,
): MergePair | null {
  if (pool.length < 2) return null;
  const pairs: MergePair[] = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i];
      const b = pool[j];
      const aDom: string[] = [];
      const bDom: string[] = [];
      for (const id of instanceIds) {
        const sa = a.scores.get(id) ?? 0;
        const sb = b.scores.get(id) ?? 0;
        if (sa > sb) aDom.push(id);
        else if (sb > sa) bDom.push(id);
      }
      // Each side must win on at least one instance; otherwise one strictly
      // dominates the other (or they're identical).
      if (aDom.length === 0 || bDom.length === 0) continue;
      pairs.push({ a, b, aDominates: aDom, bDominates: bDom });
    }
  }
  if (pairs.length === 0) return null;
  // Weight pairs by total complementary surface so distinctly-complementary
  // pairs are preferred over almost-similar ones.
  let total = 0;
  for (const p of pairs) total += p.aDominates.length + p.bDominates.length;
  let r = random() * total;
  for (const p of pairs) {
    r -= p.aDominates.length + p.bDominates.length;
    if (r <= 0) return p;
  }
  return pairs[pairs.length - 1];
}

/** Render the merge-reflection prompt — the LM sees both parents, their
 *  per-instance score vectors, and the instances each one wins on. */
export function renderMergePrompt<I, E>(opts: {
  pair: MergePair;
  evalSet: ReadonlyArray<EvalInstance<I, E>>;
  artifactDescription?: string;
}): string {
  const desc = opts.artifactDescription ?? 'candidate artifact';
  const instanceById = new Map(opts.evalSet.map(i => [i.id, i] as const));
  const lines = (label: 'A' | 'B', wins: ReadonlyArray<string>): string[] => {
    if (wins.length === 0) return [`${label} wins on: (none)`];
    const out: string[] = [`${label} wins on:`];
    for (const id of wins) {
      const inst = instanceById.get(id);
      const inputStr = inst ? renderInput(inst.input) : '(unknown)';
      const wText = label === 'A'
        ? `score(A)=${opts.pair.a.scores.get(id)?.toFixed(2) ?? '0'} vs score(B)=${opts.pair.b.scores.get(id)?.toFixed(2) ?? '0'}`
        : `score(B)=${opts.pair.b.scores.get(id)?.toFixed(2) ?? '0'} vs score(A)=${opts.pair.a.scores.get(id)?.toFixed(2) ?? '0'}`;
      out.push(`  - ${id}: ${wText}`);
      if (inst) out.push(`    input: ${truncate(inputStr, 200)}`);
    }
    return out;
  };
  return `You are merging two ${desc}s that complement each other — each one
solves different inputs better. Synthesise a hybrid that keeps the specialties
of both. Do not naively concatenate; produce a single coherent ${desc} that
behaves like A on A's strengths and like B on B's strengths.

Candidate A (aggregate ${opts.pair.a.aggregateScore.toFixed(3)}):
\`\`\`
${truncate(opts.pair.a.source, 3000)}
\`\`\`

Candidate B (aggregate ${opts.pair.b.aggregateScore.toFixed(3)}):
\`\`\`
${truncate(opts.pair.b.source, 3000)}
\`\`\`

${lines('A', opts.pair.aDominates).join('\n')}

${lines('B', opts.pair.bDominates).join('\n')}

Return ONLY the merged ${desc} source — no commentary, no markdown fences.`;
}

/** Run the LM-driven merge. Returns the synthesised source string. */
export async function proposeMerge<I, E>(opts: {
  pair: MergePair;
  evalSet: ReadonlyArray<EvalInstance<I, E>>;
  reflectionLm: ReflectionLM;
  artifactDescription?: string;
}): Promise<string> {
  const prompt = renderMergePrompt({
    pair: opts.pair,
    evalSet: opts.evalSet,
    artifactDescription: opts.artifactDescription,
  });
  const raw = await opts.reflectionLm(prompt);
  return stripMarkdownFences(raw);
}
