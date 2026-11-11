/**
 * The account's memory in the user object: who may ask, then core's store (`core/src/memory/account.ts`). Agents read it
 * whole and propose to it; only the owner accepts, edits, promotes or forgets (`memory.account.manage` is owner-only).
 */
import * as v from 'valibot';
import { Effect } from 'effect';
import {
  AccountMemoryStore, extractImportPiece, factsAsDocument, importPieces, ImportedFactsSchema,
  type AccountMemoryView, type AccountNoteHit, type AccountProposal, type AccountProposalFiled, type AccountProposer, type Fact, type ImportedFact,
  type ImportJudge, type JsonValue, type SqlExecutor, type UserCaller,
} from '@kinu.run/core';
import { attempt, CODE_IS_REFUSAL, diagnostics, KinuError, renderThrownChain, settle, toKinuError } from '@kinu.run/core/obs';
import type { UserObjectHost } from './user-host';
import { rosterSockets, sendRosterFrame } from './roster';
import type { ImportRun } from './account-imports';

export interface AccountMemoryHost extends UserObjectHost {
  /** The user object's tagged SQL, as every store over it takes. */
  readonly sql: SqlExecutor;
  /** An import was started or retried: its job comes due (`AccountImportJobs`). */
  readonly importDue: () => Promise<void>;
  /** The account's fast tier, which an import's pieces are read on. */
  readonly importJudge: () => Promise<ImportJudge>;
}

/** What an owner imports: a document, or facts the account holds, which the batch replaces once accepted. */
export const AccountImportSourceSchema = v.union([
  v.strictObject({ document: v.pipe(v.string(), v.trim(), v.nonEmpty('The document holds no words to import.')) }),
  v.strictObject({ facts: v.pipe(v.array(v.pipe(v.string(), v.nonEmpty())), v.minLength(1, 'Choose the facts to import.')) }),
]);

export type AccountImportSource = v.InferInput<typeof AccountImportSourceSchema>;

const DecisionSchema = v.picklist(['accept', 'decline']);

export class UserAccountMemory {
  private readonly store: AccountMemoryStore;

  constructor(private readonly host: AccountMemoryHost) {
    this.store = new AccountMemoryStore(host.sql, (body) => { host.ctx.storage.transactionSync(body); });
  }

  async accountMemory_facts(caller: UserCaller): Promise<Fact[]> {
    await this.host.requireTier(caller, 'memory.account.read');

    return this.store.facts();
  }

  async accountMemory_searchNotes(caller: UserCaller, query: string, limit: number): Promise<AccountNoteHit[]> {
    await this.host.requireTier(caller, 'memory.account.read');

    return this.store.searchNotes(v.parse(v.string(), query), limit);
  }

  /** Where it was said is the calling workspace, never a field a caller writes. */
  async accountMemory_propose(caller: UserCaller, proposal: AccountProposal, proposer: AccountProposer, delivery?: string): Promise<AccountProposalFiled> {
    const resolved = await this.host.requireTier(caller, 'memory.account.propose');
    const filed = this.store.propose({ proposal, proposer, ...(delivery !== undefined && { delivery }) }, resolved.kind === 'workspace' ? resolved.workspace : null);

    this.pendingMoved();

    return filed;
  }

  /** An eval workspace's teardown: the proposals it filed leave the queue, which the owner's open pages see. */
  withdrawFrom(workspace: string): void {
    if (this.store.withdrawFrom(workspace) > 0) this.pendingMoved();
  }

  /** The owner's open pages: what waits on them, sent on the roster's socket, so their chats' stacks show it. */
  pendingMoved(sockets: readonly WebSocket[] = rosterSockets(this.host.ctx)): void {
    if (sockets.length === 0) return;
    sendRosterFrame(sockets, { type: 'account_memory', pending: this.store.pending() }, this.host.sessionStands);
  }

  async accountMemory_view(caller: UserCaller): Promise<AccountMemoryView> {
    await this.host.requireTier(caller, 'memory.account.manage');

    return this.store.view();
  }

  /** `facts`: an import's facts as the owner kept and edited them, accepted in place of the batch's own. */
  async accountMemory_decide(caller: UserCaller, id: string, decision: 'accept' | 'decline', facts?: readonly ImportedFact[]): Promise<boolean> {
    await this.host.requireTier(caller, 'memory.account.manage');
    const decided = this.store.decide(id, v.parse(DecisionSchema, decision), facts === undefined ? undefined : v.parse(ImportedFactsSchema, facts));

    if (decided) this.pendingMoved();

    return decided;
  }

  /** Files the owner's import and starts reading it; its id. Facts it names are read as one document and replaced by the
   *  batch once it is accepted. */
  async accountMemory_import(caller: UserCaller, source: AccountImportSource): Promise<string> {
    await this.host.requireTier(caller, 'memory.account.manage');
    const parsed = v.parse(AccountImportSourceSchema, source);

    return settle(Effect.gen({ self: this }, function* () {
      const named = 'document' in parsed ? null : new Set(parsed.facts);
      const chosen = named === null ? [] : this.store.facts().filter((fact) => named.has(fact.key));

      if (named !== null && chosen.length === 0) return yield* new KinuError('missing', 'None of those facts is in your account memory.');

      const started = yield* Effect.try({
        try: () => ('document' in parsed
          ? this.store.startImport(importPieces(parsed.document), [])
          : this.store.startImport(importPieces(factsAsDocument(chosen)), chosen.map((fact) => fact.key))),
        catch: (cause) => toKinuError({ doing: 'filing this import', cause, otherwise: 'bad_input' }),
      });

      yield* Effect.promise(() => this.host.importDue());
      this.pendingMoved();

      return started;
    }));
  }

  /** The owner retries an import stopped on a failure, from the piece it stopped at. */
  async accountMemory_retryImport(caller: UserCaller, id: string): Promise<boolean> {
    await this.host.requireTier(caller, 'memory.account.manage');
    const retried = this.store.retryImport(id);

    if (retried) {
      await this.host.importDue();
      this.pendingMoved();
    }

    return retried;
  }

  /** Whether an import has a piece left to read. */
  importOwed(): boolean {
    return this.store.importsDue().length > 0;
  }

  /**
   * Reads the oldest import's next piece. A failure is kept on the import in its provider's words: one no wait mends
   * stops it until the owner retries it; any other is read again a lap later. The owner's open pages hear each step.
   */
  async readNextImportPiece(): Promise<ImportRun> {
    return settle(Effect.gen({ self: this }, function* () {
      const [next] = this.store.importsDue();

      if (next === undefined) return 'done' as const;

      // Read and kept as one: a piece whose facts the record cannot hold stops the import as a failed read does.
      const read = yield* Effect.result(Effect.flatMap(
        attempt({ doing: 'reading an imported document into facts', otherwise: 'unavailable' }, async () => extractImportPiece(await this.host.importJudge(), next.piece, next.known)),
        (facts) => Effect.try({
          try: () => { this.store.importRead(next.id, next.piece.index, facts); },
          catch: (cause) => toKinuError({ doing: 'keeping what a piece of the import stated', cause, otherwise: 'io' }),
        }),
      ));

      if (read._tag === 'Failure') {
        const parked = CODE_IS_REFUSAL[read.failure.code];

        diagnostics.failure('memory.import_failed', read.failure, { import: next.id, parked });
        this.store.importFailed(next.id, renderThrownChain({ cause: read.failure }), parked);
        this.pendingMoved();

        if (!parked) return 'later' as const;
      } else {
        this.pendingMoved();
      }

      return this.importOwed() ? 'more' as const : 'done' as const;
    }));
  }

  async accountMemory_put(caller: UserCaller, key: string, value: JsonValue, workspace?: string): Promise<string> {
    await this.host.requireTier(caller, 'memory.account.manage');

    return this.store.put(key, value, workspace);
  }

  async accountMemory_forget(caller: UserCaller, key: string): Promise<boolean> {
    await this.host.requireTier(caller, 'memory.account.manage');

    return this.store.forget(key);
  }

  async accountMemory_forgetNote(caller: UserCaller, id: string): Promise<boolean> {
    await this.host.requireTier(caller, 'memory.account.manage');

    return this.store.forgetNote(id);
  }
}
