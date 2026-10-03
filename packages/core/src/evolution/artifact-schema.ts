/** The tables of the artifact store and its live trials (docs/EVOLUTION-REDESIGN.md §3, §5), apart from their logic so a workspace's schema reaches no tool module. */
import { sqlCheckList } from '../identity/schema';
import type { RawSqlExec } from '../types/primitives';

export const ARTIFACT_STATUSES = ['current', 'candidate', 'trial', 'rolled_back', 'historical'] as const;

const TRIAL_STATUSES = ['running', 'kept', 'reverted'] as const;

export const ARMS = ['candidate', 'incumbent'] as const;

export function initArtifactTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS artifact_versions (
    actor_id    TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    version     INTEGER NOT NULL,
    body        TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN (${sqlCheckList(ARTIFACT_STATUSES)})),
    parent      INTEGER,
    rationale   TEXT NOT NULL,
    evidence    TEXT,
    written_at  INTEGER NOT NULL,
    decided_at  INTEGER,
    PRIMARY KEY (actor_id, artifact_id, version)
  )`);
  execRaw('CREATE INDEX IF NOT EXISTS idx_artifact_versions_status ON artifact_versions(actor_id, status, artifact_id)');
}

export function initTrialTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS artifact_trials (
    actor_id    TEXT NOT NULL,
    trial_id    TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    version     INTEGER NOT NULL,
    status      TEXT NOT NULL CHECK (status IN (${sqlCheckList(TRIAL_STATUSES)})),
    looks       INTEGER NOT NULL DEFAULT 0,
    started_at  INTEGER NOT NULL,
    decided_at  INTEGER,
    verdict     TEXT,
    PRIMARY KEY (actor_id, trial_id)
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS trial_turns (
    actor_id   TEXT NOT NULL,
    trial_id   TEXT NOT NULL,
    turn_id    TEXT NOT NULL,
    segment_id TEXT NOT NULL,
    arm        TEXT NOT NULL CHECK (arm IN (${sqlCheckList(ARMS)})),
    at         INTEGER NOT NULL,
    PRIMARY KEY (actor_id, trial_id, turn_id)
  )`);
  execRaw('CREATE INDEX IF NOT EXISTS idx_trial_turns_segment ON trial_turns(actor_id, trial_id, at DESC)');
}
