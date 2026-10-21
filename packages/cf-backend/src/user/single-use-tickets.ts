/**
 * A ticket, kept only as its hash: minted for a while and spent once. Spending deletes it, so a ticket is live or gone;
 * nothing records that it was used. Device and CLI agent connects, and a device's join, mint and spend through here.
 */
import { type ConnectionTicketPurpose, sha256Hex } from '@kinu.run/core';
import type { SqlRow, UserObjectHost } from './user-host';

/** One minute: long enough to open the socket it was minted for, no longer. */
const TICKET_TTL_MS = 60 * 1000;

/** The tickets of one purpose in `connection_tickets`: a ticket of another purpose is no ticket here. */
export class SingleUseTickets<Row extends SqlRow> {
  constructor(
    private readonly sqlx: UserObjectHost['sqlx'],
    private readonly purpose: ConnectionTicketPurpose,
    private readonly columns: readonly (keyof Row & string)[],
    private readonly ttlMs: number = TICKET_TTL_MS,
  ) {}

  /** Stores `ticket`'s hash with `row`; returns when it expires. Expired tickets go first. */
  mint(ticket: string, row: Row, now: number): number {
    const expiresAt = now + this.ttlMs;

    this.sqlx('DELETE FROM connection_tickets WHERE expires_at <= ?', now);
    this.sqlx(
      `INSERT INTO connection_tickets (ticket_hash, purpose, expires_at, ${this.columns.join(', ')})
        VALUES (?, ?, ?, ${this.columns.map(() => '?').join(', ')})`,
      sha256Hex(ticket), this.purpose, expiresAt, ...this.columns.map((column) => row[column] ?? null),
    );

    return expiresAt;
  }

  /** The row `ticket` was minted with and when it expires, deleted in the same statement; null for a ticket expired,
   * spent, never minted, or minted for another purpose. */
  spend(ticket: string, now: number): (Row & { readonly expires_at: number }) | null {
    this.sqlx('DELETE FROM connection_tickets WHERE expires_at <= ?', now);

    return this.sqlx<Row & { expires_at: number }>(
      `DELETE FROM connection_tickets WHERE ticket_hash = ? AND purpose = ? AND expires_at > ? RETURNING expires_at, ${this.columns.join(', ')}`,
      sha256Hex(ticket), this.purpose, now,
    )[0] ?? null;
  }
}
