/**
 * Alternate Takes view logic — the pure half of the chat's takes chip +
 * comparison (AlternateTakes.tsx renders it). Kept separate so the cycling,
 * labeling, and evidence formatting are unit-testable without a DOM.
 */
import type { AlternateTakeSet } from '@kinu.run/core';

/** The candidate currently serving as the answer: the user's pick when one
 *  exists, else the convergence winner. */
export function currentTakeIndex(set: AlternateTakeSet): number {
  const current = set.chosenNodeId ?? set.winnerNodeId;
  const index = set.candidates.findIndex((c) => c.nodeId === current);
  return index >= 0 ? index : 0;
}

/** The answer-card chip label — e.g. "Take 1 of 3". */
export function takeChipLabel(set: AlternateTakeSet): string {
  return `Take ${currentTakeIndex(set) + 1} of ${set.candidates.length}`;
}

/** Wrap-around carousel step (delta of ±1 from the arrows / arrow keys). */
export function cycleTakeIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return ((current + delta) % count + count) % count;
}

/** A set is comparable when there is a genuine choice to make. */
export function hasComparableTakes(set: AlternateTakeSet | undefined | null): set is AlternateTakeSet {
  return !!set && set.candidates.length >= 2;
}
