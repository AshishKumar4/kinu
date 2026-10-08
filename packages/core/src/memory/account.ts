/**
 * The account's memory as one agent of it reaches it: read whole, with the workspace's own, and written only by
 * proposal. A proposed fact or note waits until the owner accepts it (Settings → Memory); nothing an agent or the
 * background pass says is kept for the account before then. Its store is the user object's (cf-backend
 * `user/account-memory.ts`): the same `agent_facts` a workspace's world model uses, under `ACCOUNT_FACTS_ACTOR`.
 */
import * as v from 'valibot';
import { JsonValueSchema } from '../utils/json';
import { expandedTokenGroups, lexicalGroupRelevance, minimumRelevance } from './lexical-recall';
import { initFactsTable, type Fact, type FactOrigin, type FactRevision } from './facts';
import type { RawSqlExec } from '../types/primitives';

/** One account note a query matched. */
export interface AccountNoteHit {
  readonly id: string;
  readonly text: string;
  readonly score: number;
}

export const AccountProposalSchema = v.variant('kind', [
  v.strictObject({
    kind: v.literal('fact'), key: v.pipe(v.string(), v.nonEmpty(), v.maxLength(200)), value: JsonValueSchema,
    importance: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  }),
  v.strictObject({ kind: v.literal('note'), content: v.pipe(v.string(), v.nonEmpty(), v.maxLength(8000)) }),
]);

export type AccountProposal = v.InferOutput<typeof AccountProposalSchema>;

export interface AccountMemory {
  /** The account's facts, for recall, search and the memory block. */
  facts(): Promise<readonly Fact[]>;
  /** The account's notes a query matches, best first. */
  searchNotes(query: string, limit: number): Promise<readonly AccountNoteHit[]>;
  /** Files a pending promotion for the owner to accept or decline; its id. */
  propose(proposal: AccountProposal): Promise<string>;
}

export interface AccountNote {
  readonly id: string;
  readonly content: string;
  readonly origin: FactOrigin | null;
  readonly createdAt: number;
}

/** A proposal waiting on the owner, with who asked for it. */
export interface AccountMemoryProposal {
  readonly id: string;
  readonly proposal: AccountProposal;
  readonly origin: FactOrigin;
  readonly createdAt: number;
}

/** Settings → Memory: every account fact with its history, every note, and what waits on the owner. */
export interface AccountMemoryView {
  readonly facts: ReadonlyArray<Fact & { readonly history: readonly FactRevision[] }>;
  readonly notes: readonly AccountNote[];
  readonly pending: readonly AccountMemoryProposal[];
}

export function initAccountMemoryTables(execRaw: RawSqlExec): void {
  initFactsTable(execRaw);
  execRaw(`
    CREATE TABLE IF NOT EXISTS account_notes (
      id          TEXT PRIMARY KEY,
      content     TEXT NOT NULL,
      origin_json TEXT,
      created_at  INTEGER NOT NULL
    )
  `);
  // `fingerprint` keeps one pending proposal per subject: a replayed background pass files the same one again.
  execRaw(`
    CREATE TABLE IF NOT EXISTS account_memory_proposals (
      id            TEXT PRIMARY KEY,
      proposal_json TEXT NOT NULL,
      origin_json   TEXT NOT NULL,
      fingerprint   TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    INTEGER NOT NULL,
      decided_at    INTEGER
    )
  `);
}

/** What makes two proposals the same ask. */
export function proposalFingerprint(proposal: AccountProposal): string {
  return proposal.kind === 'fact' ? `fact\n${proposal.key}\n${JSON.stringify(proposal.value)}` : `note\n${proposal.content.trim()}`;
}

/** mnemopi's lexical recall over the account's notes (lexical-recall.ts), best first, above its noise floor. */
export function rankNotes(notes: readonly AccountNote[], query: string, limit: number): AccountNoteHit[] {
  const groups = expandedTokenGroups(query);

  if (groups.length === 0) return [];
  const floor = minimumRelevance(groups.length);

  return notes
    .map((note) => ({ id: note.id, text: note.content, score: lexicalGroupRelevance(groups, note.content), at: note.createdAt }))
    .filter((hit) => hit.score >= floor)
    .sort((a, b) => b.score - a.score || b.at - a.at || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map(({ id, text, score }) => ({ id, text, score }));
}
