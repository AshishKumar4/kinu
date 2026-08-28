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

/** Orthogonal solution APPROACHES, in priority order. Index i seeds branch i. */
const DIVERSITY_APPROACHES: readonly string[] = [
  'the most direct, conventional solution',
  'a fundamentally different algorithm or data structure than the obvious one',
  'the simplest possible solution, even if it sacrifices generality',
  'a performance- or scale-oriented solution',
  'an approach that anticipates edge cases and failure modes first',
  'a solution that reuses existing utilities/libraries over bespoke code',
];

/**
 * A second axis, orthogonal to the approach: where the work STARTS.
 *
 * WHY IT EXISTS. The angle used to be `APPROACHES[i % 6]`, so branch 7 was handed
 * branch 1's angle BYTE FOR BYTE — and since the angle is the only thing that differs
 * between siblings in the count-based mode, two siblings of a seven-wide wave were
 * asked an identical question and then compared against each other. `ideate` runs 5
 * and the named presets run 3-5, so the wrap was invisible until a caller asked for a
 * wider wave; `branches` has no upper bound.
 *
 * A SECOND AXIS RATHER THAN A LONGER LIST, because a list long enough to cover any
 * width would be six real distinctions padded with restatements of them. Where an
 * approach starts from is genuinely independent of which approach it takes, so the
 * pair is `approaches x starting points` distinct assignments over the same six
 * honest distinctions — and a caller who wants assignments the engine cannot invent
 * states them itself with `nodes`.
 */
const DIVERSITY_STARTING_POINTS: readonly string[] = [
  'starting from the constraints the answer has to satisfy',
  'starting from one concrete worked example and generalising from it',
  'starting from the failure you most expect and designing it out first',
  'starting from what already exists and changing the least that works',
];

/**
 * The angle assigned to branch `i` of `n`: a solution approach, and where it starts.
 *
 * The two axes advance at different rates — the approach per branch, the starting
 * point once the approaches have been exhausted — so the first six branches of a wave
 * read exactly as they always did and only a wider wave reaches the second axis.
 *
 * DISTINCT FOR THE FIRST 30 BRANCHES: six approaches alone, then those six under each
 * of four starting points. Past 30 the pair repeats, and that is a stated bound rather
 * than a hidden one — a wave that wide is asking the engine to invent distinctions it
 * does not have, and a caller who has real ones states them with `nodes`.
 */
export function diversityAngle(i: number, n: number): string {
  if (n <= 1) return DIVERSITY_APPROACHES[0] ?? '';
  const approach = DIVERSITY_APPROACHES[i % DIVERSITY_APPROACHES.length] ?? '';
  // The first pass over the approaches carries no starting point: those six are the
  // honest distinctions on their own, and pinning a starting point onto them would
  // narrow six angles that every run this engine has ever done has read.
  if (i < DIVERSITY_APPROACHES.length) return approach;
  const startingPoint = DIVERSITY_STARTING_POINTS[
    Math.floor(i / DIVERSITY_APPROACHES.length) % DIVERSITY_STARTING_POINTS.length
  ] ?? '';
  return `${approach}, ${startingPoint}`;
}

/** The angles assigned to branch i's SIBLINGS (every branch but i). Threaded
 *  into explore() so each branch knows what to differ from. Empty for n<=1. */
export function siblingAngles(i: number, n: number): string[] {
  if (n <= 1) return [];
  const angles: string[] = [];
  for (let sibling = 0; sibling < n; sibling++) {
    if (sibling !== i) angles.push(diversityAngle(sibling, n));
  }
  return angles;
}

/** Render the diversity directive a branch appends to its explore prompt: the
 *  sibling angles it must differ from. Returns '' when there is no diversity to
 *  enforce (single branch / no siblings). Shared by every explore() backend. */
export function diversityDirective(siblings: readonly string[]): string {
  if (siblings.length === 0) return '';
  const listed = siblings.map((angle, index) => `${index + 1}. ${angle}`).join('\n');
  return (
    `\n\nYou are ONE of several approaches explored in parallel for this task. ` +
    `Sibling approaches are pursuing these DISTINCT angles:\n${listed}\n` +
    `Propose an approach that is genuinely DISTINCT from those siblings — do not converge on the same idea.`
  );
}
