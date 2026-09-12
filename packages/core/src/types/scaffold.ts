/** The scaffold-version contract, declared at the platform layer: the
 *  agent-self tool surface reads versions without importing the evolution,
 *  replay, modify or archive machinery. */

export type ScaffoldStatus = 'current' | 'pending' | 'rolled_back' | 'historical';

export interface ScaffoldArchiveEntry {
  version: number;
  /** The version this one branched from (null for v0 / pre-lineage rows). */
  parentVersion: number | null;
  status: ScaffoldStatus;
  rationale: string;
  /** The failure cell this version was written to fix (`<complaint>/<shape>`,
   *  evolution/pathology.ts), or null when the proposal named none. Read as a
   *  plain string here: the archive keys on it, it never interprets it. */
  pathology: string | null;
  writtenAt: number;
  /** Shadow-eval record while this version was the pending under trial. */
  trials: number;
  wins: number;
  losses: number;
  ties: number;
  /** Win-rate over decisive (non-tie) trials; null when never decisively tried. */
  winRate: number | null;
}

/** The scaffold variant archive: recent versions with status, DGM lineage and
 *  aggregated shadow-eval record. snake_case keys are the wire shape the web
 *  surface has always read (ScaffoldLineage.tsx reads `written_at`). */
export interface ScaffoldVersionView {
  version: number;
  written_at: number;
  rationale: string;
  status: ScaffoldArchiveEntry['status'];
  parent_version: number | null;
  trials: number;
  wins: number;
  losses: number;
  ties: number;
  win_rate: number | null;
}

/** Outcome of one scaffold proposal through the 4-gate pipeline. */
export interface ModifyResult {
  ok: boolean;
  version?: number;
  error?: string;
  stage?: number;
}
