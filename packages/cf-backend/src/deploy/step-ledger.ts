// A run's ledger in its object's SQLite (`deploy_step`, made by deploy-do.ts `initSchema`): one row per step, which a
// reload renders and an eviction resumes. The run object tells its page of each change (`broadcast`).
// cf-only by design (scripts/capability-parity.lock.json): a browser run must outlive a closed tab and resume, which a
// terminal `kinu deploy` does not need, so a copy in the CLI would be dead code.
import * as v from 'valibot';
import { DeployStepRowSchema, type DeployLedger, type DeployStepFailure, type DeployStepRow, type DeployStepSeed } from '@kinu.run/core/deploy';

interface StepRecord extends Record<string, SqlStorageValue> {
  id: string;
  seq: number;
  title: string;
  state: string;
  attempt: number;
  detail: string;
  notes: string;
  failure: string | null;
  facts: string;
}

const FailureSchema = DeployStepRowSchema.entries.failure;

const FactsSchema = DeployStepRowSchema.entries.facts;

const NotesSchema = DeployStepRowSchema.entries.notes;

const StateSchema = DeployStepRowSchema.entries.state;

/** What the run object does when a step changes. */
export interface LedgerHost {
  broadcast(): Promise<void>;
  /** After a step went through, before the page hears of it. */
  settled(id: string): Promise<void>;
}

export function stepRows(sql: SqlStorage): readonly DeployStepRow[] {
  return sql.exec<StepRecord>(`SELECT * FROM deploy_step ORDER BY seq`).toArray().map((row) => ({
    id: row.id,
    seq: row.seq,
    title: row.title,
    state: v.parse(StateSchema, row.state),
    attempt: row.attempt,
    detail: row.detail,
    notes: v.parse(NotesSchema, JSON.parse(row.notes)),
    failure: row.failure === null ? null : v.parse(FailureSchema, JSON.parse(row.failure)),
    facts: v.parse(FactsSchema, JSON.parse(row.facts)),
  }));
}

export function stepLedger(sql: SqlStorage, host: LedgerHost): DeployLedger {
  return {
    rows: async () => stepRows(sql),
    seed: async (steps: readonly DeployStepSeed[]) => {
      for (const step of steps) {
        sql.exec(
          `INSERT INTO deploy_step (id, seq, title, state) VALUES (?, ?, ?, 'pending')
           ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, title = excluded.title`,
          step.id, step.seq, step.title,
        );
      }
    },
    started: async (id: string, attempt: number) => {
      sql.exec(`UPDATE deploy_step SET state = 'running', attempt = ?, failure = NULL WHERE id = ?`, attempt, id);
      await host.broadcast();
    },
    noted: (id: string, note: string) => {
      const row = sql.exec<{ notes: string }>(`SELECT notes FROM deploy_step WHERE id = ?`, id).toArray()[0];
      const notes = row === undefined ? [] : v.parse(NotesSchema, JSON.parse(row.notes));

      sql.exec(`UPDATE deploy_step SET notes = ? WHERE id = ?`, JSON.stringify([...notes, note]), id);
    },
    settled: async (id: string, detail: string, facts: Readonly<Record<string, string>>) => {
      sql.exec(`UPDATE deploy_step SET state = 'done', detail = ?, facts = ?, failure = NULL WHERE id = ?`, detail, JSON.stringify(facts), id);
      await host.settled(id);
      await host.broadcast();
    },
    failed: async (id: string, failure: DeployStepFailure) => {
      sql.exec(`UPDATE deploy_step SET state = 'failed', failure = ? WHERE id = ?`, JSON.stringify(failure), id);
      await host.broadcast();
    },
  };
}
