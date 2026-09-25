/** The owner's roster, paged in SQL, and the socket its changes arrive on. */
import * as v from 'valibot';
import { rosterMatches, WorkspaceOverviewSchema, WS_OPEN, type RosterBucket, type SqlExec, type WorkspaceOverview } from '@kinu.run/core';
import type { WorkspaceEntry } from './user-do';

export const ROSTER_SOCKET_PATH = '/roster/live';

const ROSTER_SOCKET_TAG = 'roster';

const WORKSPACE_LIST_LIMIT = 200;

export interface RosterEntry extends WorkspaceEntry {
  overview: WorkspaceOverview | null;
  /** With the owner's pending release approvals, which a tile cannot know. */
  decisions: number;
}

export interface RosterCounts {
  all: number;
  needs: number;
  working: number;
  idle: number;
  unreported: number;
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
  bucket?: Exclude<RosterBucket, 'unreported'>;
  query?: string;
}

export interface RosterFrame {
  type: 'workspace';
  name: string;
  entry: RosterEntry | null;
  counts: RosterCounts;
}

const ACTIVE = 'w.archived_at IS NULL AND w.delete_pending = 0 AND w.create_pending = 0';

const FROM = `FROM user_workspaces w
  LEFT JOIN workspace_overviews o ON o.name = w.name
  LEFT JOIN (SELECT c.agent_name AS name, COUNT(*) AS pending FROM release_approvals p
             JOIN release_changes c ON c.id = p.change_id WHERE p.decision = 'pending' GROUP BY c.agent_name) a
    ON a.name = w.name`;

const DECISIONS = 'COALESCE(o.decisions, 0) + COALESCE(a.pending, 0)';

const BUCKET = `CASE WHEN ${DECISIONS} > 0 THEN 'needs' WHEN o.activity IS NULL THEN 'unreported'
  WHEN o.activity = 'working' THEN 'working' ELSE 'idle' END`;

const ENTRY = `SELECT w.name, w.display_name AS displayName, w.created_at AS createdAt, w.last_visited AS lastVisited,
  w.archived_at AS archivedAt, o.overview, COALESCE(o.decisions, 0) + COALESCE(a.pending, 0) AS decisions`;

const RosterRowSchema = v.object({
  name: v.string(),
  displayName: v.string(),
  createdAt: v.number(),
  lastVisited: v.number(),
  archivedAt: v.nullable(v.number()),
  overview: v.nullable(v.string()),
  decisions: v.number(),
});

type RosterRow = v.InferOutput<typeof RosterRowSchema>;

const CountRowSchema = v.object({ bucket: v.picklist(['needs', 'working', 'idle', 'unreported']), n: v.number(), decisions: v.number() });

const SearchRowSchema = v.object({ name: v.string(), displayName: v.string() });

const NameRowSchema = v.object({ name: v.string() });

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

/** A tile a later schema cannot read shows as none until the workspace pushes again. */
function rosterEntry(row: RosterRow): RosterEntry {
  const stored = row.overview === null ? null : v.safeParse(WorkspaceOverviewSchema, JSON.parse(row.overview));

  return {
    name: row.name, displayName: row.displayName, createdAt: row.createdAt, lastVisited: row.lastVisited, archivedAt: row.archivedAt,
    overview: stored?.success === true ? { ...stored.output, decisionsWaiting: row.decisions } : null,
    decisions: row.decisions,
  };
}

/** A superset, since the title shown is `workspaceDisplayTitle`'s; `rosterMatches` decides. */
function searchClause(query: string) {
  const needle = query.trim().toLowerCase();
  // LIKE folds ASCII case only.
  const ascii = new TextEncoder().encode(needle).length === needle.length;

  if (needle === '' || 'untitled workspace'.includes(needle) || !ascii) return { sql: '', bindings: [] };
  const pattern = `%${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

  return { sql: " AND (w.display_name LIKE ? ESCAPE '\\' OR w.name LIKE ? ESCAPE '\\')", bindings: [pattern, pattern] };
}

export function rosterCounts(sql: SqlExec): RosterCounts {
  const counts: RosterCounts = { all: 0, needs: 0, working: 0, idle: 0, unreported: 0, decisions: 0 };

  for (const raw of sql.exec(`SELECT ${BUCKET} AS bucket, COUNT(*) AS n, SUM(${DECISIONS}) AS decisions ${FROM} WHERE ${ACTIVE} GROUP BY bucket`).toArray()) {
    const row = v.parse(CountRowSchema, raw);
    counts[row.bucket] = row.n;
    counts.all += row.n;
    counts.decisions += row.decisions;
  }

  return counts;
}

/** `idx_user_workspaces_roster` serves the order and the cursor. */
function pageRows(sql: SqlExec, query: RosterQuery, cursor: { v: number; n: string } | null, limit: number): RosterRow[] {
  const search = searchClause(query.query ?? '');
  const bucket = query.bucket === undefined ? '' : ` AND ${BUCKET} = ?`;
  const after = cursor === null ? '' : ' AND (w.last_visited < ? OR (w.last_visited = ? AND w.name > ?))';

  return sql.exec(`${ENTRY} ${FROM} WHERE ${ACTIVE}${after}${bucket}${search.sql} ORDER BY w.last_visited DESC, w.name ASC LIMIT ?`,
    ...(cursor === null ? [] : [cursor.v, cursor.v, cursor.n]), ...(query.bucket === undefined ? [] : [query.bucket]), ...search.bindings, limit)
    .toArray().map((raw) => v.parse(RosterRowSchema, raw));
}

/** A chunk short of matches reads on past its last row. */
export function rosterPage(sql: SqlExec, query: RosterQuery = {}): RosterPage {
  const limit = clampRosterLimit(query.limit);
  const entries: RosterEntry[] = [];
  let cursor = decodeRosterCursor(query.cursor);
  let more = false;

  for (;;) {
    const rows = pageRows(sql, query, cursor, limit + 1);

    for (const row of rows) {
      if (!rosterMatches(row, query.query ?? '')) continue;

      if (entries.length === limit) {
        more = true;
        break;
      }

      entries.push(rosterEntry(row));
    }

    const last = rows.at(-1);

    if (more || rows.length <= limit || last === undefined) break;
    cursor = { v: last.lastVisited, n: last.name };
  }

  const counts = rosterCounts(sql);
  const lastEntry = entries.at(-1);

  return {
    entries, total: rosterTotal(sql, query, counts), nextCursor: more && lastEntry !== undefined ? encodeRosterCursor(lastEntry) : null, counts,
  };
}

function rosterTotal(sql: SqlExec, query: RosterQuery, counts: RosterCounts): number {
  if ((query.query ?? '').trim() === '') return query.bucket === undefined ? counts.all : counts[query.bucket];
  const search = searchClause(query.query ?? '');
  const bucket = query.bucket === undefined ? '' : ` AND ${BUCKET} = ?`;
  let total = 0;

  for (const raw of sql.exec(`SELECT w.name, w.display_name AS displayName ${FROM} WHERE ${ACTIVE}${bucket}${search.sql}`,
    ...(query.bucket === undefined ? [] : [query.bucket]), ...search.bindings).toArray()) {
    if (rosterMatches(v.parse(SearchRowSchema, raw), query.query ?? '')) total += 1;
  }

  return total;
}

/** Past these, only a visit's push reports it. */
const ROSTER_NUDGE_ATTEMPTS = 6;

export function unreportedWorkspaces(sql: SqlExec, now: number): string[] {
  return sql.exec(`SELECT w.name FROM user_workspaces w
    LEFT JOIN workspace_overviews o ON o.name = w.name LEFT JOIN workspace_overview_nudges n ON n.name = w.name
    WHERE ${ACTIVE} AND o.name IS NULL AND (n.name IS NULL OR (n.attempts < ? AND n.next_at <= ?))`, ROSTER_NUDGE_ATTEMPTS, now)
    .toArray().map((row) => v.parse(NameRowSchema, row).name);
}

export function rosterRow(sql: SqlExec, name: string): RosterEntry | null {
  const [raw] = sql.exec(`${ENTRY} ${FROM} WHERE ${ACTIVE} AND w.name = ?`, name).toArray();

  return raw === undefined ? null : rosterEntry(v.parse(RosterRowSchema, raw));
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
