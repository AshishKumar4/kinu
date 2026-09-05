/**
 * The decision rule, applied to measured cells and to nothing else.
 *
 * One rule does all the work: an arm is ranked only where EVERY cell it owns is
 * `ok` AND its dispersion is inside the reporting threshold. An unavailable
 * arm, a corrupt transfer, or a failed transfer never lands in a ranking — not
 * last, not with an asterisk: OUT, with its exclusion reason named beside the
 * ranking it could not join. A number that cannot be trusted must not be
 * ordered against numbers that can.
 */

import { PAYLOAD_ARMS, PAYLOAD_SIZES_MIB, type PayloadArmId, type PayloadSizeMiB } from './arms';
import { UNSTABLE_CV, summarize, throughputMiBs } from '../r2-bench/stats';
import type { Cell, Verdict } from './schema';

/**
 * What this instrument says about the @cloudflare/sandbox docstring that
 * claims "~24 MB/s throughput vs ~0.6 MB/s for base64 readFile". Rendered
 * verbatim into every report.
 */
export const SDK_THROUGHPUT_CLAIM_NOTE =
  'The @cloudflare/sandbox source comment claiming "~24 MB/s throughput vs '
  + '~0.6 MB/s for base64 readFile" is UNVERIFIED by this report: it ships as a '
  + 'docstring with no published method and no stated conditions. The numbers '
  + 'below were measured here and stand on their own; they neither confirm nor '
  + 'retire that claim unless their conditions happen to match, which nobody '
  + 'can currently demonstrate.';

/**
 * Whether a loopback WorkerEntrypoint call executes co-resident with its
 * caller — same isolate, same machine, or across the network — is not
 * documented by the platform. Rendered verbatim into every report.
 */
export const LOOPBACK_RESIDENCY_NOTE =
  'The physical placement of the loopback entrypoint hop is UNKNOWN: whether a '
  + 'self-service-binding call runs co-resident with the caller or crosses a '
  + 'network boundary is not documented by the platform. Treat the loopback '
  + 'arm as "the entrypoint hop as invoked from the same Worker", not as a '
  + 'measured locality.';

/**
 * Image freshness, decided BEFORE any cell is accepted. A stale or unreadable
 * running image is an infrastructure failure that CENSORS the run — it never
 * becomes transfer data.
 */
export type ImageVerdict =
  | { readonly kind: 'ok'; readonly observed: string }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'stale'; readonly pinned: string; readonly observed: string };

/**
 * Deterministic redrive decision. The container daemon owns the process table;
 * a RUNNING process is read, an EXITED process is final and stays pollable.
 * Only a MISSING record starts work.
 */
export function operationNeedsStart(existing: { exitCode?: number | null } | null): boolean {
  return existing === null;
}

export function judgeImage(pinnedImage: string, observed: string | null): ImageVerdict {
  if (observed === null) return { kind: 'unknown' };
  const pinnedTag = pinnedImage.split(':').pop() ?? '';
  return observed.startsWith(pinnedTag)
    ? { kind: 'ok', observed }
    : { kind: 'stale', pinned: pinnedImage, observed };
}

export const CPU_ACCOUNTING_NOTE =
  'CPU per arm is UNKNOWN. workerd exposes no per-request CPU counter to the '
  + 'request path, and Workers analytics aggregates cannot attribute CPU to one '
  + 'arm of one run. Byte volumes are exact because this instrument constructs '
  + 'them; CPU would be inference, so it is reported as unknown instead.';

/** Median wall time of one cell family (all reps of one arm/op/size). */
function medianWallMs(cells: readonly Cell[]): number | null {
  const walls = cells.filter((cell) => cell.wallMs !== null).map((cell) => cell.wallMs!);
  if (walls.length === 0) return null;
  return summarize(walls).p50;
}

const EXCLUSION_REASON = {
  unavailable: 'the arm was unavailable before the run started',
  failed: 'a transfer threw',
  corrupt: 'a completed transfer returned wrong bytes',
  unstable: 'repetitions disagreed beyond the reporting threshold',
} as const;

function statusOf(cells: readonly Cell[]): 'ok' | 'unavailable' | 'failed' | 'corrupt' {
  if (cells.some((cell) => cell.status === 'corrupt')) return 'corrupt';
  if (cells.some((cell) => cell.status === 'failed')) return 'failed';
  if (cells.some((cell) => cell.status === 'unavailable')) return 'unavailable';
  return 'ok';
}

/**
 * Rank the arms for one size tier. Both directions count: an arm earns a row
 * only when every PUT and GET cell at this size is ok and stable, because a
 * transport that uploads fast but downloads slowly is not "fast" — it is half
 * measured.
 */
export function rankTier(cells: readonly Cell[], sizeMiB: PayloadSizeMiB): Verdict {
  const tierCells = cells.filter((cell) => cell.sizeMiB === sizeMiB);
  const ranked: { arm: PayloadArmId; medianMiBs: number }[] = [];
  const exclusions: { arm: PayloadArmId; reason: string }[] = [];

  for (const arm of PAYLOAD_ARMS) {
    const own = tierCells.filter((cell) => cell.arm === arm);
    if (own.length === 0) continue;

    const status = statusOf(own);
    if (status !== 'ok') {
      exclusions.push({ arm, reason: EXCLUSION_REASON[status]! });
      continue;
    }
    const putMedian = medianWallMs(own.filter((cell) => cell.op === 'put'));
    const getMedian = medianWallMs(own.filter((cell) => cell.op === 'get'));
    if (putMedian === null || getMedian === null) {
      exclusions.push({ arm, reason: 'no completed transfers to rank' });
      continue;
    }
    const putWalls = own.filter((cell) => cell.op === 'put' && cell.wallMs !== null)
      .map((cell) => cell.wallMs!);
    const getWalls = own.filter((cell) => cell.op === 'get' && cell.wallMs !== null)
      .map((cell) => cell.wallMs!);
    // Dispersion on EITHER direction disqualifies the arm at this tier.
    if (summarize(putWalls).cv > UNSTABLE_CV || summarize(getWalls).cv > UNSTABLE_CV) {
      exclusions.push({ arm, reason: EXCLUSION_REASON['unstable']! });
      continue;
    }
    // The tier's figure is the SLOWER direction: a transport is as good as its
    // worst leg, and reporting max(put, get) cannot flatter anyone.
    const slowestMedianMs = Math.max(putMedian, getMedian);
    ranked.push({
      arm,
      medianMiBs: throughputMiBs(sizeMiB, slowestMedianMs),
    });
  }

  if (ranked.length < 2) {
    return {
      kind: 'no-ranking',
      sizeMiB,
      reason: ranked.length === 0
        ? 'no arm completed this tier cleanly enough to measure'
        : 'only one arm completed this tier cleanly; a ranking needs two',
      exclusions,
    };
  }
  ranked.sort((a, b) => b.medianMiBs - a.medianMiBs);
  return { kind: 'ranking', sizeMiB, ranked, exclusions };
}

export function decideAll(cells: readonly Cell[]): readonly Verdict[] {
  return PAYLOAD_SIZES_MIB.map((sizeMiB) => rankTier(cells, sizeMiB));
}
