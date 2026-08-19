/**
 * The archive — §6.3's grid of cells, and the admission test that keeps it a grid.
 *
 * WHAT THE SUBSTRATE IS, AND WHY THERE IS NO SECOND STORE. `exploration_records`
 * ALREADY IS the grid, and the check was made before anything was built rather than
 * assumed: a row is keyed `(objectiveId, floorDigest, descriptor, artifactDigest)`,
 * `descriptor` IS the cell coordinate, `bestInCell` is that cell's elite, no row's
 * value ever falls, and `admitsPublication` gates every write. An archive is a grid of
 * cells each holding the best candidate for its coordinate, which is that table read
 * one descriptor partition at a time. So this file adds a POLICY over the store and
 * not a store beside it.
 *
 * WHAT THE STORE GENUINELY LACKED, all three named rather than discovered later:
 *
 * 1. AN OCCUPANCY READ. `recordsFor` spans every cell and `bestInCell` returns one
 *    row; an admission test needs one cell's whole population. That is
 *    {@link cellOccupants}, one more SELECT over the same table.
 * 2. A REJECTION TEST. Nothing in the store measures how close two artifacts are,
 *    and it should not: the store decides whether a write LOWERS a cell, the archive
 *    decides whether a candidate BELONGS in one. {@link noveltyDistance} is the
 *    second question and it lives here.
 * 3. A COORDINATE THAT IS NOT A FREE STRING. `descriptor` is `TEXT`, so nothing in
 *    the store stops two runs writing coordinates on different dimensions into one
 *    identity's cell space. {@link archiveCellOf} makes the descriptor
 *    `<key>=<witnessed value>` — the dimension the run declared, together with the
 *    coordinate its INSTRUMENT reported — so a run keyed on one dimension cannot
 *    collide with a run keyed on another, and no cell coordinate is ever a claim a
 *    node made about itself.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *
 * NO EVICTION RULE. `isBetter`'s docstring names displacement, eviction and a cell's
 * best as its three call sites and the store implements two. The third is not missing
 * here, it is unreachable by construction: nothing is ever deleted from a cell,
 * because the thing that bounds a cell's population is the admission test rather than
 * a row cap — a candidate too close to an occupant never lands, so a cell cannot
 * accumulate the near-copies an eviction rule would exist to remove. §11.4's *"cell
 * capacity is a number nobody has measured"* is therefore a number this file does not
 * have to invent, which is the point.
 *
 * NO BIN WIDTH. A coordinate is the value the instrument reported, at the resolution
 * the instrument reports it. Binning a continuous descriptor into a grid needs a width,
 * that width is unmeasured, and an invented one silently decides how much coverage a
 * run can claim. So the grid's resolution is a property of the instrument, stated,
 * rather than a constant here that no evidence supports.
 *
 * NO JUDGED DESCRIPTOR, and this is a refusal §6.5 already carries with its evidence:
 * judge variance in the archive KEY is unrecoverable, because a mis-ranked candidate can
 * be re-ranked while a mis-binned elite is silently lost — a grid that fills completely
 * with bins holding the wrong behaviours reports coverage it does not have. The
 * coordinate is witnessed by the same instrument that measured the value — §2.3's
 * *measured, never asserted*, applied to the descriptor as well as to the number.
 */
import { admitsPublication, type ExplorationRecord, type PublicationState } from './objective';
import { cellOccupants, recordExploration, type ExplorationWrite, type RecordVerdict } from './records';
import type { SqlExecutor } from '../types/primitives';

/**
 * The cell a candidate belongs to, or the fact that its instrument witnessed none.
 *
 * Two arms rather than a nullable string, because *"this candidate has no cell"* and
 * *"this candidate is in the unnamed cell"* are the distinction `descriptor`'s
 * nullability exists to keep — one of them is an archive that cannot place a
 * candidate, the other is a flat run's single partition, and collapsing them is how a
 * run reports coverage it never measured.
 */
export type ArchiveCell =
  | { readonly kind: 'cell'; readonly descriptor: string }
  | {
      readonly kind: 'unwitnessed';
      /** Every quantity the instrument DID report, sorted — so a refusal can name the
       *  keys a caller could have asked for instead of only the one that missed. */
      readonly reported: readonly string[];
    };

/**
 * The grid coordinate for one candidate: the run's declared `key`, and the value the
 * instrument reported for it.
 *
 * `MeasuredValue.measured` is where a witnessed quantity lives — *"raw quantities the
 * value was derived from"* — and it is the only place a coordinate can come from
 * without either a second model binning candidates or a node labelling itself. That
 * bounds what a key may name today: the map is `Record<string, number>`, so an archive
 * bins on a quantity an instrument counts. A categorical coordinate — §6.3's ATT&CK
 * tactic, a finding class — needs the instrument to report one, which is a change to a
 * registered verifier kind and is named here rather than faked by asking a node.
 *
 * THE MAP AND NOT THE MEASUREMENT, because an `Unmeasurable` carries one too: the
 * baseline check that refuses a key no instrument witnesses has to read the quantities a
 * verifier reported whether or not it produced a value, and a signature over
 * a `MeasuredValue` would silently skip that case.
 *
 * A NON-FINITE value is `unwitnessed` rather than a cell called `"NaN"`: a coordinate
 * that is not a number does not identify a partition, and stringifying it would make
 * every unmeasurable descriptor share one cell.
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

/** Tokens as the vocabulary of an answer: lowercased words, punctuation dropped, order
 *  and repetition discarded by the Set the caller builds. */
const TOKEN = /[a-z0-9']+/g;

/**
 * How far apart two artifacts are, in [0,1]: one minus the Jaccard overlap of their
 * token sets. 0 is *the same vocabulary*, 1 is *nothing in common*.
 *
 * WHY THIS AND NOT BLEU, which is the measure Rainbow Teaming's τ filter is stated over.
 * That filter compares a mutant against its PARENT, which is a strictly weaker test than
 * novelty against a cell's occupants, so it is evidence that a rejection test is needed
 * and not a threshold this file inherits — and it says nothing about which measure an
 * archive-side test should use. On that question BLEU decides itself out:
 * BLEU is asymmetric — it scores a candidate against a reference — so using it here
 * would need a rule saying which of the candidate and the occupant is the reference,
 * and an admission test that answers differently depending on arrival order lets A
 * into a cell that would have refused it had B arrived first. Jaccard distance is
 * symmetric and a true metric, so the archive's contents do not depend on the order
 * its runs happened in beyond what the monotone rule already decides. It is also
 * deterministic and model-free, which the descriptor rule above requires of anything
 * that decides a cell.
 *
 * NOT the two private token-overlap helpers already in the tree, and both exclusions
 * are behavioural rather than stylistic: `evolution/behavior-labels.ts` returns 0
 * below a five-word floor, which here would read as *maximally novel* and admit every
 * short answer into every cell; `craft/conflict.ts` splits on whitespace alone, so
 * `solve(x)` and `solve(x);` are different tokens and a semicolon buys a candidate its
 * novelty.
 */
export function noveltyDistance(left: string, right: string): number {
  const first = new Set(left.toLowerCase().match(TOKEN) ?? []);
  const second = new Set(right.toLowerCase().match(TOKEN) ?? []);
  let shared = 0;
  for (const token of first) if (second.has(token)) shared += 1;
  const union = first.size + second.size - shared;
  // Two artifacts with no tokens at all are the same artifact, not two novel ones.
  return union === 0 ? 0 : 1 - shared / union;
}

/**
 * A write into an archive: {@link ExplorationWrite} with the cell REQUIRED.
 *
 * `descriptor: string` rather than `string | null`, so an archive write with no cell is
 * not a value that can be constructed — the same move that put `novelty` on the
 * `advance:'archive'` arm instead of beside it.
 */
export interface ArchiveWrite extends Omit<ExplorationWrite, 'descriptor'> {
  readonly descriptor: string;
}

/**
 * What the archive did with one candidate.
 *
 * The store's own verdicts pass through unchanged — a refused write is refused for the
 * store's reason, not re-labelled by the layer above — and the archive adds exactly the
 * one cause it owns.
 */
export type ArchiveVerdict =
  | RecordVerdict
  | {
      readonly kind: 'refused';
      readonly cause: 'too-close';
      /** The occupant it collided with, by the identity a cell keys on: its content
       *  digest. Named because a rejection a reader cannot trace is indistinguishable
       *  from a threshold set wrong. */
      readonly occupant: string;
      /** How far apart they actually were, against the floor that refused it. Both, so
       *  the refusal reports the comparison rather than only its outcome. */
      readonly distance: number;
      readonly novelty: number;
    };

/**
 * Admit one candidate to its cell, or refuse and say which occupant it duplicated.
 *
 * THE SEAL IS CHECKED HERE, FIRST, AND IT IS NOT A DUPLICATE OF THE TWO GATES AROUND
 * IT. `admitCarry` decides admission at the settle barrier and `recordExploration`
 * decides a write, and §4.4's hole was exactly a publication path that called itself
 * separate and unchanged — so a third path that reached the store would need its own
 * check whatever the other two do. What makes this one load-bearing rather than
 * ceremonial is the ORDER: everything below it READS the cell, and a breached run must
 * not so much as inspect the store it may not write. Without the check a sealed run
 * would compute novelty against occupants it is not entitled to see and report a
 * candidate as *too close to* one of them, which names the wrong cause for the wrong
 * reason — the run was not refused for duplicating anything, it was refused for having
 * crossed its floor.
 *
 * THE NEAREST OCCUPANT IS THE ONE NAMED, not the first one that fails. A cell is read
 * best-first, so refusing on the first failure would name whichever occupant the
 * ordering happened to put on top and report 0.35 as the offender while an exact
 * duplicate sat two rows down. The occupant a refusal names has to be a fact about the
 * candidate rather than about the sort.
 *
 * AN IDENTICAL ARTIFACT IS NOT AN ADMISSION QUESTION. Identity within a cell is what
 * the artifact IS, so re-recording the same bytes addresses the row that already
 * exists, and the monotone rule decides it. Skipping it here is what keeps a run from
 * refusing its own incumbent as a duplicate of itself.
 */
export function admitToArchive(
  sql: SqlExecutor,
  input: {
    readonly publication: PublicationState;
    readonly write: ArchiveWrite;
    /** The distance floor a candidate must CLEAR, from `advance:{kind:'archive'}`. */
    readonly novelty: number;
  },
): ArchiveVerdict {
  const { write, novelty } = input;
  if (admitsPublication(input.publication, 'records').kind === 'refused') {
    return { kind: 'refused', cause: 'sealed' };
  }

  let nearest: { readonly occupant: ExplorationRecord; readonly distance: number } | null = null;
  for (const occupant of cellOccupants(sql, {
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
  return recordExploration(sql, { publication: input.publication, write });
}
