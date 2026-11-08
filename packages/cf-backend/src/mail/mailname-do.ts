/**
 * One address label (`idFromName(label)`, docs/MAIL.md §2): its single row is the claim, and naming the object is
 * the global lock, so the first claim wins. Inbound mail looks a label up here in one hop: no singleton on the hot
 * path. A label never passes to another account: one retired as its account is deleted routes nothing, and only the
 * account it was retired from may claim it again (docs/MAIL.md §11).
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { Effect, Exit } from 'effect';
import { hold, KinuError, settle, settleSync } from '@kinu.run/core/obs';
import { mailRoutesOf, type MailRoutes } from '@kinu.run/core/deploy';
import { initMailNameTables, mailUsernameRefusal, openSchema, StoragePredatesReleaseError } from '@kinu.run/core';

const ClaimRow = v.object({
  label: v.string(), user_id: v.string(), kind: v.picklist(['username', 'alias']), target_path: v.nullable(v.string()),
});

export type MailNameClaim = v.InferOutput<typeof ClaimRow>;

/** Whether an account may hold the label: no one ever has, it is theirs (held, or retired from them), or another's. */
export type MailNameStanding = 'unclaimed' | 'theirs' | 'taken';

/** What an operator's hand-back did: the label is the account's to claim again, or why not. */
export type MailNameReturn = 'returned' | 'unclaimed' | 'held' | 'retired_from_another';

/** The account a retired label was retired from: the one account that may claim it again. */
const RETIRED_FROM = 'mail:retired-from';

export class MailNameDO extends DurableObject<Env> {
  private readonly storageRefusal: StoragePredatesReleaseError | undefined;

  /** Null where the deployment's mail is on its zone's apex, whose catch-all routes every address (core deploy/mail-rules.ts). */
  private readonly routes: MailRoutes | null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.routes = mailRoutesOf(env);
    const opened = openSchema(ctx.storage, 'mailname', () => { initMailNameTables(ctx.storage.sql); }, `mail name ${ctx.id.toString()}`);

    if (opened.refused !== null) this.storageRefusal = opened.refused;
  }

  private held(): MailNameClaim | null {
    const [row] = this.ctx.storage.sql.exec('SELECT label, user_id, kind, target_path FROM mail_name').toArray();

    return row === undefined ? null : v.parse(ClaimRow, row);
  }

  private standingOf(held: MailNameClaim | null, userId: string): MailNameStanding {
    if (held === null) return 'unclaimed';

    const theirs = held.user_id === userId || (held.user_id === '' && this.ctx.storage.kv.get(RETIRED_FROM) === userId);

    return theirs ? 'theirs' : 'taken';
  }

  /** Who holds the label, and how; null while nobody does. A retired label is held by no account (`user_id` empty). */
  lookup(): Promise<MailNameClaim | null> {
    if (this.storageRefusal !== undefined) return settleSync(Effect.fail(this.storageRefusal));

    return Promise.resolve(this.held());
  }

  /** Whether `userId` may hold the label, as its owner reads a name they type. */
  standing(userId: string): Promise<MailNameStanding> {
    if (this.storageRefusal !== undefined) return settleSync(Effect.fail(this.storageRefusal));

    return Promise.resolve(this.standingOf(this.held(), userId));
  }

  /**
   * Claims the label for `userId`; the holder already is that account when it answers, and a label retired from that
   * account is theirs again. A reserved label is refused. On a subdomain its address is routed first, with nothing
   * between the rule and the row: an address Cloudflare will not route, the 201st among them, is refused in its words
   * and claimed by no one.
   */
  claim(label: string, userId: string, kind: 'username' | 'alias' = 'username', targetPath: string | null = null): Promise<MailNameClaim> {
    if (mailUsernameRefusal(label) !== null) return settle(Effect.fail(new KinuError('bad_input', `"${label}" cannot be an address.`)));

    if (this.storageRefusal !== undefined) return settle(Effect.fail(this.storageRefusal));

    // Answered outside the block: a refusal thrown inside it would reset the object.
    const claimed = Effect.promise(async () => this.ctx.blockConcurrencyWhile(async (): Promise<Exit.Exit<MailNameClaim, KinuError>> => {
      const held = this.held();

      if (this.standingOf(held, userId) === 'taken') return Exit.fail(new KinuError('denied', `"${label}" is taken.`));

      if (held !== null && held.user_id === userId) return Exit.succeed(held);
      const routed = this.routes === null ? Exit.void : await hold(this.routes.routed([`${label}@${this.env.EMAIL_DOMAIN ?? ''}`]));

      if (Exit.isFailure(routed)) return Exit.failCause(routed.cause);
      const claim: MailNameClaim = { label, user_id: userId, kind, target_path: kind === 'alias' ? targetPath : null };

      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO mail_name (label, user_id, kind, target_path) VALUES (?, ?, ?, ?)',
        claim.label, claim.user_id, claim.kind, claim.target_path);
      this.ctx.storage.kv.delete(RETIRED_FROM);

      return Exit.succeed(claim);
    }));

    return settle(Effect.flatMap(claimed, (exit) => exit));
  }

  /**
   * The label let go as `userId`'s account is deleted (docs/MAIL.md §11), serialized with claims so none under way is
   * unrouted beneath it. Held by that account: the rules of its address and of every box under it deleted, then the
   * label retired. Held by no one: a claim cut off after its rule was made may have left that rule, which goes too.
   * Another account's: nothing. Answered outside the block, where a thrown refusal would reset the object.
   */
  release(label: string, userId: string): Promise<void> {
    if (this.storageRefusal !== undefined) return settle(Effect.fail(this.storageRefusal));

    const releasing = Effect.promise(async () => this.ctx.blockConcurrencyWhile(async (): Promise<Exit.Exit<void, KinuError>> => {
      const held = this.held();

      if (held !== null && held.user_id !== userId) return Exit.void;
      const unrouted = this.routes === null ? Exit.void : await hold(this.routes.unrouted(label, this.env.EMAIL_DOMAIN ?? ''));

      if (Exit.isFailure(unrouted)) return unrouted;

      if (held !== null) await this.retire(userId);

      return Exit.void;
    }));

    return settle(Effect.flatMap(releasing, (exit) => exit));
  }

  /**
   * The label retired as `userId`'s account is deleted (docs/MAIL.md §11): its row stays, held by no account, so it
   * routes nothing and no other account can claim it; the account it was retired from is kept beside it, so the same
   * person, signed in again, may. A label `userId` does not hold is not its to retire.
   */
  async retire(userId: string): Promise<void> {
    const retired = this.ctx.storage.sql.exec(`UPDATE mail_name SET user_id = '' WHERE user_id = ?`, userId).rowsWritten;

    if (retired > 0) this.ctx.storage.kv.put(RETIRED_FROM, userId);
  }

  /**
   * An operator's hand-back (the control plane's `account.address_return`): a retired label made `userId`'s to claim
   * again, for a label retired before its object kept whom it was retired from. Nothing routes until they claim it. A
   * label someone holds, one no one ever claimed, and one retired from another account are refused.
   */
  returnTo(userId: string): Promise<MailNameReturn> {
    if (this.storageRefusal !== undefined) return settleSync(Effect.fail(this.storageRefusal));
    const held = this.held();

    if (held === null) return Promise.resolve('unclaimed');

    if (held.user_id !== '') return Promise.resolve('held');
    const from = this.ctx.storage.kv.get(RETIRED_FROM);

    if (from !== undefined && from !== userId) return Promise.resolve('retired_from_another');
    this.ctx.storage.kv.put(RETIRED_FROM, userId);

    return Promise.resolve('returned');
  }
}
