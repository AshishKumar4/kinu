/**
 * A ticket, kept only as its hash: minted for a while and spent once. Spending deletes it, so a ticket is live or gone;
 * nothing records that it was used. Device and CLI agent connects, and a device's join, mint and spend through here.
 */
import { sha256Hex } from '@kinu.run/core';
import type { SqlRow, UserObjectHost } from './user-host';

/** One minute: long enough to open the socket it was minted for, no longer. */
const TICKET_TTL_MS = 60 * 1000;

type TicketTable = 'device_connect_tickets' | 'cli_agent_connect_tickets' | 'device_joins';

export class SingleUseTickets<Row extends SqlRow> {
  constructor(
    private readonly sqlx: UserObjectHost['sqlx'],
    private readonly table: TicketTable,
    private readonly columns: readonly (keyof Row & string)[],
    private readonly ttlMs: number = TICKET_TTL_MS,
  ) {}

  /** Stores `ticket`'s hash with `row`; returns when it expires. Expired tickets go first. */
  mint(ticket: string, row: Row, now: number): number {
    const expiresAt = now + this.ttlMs;

    this.sqlx(`DELETE FROM ${this.table} WHERE expires_at <= ?`, now);
    this.sqlx(
      `INSERT INTO ${this.table} (ticket_hash, expires_at, ${this.columns.join(', ')}) VALUES (?, ?, ${this.columns.map(() => '?').join(', ')})`,
      sha256Hex(ticket), expiresAt, ...this.columns.map((column) => row[column] ?? null),
    );

    return expiresAt;
  }

  /** The row `ticket` was minted with and when it expires, deleted in the same statement; null for a ticket expired,
   * spent or never minted. */
  spend(ticket: string, now: number): (Row & { readonly expires_at: number }) | null {
    this.sqlx(`DELETE FROM ${this.table} WHERE expires_at <= ?`, now);

    return this.sqlx<Row & { expires_at: number }>(
      `DELETE FROM ${this.table} WHERE ticket_hash = ? AND expires_at > ? RETURNING expires_at, ${this.columns.join(', ')}`, sha256Hex(ticket), now,
    )[0] ?? null;
  }
}
