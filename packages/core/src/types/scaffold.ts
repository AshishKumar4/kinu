export type ScaffoldStatus = 'current' | 'pending' | 'rolled_back' | 'historical';

export interface ScaffoldArchiveEntry {
  version: number;
  /** Null for v0 / pre-lineage rows. */
  parentVersion: number | null;
  status: ScaffoldStatus;
  rationale: string;
  /** Failure cell this version targets (`<complaint>/<shape>`); keyed on, never interpreted. */
  pathology: string | null;
  writtenAt: number;
  trials: number;
  wins: number;
  losses: number;
  ties: number;
  /** Over decisive (non-tie) trials; null when never decisively tried. */
  winRate: number | null;
}

/** snake_case keys are the wire shape the web surface reads. */
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

export interface ModifyResult {
  ok: boolean;
  version?: number;
  error?: string;
  stage?: number;
}
