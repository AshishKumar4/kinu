/**
 * The account's memory in the user object: who may ask, then core's store (`core/src/memory/account.ts`). Agents read it
 * whole and propose to it; only the owner accepts, edits, promotes or forgets (`memory.account.manage` is owner-only).
 */
import * as v from 'valibot';
import {
  AccountMemoryStore,
  type AccountMemoryView, type AccountNoteHit, type AccountProposal, type AccountProposer, type Fact, type JsonValue,
  type SqlExecutor, type UserCaller,
} from '@kinu.run/core';
import type { UserObjectHost } from './user-host';

export interface AccountMemoryHost extends UserObjectHost {
  /** The user object's tagged SQL, as every store over it takes. */
  readonly sql: SqlExecutor;
}

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
  async accountMemory_propose(caller: UserCaller, proposal: AccountProposal, proposer: AccountProposer, delivery?: string): Promise<string> {
    const resolved = await this.host.requireTier(caller, 'memory.account.propose');

    return this.store.propose({ proposal, proposer, ...(delivery !== undefined && { delivery }) }, resolved.kind === 'workspace' ? resolved.workspace : null);
  }

  async accountMemory_view(caller: UserCaller): Promise<AccountMemoryView> {
    await this.host.requireTier(caller, 'memory.account.manage');

    return this.store.view();
  }

  async accountMemory_decide(caller: UserCaller, id: string, decision: 'accept' | 'decline'): Promise<boolean> {
    await this.host.requireTier(caller, 'memory.account.manage');

    return this.store.decide(id, v.parse(DecisionSchema, decision));
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
