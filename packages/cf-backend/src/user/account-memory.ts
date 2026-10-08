/**
 * The account's memory, in the user object: facts in the same `agent_facts` store a workspace's world model uses
 * (under `ACCOUNT_FACTS_ACTOR`), notes, and the proposals that wait on the owner. Agents read it whole and propose to
 * it; only the owner accepts, edits, promotes or forgets (`memory.account.manage` is owner-only).
 */
import * as v from 'valibot';
import {
  ACCOUNT_FACTS_ACTOR, AccountProposalSchema, FactOriginSchema, createFactsStore, normalizeFactKey, proposalFingerprint, rankNotes,
  safeJsonParse, nanoid,
  type AccountMemoryProposal, type AccountMemoryView, type AccountNote, type AccountNoteHit, type AccountProposal, type Fact, type FactOrigin,
  type FactsStore, type JsonValue, type SqlExecutor, type UserCaller,
} from '@kinu.run/core';
import type { SqlRow, UserObjectHost } from './user-host';

export interface AccountMemoryHost extends UserObjectHost {
  /** The user object's tagged SQL, as every store over it takes. */
  readonly sql: SqlExecutor;
}

const ProposalDecisionSchema = v.picklist(['accept', 'decline']);

/** A key as the store keeps it: normalized, and something left once it is. */
const FactKeySchema = v.pipe(v.string(), v.maxLength(200), v.transform(normalizeFactKey), v.nonEmpty('An account fact needs a key.'));

interface ProposalRow extends SqlRow {
  id: string;
  proposal_json: string;
  origin_json: string;
  created_at: number;
}

interface NoteRow extends SqlRow {
  id: string;
  content: string;
  origin_json: string | null;
  created_at: number;
}

function originOf(raw: string | null): FactOrigin | null {
  const parsed = raw === null ? undefined : v.safeParse(FactOriginSchema, safeJsonParse(raw));

  return parsed?.success === true ? parsed.output : null;
}

function noteOf(row: NoteRow): AccountNote {
  return { id: row.id, content: row.content, origin: originOf(row.origin_json), createdAt: row.created_at };
}

export class UserAccountMemory {
  private readonly facts: FactsStore;

  constructor(private readonly host: AccountMemoryHost) {
    // The user object is this store's only writer, and never retires it.
    this.facts = createFactsStore(host.sql, { actorId: ACCOUNT_FACTS_ACTOR, assertCurrent: () => {} });
  }

  async accountMemory_facts(caller: UserCaller): Promise<Fact[]> {
    await this.host.requireTier(caller, 'memory.account.read');

    return this.facts.all();
  }

  async accountMemory_searchNotes(caller: UserCaller, query: string, limit: number): Promise<AccountNoteHit[]> {
    await this.host.requireTier(caller, 'memory.account.read');

    return rankNotes(this.notes(), v.parse(v.string(), query), Math.min(50, Math.max(1, Math.floor(limit))));
  }

  /** One pending proposal per subject: the same ask filed again answers the first one's id. */
  async accountMemory_propose(caller: UserCaller, raw: AccountProposal, agent: string): Promise<string> {
    const resolved = await this.host.requireTier(caller, 'memory.account.propose');
    const proposal = v.parse(AccountProposalSchema, raw);
    const normalized = proposal.kind === 'fact' ? { ...proposal, key: normalizeFactKey(proposal.key) } : proposal;
    const fingerprint = proposalFingerprint(normalized);

    const pending = this.host.sqlx<{ id: string }>(
      `SELECT id FROM account_memory_proposals WHERE fingerprint = ? AND status = 'pending' LIMIT 1`, fingerprint,
    )[0];

    if (pending !== undefined) return pending.id;

    const origin: FactOrigin = {
      by: v.parse(v.string(), agent) === 'background' ? 'background' : 'agent',
      ...(resolved.kind === 'workspace' && { workspace: resolved.workspace }),
      ...(agent !== 'background' && { agent }),
    };

    const id = `amp_${nanoid(12)}`;

    this.host.sqlx(
      `INSERT INTO account_memory_proposals (id, proposal_json, origin_json, fingerprint, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
      id, JSON.stringify(normalized), JSON.stringify(origin), fingerprint, Date.now(),
    );

    return id;
  }

  async accountMemory_view(caller: UserCaller): Promise<AccountMemoryView> {
    await this.host.requireTier(caller, 'memory.account.manage');

    return {
      facts: this.facts.all().map((fact) => ({ ...fact, history: this.facts.history(fact.key) })),
      notes: this.notes(),
      pending: this.pending(),
    };
  }

  /** Accepting writes the proposal with who asked for it; either way it leaves the queue. Answers whether it was pending. */
  async accountMemory_decide(caller: UserCaller, id: string, decision: 'accept' | 'decline'): Promise<boolean> {
    await this.host.requireTier(caller, 'memory.account.manage');
    const chosen = v.parse(ProposalDecisionSchema, decision);
    const row = this.host.sqlx<ProposalRow>(`SELECT id, proposal_json, origin_json, created_at FROM account_memory_proposals WHERE id = ? AND status = 'pending'`, id)[0];

    if (row === undefined) return false;
    const proposal = v.parse(AccountProposalSchema, JSON.parse(row.proposal_json));
    const origin = originOf(row.origin_json) ?? { by: 'agent' as const };

    this.host.ctx.storage.transactionSync(() => {
      if (chosen === 'accept') this.write(proposal, origin);
      this.host.sqlx(`UPDATE account_memory_proposals SET status = ?, decided_at = ? WHERE id = ?`, chosen === 'accept' ? 'accepted' : 'declined', Date.now(), id);
    });

    return true;
  }

  /** The owner's own write: an edit, or a workspace fact promoted from its world model (`workspace` names it). */
  async accountMemory_put(caller: UserCaller, key: string, value: JsonValue, workspace?: string): Promise<string> {
    await this.host.requireTier(caller, 'memory.account.manage');
    const stored = v.parse(FactKeySchema, key);

    this.facts.upsert(stored, value, { veracity: 'stated', origin: { by: 'owner', ...(workspace !== undefined && { workspace }) } });

    return stored;
  }

  async accountMemory_forget(caller: UserCaller, key: string): Promise<boolean> {
    await this.host.requireTier(caller, 'memory.account.manage');
    const existed = this.facts.recall(key) !== null;

    this.facts.forget(key, { by: 'owner' });

    return existed;
  }

  async accountMemory_forgetNote(caller: UserCaller, id: string): Promise<boolean> {
    await this.host.requireTier(caller, 'memory.account.manage');
    const existed = this.host.sqlx(`SELECT id FROM account_notes WHERE id = ?`, id).length > 0;

    this.host.sqlx(`DELETE FROM account_notes WHERE id = ?`, id);

    return existed;
  }

  private write(proposal: AccountProposal, origin: FactOrigin): void {
    if (proposal.kind === 'fact') {
      this.facts.upsert(proposal.key, proposal.value, {
        veracity: origin.by === 'background' ? 'inferred' : 'stated', origin,
        ...(proposal.importance !== undefined && { importance: proposal.importance }),
      });

      return;
    }

    this.host.sqlx(
      `INSERT INTO account_notes (id, content, origin_json, created_at) VALUES (?, ?, ?, ?)`,
      `acn_${nanoid(12)}`, proposal.content.trim(), JSON.stringify(origin), Date.now(),
    );
  }

  private notes(): AccountNote[] {
    return this.host.sqlx<NoteRow>(`SELECT id, content, origin_json, created_at FROM account_notes ORDER BY created_at DESC, id`).map(noteOf);
  }

  private pending(): AccountMemoryProposal[] {
    return this.host.sqlx<ProposalRow>(
      `SELECT id, proposal_json, origin_json, created_at FROM account_memory_proposals WHERE status = 'pending' ORDER BY created_at, id`,
    ).map((row) => ({
      id: row.id,
      proposal: v.parse(AccountProposalSchema, JSON.parse(row.proposal_json)),
      origin: originOf(row.origin_json) ?? { by: 'agent' },
      createdAt: row.created_at,
    }));
  }
}
