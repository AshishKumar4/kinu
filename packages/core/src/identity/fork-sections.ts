/**
 * The row sections a fork streams, each declared once: the source rows it selects, their count, their weight on the
 * wire and where they land. The source's stream and declared counts, the receiver's dispatch and the commit's check
 * are all derived from here.
 */

import * as v from 'valibot';
import { markStoreChanged } from '@kinu.run/agent-utils';
import { SHELL_APPROVAL_AUTHORITY_KEYS } from '../config/store';
import { CHAT_SESSION_ID } from '../session/transcript-schema';
import type { SqlExecutor } from '../types/primitives';
import { parseJsonValue, type JsonValue } from '../utils/json';
import { forkConversationEntryPartRows, forkConversationEntryRow, forkSessionMessageRow, type ForkConversationPlan } from './fork-plan';
import {
  ForkAppRowSchema, ForkAppTableRowSchema, ForkConfigRowSchema, ForkContextMemberRowSchema, ForkConversationEntryPartRowSchema, ForkConversationEntryRowSchema,
  ForkCraftedToolRowSchema, ForkFactRowSchema, ForkLessonRowSchema, ForkSessionMessageRowSchema, ForkToolLessonRowSchema,
  type ForkAppRow, type ForkAppTableRow, type ForkConfigRow, type ForkContextMemberRow, type ForkConversationEntryPartRow, type ForkConversationEntryRow,
  type ForkCraftedToolRow, type ForkFactRow, type ForkLessonRow, type ForkSessionMessageRow, type ForkToolLessonRow,
} from './fork-rows';
import { openWorkspaceMainActor } from './workspace-actors';

/** Revision of the target's fresh context: a restoration of the cut membership, not a continuation. */
export const FORK_CONTEXT_REVISION = 1;

/** Each section's row as it crosses. */
export interface ForkRows {
  agentConfig: ForkConfigRow;
  craftedTools: ForkCraftedToolRow;
  sessionMessages: ForkSessionMessageRow;
  conversationEntries: ForkConversationEntryRow;
  conversationEntryParts: ForkConversationEntryPartRow;
  contextMembers: ForkContextMemberRow;
  lessons: ForkLessonRow;
  toolLessons: ForkToolLessonRow;
  facts: ForkFactRow;
  appTables: ForkAppTableRow;
  appRows: ForkAppRow;
}

export type ForkRowSection = keyof ForkRows;

/** Crossing order, which is the canonical store's foreign-key order: no transaction spans a hosted transfer. */
export const FORK_ROW_SECTIONS = [
  'agentConfig',
  'craftedTools',
  'sessionMessages',
  'conversationEntries',
  'conversationEntryParts',
  'contextMembers',
  'lessons',
  'toolLessons',
  'facts',
  'appTables',
  'appRows',
] as const satisfies readonly ForkRowSection[];

/** One value per section; the compiler holds it to every section. */
export function perSection<T>(make: (section: ForkRowSection) => T): Record<ForkRowSection, T> {
  return {
    agentConfig: make('agentConfig'),
    craftedTools: make('craftedTools'),
    sessionMessages: make('sessionMessages'),
    conversationEntries: make('conversationEntries'),
    conversationEntryParts: make('conversationEntryParts'),
    contextMembers: make('contextMembers'),
    lessons: make('lessons'),
    toolLessons: make('toolLessons'),
    facts: make('facts'),
    appTables: make('appTables'),
    appRows: make('appRows'),
  };
}

/** What a section reads on the source: its main actor's rows, the cut's plan, payloads relative to its directory. */
export interface ForkSectionSource {
  readonly sql: SqlExecutor;
  readonly actorId: string;
  readonly plan: ForkConversationPlan;
  readonly artifactDirectory: string;
  /** The `db` tool's store as the source's main actor reads it. */
  readonly appData: ForkAppData;
}

/** Where a section's rows land on the target. */
export interface ForkSectionTarget {
  readonly sql: SqlExecutor;
  readonly actorId: string;
  /** A carried payload, re-rooted under the target's own artifact directory. */
  readonly artifactPath: (relative: string) => string;
  /** The fork's one working context, made on first use. */
  readonly context: () => string;
  /** The `db` tool's store as the target's main actor writes it, opened on first use: the actor is born at `begin`. */
  readonly appData: () => ForkAppData;
}

export interface ForkSection<Row> {
  readonly rows: v.GenericSchema<Row>;
  /** The source's rows, one at a time so the sender holds a frame, never a section. */
  select(source: ForkSectionSource): Iterable<Row>;
  /** How many `select` yields, without reading the rows twice; counted by selecting when absent. */
  count?(source: ForkSectionSource): number;
  /** Payload bytes on the wire, which the frame budget bounds. */
  bytes(row: Row): number;
  stage(target: ForkSectionTarget, rows: readonly Row[]): void;
  /** Empties what an abandoned attempt landed where fork-policy.ts cannot name the tables. */
  reset?(target: ForkSectionTarget): void;
}

/**
 * The `db` tool's store as a fork reads and lands it, in the store's own codec and DDL (`AppDataStore.fork`). The
 * platform's copy, not the agent's work: no work-mode gate, and no `db_op` evidence, which records what an agent did.
 */
export interface ForkAppData {
  /** Every declared table, oldest first: its declaration's JSON text, and when it was declared. */
  tables(): ReadonlyArray<{ readonly declaration: string; readonly createdAt: number }>;
  /** Rows of `table` this store's actor may read, in insertion order after row `after` (null: from the first);
   *  `next` is null at the end. */
  page(table: string, after: number | null, limit: number): { readonly rows: Array<Record<string, JsonValue>>; readonly next: number | null };
  count(table: string): number;
  /** Declares a table from the JSON text `tables` gave, checked as `db.createTable` checks a declaration. */
  create(declaration: string, createdAt: number): void;
  insert(table: string, rows: ReadonlyArray<Record<string, JsonValue>>): void;
  /** Drops every declared table and its catalogue row: what an abandoned fork attempt landed. */
  clear(): void;
}

/** Rows of the `db` tool's tables per page read; a frame takes as many as fit its bytes. */
const APP_ROWS_PAGE = 200;

const utf8Bytes = (text: string | null): number => (text === null ? 0 : Buffer.byteLength(text, 'utf8'));

/** The source's settings, one row at a time; its shell-approval authority is its owner's, so it never crosses. */
function* configRows({ sql }: ForkSectionSource): Iterable<ForkConfigRow> {
  const actorId = openWorkspaceMainActor(sql).actorId;

  for (let rowid = 0; ;) {
    const row = sql<ForkConfigRow & { rowid: number }>`
      SELECT rowid, key, value FROM actor_config WHERE actor_id = ${actorId} AND rowid > ${rowid} ORDER BY rowid ASC LIMIT 1
    `[0];

    if (row === undefined) return;
    rowid = row.rowid;

    if (!SHELL_APPROVAL_AUTHORITY_KEYS.includes(row.key)) yield { key: row.key, value: row.value };
  }
}

/** Rows of one actor-keyed table, one at a time by rowid, so a large table never sits whole in the sender. */
function* actorRows<Row>(sql: SqlExecutor, read: (actorId: string, after: number) => { readonly rowid: number; readonly row: Row } | undefined): Iterable<Row> {
  const actorId = openWorkspaceMainActor(sql).actorId;

  for (let after = 0; ;) {
    const next = read(actorId, after);

    if (next === undefined) return;
    after = next.rowid;
    yield next.row;
  }
}

/** The source's lessons as they stood at the cut: none made after it, and one corroborated after it still provisional. */
function lessonRows({ sql, plan }: ForkSectionSource): Iterable<ForkLessonRow> {
  const cut = plan.cut.recordedAt;

  return actorRows(sql, (actorId, after) => {
    const found = sql<ForkLessonRow & { rowid: number }>`
      SELECT rowid, id, turn_ids, text, source, status, created_at, corroborated_at FROM lessons
      WHERE actor_id = ${actorId} AND created_at <= ${cut} AND rowid > ${after} ORDER BY rowid LIMIT 1
    `[0];

    if (found === undefined) return undefined;
    const later = found.corroborated_at !== null && found.corroborated_at > cut;
    const row = v.parse(ForkLessonRowSchema, { ...found, ...(later && { status: 'provisional', corroborated_at: null }) });

    return { rowid: found.rowid, row };
  });
}

const DeclaredNameSchema = v.object({ name: v.string() });

/** Each declared table's name, read from the declaration the store gives. */
function appTableNames(appData: ForkAppData): string[] {
  return appData.tables().map(({ declaration }) => v.parse(DeclaredNameSchema, parseJsonValue(declaration)).name);
}

/** The `db` tool's rows its main actor may read, every table in declaration order, a page at a time by rowid. */
function* appRows({ appData }: ForkSectionSource): Iterable<ForkAppRow> {
  for (const name of appTableNames(appData)) {
    for (let page = appData.page(name, null, APP_ROWS_PAGE); ; page = appData.page(name, page.next, APP_ROWS_PAGE)) {
      for (const row of page.rows) yield { table: name, row };

      if (page.next === null) break;
    }
  }
}

function* craftedToolRows({ sql }: ForkSectionSource): Iterable<ForkCraftedToolRow> {
  for (let rowid = 0; ;) {
    const row = sql<ForkCraftedToolRow & { rowid: number }>`
      SELECT rowid, name, description, code, created_at, updated_at FROM crafted_tools WHERE rowid > ${rowid} ORDER BY rowid ASC LIMIT 1
    `[0];

    if (row === undefined) return;
    rowid = row.rowid;
    yield { name: row.name, description: row.description, code: row.code, created_at: row.created_at, updated_at: row.updated_at };
  }
}

/** Every section's declaration, each over its own row. */
export type ForkSections = { readonly [K in ForkRowSection]: ForkSection<ForkRows[K]> };

export const FORK_SECTIONS: ForkSections = {
  agentConfig: {
    rows: ForkConfigRowSchema,
    select: configRows,
    bytes: (row) => utf8Bytes(row.key) + utf8Bytes(row.value),
    stage: ({ sql }, rows) => {
      const { config } = openWorkspaceMainActor(sql);

      for (const row of rows) config.set(row.key, row.value);
    },
  },
  craftedTools: {
    rows: ForkCraftedToolRowSchema,
    select: craftedToolRows,
    bytes: (row) => utf8Bytes(row.name) + utf8Bytes(row.description) + utf8Bytes(row.code),
    stage: ({ sql }, rows) => {
      for (const row of rows) {
        void sql`
          INSERT OR REPLACE INTO crafted_tools (name, description, code, created_at, updated_at)
          VALUES (${row.name}, ${row.description}, ${row.code}, ${row.created_at}, ${row.updated_at})
        `;
        markStoreChanged(sql);
      }
    },
  },
  sessionMessages: {
    rows: ForkSessionMessageRowSchema,
    select: function* ({ sql, actorId, plan, artifactDirectory }) {
      for (const messageId of plan.messageIds) yield forkSessionMessageRow(sql, actorId, messageId, artifactDirectory);
    },
    count: ({ plan }) => plan.messageIds.length,
    // Content is the one unbounded conversation field: inline `content_json` is a whole message's parts.
    bytes: (row) => utf8Bytes(row.message_id) + utf8Bytes(row.role) + utf8Bytes(row.native_content_kind) + utf8Bytes(row.origin)
      + utf8Bytes(row.envelope_json) + utf8Bytes(row.content_json) + utf8Bytes(row.content_path) + utf8Bytes(row.content_digest),
    // Request, output slot and ingress id are the source run's and do not cross.
    stage: ({ sql, actorId, artifactPath }, rows) => {
      for (const row of rows) {
        void sql`
          INSERT INTO session_messages
          (actor_id, message_id, role, native_content_kind, origin, request_id, output_slot, ingress_id,
           envelope_json, sealed_at, content_json, content_path, content_digest)
          VALUES (${actorId}, ${row.message_id}, ${row.role}, ${row.native_content_kind}, ${row.origin}, ${null}, ${null}, ${null},
                  ${row.envelope_json}, ${row.sealed_at}, ${row.content_json},
                  ${row.content_path === null ? null : artifactPath(row.content_path)}, ${row.content_digest})
        `;
      }
    },
  },
  conversationEntries: {
    rows: ForkConversationEntryRowSchema,
    select: function* ({ sql, actorId, plan, artifactDirectory }) {
      for (const entryId of plan.entryIds) yield forkConversationEntryRow(sql, actorId, entryId, artifactDirectory);
    },
    count: ({ plan }) => plan.entryIds.length,
    bytes: (row) => utf8Bytes(row.id) + utf8Bytes(row.role) + utf8Bytes(row.turn_id) + utf8Bytes(row.run_id)
      + utf8Bytes(row.metadata_json) + utf8Bytes(row.metadata_path) + utf8Bytes(row.metadata_digest),
    // The public chat, oldest first; its context columns stay null until publication points the cut at the fork's.
    stage: ({ sql, actorId, artifactPath }, rows) => {
      for (const row of rows) {
        void sql`
          INSERT INTO conversation_entries
          (actor_id, session_id, id, position, role, turn_id, run_id,
           metadata_json, metadata_path, metadata_digest, recorded_at, context_id, context_revision)
          VALUES (${actorId}, ${CHAT_SESSION_ID}, ${row.id}, ${row.position}, ${row.role}, ${row.turn_id}, ${row.run_id},
                  ${row.metadata_json}, ${row.metadata_path === null ? null : artifactPath(row.metadata_path)},
                  ${row.metadata_digest}, ${row.recorded_at}, ${null}, ${null})
        `;
      }
    },
  },
  conversationEntryParts: {
    rows: ForkConversationEntryPartRowSchema,
    select: function* ({ sql, actorId, plan }) {
      for (const entryId of plan.entryIds) yield* forkConversationEntryPartRows(sql, actorId, entryId);
    },
    count: ({ sql, actorId, plan }) => plan.entryIds.reduce((total, entryId) => total + (sql<{ total: number }>`
      SELECT COUNT(*) AS total FROM conversation_entry_parts
      WHERE actor_id = ${actorId} AND session_id = ${CHAT_SESSION_ID} AND entry_id = ${entryId}
    `[0]?.total ?? 0), 0),
    bytes: (row) => utf8Bytes(row.entry_id) + utf8Bytes(row.message_id),
    stage: ({ sql, actorId }, rows) => {
      for (const row of rows) {
        void sql`
          INSERT INTO conversation_entry_parts
          (actor_id, session_id, entry_id, position, message_id, part_no, text_start, text_length)
          VALUES (${actorId}, ${CHAT_SESSION_ID}, ${row.entry_id}, ${row.position}, ${row.message_id},
                  ${row.part_no}, ${row.text_start}, ${row.text_length})
        `;
      }
    },
  },
  lessons: {
    rows: ForkLessonRowSchema,
    select: lessonRows,
    bytes: (row) => utf8Bytes(row.id) + utf8Bytes(row.turn_ids) + utf8Bytes(row.text) + utf8Bytes(row.source),
    stage: ({ sql, actorId }, rows) => {
      for (const row of rows) {
        void sql`
          INSERT INTO lessons (actor_id, id, turn_ids, text, source, status, created_at, corroborated_at)
          VALUES (${actorId}, ${row.id}, ${row.turn_ids}, ${row.text}, ${row.source}, ${row.status}, ${row.created_at}, ${row.corroborated_at})
        `;
      }
    },
  },
  toolLessons: {
    rows: ForkToolLessonRowSchema,
    select: ({ sql }) => actorRows(sql, (actorId, after) => {
      const found = sql<ForkToolLessonRow & { rowid: number }>`
        SELECT rowid, id, tool, text, revision, helpful, harmful, turn_ids, status, created_at, updated_at FROM tool_lessons
        WHERE actor_id = ${actorId} AND rowid > ${after} ORDER BY rowid LIMIT 1
      `[0];

      return found === undefined ? undefined : { rowid: found.rowid, row: v.parse(ForkToolLessonRowSchema, found) };
    }),
    bytes: (row) => utf8Bytes(row.id) + utf8Bytes(row.tool) + utf8Bytes(row.text) + utf8Bytes(row.turn_ids),
    stage: ({ sql, actorId }, rows) => {
      for (const row of rows) {
        void sql`
          INSERT INTO tool_lessons (actor_id, id, tool, text, revision, helpful, harmful, turn_ids, status, created_at, updated_at)
          VALUES (${actorId}, ${row.id}, ${row.tool}, ${row.text}, ${row.revision}, ${row.helpful}, ${row.harmful},
                  ${row.turn_ids}, ${row.status}, ${row.created_at}, ${row.updated_at})
        `;
      }
    },
  },
  facts: {
    rows: ForkFactRowSchema,
    select: ({ sql }) => actorRows(sql, (actorId, after) => {
      const found = sql<ForkFactRow & { rowid: number }>`
        SELECT rowid, key, value_json, confidence, source, last_observed_at, importance, veracity, origin_json FROM agent_facts
        WHERE actor_id = ${actorId} AND rowid > ${after} ORDER BY rowid LIMIT 1
      `[0];

      return found === undefined ? undefined : { rowid: found.rowid, row: v.parse(ForkFactRowSchema, found) };
    }),
    bytes: (row) => utf8Bytes(row.key) + utf8Bytes(row.value_json) + utf8Bytes(row.source) + utf8Bytes(row.origin_json),
    stage: ({ sql, actorId }, rows) => {
      for (const row of rows) {
        void sql`
          INSERT INTO agent_facts (actor_id, key, value_json, confidence, source, last_observed_at, importance, veracity, origin_json)
          VALUES (${actorId}, ${row.key}, ${row.value_json}, ${row.confidence}, ${row.source}, ${row.last_observed_at},
                  ${row.importance}, ${row.veracity}, ${row.origin_json})
        `;
      }

      markStoreChanged(sql);
    },
  },
  appTables: {
    rows: ForkAppTableRowSchema,
    select: ({ appData }) => appData.tables().map(({ declaration, createdAt }) => ({ declaration, created_at: createdAt })),
    bytes: (row) => utf8Bytes(row.declaration),
    stage: ({ appData }, rows) => {
      const store = appData();

      for (const row of rows) store.create(row.declaration, row.created_at);
    },
    // The declared tables are named in the catalogue, not in fork-policy.ts, so the store drops its own.
    reset: ({ appData }) => { appData().clear(); },
  },
  appRows: {
    rows: ForkAppRowSchema,
    select: appRows,
    count: ({ appData }) => appTableNames(appData).reduce((total, name) => total + appData.count(name), 0),
    bytes: (row) => utf8Bytes(row.table) + utf8Bytes(JSON.stringify(row.row)),
    stage: ({ appData }, rows) => {
      const store = appData();

      // Consecutive rows of one table land in one insert.
      for (let at = 0; at < rows.length;) {
        const table = rows[at]?.table ?? '';
        let end = at;

        while (end < rows.length && rows[end]?.table === table) end += 1;
        store.insert(table, rows.slice(at, end).map(({ row }) => row));
        at = end;
      }
    },
  },
  contextMembers: {
    rows: ForkContextMemberRowSchema,
    select: ({ plan }) => plan.members,
    count: ({ plan }) => plan.members.length,
    bytes: (row) => utf8Bytes(row.entry_id) + utf8Bytes(row.message_id),
    // The restored working context: one revision of a fresh context with the cut revision's membership.
    stage: ({ sql, actorId, context }, rows) => {
      const contextId = context();

      for (const row of rows) {
        void sql`
          INSERT INTO context_memberships (actor_id, context_id, entry_id, from_revision, to_revision, position, message_id)
          VALUES (${actorId}, ${contextId}, ${row.entry_id}, ${FORK_CONTEXT_REVISION}, ${null}, ${row.position}, ${row.message_id})
        `;
      }
    },
  },
};

/** Rows `section` selects on the source. */
export function forkSectionCount(kind: ForkRowSection, source: ForkSectionSource): number {
  const declared = FORK_SECTIONS[kind];

  if (declared.count !== undefined) return declared.count(source);
  let total = 0;

  for (const _row of declared.select(source)) total += 1;

  return total;
}
