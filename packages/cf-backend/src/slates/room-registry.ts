/**
 * Every room a workspace made for its slates, built or not, and where each fork came from. A room serves its own image
 * and holds its own people, link and listing, so the workspace's deletion retires every room this names; and a fork's
 * room is made knowing its parent, so code someone else wrote is never taken for its forker's own.
 */
import * as v from 'valibot';
import type { RawSqlExec } from '@kinu.run/core';

export function initSlateRoomRegistry(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS slate_rooms (
    slate  TEXT PRIMARY KEY,
    parent TEXT
  )`);
}

export class SlateRoomRegistry {
  constructor(private readonly sql: SqlStorage) {}

  /** A fork landed as `slate`: its room, whenever it is made, names `parent`, the slate it was forked from. */
  forked(slate: string, parent: string): void {
    this.sql.exec('INSERT INTO slate_rooms (slate, parent) VALUES (?, ?) ON CONFLICT (slate) DO UPDATE SET parent = excluded.parent', slate, parent);
  }

  /** `slate`'s room is being made: recorded first, so no room exists that the registry does not name. Its parent, if a fork. */
  making(slate: string): string | null {
    this.sql.exec('INSERT OR IGNORE INTO slate_rooms (slate, parent) VALUES (?, NULL)', slate);
    const row = this.sql.exec('SELECT parent FROM slate_rooms WHERE slate = ?', slate).toArray()[0];

    return v.parse(v.object({ parent: v.nullable(v.string()) }), row).parent;
  }

  slates(): string[] {
    return this.sql.exec('SELECT slate FROM slate_rooms ORDER BY slate').toArray().map((row) => v.parse(v.object({ slate: v.string() }), row).slate);
  }

  /** The slate was removed and its room retired: a slate made again under its name is no fork. */
  forget(slate: string): void {
    this.sql.exec('DELETE FROM slate_rooms WHERE slate = ?', slate);
  }
}
