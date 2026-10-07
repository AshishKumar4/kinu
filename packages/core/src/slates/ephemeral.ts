import * as v from 'valibot';
import type { RawSqlExec, SqlExec } from '../types/primitives';

/** An answer's pages keep a process and a reservation each; these are the ones that do, by when each was last drawn. */
export function initEphemeralSlateTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS ephemeral_slates (
    id TEXT PRIMARY KEY,
    drawn_at INTEGER NOT NULL
  )`);
}

export class EphemeralSlates {
  constructor(private readonly db: SqlExec) {}

  /** Records `id` drawn at `now`, and forgets and answers every page beyond the `limit` drawn most recently. */
  drawn(id: string, now: number, limit: number): readonly string[] {
    this.db.exec('INSERT INTO ephemeral_slates (id, drawn_at) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET drawn_at = excluded.drawn_at', id, now);

    const beyond = this.db.exec('SELECT id FROM ephemeral_slates ORDER BY drawn_at DESC, id LIMIT -1 OFFSET ?', limit).toArray()
      .map((row) => v.parse(v.string(), row.id));

    for (const old of beyond) this.db.exec('DELETE FROM ephemeral_slates WHERE id = ?', old);

    return beyond;
  }
}
