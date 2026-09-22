/**
 * Sibling diversity at expansion: parallel siblings cannot see each other's output, so each gets
 * a distinct deterministic angle plus the angles its siblings were handed.
 */

/** Solution approaches in priority order; index i seeds branch i. */
const DIVERSITY_APPROACHES: readonly string[] = [
  'the most direct, conventional solution',
  'a fundamentally different algorithm or data structure than the obvious one',
  'the simplest possible solution, even if it sacrifices generality',
  'a performance- or scale-oriented solution',
  'an approach that anticipates edge cases and failure modes first',
  'a solution that reuses existing utilities/libraries over bespoke code',
];

/** A second axis, where the work starts, so waves wider than the approach list stay distinct. */
const DIVERSITY_STARTING_POINTS: readonly string[] = [
  'starting from the constraints the answer has to satisfy',
  'starting from one concrete worked example and generalising from it',
  'starting from the failure you most expect and designing it out first',
  'starting from what already exists and changing the least that works',
];

/**
 * The angle assigned to branch `i` of `n`. Distinct for the first 30 branches (six approaches,
 * then each under four starting points); past that pairs repeat, and callers supply `nodes`.
 */
export function diversityAngle(i: number, n: number): string {
  if (n <= 1) return DIVERSITY_APPROACHES[0] ?? '';
  const approach = DIVERSITY_APPROACHES[i % DIVERSITY_APPROACHES.length] ?? '';

  // The first pass over the approaches carries no starting point.
  if (i < DIVERSITY_APPROACHES.length) return approach;

  const startingPoint = DIVERSITY_STARTING_POINTS[
    Math.floor(i / DIVERSITY_APPROACHES.length) % DIVERSITY_STARTING_POINTS.length
  ] ?? '';

  return `${approach}, ${startingPoint}`;
}

/** The angles assigned to branch i's siblings; empty for n<=1. */
export function siblingAngles(i: number, n: number): string[] {
  if (n <= 1) return [];
  const angles: string[] = [];

  for (let sibling = 0; sibling < n; sibling++) {
    if (sibling !== i) angles.push(diversityAngle(sibling, n));
  }

  return angles;
}

/** The diversity directive a branch appends to its explore prompt; '' with no siblings. */
export function diversityDirective(siblings: readonly string[]): string {
  if (siblings.length === 0) return '';
  const listed = siblings.map((angle, index) => `${index + 1}. ${angle}`).join('\n');

  return (
    `\n\nYou are ONE of several approaches explored in parallel for this task. ` +
    `Sibling approaches are pursuing these DISTINCT angles:\n${listed}\n` +
    `Propose an approach that is genuinely DISTINCT from those siblings — do not converge on the same idea.`
  );
}
