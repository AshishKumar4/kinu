/**
 * The account's memory: what every workspace and agent of one account reads alongside its own, held in that account's
 * user object. Agents read it whole and only propose to it: a proposed fact or note waits until the owner accepts it
 * (Settings → Memory). Its facts are the same `agent_facts` store a workspace's world model uses, under
 * {@link ACCOUNT_FACTS_ACTOR}; this module holds the rest of its rules (proposals, notes, the owner's view), so the user
 * object only checks who asks and delegates here.
 */
import * as v from 'valibot';
import { markStoreChanged } from '@kinu.run/agent-utils';
import { JsonValueSchema, safeJsonParse, type JsonValue } from '../utils/json';
import { nanoid } from '../utils/nanoid';
import { expandedTokenGroups, lexicalGroupRelevance, minimumRelevance } from './lexical-recall';
import {
  ACCOUNT_FACTS_ACTOR, createFactsStore, FactOriginSchema, initFactsTable, normalizeFactKey,
  type Fact, type FactOrigin, type FactRevision, type FactsStore,
} from './facts';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';

/** One account note a query matched. */
export interface AccountNoteHit {
  readonly id: string;
  readonly text: string;
  readonly score: number;
}

/** A key as the store keeps it: normalized, with something left once it is. */
const FactKeySchema = v.pipe(v.string(), v.maxLength(200), v.transform(normalizeFactKey), v.nonEmpty('An account fact needs a key.'));

export const AccountProposalSchema = v.variant('kind', [
  v.strictObject({
    kind: v.literal('fact'), key: FactKeySchema, value: JsonValueSchema,
    importance: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  }),
  v.strictObject({ kind: v.literal('note'), content: v.pipe(v.string(), v.trim(), v.nonEmpty('An account note needs words.'), v.maxLength(8000)) }),
]);

export type AccountProposal = v.InferInput<typeof AccountProposalSchema>;

/** Who proposes: an agent by its name, or the background pass, which reads the owner's own words. Never a name alone,
 *  as a workspace may name its agent anything. */
export type AccountProposer = { readonly by: 'agent'; readonly agent: string } | { readonly by: 'background' };

const AccountProposerSchema = v.variant('by', [
  v.strictObject({ by: v.literal('agent'), agent: v.pipe(v.string(), v.nonEmpty()) }),
  v.strictObject({ by: v.literal('background') }),
]);

/** A proposal as it is filed: what is proposed, by whom, and the delivery that carries it, so a replayed delivery files
 *  nothing new even after the owner decided the first. */
export interface AccountProposalFiling {
  readonly proposal: AccountProposal;
  readonly proposer: AccountProposer;
  readonly delivery?: string;
}

/** The account's memory as one agent of it reaches it. */
export interface AccountMemory {
  /** The account's facts, for recall, search and the memory block. */
  facts(): Promise<readonly Fact[]>;
  /** The account's notes a query matches, best first. */
  searchNotes(query: string, limit: number): Promise<readonly AccountNoteHit[]>;
  /** Files a pending promotion for the owner to accept or decline; its id. `delivery` names a replayable delivery. */
  propose(proposal: AccountProposal, delivery?: string): Promise<string>;
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
  readonly proposal: v.InferOutput<typeof AccountProposalSchema>;
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
  // `fingerprint` keeps one pending proposal per subject; `delivery` keeps one proposal per delivery for good.
  execRaw(`
    CREATE TABLE IF NOT EXISTS account_memory_proposals (
      id            TEXT PRIMARY KEY,
      proposal_json TEXT NOT NULL,
      origin_json   TEXT NOT NULL,
      fingerprint   TEXT NOT NULL,
      delivery      TEXT UNIQUE,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    INTEGER NOT NULL,
      decided_at    INTEGER
    )
  `);
}

/** What makes two proposals the same ask. */
function fingerprintOf(proposal: v.InferOutput<typeof AccountProposalSchema>): string {
  return proposal.kind === 'fact' ? `fact\n${proposal.key}\n${JSON.stringify(proposal.value)}` : `note\n${proposal.content}`;
}

/** mnemopi's lexical recall over the account's notes (lexical-recall.ts), best first, above its noise floor. */
function rankNotes(notes: readonly AccountNote[], query: string, limit: number): AccountNoteHit[] {
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

interface ProposalRow {
  id: string;
  proposal_json: string;
  origin_json: string;
  created_at: number;
}

interface NoteRow {
  id: string;
  content: string;
  origin_json: string | null;
  created_at: number;
}

function originOf(raw: string | null): FactOrigin | null {
  const parsed = raw === null ? undefined : v.safeParse(FactOriginSchema, safeJsonParse(raw));

  return parsed?.success === true ? parsed.output : null;
}

/** The account's memory over the user object's SQL. `transaction` runs its body as one commit. */
export class AccountMemoryStore {
  private readonly factsStore: FactsStore;

  constructor(private readonly sql: SqlExecutor, private readonly transaction: (body: () => void) => void) {
    // The user object is this store's only writer, and never retires it.
    this.factsStore = createFactsStore(sql, { actorId: ACCOUNT_FACTS_ACTOR, assertCurrent: () => {} });
  }

  facts(): Fact[] {
    return this.factsStore.all();
  }

  searchNotes(query: string, limit: number): AccountNoteHit[] {
    return rankNotes(this.notes(), query, Math.min(50, Math.max(1, Math.floor(limit))));
  }

  /**
   * Files a proposal, answering its id: the pending one of the same subject when there is one, and the one a delivery
   * already filed whatever became of it. `workspace` is where it was said.
   */
  propose(filing: AccountProposalFiling, workspace: string | null): string {
    const proposal = v.parse(AccountProposalSchema, filing.proposal);
    const proposer = v.parse(AccountProposerSchema, filing.proposer);
    const fingerprint = fingerprintOf(proposal);
    const delivered = filing.delivery === undefined ? undefined : this.sql<{ id: string }>`SELECT id FROM account_memory_proposals WHERE delivery = ${filing.delivery}`[0];

    if (delivered !== undefined) return delivered.id;
    const pending = this.sql<{ id: string }>`SELECT id FROM account_memory_proposals WHERE fingerprint = ${fingerprint} AND status = 'pending' LIMIT 1`[0];

    if (pending !== undefined) return pending.id;
    const origin: FactOrigin = { ...proposer, ...(workspace !== null && { workspace }) };
    const id = `amp_${nanoid(12)}`;

    void this.sql`INSERT INTO account_memory_proposals (id, proposal_json, origin_json, fingerprint, delivery, status, created_at)
      VALUES (${id}, ${JSON.stringify(proposal)}, ${JSON.stringify(origin)}, ${fingerprint}, ${filing.delivery ?? null}, 'pending', ${Date.now()})`;
    markStoreChanged(this.sql);

    return id;
  }

  view(): AccountMemoryView {
    return {
      facts: this.factsStore.all().map((fact) => ({ ...fact, history: this.factsStore.history(fact.key) })),
      notes: this.notes(),
      pending: this.pending(),
    };
  }

  /** Accepting writes the proposal with who asked for it; either way it leaves the queue. Answers whether it was pending. */
  decide(id: string, decision: 'accept' | 'decline'): boolean {
    const row = this.sql<ProposalRow>`SELECT id, proposal_json, origin_json, created_at FROM account_memory_proposals WHERE id = ${id} AND status = 'pending'`[0];

    if (row === undefined) return false;
    const proposal = v.parse(AccountProposalSchema, JSON.parse(row.proposal_json));
    const origin = originOf(row.origin_json) ?? { by: 'agent' as const };

    this.transaction(() => {
      if (decision === 'accept') this.write(proposal, origin);
      void this.sql`UPDATE account_memory_proposals SET status = ${decision === 'accept' ? 'accepted' : 'declined'}, decided_at = ${Date.now()} WHERE id = ${id}`;
    });
    markStoreChanged(this.sql);

    return true;
  }

  /** The owner's own write: an edit, or a workspace fact promoted from its world model (`workspace` names it). */
  put(key: string, value: JsonValue, workspace?: string): string {
    const stored = v.parse(FactKeySchema, key);

    this.factsStore.upsert(stored, value, { veracity: 'stated', origin: { by: 'owner', ...(workspace !== undefined && { workspace }) } });

    return stored;
  }

  forget(key: string): boolean {
    const existed = this.factsStore.recall(key) !== null;

    this.factsStore.forget(key, { by: 'owner' });

    return existed;
  }

  forgetNote(id: string): boolean {
    const existed = this.sql<{ id: string }>`SELECT id FROM account_notes WHERE id = ${id}`.length > 0;

    void this.sql`DELETE FROM account_notes WHERE id = ${id}`;
    markStoreChanged(this.sql);

    return existed;
  }

  private write(proposal: v.InferOutput<typeof AccountProposalSchema>, origin: FactOrigin): void {
    if (proposal.kind === 'fact') {
      this.factsStore.upsert(proposal.key, proposal.value, {
        veracity: origin.by === 'background' ? 'inferred' : 'stated', origin,
        ...(proposal.importance !== undefined && { importance: proposal.importance }),
      });

      return;
    }

    void this.sql`INSERT INTO account_notes (id, content, origin_json, created_at)
      VALUES (${`acn_${nanoid(12)}`}, ${proposal.content}, ${JSON.stringify(origin)}, ${Date.now()})`;
  }

  private notes(): AccountNote[] {
    return this.sql<NoteRow>`SELECT id, content, origin_json, created_at FROM account_notes ORDER BY created_at DESC, id`
      .map((row) => ({ id: row.id, content: row.content, origin: originOf(row.origin_json), createdAt: row.created_at }));
  }

  /** What waits on the owner, oldest first: the view's `pending`, for a reader that needs only that. */
  pending(): AccountMemoryProposal[] {
    return this.sql<ProposalRow>`
      SELECT id, proposal_json, origin_json, created_at FROM account_memory_proposals WHERE status = 'pending' ORDER BY created_at, id`
      .flatMap((row) => {
        // A row an older build filed that no longer reads as a proposal is left out, never the whole view.
        const proposal = v.safeParse(AccountProposalSchema, safeJsonParse(row.proposal_json));

        return proposal.success ? [{ id: row.id, proposal: proposal.output, origin: originOf(row.origin_json) ?? { by: 'agent' as const }, createdAt: row.created_at }] : [];
      });
  }
}
