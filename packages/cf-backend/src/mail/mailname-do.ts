/**
 * One address label (`idFromName(label)`, docs/MAIL.md §2): its single row is the claim, and naming the object is
 * the global lock, so the first claim wins. Inbound mail looks a label up here in one hop: no singleton on the hot
 * path. A label is never reissued: a renamed-away username stays `former` and keeps routing to its account.
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

  /** Who holds the label, and how; null while nobody does. */
  lookup(): Promise<MailNameClaim | null> {
    if (this.storageRefusal !== undefined) return settleSync(Effect.fail(this.storageRefusal));
    const [row] = this.ctx.storage.sql.exec('SELECT label, user_id, kind, target_path FROM mail_name').toArray();

    return Promise.resolve(row === undefined ? null : v.parse(ClaimRow, row));
  }

  /**
   * Claims the label for `userId`; the holder already is that account when it answers. A reserved label is refused. On a
   * subdomain its address is routed first, with nothing between the rule and the row: an address Cloudflare will not
   * route, the 201st among them, is refused in its words and claimed by no one.
   */
  claim(label: string, userId: string, kind: 'username' | 'alias' = 'username', targetPath: string | null = null): Promise<MailNameClaim> {
    if (mailUsernameRefusal(label) !== null) return settle(Effect.fail(new KinuError('bad_input', `"${label}" cannot be an address.`)));

    if (this.storageRefusal !== undefined) return settle(Effect.fail(this.storageRefusal));

    // Answered outside the block: a refusal thrown inside it would reset the object.
    const claimed = Effect.promise(async () => this.ctx.blockConcurrencyWhile(async (): Promise<Exit.Exit<MailNameClaim, KinuError>> => {
      const held = await this.lookup();

      if (held !== null) return held.user_id === userId ? Exit.succeed(held) : Exit.fail(new KinuError('denied', `"${label}" is taken.`));
      const routed = this.routes === null ? Exit.void : await hold(this.routes.routed([`${label}@${this.env.EMAIL_DOMAIN ?? ''}`]));

      if (Exit.isFailure(routed)) return Exit.failCause(routed.cause);
      this.ctx.storage.sql.exec('INSERT INTO mail_name (label, user_id, kind, target_path) VALUES (?, ?, ?, ?)',
        label, userId, kind, kind === 'alias' ? targetPath : null);

      return Exit.succeed({ label, user_id: userId, kind, target_path: kind === 'alias' ? targetPath : null });
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
      const held = await this.lookup();

      if (held !== null && held.user_id !== userId) return Exit.void;
      const unrouted = this.routes === null ? Exit.void : await hold(this.routes.unrouted(label, this.env.EMAIL_DOMAIN ?? ''));

      if (Exit.isFailure(unrouted)) return unrouted;

      if (held !== null) await this.retire(userId);

      return Exit.void;
    }));

    return settle(Effect.flatMap(releasing, (exit) => exit));
  }

  /**
   * The label retired for good, as its account is deleted (docs/MAIL.md §11): its row stays, owned by no one, so it never
   * routes and is never claimed again. A label `userId` does not hold is not its to retire.
   */
  async retire(userId: string): Promise<void> {
    this.ctx.storage.sql.exec(`UPDATE mail_name SET user_id = '' WHERE user_id = ?`, userId);
  }
}
