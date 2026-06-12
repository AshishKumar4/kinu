/**
 * Sibling diversity at expansion.
 *
 * MCTS expands N branches in PARALLEL from the same parent, so a branch can
 * never see a sibling's *output* before producing its own. Without a diversity
 * signal the N branches share an identical prompt and diverge on sampling
 * temperature alone — the judge then calibrates "score relative to siblings"
 * over near-duplicates (THINKING-AUDIT-2026-06-12 §4 DO-NOW #1).
 *
 * The fix gives each branch a distinct ANGLE and tells it the angles its
 * siblings were handed, with an explicit "propose an approach DISTINCT from the
 * others" instruction. The angles are deterministic and LLM-free, so diversity
 * costs nothing and is reproducible. Grounding: diversity-aware / DPP sampling.
 */

/** Orthogonal solution angles, in priority order. Index i seeds branch i. */
const DIVERSITY_ANGLES: readonly string[] = [
  'the most direct, conventional solution',
  'a fundamentally different algorithm or data structure than the obvious one',
  'the simplest possible solution, even if it sacrifices generality',
  'a performance- or scale-oriented solution',
  'an approach that anticipates edge cases and failure modes first',
  'a solution that reuses existing utilities/libraries over bespoke code',
];

/** The angle assigned to branch `i` of `n`. Wraps if n exceeds the angle list. */
export function diversityAngle(i: number, n: number): string {
  if (n <= 1) return DIVERSITY_ANGLES[0]!;
  return DIVERSITY_ANGLES[i % DIVERSITY_ANGLES.length]!;
}

/** The angles assigned to branch i's SIBLINGS (every branch but i). Threaded
 *  into explore() so each branch knows what to differ from. Empty for n<=1. */
export function siblingAngles(i: number, n: number): string[] {
  if (n <= 1) return [];
  const out: string[] = [];
  for (let j = 0; j < n; j++) {
    if (j !== i) out.push(diversityAngle(j, n));
  }
  return out;
}

/** Render the diversity directive a branch appends to its explore prompt: the
 *  sibling angles it must differ from. Returns '' when there is no diversity to
 *  enforce (single branch / no siblings). Shared by every explore() backend. */
export function diversityDirective(siblings: readonly string[]): string {
  if (siblings.length === 0) return '';
  const others = siblings.map((s, k) => `${k + 1}. ${s}`).join('\n');
  return (
    `\n\nYou are ONE of several approaches explored in parallel for this task. ` +
    `Sibling approaches are pursuing these DISTINCT angles:\n${others}\n` +
    `Propose an approach that is genuinely DISTINCT from those siblings — do not converge on the same idea.`
  );
}
