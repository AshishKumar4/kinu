/**
 * One address label (`idFromName(label)`, docs/MAIL.md §2): its single row is the claim, and naming the object is
 * the global lock, so the first claim wins. Inbound mail looks a label up here in one hop: no singleton on the hot
 * path. A label is never reissued: a renamed-away username stays `former` and keeps routing to its account.
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { KinuError } from '@kinu.run/core/obs';
import { durableStamps, initMailNameTables, isMailLabel, readStamp, repairSchema, SCHEMA_TABLES, StoragePredatesReleaseError, writeStamp } from '@kinu.run/core';

/** Labels no account may claim: the mailbox names mail systems and people expect to reach a deployment's operator. */
const RESERVED_LABELS: ReadonlySet<string> = new Set([
  'postmaster', 'abuse', 'admin', 'administrator', 'noreply', 'no-reply', 'mail', 'mailer-daemon', 'ops', 'dmarc', 'security',
  'support', 'root', 'www', 'hostmaster', 'webmaster', 'info', 'help', 'billing',
]);

const ClaimRow = v.object({
  label: v.string(), user_id: v.string(), kind: v.picklist(['username', 'alias']), target_path: v.nullable(v.string()),
  state: v.picklist(['active', 'former', 'retired']),
});

export type MailNameClaim = v.InferOutput<typeof ClaimRow>;

export class MailNameDO extends DurableObject<Env> {
  private readonly storageRefusal: StoragePredatesReleaseError | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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
    if (this.storageRefusal !== undefined) throw this.storageRefusal;
    const [row] = this.ctx.storage.sql.exec('SELECT label, user_id, kind, target_path, state FROM mail_name').toArray();

    return Promise.resolve(row === undefined ? null : v.parse(ClaimRow, row));
  }

  /** Claims the label for `userId`; the holder already is that account when it answers. A reserved label is refused. */
  async claim(label: string, userId: string, kind: 'username' | 'alias' = 'username', targetPath: string | null = null): Promise<MailNameClaim> {
    if (!isMailLabel(label) || RESERVED_LABELS.has(label)) throw new KinuError('bad_input', `"${label}" cannot be an address.`);
    const held = await this.lookup();

    if (held !== null) {
      if (held.user_id !== userId || held.state === 'retired') throw new KinuError('denied', `"${label}" is taken.`);

      return held;
    }

    this.ctx.storage.sql.exec('INSERT INTO mail_name (label, user_id, kind, target_path, claimed_at) VALUES (?, ?, ?, ?, ?)',
      label, userId, kind, kind === 'alias' ? targetPath : null, Date.now());

    return { label, user_id: userId, kind, target_path: kind === 'alias' ? targetPath : null, state: 'active' };
  }
}
