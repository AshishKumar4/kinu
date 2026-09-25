/** The owner's roster as its pages read it, and the socket each change arrives on; no workspace is asked. */
import * as v from 'valibot';
import { rosterBucket, rosterMatches, WorkspaceOverviewSchema, WS_OPEN, type RosterBucket, type WorkspaceOverview } from '@kinu.run/core';
import type { WorkspaceEntry } from './user-do';

export const ROSTER_SOCKET_PATH = '/roster/live';

const ROSTER_SOCKET_TAG = 'roster';

const WORKSPACE_LIST_LIMIT = 200;

export interface RosterEntry extends WorkspaceEntry {
  /** `decisionsWaiting` counts the owner's release approvals too. */
  overview: WorkspaceOverview | null;
}

export interface RosterCounts {
  all: number;
  needs: number;
  working: number;
  idle: number;
  decisions: number;
}

/** `total` counts what the query matches; `counts`, the whole roster. */
export interface RosterPage {
  entries: RosterEntry[];
  total: number;
  nextCursor: string | null;
  counts: RosterCounts;
}

export interface RosterQuery {
  cursor?: string | null;
  limit?: number;
  bucket?: RosterBucket;
  query?: string;
}

export interface RosterRow extends WorkspaceEntry {
  overview: string | null;
  activity: WorkspaceOverview['activity'] | null;
  decisions: number;
}

export interface RosterFrame {
  type: 'workspace';
  name: string;
  entry: RosterEntry | null;
  counts: RosterCounts;
}

function encodeRosterCursor(entry: Pick<WorkspaceEntry, 'name' | 'lastVisited'>): string {
  return encodeURIComponent(JSON.stringify({ v: entry.lastVisited, n: entry.name }));
}

const RosterCursorSchema = v.strictObject({ v: v.number(), n: v.string() });

function decodeRosterCursor(cursor?: string | null): { v: number; n: string } | null {
  if (cursor == null || cursor === '') return null;
  let raw: unknown;

  try {
    raw = JSON.parse(decodeURIComponent(cursor));
  } catch (e) {
    throw new Error('Invalid workspace roster cursor; start from page one.', { cause: e });
  }

  const parsed = v.safeParse(RosterCursorSchema, raw);

  if (!parsed.success) throw new Error('Invalid workspace roster cursor; start from page one.');

  return parsed.output;
}

function clampRosterLimit(limit?: number): number {
  if (limit === undefined) return WORKSPACE_LIST_LIMIT;

  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Workspace roster limit must be a positive integer.');

  return Math.min(limit, WORKSPACE_LIST_LIMIT);
}

function rowBucket(row: RosterRow): RosterBucket {
  return rosterBucket(row.activity, row.decisions);
}

/** A tile a later schema cannot read shows as none until the workspace pushes again. */
export function rosterEntry(row: RosterRow): RosterEntry {
  const stored = row.overview === null ? null : v.safeParse(WorkspaceOverviewSchema, JSON.parse(row.overview));

  return {
    name: row.name, displayName: row.displayName, createdAt: row.createdAt, lastVisited: row.lastVisited, archivedAt: row.archivedAt,
    overview: stored?.success === true ? { ...stored.output, decisionsWaiting: row.decisions } : null,
  };
}

export function rosterCounts(rows: readonly RosterRow[]): RosterCounts {
  const counts: RosterCounts = { all: rows.length, needs: 0, working: 0, idle: 0, decisions: 0 };

  for (const row of rows) {
    counts[rowBucket(row)] += 1;
    counts.decisions += row.decisions;
  }

  return counts;
}

export function rosterPage(rows: readonly RosterRow[], query: RosterQuery = {}): RosterPage {
  const limit = clampRosterLimit(query.limit);
  const cursor = decodeRosterCursor(query.cursor);

  const matching = rows.filter((row) => (query.bucket === undefined || rowBucket(row) === query.bucket)
    && rosterMatches(row, query.query ?? ''));

  const after = cursor === null ? 0 : matching.findIndex((row) => row.lastVisited < cursor.v
    || (row.lastVisited === cursor.v && row.name > cursor.n));

  const start = after < 0 ? matching.length : after;
  const page = matching.slice(start, start + limit);
  const last = page.at(-1);

  return {
    entries: page.map(rosterEntry),
    total: matching.length,
    nextCursor: start + limit < matching.length && last !== undefined ? encodeRosterCursor(last) : null,
    counts: rosterCounts(rows),
  };
}

const RosterAttachmentSchema = v.object({ roster: v.literal(true) });

export function isRosterSocket(ws: WebSocket): boolean {
  return v.is(RosterAttachmentSchema, ws.deserializeAttachment());
}

/** Hibernatable, so the object sleeps between frames. */
export function acceptRosterSocket(ctx: DurableObjectState, request: Request): Response {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 });
  }

  const [client, server] = Object.values(new WebSocketPair());
  ctx.acceptWebSocket(server, [ROSTER_SOCKET_TAG]);
  server.serializeAttachment({ roster: true });
  const init: ResponseInit & { webSocket: WebSocket } = { status: 101, webSocket: client };

  return new Response(null, init);
}

export function rosterSockets(ctx: DurableObjectState): WebSocket[] {
  return ctx.getWebSockets(ROSTER_SOCKET_TAG);
}

export function sendRosterFrame(sockets: readonly WebSocket[], frame: RosterFrame): void {
  const text = JSON.stringify(frame);

  for (const socket of sockets) {
    if (socket.readyState === WS_OPEN) socket.send(text);
  }
}
