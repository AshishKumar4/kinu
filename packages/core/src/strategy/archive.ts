/**
 * The archive: a grid of cells over a descriptor, and the admission test that keeps it a grid.
 * `exploration_records` is the grid (`descriptor` is the cell coordinate, `bestInCell` its elite);
 * this file adds a policy over that store, not a second store.
 *
 * No eviction rule: admitted occupants stay pairwise `novelty` apart
 * (`ArchiveAdmission.lean — separation_is_invariant, no_near_copy_is_reachable`), but a cell's
 * population is unbounded (`ArchiveAdmission.lean — separated_cells_are_unboundedly_large`),
 * and admission reads the whole cell. No bin width, no judged descriptor.
 * Spec: docs/EXPLORATION.md "The archive".
 */
import { admitsPublication, type ExplorationRecord, type PublicationState } from './objective';
import {
  cellOccupants, publicationOf, recordExploration, type ExplorationWrite, type RecordVerdict,
} from './records';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';

/** A candidate's cell, or `unwitnessed` when its instrument reported no coordinate (distinct from the unnamed cell). */
export type ArchiveCell =
  | { readonly kind: 'cell'; readonly descriptor: string }
  | {
      readonly kind: 'unwitnessed';
      /** Every quantity the instrument did report, sorted. */
      readonly reported: readonly string[];
    };

/**
 * The grid coordinate `<key>=<value>` from the instrument's measured quantities, never from a node.
 * Takes the quantities map, not the measurement, so an `Unmeasurable` is handled too.
 * A non-finite value is `unwitnessed`, not a cell called `"NaN"`.
 */
export function archiveCellOf(
  key: string, quantities: Readonly<Record<string, number>> | undefined,
): ArchiveCell {
  const coordinate = quantities?.[key];

  if (coordinate === undefined || !Number.isFinite(coordinate)) {
    return { kind: 'unwitnessed', reported: quantities ? Object.keys(quantities).sort() : [] };
  }

  return { kind: 'cell', descriptor: `${key}=${String(coordinate)}` };
}

const TOKEN = /[a-z0-9']+/g;

/**
 * One minus the Jaccard overlap of two artifacts' token sets, in [0,1].
 * Must be symmetric (so admission does not depend on arrival order), deterministic and model-free.
 */
export function noveltyDistance(left: string, right: string): number {
  const first = new Set(left.toLowerCase().match(TOKEN) ?? []);
  const second = new Set(right.toLowerCase().match(TOKEN) ?? []);
  let shared = 0;

  for (const token of first) if (second.has(token)) shared += 1;
  const union = first.size + second.size - shared;

  // Two artifacts with no tokens at all are the same artifact.
  return union === 0 ? 0 : 1 - shared / union;
}

/** {@link ExplorationWrite} with the cell required. */
export interface ArchiveWrite extends Omit<ExplorationWrite, 'descriptor'> {
  readonly descriptor: string;
}

/** Store verdicts pass through unchanged; the archive adds only `too-close`. */
export type ArchiveVerdict =
  | RecordVerdict
  | {
      readonly kind: 'refused';
      readonly cause: 'too-close';
      /** Content digest of the nearest occupant. */
      readonly occupant: string;
      readonly distance: number;
      readonly novelty: number;
    };

/**
 * Admit one candidate to its cell, or refuse and name the nearest occupant it duplicates.
 * The seal check must run first: a sealed run must not read the cell it may not write.
 * An identical artifact is skipped here; the monotone rule decides it.
 */
export function admitToArchive(
  sql: SqlExecutor,
  actor: ActorHandle,
  input: {
    readonly publication: PublicationState;
    readonly write: ArchiveWrite;
    /** The distance floor a candidate must clear, from `advance:{kind:'archive'}`. */
    readonly novelty: number;
  },
): ArchiveVerdict {
  const { write, novelty } = input;

  if (admitsPublication(input.publication, 'records').kind === 'refused') {
    return { kind: 'refused', cause: 'sealed' };
  }

  actor.assertCurrent();

  if (admitsPublication(publicationOf(sql, actor, input.publication, write), 'records').kind === 'refused') {
    return { kind: 'refused', cause: 'sealed' };
  }

  let nearest: { readonly occupant: ExplorationRecord; readonly distance: number } | null = null;

  for (const occupant of cellOccupants(sql, actor, {
    identity: write.identity, floor: write.floor, descriptor: write.descriptor,
  })) {
    if (occupant.artifact === write.artifact) continue;
    const distance = noveltyDistance(write.artifact, occupant.artifact);

    if (nearest === null || distance < nearest.distance) nearest = { occupant, distance };
  }

  if (nearest !== null && nearest.distance < novelty) {
    return {
      kind: 'refused',
      cause: 'too-close',
      occupant: nearest.occupant.artifactDigest,
      distance: nearest.distance,
      novelty,
    };
  }

  return recordExploration(sql, actor, { publication: input.publication, write });
}
