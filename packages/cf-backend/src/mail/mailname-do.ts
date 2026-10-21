/**
 * One address label (`idFromName(label)`, docs/MAIL.md §2): its single row is the claim, and naming the object is
 * the global lock, so the first claim wins. Inbound mail looks a label up here in one hop: no singleton on the hot
 * path. A label is never reissued: a renamed-away username stays `former` and keeps routing to its account.
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { Effect, Exit } from 'effect';
import { hold, KinuError, settle, settleSync } from '@kinu.run/core/obs';
import type { MailRoutes } from '@kinu.run/core/deploy';
import { mailRoutesOf } from './routing';
import { durableStamps, initMailNameTables, mailUsernameRefusal, readStamp, repairSchema, SCHEMA_TABLES, StoragePredatesReleaseError, writeStamp } from '@kinu.run/core';

const ClaimRow = v.object({
  label: v.string(), user_id: v.string(), kind: v.picklist(['username', 'alias']), target_path: v.nullable(v.string()),
});

export type MailNameClaim = v.InferOutput<typeof ClaimRow>;

export class MailNameDO extends DurableObject<Env> {
  private readonly storageRefusal: StoragePredatesReleaseError | undefined;

  /** Null where the deployment's mail is on its zone's apex, whose catch-all routes every address (routing.ts). */
  private readonly routes: MailRoutes | null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.routes = mailRoutesOf(env);
    const stamps = durableStamps(ctx.storage.kv);
    const unmade = readStamp(stamps, ctx.storage.sql, 'mailname') === 'unmade';
    const init = (): void => { initMailNameTables(ctx.storage.sql); };

    const repair = repairSchema(ctx.storage.sql, {
      schema: 'mailname', tables: SCHEMA_TABLES.mailname, stamps, transactionSync: (write) => ctx.storage.transactionSync(write), init,
    }, `mail name ${ctx.id.toString()}`);

    if (repair?.refused != null) this.storageRefusal = new StoragePredatesReleaseError('mailname', repair.refused);
    else if (repair === null) init();

    if (unmade && this.storageRefusal === undefined) writeStamp(stamps, 'mailname');
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

    // Answered outside the block: a refusal thrown inside it would reset the object.
    const claimed = Effect.promise(async () => this.ctx.blockConcurrencyWhile(async (): Promise<Exit.Exit<MailNameClaim, KinuError>> => {
      const held = await this.lookup();

      if (held !== null) return held.user_id === userId ? Exit.succeed(held) : Exit.fail(new KinuError('denied', `"${label}" is taken.`));
      const routed = this.routes === null ? Exit.void : await hold(this.routes.routed(`${label}@${this.env.EMAIL_DOMAIN ?? ''}`));

      if (Exit.isFailure(routed)) return Exit.failCause(routed.cause);
      this.ctx.storage.sql.exec('INSERT INTO mail_name (label, user_id, kind, target_path) VALUES (?, ?, ?, ?)',
        label, userId, kind, kind === 'alias' ? targetPath : null);

      return Exit.succeed({ label, user_id: userId, kind, target_path: kind === 'alias' ? targetPath : null });
    }));

    return settle(Effect.flatMap(claimed, (exit) => exit));
  }

  /**
   * The label retired for good, as its account is deleted (docs/MAIL.md §11): its row stays, owned by no one, so it never
   * routes and is never claimed again. A label `userId` does not hold is not its to retire. On a subdomain the rules of
   * its address and of every box under it go first, while the row still says whose they were, so a retry finds them.
   */
  async retire(userId: string): Promise<void> {
    const held = this.routes === null ? null : await this.lookup();

    if (held !== null && held.user_id === userId && this.routes !== null) {
      const unrouted = await hold(this.routes.unrouted(held.label, this.env.EMAIL_DOMAIN ?? ''));

      if (Exit.isFailure(unrouted)) return settleSync(Effect.failCause(unrouted.cause));
    }

    this.ctx.storage.sql.exec(`UPDATE mail_name SET user_id = '' WHERE user_id = ?`, userId);
  }
}
