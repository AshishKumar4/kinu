/**
 * GEPA Merge (Appendix F), as reflective merge: a single-file artifact has no modules
 * to splice, so the reflection LM synthesises a hybrid from two complementary parents.
 * Attempted only when the pool holds a pair each best somewhere and neither dominating.
 */

import type {
  GepaCandidate, EvalInstance, ReflectionLM,
} from './types';
import { renderInput, truncate } from './text';
import { stripMarkdownFences } from '../../prompts/structured';

export interface MergePair {
  a: GepaCandidate;
  b: GepaCandidate;
  aDominates: string[];
  bDominates: string[];
}

/** Two candidates each best on some instances with neither strictly dominating; null if none. */
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

      if (aDom.length === 0 || bDom.length === 0) continue;
      pairs.push({ a, b, aDominates: aDom, bDominates: bDom });
    }
  }

  if (pairs.length === 0) return null;
  // Prefer distinctly complementary pairs over almost-similar ones.
  let total = 0;

  for (const p of pairs) total += p.aDominates.length + p.bDominates.length;
  let r = random() * total;

  for (const p of pairs) {
    r -= p.aDominates.length + p.bDominates.length;

    if (r <= 0) return p;
  }

  return pairs[pairs.length - 1];
}

/** States the `checkConstraints` survival contract up front: a violating child is only rejected after a paid scoring pass. */
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
      const inputStr = inst ? renderInput(inst) : '(unknown)';

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

Naive concatenation, and what to do instead:
  Bad: both sources pasted one after the other, or all of A wrapped in a branch on a condition neither parent has. Two artifacts in one file, the entry point defined twice, and neither parent's behaviour intact.
  Good: ONE artifact carrying the specific mechanism behind each parent's wins — A's handling of the inputs A wins on, B's of B's — and a single definition of everything they both have.

Everything the two parents share structurally must survive intact: the entry point they export, the
host API they call through, and the shape of what they return. A child that drops one of those is
refused by the constraint gate downstream, after a full eval-set scoring pass has already been paid
for it.

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
