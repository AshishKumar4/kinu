/** Pure half of the chat's takes chip and comparison (AlternateTakes.tsx renders it). */
import type { AlternateTakeSet } from '../mcts/takes';

/** The user's pick when one exists, else the convergence winner. */
export function currentTakeIndex(set: AlternateTakeSet): number {
  const current = set.chosenNodeId ?? set.winnerNodeId;
  const index = set.candidates.findIndex((c) => c.nodeId === current);

  return index >= 0 ? index : 0;
}

export function takeChipLabel(set: AlternateTakeSet): string {
  return `Take ${currentTakeIndex(set) + 1} of ${set.candidates.length}`;
}

/** Wrap-around carousel step. */
export function cycleTakeIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;

  return ((current + delta) % count + count) % count;
}

export function hasComparableTakes(set: AlternateTakeSet | undefined | null): set is AlternateTakeSet {
  return (set?.candidates.length ?? 0) >= 2;
}
