/**
 * The account's memory: what every workspace and agent of one account reads alongside its own, held in that account's
 * user object. Agents read it whole and only propose to it: a proposed fact or note waits until the owner accepts it
 * (Settings → Memory). Its facts are the same `agent_facts` store a workspace's world model uses, under
 * {@link ACCOUNT_FACTS_ACTOR}; this module holds the rest of its rules (proposals, notes, the owner's view), so the user
 * object only checks who asks and delegates here.
 */
import * as v from 'valibot';
import { Effect } from 'effect';
import { markStoreChanged } from '@kinu.run/agent-utils';
import { JsonValueSchema, parseJsonValue, type JsonValue } from '../utils/json';
import { KinuError, settleSync, tolerate } from '../obs/index';
import { nanoid } from '../utils/nanoid';
import { scrubSecrets } from '../safety/secret-patterns';
import { scrubMemoryValue } from './scrub';
import { expandedTokenGroups, lexicalGroupRelevance, minimumRelevance } from './lexical-recall';
import {
  ACCOUNT_FACTS_ACTOR, createFactsStore, FactKeySchema, FactOriginSchema, FactRevisionSchema, FactSchema, initFactsTable,
  type Fact, type FactOrigin, type FactsStore,
} from './facts';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { stableStringify } from '../safety/argument-digest';
import { PLATFORM_LIMITS } from '../platform-limits';
import { accountProfile, effectiveProfileFacts, unshownIfKept, type UnshownFact } from './account-profile';
import { ImportedFactSchema, ImportedFactsSchema, mergeImported, type ImportedFact } from './account-import';

/** One account note a query matched. */
export interface AccountNoteHit {
  readonly id: string;
  readonly text: string;
  readonly score: number;
  /** When the owner kept it. */
  readonly at: number;
}


export const AccountProposalSchema = v.variant('kind', [
  v.strictObject({
    kind: v.literal('fact'), key: FactKeySchema, value: JsonValueSchema,
    importance: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  }),
  v.strictObject({ kind: v.literal('note'), content: v.pipe(v.string(), v.trim(), v.nonEmpty('An account note needs words.'), v.maxLength(8000)) }),
]);

export type AccountProposal = v.InferInput<typeof AccountProposalSchema>;


/**
 * What the owner imported (`account-import.ts`): how many pieces it holds (kept apart, {@link ImportPieces}), the facts
 * read from them so far (`read` of the pieces), the facts it replaces once accepted, and whether its pieces are kept as
 * notes then: a document's are, an export's conversations never. `failure` is the last read's, in its provider's words.
 */
const AccountImportSchema = v.strictObject({
  kind: v.literal('import'),
  pieces: v.pipe(v.number(), v.integer(), v.minValue(1)),
  keepNotes: v.boolean(),
  read: v.pipe(v.number(), v.integer(), v.minValue(0)),
  facts: v.array(ImportedFactSchema),
  replaces: v.array(FactKeySchema),
  failure: v.optional(v.string()),
});

/**
 * An import row as builds e68901c09 to ab0fff2ca wrote it, its pieces in the row as `notes`. One-time conversion
 * (`convertLegacyImports`); remove it, and this, once production has started every account on a build that has it
 * (ARCHITECTURE-DECISIONS: a change that must keep rows writes its own one-time migration).
 */
const LegacyImportSchema = v.strictObject({
  kind: v.literal('import'),
  notes: v.pipe(v.array(v.string()), v.minLength(1)),
  read: v.pipe(v.number(), v.integer(), v.minValue(0)),
  facts: v.array(ImportedFactSchema),
  replaces: v.array(FactKeySchema),
  failure: v.optional(v.string()),
});

/** What a proposal row holds: an agent's or the background pass's fact or note, or an owner's import. */
const StoredProposalSchema = v.variant('kind', [...AccountProposalSchema.options, AccountImportSchema]);

type StoredProposal = v.InferOutput<typeof StoredProposalSchema>;

type AccountImport = v.InferOutput<typeof AccountImportSchema>;


/** Who proposes: an agent by its name, or the background pass, which reads the owner's own words. Never a name alone,
 *  as a workspace may name its agent anything. An owner's import files its own batch (`startImport`). */
export type AccountProposer = { readonly by: 'agent'; readonly agent: string } | { readonly by: 'background' };

const AccountProposerSchema = v.variant('by', [
  v.strictObject({ by: v.literal('agent'), agent: v.pipe(v.string(), v.nonEmpty()) }),
  v.strictObject({ by: v.literal('background') }),
]);

/** A proposal filed: its id, and, for a fact the profile would leave out once kept, its size against the budget. */
export interface AccountProposalFiled {
  readonly id: string;
  readonly unshown: UnshownFact | null;
}

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
  /** Files a pending promotion for the owner to accept or decline. `delivery` names a replayable delivery. */
  propose(proposal: AccountProposal, delivery?: string): Promise<AccountProposalFiled>;
}

export const AccountNoteSchema = v.object({
  id: v.string(),
  content: v.string(),
  origin: v.nullable(FactOriginSchema),
  createdAt: v.number(),
});

export type AccountNote = Readonly<v.InferOutput<typeof AccountNoteSchema>>;

/**
 * A proposal waiting on the owner, with who asked for it. The roster's socket and `GET /api/user/memory` carry it as it
 * is, so the owner's page reads it with this schema and holds no second shape of it.
 */
export const AccountMemoryProposalSchema = v.object({
  id: v.string(),
  proposal: StoredProposalSchema,
  origin: v.variant('by', [
    v.object({ ...AccountProposerSchema.options[0].entries, workspace: v.optional(v.string()) }),
    v.object({ ...AccountProposerSchema.options[1].entries, workspace: v.optional(v.string()) }),
    v.object({ by: v.literal('import'), workspace: v.optional(v.string()) }),
  ]),
  createdAt: v.number(),
});

export type AccountMemoryProposal = Readonly<v.InferOutput<typeof AccountMemoryProposalSchema>>;

/** An import still reading its document, or stopped on a failure until the owner retries it. */
export const AccountImportStatusSchema = v.object({
  id: v.string(),
  pieces: v.number(),
  read: v.number(),
  facts: v.number(),
  replaces: v.number(),
  failure: v.nullable(v.string()),
  /** Stopped until the owner retries: its failure is one no wait mends. */
  parked: v.boolean(),
  createdAt: v.number(),
});

export type AccountImportStatus = v.InferOutput<typeof AccountImportStatusSchema>;

/** The profile's use of its budget, and the facts it leaves out, as Settings shows them. */
export const AccountProfileUseSchema = v.object({
  used: v.number(), budget: v.number(),
  unshown: v.pipe(v.array(v.object({ key: v.string(), chars: v.number() })), v.readonly()),
});

/**
 * Settings → Memory: every account fact with its history, every note, what waits on the owner, the imports under way,
 * and the profile every agent reads: its use of the budget and the facts it leaves out.
 */
const AccountMemoryViewSchema = v.object({
  facts: v.pipe(v.array(v.object({ ...FactSchema.entries, history: v.pipe(v.array(FactRevisionSchema), v.readonly()) })), v.readonly()),
  notes: v.pipe(v.array(AccountNoteSchema), v.readonly()),
  pending: v.pipe(v.array(AccountMemoryProposalSchema), v.readonly()),
  imports: v.pipe(v.array(AccountImportStatusSchema), v.readonly()),
  profile: AccountProfileUseSchema,
});

export type AccountMemoryView = Readonly<v.InferOutput<typeof AccountMemoryViewSchema>>;

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
  // `delivery` keeps one proposal per delivery for good.
  execRaw(`
    CREATE TABLE IF NOT EXISTS account_memory_proposals (
      id            TEXT PRIMARY KEY,
      proposal_json TEXT NOT NULL,
      origin_json   TEXT NOT NULL,
      delivery      TEXT UNIQUE,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    INTEGER NOT NULL
    )
  `);
}

/** Two proposals are the same ask when they name the same fact key and value, or the same note; importance aside. */
function sameAsk(a: v.InferOutput<typeof AccountProposalSchema>, b: StoredProposal): boolean {
  if (a.kind === 'fact') return b.kind === 'fact' && a.key === b.key && stableStringify(a.value) === stableStringify(b.value);

  return b.kind === 'note' && a.content === b.content;
}

/** One stored row's ceiling, which an import's whole record must fit. */
const ROW_BYTES = PLATFORM_LIMITS['do.sqlite.row_bytes'].value;

/** `record` as its row stores it; a refusal naming the ceiling where it does not fit. */
const rowBytes = (json: string): number => new TextEncoder().encode(json).length;

function importRow(record: AccountImport): Effect.Effect<string, KinuError> {
  const json = JSON.stringify(record);
  const bytes = rowBytes(json);

  return bytes <= ROW_BYTES ? Effect.succeed(json) : Effect.fail(new KinuError('bad_input',
    `This import is ${bytes.toLocaleString('en-US')} bytes stored, and one stored row holds at most ${ROW_BYTES.toLocaleString('en-US')} (do.sqlite.row_bytes). Import the document in parts.`));
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
    .slice(0, limit);
}

interface ProposalRow {
  id: string;
  proposal_json: string;
  origin_json: string;
  created_at: number;
}

interface ImportRow {
  id: string;
  proposal_json: string;
  status: string;
  created_at: number;
}

function readImport(row: Pick<ImportRow, 'id' | 'proposal_json'>): Effect.Effect<AccountImport, KinuError> {
  return Effect.try({
    try: () => v.parse(AccountImportSchema, parseJsonValue(row.proposal_json)),
    catch: (cause) => new KinuError('io', `Corrupt account memory import ${row.id}`, { cause }),
  });
}

interface NoteRow {
  id: string;
  content: string;
  origin_json: string | null;
  created_at: number;
}

function readProposal(row: ProposalRow): Effect.Effect<AccountMemoryProposal, KinuError> {
  return Effect.try({
    try: () => v.parse(AccountMemoryProposalSchema, {
      id: row.id,
      proposal: parseJsonValue(row.proposal_json),
      origin: parseJsonValue(row.origin_json),
      createdAt: row.created_at,
    }),
    catch: (cause) => new KinuError('io', `Corrupt account memory proposal ${row.id}`, { cause }),
  });
}

/**
 * An import's pieces, kept apart from its row so the row stays small whatever was imported and the owner's open pages
 * hear a count, never the text. Written in the same commit as the row (the user object's key-value storage shares its
 * SQLite transaction).
 */
export interface ImportPieces {
  put(id: string, at: number, text: string): void;
  get(id: string, at: number): string | undefined;
  drop(id: string, count: number): void;
}

/** The account's memory over the user object's SQL. `transaction` runs its body as one commit. */
export class AccountMemoryStore {
  private readonly factsStore: FactsStore;

  constructor(private readonly sql: SqlExecutor, private readonly transaction: (body: () => void) => void, private readonly pieces: ImportPieces) {
    // The user object is this store's only writer, and never retires it.
    this.factsStore = createFactsStore(sql, { actorId: ACCOUNT_FACTS_ACTOR, assertCurrent: () => {} });
  }

  facts(): Fact[] {
    return this.factsStore.all();
  }

  searchNotes(query: string, limit: number): AccountNoteHit[] {
    const take = Math.min(50, Math.max(1, Math.floor(limit)));

    return settleSync(Effect.map(this.notes(), (notes) => rankNotes(notes, query, take)));
  }

  /**
   * Files a proposal, answering its id: the pending one of the same subject when there is one, and the one a delivery
   * already filed whatever became of it. `workspace` is where it was said.
   */
  propose(filing: AccountProposalFiling, workspace: string | null): AccountProposalFiled {
    const filed = v.parse(AccountProposalSchema, filing.proposal);
    const unshown = filed.kind === 'fact' ? unshownIfKept(this.factsStore.all(), filed.key, filed.value) : null;
    // Kept scrubbed (`memory/scrub.ts`): an accepted proposal is written as it was filed.
    const proposal = filed.kind === 'fact' ? { ...filed, value: scrubMemoryValue(filed.value) } : { ...filed, content: scrubSecrets(filed.content) };
    const proposer = v.parse(AccountProposerSchema, filing.proposer);
    const delivered = filing.delivery === undefined ? undefined : this.sql<{ id: string }>`SELECT id FROM account_memory_proposals WHERE delivery = ${filing.delivery}`[0];

    if (delivered !== undefined) return { id: delivered.id, unshown };
    // One pending proposal per subject: the owner's queue is short, and its rows are the canonical proposals.
    const pending = this.pending().find((waiting) => sameAsk(proposal, waiting.proposal));

    if (pending !== undefined) return { id: pending.id, unshown };
    const origin: FactOrigin = { ...proposer, ...(workspace !== null && { workspace }) };
    const id = `amp_${nanoid(12)}`;

    void this.sql`INSERT INTO account_memory_proposals (id, proposal_json, origin_json, delivery, status, created_at)
      VALUES (${id}, ${JSON.stringify(proposal)}, ${JSON.stringify(origin)}, ${filing.delivery ?? null}, 'pending', ${Date.now()})`;
    markStoreChanged(this.sql);

    return { id, unshown };
  }

  view(): AccountMemoryView {
    return settleSync(Effect.gen({ self: this }, function* () {
      const notes = yield* this.notes();
      const facts = this.factsStore.all();
      const { used, budget, unshown } = accountProfile(effectiveProfileFacts(facts, []));

      const imports = yield* Effect.forEach(this.sql<ImportRow>`SELECT id, proposal_json, status, created_at FROM account_memory_proposals
        WHERE status IN ('importing', 'failed') ORDER BY created_at, id`, (row) => Effect.map(readImport(row), (record): AccountImportStatus => ({
        id: row.id, pieces: record.pieces, read: record.read, facts: record.facts.length, replaces: record.replaces.length,
        failure: record.failure ?? null, parked: row.status === 'failed', createdAt: row.created_at,
      })));

      return {
        facts: facts.map((fact) => ({ ...fact, history: this.factsStore.history(fact.key) })),
        notes, pending: this.pending(), imports, profile: { used, budget, unshown },
      };
    }));
  }

  /**
   * Accepting writes the proposal with who asked for it; either way it leaves the queue. An import is accepted whole, with
   * `edited` the facts the owner kept of it as they left them, and declined at any point, its reading too. Answers whether
   * it was there to decide.
   */
  decide(id: string, decision: 'accept' | 'decline', edited?: readonly ImportedFact[]): boolean {
    return settleSync(Effect.gen({ self: this }, function* () {
      const row = this.sql<ProposalRow & { status: string }>`SELECT id, proposal_json, origin_json, created_at, status FROM account_memory_proposals
        WHERE id = ${id} AND status IN ('pending', 'importing', 'failed')`[0];

      if (row === undefined || (decision === 'accept' && row.status !== 'pending')) return false;
      const { proposal, origin } = yield* readProposal(row);
      const kept = proposal.kind === 'import' && edited !== undefined ? { ...proposal, facts: v.parse(ImportedFactsSchema, edited) } : proposal;

      this.transaction(() => {
        if (decision === 'accept') this.write(kept, origin, id);

        if (kept.kind === 'import') this.pieces.drop(id, kept.pieces);
        void this.sql`UPDATE account_memory_proposals SET status = ${decision === 'accept' ? 'accepted' : 'declined'} WHERE id = ${id}`;
      });
      markStoreChanged(this.sql);

      return true;
    }));
  }

  /** Files the owner's import of `pieces`, in the order they are read, reading none of it yet. `replaces` are the facts it
   *  takes the place of once accepted; `keepNotes`, whether its pieces are kept as notes then. Its id. */
  startImport(pieces: readonly string[], replaces: readonly string[], keepNotes: boolean): string {
    return settleSync(Effect.gen({ self: this }, function* () {
      if (pieces.length === 0) return yield* new KinuError('bad_input', 'There are no words to import.');
      const record: AccountImport = { kind: 'import', pieces: pieces.length, keepNotes, read: 0, facts: [], replaces: replaces.map((key) => v.parse(FactKeySchema, key)) };
      const json = yield* importRow(record);
      const id = `amp_${nanoid(12)}`;

      this.transaction(() => {
        // Kept scrubbed (`memory/scrub.ts`), as every note is, and so read.
        for (const [at, piece] of pieces.entries()) this.pieces.put(id, at, scrubSecrets(piece));
        void this.sql`INSERT INTO account_memory_proposals (id, proposal_json, origin_json, delivery, status, created_at)
          VALUES (${id}, ${json}, ${JSON.stringify({ by: 'import' })}, ${null}, 'importing', ${Date.now()})`;
      });
      markStoreChanged(this.sql);

      return id;
    }));
  }

  /**
   * Each import row an earlier build wrote with its pieces inside, as this build keeps it: the pieces apart, the row their
   * count. One transaction; a row already converted is no longer legacy, so a second start changes nothing. Answers how
   * many it converted. One-time: see {@link LegacyImportSchema}.
   */
  convertLegacyImports(): number {
    const rows = this.sql<ImportRow>`SELECT id, proposal_json, status, created_at FROM account_memory_proposals
      WHERE proposal_json LIKE '%"kind":"import"%' AND proposal_json LIKE '%"notes":[%'`;

    const legacy = rows.flatMap((row) => {
      const parsed = v.safeParse(LegacyImportSchema, tolerate(() => parseJsonValue(row.proposal_json), 'malformed-input'));

      return parsed.success ? [{ id: row.id, record: parsed.output, open: row.status === 'pending' || row.status === 'importing' || row.status === 'failed' }] : [];
    });

    if (legacy.length === 0) return 0;
    this.transaction(() => {
      for (const { id, record, open } of legacy) {
        const { notes, ...rest } = record;

        // A decided import's pieces are read no more: only an open one keeps them, as `decide` drops them.
        for (const [at, piece] of open ? notes.entries() : []) this.pieces.put(id, at, piece);
        void this.sql`UPDATE account_memory_proposals SET proposal_json = ${JSON.stringify({ ...rest, pieces: notes.length, keepNotes: true })} WHERE id = ${id}`;
      }
    });
    markStoreChanged(this.sql);

    return legacy.length;
  }

  /** The imports still reading their document: each its next piece, and what the account will hold beside it. */
  importsDue(): { readonly id: string; readonly piece: { readonly text: string; readonly index: number; readonly total: number }; readonly known: ImportedFact[] }[] {
    return settleSync(Effect.forEach(this.sql<ImportRow>`SELECT id, proposal_json, status, created_at FROM account_memory_proposals
      WHERE status = 'importing' ORDER BY created_at, id`, (row) => Effect.map(readImport(row), (record) => {
      const replaced = new Set(record.replaces);
      // What it replaces is not what the account holds: the extractor would skip a subject it found there.
      const held = this.factsStore.all().filter((fact) => !replaced.has(fact.key)).map(({ key, value }) => ({ key, value }));

      return {
        id: row.id,
        piece: { text: this.pieces.get(row.id, record.read) ?? '', index: record.read, total: record.pieces },
        known: mergeImported(held, record.facts),
      };
    })));
  }

  /** The facts `id`'s piece `index` stated, kept with its earlier ones; the last piece files the batch for the owner.
   *  Answers whether more is left to read. A piece already read, or an import declined meanwhile, changes nothing. */
  importRead(id: string, index: number, facts: readonly ImportedFact[]): boolean {
    return settleSync(Effect.gen({ self: this }, function* () {
      const row = this.sql<ImportRow>`SELECT id, proposal_json, status, created_at FROM account_memory_proposals WHERE id = ${id} AND status = 'importing'`[0];

      if (row === undefined) return false;
      const record = yield* readImport(row);

      if (record.read !== index) return record.read < record.pieces;
      const next: AccountImport = { kind: 'import', pieces: record.pieces, keepNotes: record.keepNotes, read: index + 1, facts: mergeImported(record.facts, facts), replaces: record.replaces };
      const done = next.read >= next.pieces;
      const json = yield* importRow(next);

      void this.sql`UPDATE account_memory_proposals SET proposal_json = ${json}, status = ${done ? 'pending' : 'importing'} WHERE id = ${id}`;
      markStoreChanged(this.sql);

      return !done;
    }));
  }

  /** `id`'s last read failed, in `failure`'s words; `parked`: no wait mends it, so it waits for the owner's retry. */
  importFailed(id: string, failure: string, parked: boolean): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      const row = this.sql<ImportRow>`SELECT id, proposal_json, status, created_at FROM account_memory_proposals WHERE id = ${id} AND status = 'importing'`[0];

      if (row === undefined) return;
      const record = yield* readImport(row);
      const said = JSON.stringify({ ...record, failure });
      // A record at its row's ceiling keeps its words out rather than fail to stop: it parks all the same.
      const kept = rowBytes(said) <= ROW_BYTES ? said : row.proposal_json;

      void this.sql`UPDATE account_memory_proposals SET proposal_json = ${kept}, status = ${parked ? 'failed' : 'importing'}
        WHERE id = ${id}`;
      markStoreChanged(this.sql);
    }));
  }

  /** The owner retries a stopped import from the piece it stopped at. Answers whether one was stopped. */
  retryImport(id: string): boolean {
    const retried = this.sql<{ id: string }>`UPDATE account_memory_proposals SET status = 'importing' WHERE id = ${id} AND status = 'failed' RETURNING id`;

    if (retried.length > 0) markStoreChanged(this.sql);

    return retried.length > 0;
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

  /** Writes what the proposal asks; an import as `id`'s, whose pieces it reads. */
  private write(proposal: StoredProposal, origin: FactOrigin, id: string): void {
    if (proposal.kind === 'import') {
      const kept = new Set(proposal.facts.map((fact) => fact.key));

      for (let at = 0; proposal.keepNotes && at < proposal.pieces; at += 1) {
        const content = this.pieces.get(id, at);

        if (content !== undefined) this.insertNote(content, origin);
      }

      for (const key of proposal.replaces) if (!kept.has(key)) this.factsStore.forget(key, origin);

      for (const fact of proposal.facts) {
        this.factsStore.upsert(fact.key, fact.value, { veracity: 'stated', origin, ...(fact.importance !== undefined && { importance: fact.importance }) });
      }

      return;
    }

    if (proposal.kind === 'fact') {
      this.factsStore.upsert(proposal.key, proposal.value, {
        veracity: origin.by === 'background' ? 'inferred' : 'stated', origin,
        ...(proposal.importance !== undefined && { importance: proposal.importance }),
      });

      return;
    }

    this.insertNote(proposal.content, origin);
  }

  private insertNote(content: string, origin: FactOrigin): void {
    void this.sql`INSERT INTO account_notes (id, content, origin_json, created_at)
      VALUES (${`acn_${nanoid(12)}`}, ${content}, ${JSON.stringify(origin)}, ${Date.now()})`;
  }

  private notes(): Effect.Effect<AccountNote[], KinuError> {
    return Effect.forEach(this.sql<NoteRow>`SELECT id, content, origin_json, created_at FROM account_notes ORDER BY created_at DESC, id`, (row) => Effect.try({
      try: () => ({
        id: row.id, content: row.content, createdAt: row.created_at,
        origin: row.origin_json === null ? null : v.parse(FactOriginSchema, parseJsonValue(row.origin_json)),
      }),
      catch: (cause) => new KinuError('io', `Corrupt account memory note ${row.id}`, { cause }),
    }));
  }

  /** What waits on the owner, oldest first: the view's `pending`, for a reader that needs only that. */
  /** Withdraws the proposals still pending that `workspace` filed, as an eval workspace's teardown does with its own:
   *  no later trial reads them. Answers how many it withdrew. */
  withdrawFrom(workspace: string): number {
    const withdrawn = this.sql<{ id: string }>`UPDATE account_memory_proposals SET status = 'withdrawn'
      WHERE status = 'pending' AND json_extract(origin_json, '$.workspace') = ${workspace} RETURNING id`;

    if (withdrawn.length > 0) markStoreChanged(this.sql);

    return withdrawn.length;
  }

  pending(): AccountMemoryProposal[] {
    return settleSync(Effect.forEach(this.sql<ProposalRow>`
      SELECT id, proposal_json, origin_json, created_at FROM account_memory_proposals WHERE status = 'pending' ORDER BY created_at, id`, readProposal));
  }
}
