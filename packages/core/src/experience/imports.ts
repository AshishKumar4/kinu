/**
 * The import side of experience transfer — where another workspace's knowledge
 * has to earn its place in this one.
 *
 * Two mechanisms guard it, and they are the two this agent already trusts
 * everywhere else; nothing new is invented at the sharing boundary.
 *
 *   1. The misevolution gate (scaffold/misevolution.ts). Every import, of every
 *      kind, is checked before it is staged, and a veto is recorded in the same
 *      evolution_events ledger every other veto lands in. The gate reads the
 *      exact text that would end up inside this agent, because imported prose
 *      reaches MEMORY.md and the facts block just as imported code reaches the
 *      tool surface.
 *
 *   2. Provisional-until-corroborated (evolution/outcomes.ts' lessons ledger,
 *      mirrored). An import is STAGED, never adopted: nothing is written to
 *      MEMORY.md, agent_facts or the CraftStore at import time. The tool hands
 *      the payload back inline, so the agent can act on it during the very turn
 *      it imported it — and that turn's own outcome decides. Accepted: the
 *      import is promoted into this workspace's durable stores. Corrected or
 *      frustrated: it is discarded. Ungraded: it waits.
 *
 * Binding is post-hoc for the same reason lessons bind post-hoc — a turn's id
 * is its assistant message, which does not exist while the turn is running. So
 * an unbound import attaches to the first turn this workspace actually grades
 * after it was staged, and that turn's verdict settles it.
 *
 * An imported SCAFFOLD is the one kind whose adoption is not the end of its
 * journey, and deliberately so: "promoting" it hands the code to
 * `modifyScaffold`, the same 4-gate pipeline a locally-proposed mutation goes
 * through, so it lands as a PENDING version and the live `scaffold/agent.js` is
 * untouched. This workspace's own shadow trials and promotion gate then decide
 * whether it ever runs. There is no other route: an imported loop is a proposal
 * here, whatever it proved elsewhere.
 */

import type { AgentRuntime } from '../types/agent-runtime';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { checkMisevolution, recordMisevolutionVeto } from '../scaffold/misevolution';
import { modifyScaffold } from '../scaffold/modify';
import { upsertCraftedTool } from '../craft/conflict';
import { createFactsStore } from '../memory/facts';
import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';
import * as v from 'valibot';
import { recordLesson } from '../evolution/outcomes';
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
  /** The library entry this came from — the provenance reference. */
  libraryId: string;
  kind: ExperienceKind;
  key: string;
  title: string;
  payload: ExperiencePayload;
  evidence: string;
  sourceWorkspace: string;
  status: ImportStatus;
  /** The graded turns this import is riding on. Empty until one is graded. */
  turnIds: string[];
  importedAt: number;
  corroboratedAt: number | null;
}

export function initImportedExperienceTable(execRaw: RawSqlExec, sql: SqlExecutor): void {
  const ddl = `(
    id               TEXT PRIMARY KEY,
    library_id       TEXT NOT NULL UNIQUE,
    kind             TEXT NOT NULL CHECK (kind IN (${EXPERIENCE_KINDS.map((k) => `'${k}'`).join(',')})),
    key              TEXT NOT NULL,
    title            TEXT NOT NULL,
    payload_json     TEXT NOT NULL,
    evidence         TEXT NOT NULL,
    source_workspace TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('provisional','corroborated')),
    turn_ids         TEXT NOT NULL,
    imported_at      INTEGER NOT NULL,
    corroborated_at  INTEGER
  )`;
  const storedDdl = (name: string): string | null =>
    sql<{ sql: string }>`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${name}`[0]?.sql
      ?? null;

  // Resume an interrupted rebuild first: a crash mid-sequence leaves the rows
  // in `imported_experience_legacy` while a bare CREATE IF NOT EXISTS would
  // silently start an empty ledger. Same discipline as turn_outcomes
  // (evolution/outcomes.ts) — SQLite cannot ALTER a CHECK, so widening one is
  // an in-place rebuild, and the resume branch makes it idempotent at every
  // crash point.
  if (storedDdl('imported_experience_legacy') !== null) {
    execRaw(`CREATE TABLE IF NOT EXISTS imported_experience ${ddl}`);
    execRaw(`INSERT OR IGNORE INTO imported_experience SELECT * FROM imported_experience_legacy`);
    execRaw(`DROP TABLE imported_experience_legacy`);
  }
  execRaw(`CREATE TABLE IF NOT EXISTS imported_experience ${ddl}`);
  // A table created before a kind was added carries a narrower CHECK that
  // rejects the new kind's rows. The probe is the kind LIST itself, so adding a
  // member is the only edit ever needed here.
  const current = storedDdl('imported_experience');
  if (current !== null && EXPERIENCE_KINDS.some((kind) => !current.includes(`'${kind}'`))) {
    execRaw(`ALTER TABLE imported_experience RENAME TO imported_experience_legacy`);
    execRaw(`CREATE TABLE imported_experience ${ddl}`);
    execRaw(`INSERT OR IGNORE INTO imported_experience SELECT * FROM imported_experience_legacy`);
    execRaw(`DROP TABLE imported_experience_legacy`);
  }
}

interface RawImportRow {
  id: string; library_id: string; kind: ExperienceKind; key: string; title: string;
  payload_json: string; evidence: string; source_workspace: string;
  status: ImportStatus; turn_ids: string; imported_at: number; corroborated_at: number | null;
}

function toImportRow(r: RawImportRow): ImportedExperienceRow | null {
  const payload = parseExperiencePayload(r.payload_json);
  if (!payload || payload.kind !== r.kind) return null;
  const rawTurnIds: unknown = JSON.parse(r.turn_ids);
  const turnIds = v.parse(v.array(v.string()), rawTurnIds);
  return {
    id: r.id, libraryId: r.library_id, kind: r.kind, key: r.key, title: r.title,
    payload, evidence: r.evidence, sourceWorkspace: r.source_workspace,
    status: r.status, turnIds, importedAt: r.imported_at, corroboratedAt: r.corroborated_at,
  };
}

export function listImportedExperience(
  sql: SqlExecutor,
  options: { status?: ImportStatus; limit?: number } = {},
): ImportedExperienceRow[] {
  const limit = options.limit ?? 100;
  const rows = options.status
    ? sql<RawImportRow>`SELECT * FROM imported_experience WHERE status = ${options.status}
        ORDER BY imported_at DESC LIMIT ${limit}`
    : sql<RawImportRow>`SELECT * FROM imported_experience ORDER BY imported_at DESC LIMIT ${limit}`;
  return rows.map(toImportRow).filter((r): r is ImportedExperienceRow => r !== null);
}

export type ImportOutcome =
  | { ok: true; row: ImportedExperienceRow }
  | { ok: false; reason: string };

/**
 * Gate an entry and stage it as provisional. Writes nothing to the durable
 * knowledge stores — that only happens if a graded turn accepts it.
 */
export function stageImport(
  rt: AgentRuntime,
  entry: ExperienceEntry,
  now = nowMs(),
): ImportOutcome {
  const verdict = checkMisevolution(misevolutionSourceOf(entry.payload));
  if (!verdict.ok) {
    recordMisevolutionVeto(rt.storage.sql, {
      surface: 'import',
      violation: verdict,
      detail: `${entry.kind} "${entry.key}" from workspace "${entry.sourceWorkspace}" rejected`,
    });
    return {
      ok: false,
      reason: `Misevolution veto (${verdict.criterionId}): ${verdict.reason}`,
    };
  }

  const existing = rt.storage.sql<{ status: ImportStatus }>`
    SELECT status FROM imported_experience WHERE library_id = ${entry.id} LIMIT 1`[0];
  if (existing) {
    return {
      ok: false,
      reason: existing.status === 'corroborated'
        ? `already imported and corroborated here — it is part of this workspace already`
        : `already imported this turn and waiting on the outcome that would corroborate it`,
    };
  }

  const id = `imp-${nanoid()}`;
  void rt.storage.sql`INSERT INTO imported_experience
      (id, library_id, kind, key, title, payload_json, evidence, source_workspace,
       status, turn_ids, imported_at, corroborated_at)
    VALUES (${id}, ${entry.id}, ${entry.kind}, ${entry.key}, ${entry.title},
            ${JSON.stringify(entry.payload)}, ${entry.evidence}, ${entry.sourceWorkspace},
            'provisional', '[]', ${now}, NULL)`;

  return {
    ok: true,
    row: {
      id, libraryId: entry.id, kind: entry.kind, key: entry.key, title: entry.title,
      payload: entry.payload, evidence: entry.evidence, sourceWorkspace: entry.sourceWorkspace,
      status: 'provisional', turnIds: [], importedAt: now, corroboratedAt: null,
    },
  };
}

/**
 * Attach every still-unbound provisional import to the turn now being graded.
 * Called only when a turn actually received an outcome — an ungraded turn
 * carries no verdict, so binding to it would throw the evidence away.
 */
export function bindPendingImports(sql: SqlExecutor, turnId: string): void {
  const pending = listImportedExperience(sql, { status: 'provisional', limit: 200 })
    .filter((row) => row.turnIds.length === 0);
  for (const row of pending) {
    void sql`UPDATE imported_experience SET turn_ids = ${JSON.stringify([turnId])} WHERE id = ${row.id}`;
  }
}

export interface ImportSettlement {
  corroborated: ImportedExperienceRow[];
  discarded: ImportedExperienceRow[];
}

/**
 * Settle the imports riding on one graded turn.
 *
 * `accepted` promotes them into this workspace's durable stores; anything else
 * discards them — an import that did not survive the turn it was used in has no
 * standing here, and the library entry stays available to import again later.
 * A craft the conflict gate declines is discarded too, so no provisional row
 * survives its verdict.
 */
export async function settleImportsForTurn(
  rt: AgentRuntime,
  turnId: string,
  verdict: 'accepted' | 'rejected',
  now = nowMs(),
): Promise<ImportSettlement> {
  const riding = listImportedExperience(rt.storage.sql, { status: 'provisional', limit: 200 })
    .filter((row) => row.turnIds.includes(turnId));
  const settlement: ImportSettlement = { corroborated: [], discarded: [] };

  for (const row of riding) {
    if (verdict === 'accepted' && await promoteImport(rt, row)) {
      void rt.storage.sql`UPDATE imported_experience
          SET status = 'corroborated', corroborated_at = ${now} WHERE id = ${row.id}`;
      settlement.corroborated.push({ ...row, status: 'corroborated', corroboratedAt: now });
    } else {
      void rt.storage.sql`DELETE FROM imported_experience WHERE id = ${row.id}`;
      settlement.discarded.push(row);
    }
  }
  return settlement;
}

/**
 * Write a corroborated import into the store its kind belongs in — the same
 * public write path this workspace's own experience takes, so an imported
 * artifact is indistinguishable from a home-grown one once adopted (and, for a
 * craft, passes the misevolution gate a second time inside upsertCraftedTool).
 *
 * A scaffold's "store" is the version archive, entered the only way anything
 * enters it: `modifyScaffold`. That leaves a PENDING version and the live loop
 * untouched, so adoption here means "this workspace will now try it", not "this
 * workspace now runs it".
 *
 * Returns false when the receiving write path declined — the craft conflict
 * gate, or any of modifyScaffold's four gates (a rollout already in flight, a
 * rationale too short, its own misevolution veto). A declined import is
 * discarded rather than left staged, and the library entry stays importable.
 */
async function promoteImport(rt: AgentRuntime, row: ImportedExperienceRow): Promise<boolean> {
  const from = `imported from workspace "${row.sourceWorkspace}" (${row.evidence})`;
  switch (row.payload.kind) {
    case 'craft': {
      const accepted = await upsertCraftedTool(rt, {
        name: row.payload.name,
        description: row.payload.description,
        params: row.payload.params,
        code: row.payload.code,
        score: row.payload.score,
      });
      return accepted.accepted;
    }
    case 'lesson': {
      // The lesson joins THIS workspace's ledger as an already-corroborated
      // row — the same store every other lesson lives in, so prompt weaving,
      // memory search and re-publication all read it through one path. A
      // MEMORY.md copy would be a second home for text the ledger owns.
      recordLesson(rt.storage.sql, {
        turnIds: [],
        text: `${row.payload.text}\n(${from})`,
        source: 'import',
        status: 'corroborated',
      });
      return true;
    }
    case 'fact': {
      createFactsStore(rt.storage.sql).upsert(row.payload.key, row.payload.value, {
        confidence: row.payload.confidence,
        source: `experience:${row.sourceWorkspace}`,
      });
      return true;
    }
    case 'scaffold': {
      // Provenance in the rationale, because that is what scaffold_versions
      // stores, the day log records and the Evolution Changelog shows the
      // operator — the same place a local proposal states its case.
      const proposed = await modifyScaffold(
        rt,
        `Imported scaffold, ${from}. Its rationale there: ${row.payload.rationale}`,
        row.payload.code,
      );
      return proposed.ok;
    }
  }
}
