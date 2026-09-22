/**
 * The swarm model recovered from what the exploration store persisted: the run's preset-or-label,
 * each node's rationale, and how the run ended. Nothing else is inferred; a `custom`
 * composition's axes are not persisted in a readable form.
 * Specified by docs/EXPLORATION.md: "The six axes", "Presets", "Settle is derived", "Refusals".
 */
import { settleOf, SWARM_PRESET_POINTS, type SwarmPresetRow } from '../strategy/swarm';
import {
  NAMED_SWARM_PRESETS,
  type NamedSwarmPreset, type SwarmConfig, type SwarmSettle,
} from '../types/swarm';
import type { HeadRunView } from '../heads/types';

export type SwarmAxis = "unit" | "context" | "expand" | "score" | "advance" | "carry";

export interface SwarmAxisRow {
  readonly axis: SwarmAxis;
  readonly value: string;
}

export type SwarmResolution =
  | {
      readonly kind: "preset";
      readonly preset: NamedSwarmPreset;
      readonly config: SwarmConfig;
      /** Derived from the resolved axes by `settleOf`, never chosen. */
      readonly settle: SwarmSettle;
      /** The preset row's default caps; a caller override is not recorded. */
      readonly depth: number;
      readonly branches: number;
    }
  | { readonly kind: "custom"; readonly label: string };

/** Resolution behind `HeadRunView.rationale` (`resolved.label ?? resolved.preset`); null when
 *  none was recorded, e.g. `unit:'thought'` runs write no journal. */
export function swarmResolutionOf(label: string | null | undefined): SwarmResolution | null {
  const named = label?.trim();

  if (!named) return null;
  const preset = NAMED_SWARM_PRESETS.find((candidate) => candidate === named);

  if (preset === undefined) return { kind: "custom", label: named };
  const row: SwarmPresetRow = SWARM_PRESET_POINTS[preset];

  return {
    kind: "preset",
    preset,
    config: row.config,
    settle: settleOf(row.config),
    depth: row.depth,
    branches: row.branches,
  };
}

export function swarmAxisRows(config: SwarmConfig): readonly SwarmAxisRow[] {
  return [
    { axis: "unit", value: config.unit.kind },
    { axis: "context", value: config.context },
    { axis: "expand", value: config.expand },
    {
      axis: "score",
      value: config.score.kind === "judge"
        ? `judge ×${config.score.samples}`
        : config.score.kind,
    },
    {
      axis: "advance",
      // `≥`, not `τ`: novelty is a distance floor, and τ conventionally denotes a similarity ceiling.
      value: config.advance.kind === "archive"
        ? `archive ≥${config.advance.novelty}`
        : config.advance.kind,
    },
    {
      axis: "carry",
      value: config.carry.kind === "reflections" || config.carry.kind === "artifacts"
        ? `${config.carry.kind} ≥${config.carry.threshold}`
        : config.carry.kind,
    },
  ];
}

/** Fan-in parent count parsed from the rationale `strategy/swarm-run.ts` writes (`fan-in over k
 *  parents of depth d`); `search_nodes` keeps only one parent per row. Null for a sampled sibling. */
export function fanInArity(rationale: string | null | undefined): number | null {
  const matched = /^fan-in over (\d+) parents\b/.exec(rationale?.trim() ?? "");

  if (matched === null) return null;
  const parents = Number(matched[1]);

  // The engine never labels fewer than two parents a fan-in; below two is a misread.
  return parents >= 2 ? parents : null;
}

export function fanInVertices(head: HeadRunView | null): ReadonlyMap<string, number> {
  const vertices = new Map<string, number>();

  for (const node of head?.heads ?? []) {
    const parents = fanInArity(node.rationale);

    if (parents !== null) vertices.set(node.id, parents);
  }

  return vertices;
}

export function nodeRationales(head: HeadRunView | null): ReadonlyMap<string, string> {
  const why = new Map<string, string>();

  for (const node of head?.heads ?? []) {
    if (node.rationale.trim() !== "") why.set(node.id, node.rationale.trim());
  }

  return why;
}

/** Why a started run has no answer. Call-time refusals (`resolveSwarm`, `swarmValidity`) never
 *  reach here: they land before the root is written. */
export interface RunRefusal {
  readonly reason: "failed" | "stopped" | "no_branch";
  readonly error: string;
}

const REFUSAL_PROSE = {
  failed: "The search failed and no branch recorded a cause.",
  stopped: "The search stopped without an answer.",
  no_branch: "The search stopped before its first branch, so there is nothing to compare.",
} as const satisfies Record<RunRefusal["reason"], string>;

/** The run's refusal, or null when it has an answer or is still working. Prefers a branch's own
 *  error message over generic prose. */
export function runRefusal(
  run: {
    readonly status: "running" | "completed" | "failed" | "partial";
    readonly branches: number;
  },
  head: HeadRunView | null,
): RunRefusal | null {
  if (run.status === "running") return null;
  const branchError = head?.heads.find((node) => node.errorMessage !== null)?.errorMessage ?? null;

  if (run.status === "failed") {
    return { reason: "failed", error: branchError ?? REFUSAL_PROSE.failed };
  }

  if (run.status === "partial") {
    return { reason: "stopped", error: branchError ?? REFUSAL_PROSE.stopped };
  }

  // Completed but expanded nothing: a refusal, not an empty tree.
  if (run.branches === 0) {
    return { reason: "no_branch", error: branchError ?? REFUSAL_PROSE.no_branch };
  }

  return null;
}

export interface RunLevel {
  readonly depth: number;
  readonly running: number;
  readonly reported: number;
  readonly failed: number;
  readonly total: number;
}

/** What a search is doing now, counted off `head_journal` (the only store holding unreported
 *  nodes). */
export interface RunLiveness {
  readonly running: number;
  readonly reported: number;
  readonly failed: number;
  readonly total: number;
  /** Epoch ms of the latest step, or latest spawn where no node has stepped. */
  readonly lastEventAt: number;
  readonly levels: readonly RunLevel[];
}

/** Unknown statuses (e.g. `interrupted`) count only in `total`, never in `running`. */
function bucketOf(status: string): "running" | "reported" | "failed" | null {
  if (status === "running") return "running";

  if (status === "completed") return "reported";

  if (status === "errored" || status === "aborted") return "failed";

  return null;
}

export function runLiveness(head: HeadRunView | null): RunLiveness | null {
  const nodes = head?.heads ?? [];

  if (nodes.length === 0) return null;
  const totals = { running: 0, reported: 0, failed: 0 };
  const byDepth = new Map<number, { running: number; reported: number; failed: number; total: number }>();
  let lastEventAt = 0;

  for (const node of nodes) {
    const bucket = bucketOf(node.status);

    if (bucket !== null) totals[bucket] += 1;

    const level = byDepth.get(node.depth)
      ?? { running: 0, reported: 0, failed: 0, total: 0 };

    if (bucket !== null) level[bucket] += 1;
    level.total += 1;
    byDepth.set(node.depth, level);
    lastEventAt = Math.max(lastEventAt, node.lastStepAt ?? node.spawnedAt);
  }

  return {
    ...totals,
    total: nodes.length,
    lastEventAt,
    levels: [...byDepth.entries()]
      .sort(([a], [b]) => a - b)
      .map(([depth, counts]) => ({ depth, ...counts })),
  };
}

/** One Pareto evidence value in its own raw unit, never a percent. */
export function formatEvidenceValue(value: number): string {
  if (Number.isInteger(value)) return String(value);

  return String(Math.round(value * 1000) / 1000);
}
