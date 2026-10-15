// Imports are misevolution-gated, then staged provisional; the next graded turn promotes or discards them.
// An imported scaffold only becomes a pending version via modifyScaffold, never the live loop.

import type { AgentRuntime } from '../types/agent-runtime';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { sqlCheckList } from '../identity/schema';
import { checkMisevolutionForSurface, recordMisevolutionVeto } from '../safety/misevolution';
import { modifyScaffold } from '../scaffold/modify';
import { getPendingScaffold } from '../scaffold/versions';
import { upsertCraftedTool } from '../craft/conflict';
import { createFactsStore } from '../memory/facts';
import { effectAlreadyDone, recordEffectDone } from '../identity/effect-tombstones';
import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';
import * as v from 'valibot';
import { diagnostics, toKinuError, tolerate } from '../obs/index';
import { recordLesson } from '../evolution/lessons';
import {
  EXPERIENCE_KINDS,
  misevolutionSourceOf,
  parseExperiencePayload,
  type ExperienceEntry,
  type ExperienceKind,
  type ExperiencePayload,
} from './types';

export type ImportStatus = 'provisional' | 'corroborated';

export interface ImportedExperienceRow {
  id: string;
  libraryId: string;
  key: string;
  title: string;
  payload: ExperiencePayload;
  evidence: string;
  sourceWorkspace: string;
  status: ImportStatus;
  turnIds: string[];
  importedAt: number;
  corroboratedAt: number | null;
}

export function initImportedExperienceTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS imported_experience (
    actor_id         TEXT NOT NULL,
    id               TEXT NOT NULL,
    library_id       TEXT NOT NULL,
    kind             TEXT NOT NULL CHECK (kind IN (${sqlCheckList(EXPERIENCE_KINDS)})),
    key              TEXT NOT NULL,
    title            TEXT NOT NULL,
    payload_json     TEXT NOT NULL,
    evidence         TEXT NOT NULL,
    source_workspace TEXT NOT NULL,
    turn_ids         TEXT NOT NULL,
    imported_at      INTEGER NOT NULL,
    -- Null while provisional.
    corroborated_at  INTEGER,
    PRIMARY KEY (actor_id, id)
  )`);
  // Unique per actor: two actors of one workspace may each adopt the same entry.
  execRaw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_imported_experience_library
    ON imported_experience(actor_id, library_id)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_imported_experience_recent
    ON imported_experience(actor_id, imported_at DESC)`);
}

interface RawImportRow {
  id: string; library_id: string; kind: ExperienceKind; key: string; title: string;
  payload_json: string; evidence: string; source_workspace: string;
  turn_ids: string; imported_at: number; corroborated_at: number | null;
}

function toImportRow(r: RawImportRow): ImportedExperienceRow | null {
  const payload = parseExperiencePayload(r.payload_json);

  if (!payload) return null;
  const rawTurnIds: unknown = tolerate(() => JSON.parse(r.turn_ids), 'malformed-input');
  const parsedTurnIds = v.safeParse(v.array(v.string()), rawTurnIds);

  if (!parsedTurnIds.success) {
    diagnostics.failure(
      'experience.import_row_unreadable',
      toKinuError({
        doing: 'decode an imported experience row',
        cause: rawTurnIds === undefined ? new Error('the stored turn ids are not JSON') : parsedTurnIds.issues.map((issue) => issue.message).join('; '),
        otherwise: 'bad_input',
      }),
      { rowId: r.id },
    );

    return null;
  }

  const turnIds = parsedTurnIds.output;

  return {
    id: r.id, libraryId: r.library_id, key: r.key, title: r.title,
    payload, evidence: r.evidence, sourceWorkspace: r.source_workspace,
    status: r.corroborated_at === null ? 'provisional' : 'corroborated', turnIds, importedAt: r.imported_at,
    corroboratedAt: r.corroborated_at,
  };
}

export function listImportedExperience(
  sql: SqlExecutor,
  actor: ActorHandle,
  options: { status?: ImportStatus; limit?: number } = {},
): ImportedExperienceRow[] {
  actor.assertCurrent();
  const limit = options.limit ?? 100;

  // A status reads as the timestamp's nullness: provisional while it is null.
  const status = options.status ?? null;

  const rows = sql<RawImportRow>`SELECT * FROM imported_experience
    WHERE actor_id = ${actor.actorId} AND (${status} IS NULL OR (corroborated_at IS NULL) = (${status} = 'provisional'))
    ORDER BY imported_at DESC LIMIT ${limit}`;

  return rows.map(toImportRow).filter((r): r is ImportedExperienceRow => r !== null);
}

export type ImportOutcome =
  | { ok: true; row: ImportedExperienceRow }
  | { ok: false; reason: string };

/** Stage as provisional; durable stores are written only when a graded turn accepts it. */
export function stageImport(
  rt: AgentRuntime,
  entry: ExperienceEntry,
  now = nowMs(),
): ImportOutcome {

  const verdict = checkMisevolutionForSurface(misevolutionSourceOf(entry.payload), 'import');

  if (!verdict.ok) {
    recordMisevolutionVeto(rt.storage.sql, rt.actor, {
      surface: 'import',
      violation: verdict,
      detail: `${entry.payload.kind} "${entry.key}" from workspace "${entry.sourceWorkspace}" rejected`,
    });

    return {
      ok: false,
      reason: `Misevolution veto (${verdict.criterionId}): ${verdict.reason}`,
    };
  }

  rt.actor.assertCurrent();

  const existing = rt.storage.sql<{ corroborated_at: number | null }>`
    SELECT corroborated_at FROM imported_experience
    WHERE actor_id = ${rt.actor.actorId} AND library_id = ${entry.id} LIMIT 1`[0];

  if (existing) {
    return {
      ok: false,
      reason: existing.corroborated_at !== null
        ? `already imported and corroborated here: it is part of this workspace already`
        : `already imported this turn and waiting on the outcome that would corroborate it`,
    };
  }

  const id = `imp-${nanoid()}`;
  void rt.storage.sql`INSERT INTO imported_experience
      (actor_id, id, library_id, kind, key, title, payload_json, evidence, source_workspace,
       turn_ids, imported_at, corroborated_at)
    VALUES (${rt.actor.actorId}, ${id}, ${entry.id}, ${entry.payload.kind}, ${entry.key}, ${entry.title},
            ${JSON.stringify(entry.payload)}, ${entry.evidence}, ${entry.sourceWorkspace},
            '[]', ${now}, NULL)`;

  return {
    ok: true,
    row: {
      id, libraryId: entry.id, key: entry.key, title: entry.title,
      payload: entry.payload, evidence: entry.evidence, sourceWorkspace: entry.sourceWorkspace,
      status: 'provisional', turnIds: [], importedAt: now, corroboratedAt: null,
    },
  };
}

/** Call only for graded turns: binding to an ungraded turn would discard the evidence. */
export function bindPendingImports(sql: SqlExecutor, actor: ActorHandle, turnId: string): void {
  actor.assertCurrent();
  // `stageImport` writes `'[]'`, so an unbound row is exactly that literal.
  void sql`UPDATE imported_experience SET turn_ids = ${JSON.stringify([turnId])}
    WHERE actor_id = ${actor.actorId} AND corroborated_at IS NULL AND turn_ids = '[]'`;
}

export interface ImportSettlement {
  corroborated: ImportedExperienceRow[];
  discarded: ImportedExperienceRow[];
}

/** Written with the corroboration, so a failed promotion stays retryable. */
const IMPORT_SETTLED_SCOPE = 'import_settled';

export async function settleImportsForTurn(
  rt: AgentRuntime,
  turnId: string,
  verdict: 'accepted' | 'rejected',
  now = nowMs(),
): Promise<ImportSettlement> {
  const riding = listImportedExperience(rt.storage.sql, rt.actor, { status: 'provisional', limit: 200 })
    .filter((row) => row.turnIds.includes(turnId));

  const settlement: ImportSettlement = { corroborated: [], discarded: [] };

  for (const row of riding) {
    // Retry safety comes from idempotent promoteImport destinations; this marker only prevents a second settlement.
    if (effectAlreadyDone(rt.storage.sql, rt.actor, IMPORT_SETTLED_SCOPE, row.id)) continue;

    if (verdict === 'accepted' && await promoteImport(rt, row, turnId)) {
      void rt.storage.sql`UPDATE imported_experience
          SET corroborated_at = ${now}
          WHERE actor_id = ${rt.actor.actorId} AND id = ${row.id}`;
      recordEffectDone(rt.storage.sql, rt.actor, { scope: IMPORT_SETTLED_SCOPE, key: row.id });
      settlement.corroborated.push({ ...row, status: 'corroborated', corroboratedAt: now });
    } else {
      void rt.storage.sql`DELETE FROM imported_experience
        WHERE actor_id = ${rt.actor.actorId} AND id = ${row.id}`;
      recordEffectDone(rt.storage.sql, rt.actor, { scope: IMPORT_SETTLED_SCOPE, key: row.id });
      settlement.discarded.push(row);
    }
  }

  return settlement;
}

/** Delimited because it is read back; matching incidental prose would break on rewording. */
function importedScaffoldMarker(importId: string): string {
  return `[import:${importId}]`;
}

/** False when the destination write path declined (craft conflict gate or a modifyScaffold gate). */
async function promoteImport(rt: AgentRuntime, row: ImportedExperienceRow, turnId: string): Promise<boolean> {
  const from = `imported from workspace "${row.sourceWorkspace}" (${row.evidence})`;

  switch (row.payload.kind) {
    case 'craft': {
      const accepted = await upsertCraftedTool(rt, {
        name: row.payload.name,
        description: row.payload.description,
        code: row.payload.code,
        score: row.payload.score,
      });

      return accepted.accepted;
    }

    case 'lesson': {
      recordLesson(rt.storage.sql, rt.actor, {
        turnIds: [turnId],
        text: `${row.payload.text}\n(${from})`,
        source: 'import',
        status: 'corroborated',
        // Keyed so a re-promotion after a crash does not duplicate the lesson.
        key: row.id,
      });

      return true;
    }

    case 'fact': {
      createFactsStore(rt.storage.sql, rt.actor).upsert(row.payload.key, row.payload.value, {
        confidence: row.payload.confidence,
        source: `experience:${row.sourceWorkspace}`,
        veracity: 'imported',
        origin: { by: 'import', workspace: row.sourceWorkspace },
      });

      return true;
    }

    case 'scaffold': {
      // The marker rides in the rationale, written in the same insert as the version, so a retry
      // can tell its own pending scaffold from someone else's.
      const marker = importedScaffoldMarker(row.id);
      const pending = getPendingScaffold(rt.storage.sql, rt.actor);

      if (pending?.rationale.includes(marker)) return true;

      const proposed = await modifyScaffold(
        rt,
        `Imported scaffold, ${from}. Its rationale there: ${row.payload.rationale} ${marker}`,
        row.payload.code,
      );

      return proposed.ok;
    }
  }
}
