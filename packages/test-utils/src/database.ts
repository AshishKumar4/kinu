import { Database } from 'bun:sqlite';

/** A workspace database on disk as `kinu create` publishes it: in WAL, where the runtime commits without an fsync. */
export function workspaceDatabase(path: string, options?: ConstructorParameters<typeof Database>[1]): Database {
  const db = new Database(path, options);
  db.exec('PRAGMA journal_mode = WAL');

  return db;
}
