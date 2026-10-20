/**
 * One account's mail (docs/MAIL.md §2): every box it has (its person, workspaces and agents), their threads, messages
 * and search, over this object's SQLite; bytes in R2 under `mail/<user_id>/`. Sends go out through `EmailOutbox` on
 * the `send_email` binding, retried on this object's alarm, which also empties the Trash. Only the Worker holds its
 * stub: the router delivers, and the account's routes and its workspaces' `mail.*` tools read and write.
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import {
  durableStamps, EmailOutbox, initMailboxTables, readStamp, repairSchema, SCHEMA_TABLES, StoragePredatesReleaseError, writeStamp,
  type MailBox, type MailboxCalls, type MailDelivery, type MailListing, type MailListQuery, type MailMessageView, type MailOutgoing,
  type MailRecipient, type MailThreadSummary, type MailThreadView, type MailWake,
} from '@kinu.run/core';
import { installAnalyticsDiagnostics } from '@kinu.run/core/analytics';
import { KinuError } from '@kinu.run/core/obs';
import { MailStore, type MailBlobs } from './store';
import { parseMail } from './parse';

/** Sends a day for an account that is not one of the deployment's operators (the owner, 2026-10-19). */
const DAILY_SEND_CAP = 100;

async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);

  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Whether `email` is one of the deployment's operators, who have no send cap and may always claim an address. */
function isMailOperator(env: Pick<Env, 'CONTROL_PLANE_ADMINS'>, email: string): boolean {
  return (env.CONTROL_PLANE_ADMINS ?? '').split(',').map((each) => each.trim().toLowerCase()).includes(email.trim().toLowerCase());
}

const IdentityRow = v.object({ user_id: v.string(), email: v.string() });

/** A message's own id, and for a reply what it answers. */
function replyHeaders(headerId: string, inReplyTo: string | null): Record<string, string> {
  const own = { 'Message-ID': `<${headerId}>` };

  return inReplyTo === null ? own : { ...own, 'In-Reply-To': inReplyTo, References: inReplyTo };
}

export class MailboxDO extends DurableObject<Env> implements MailboxCalls {
  private readonly store: MailStore;

  private readonly outbox: EmailOutbox;

  /** Why this account's mail may not be read: its repair could not bring it to this build. */
  private readonly storageRefusal: StoragePredatesReleaseError | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Storage a release left behind is repaired first, before any method reads it (core state/schema-repair.ts).
    const stamps = durableStamps(ctx.storage.kv);
    const unmade = readStamp(stamps, ctx.storage.sql, 'mailbox') === 'unmade';
    const init = (): void => { initMailboxTables(ctx.storage.sql); };

    const repair = repairSchema(ctx.storage.sql, {
      schema: 'mailbox', tables: SCHEMA_TABLES.mailbox, stamps, transactionSync: (write) => ctx.storage.transactionSync(write), init,
    }, `mailbox ${ctx.id.toString()}`);

    if (repair?.refused != null) this.storageRefusal = new StoragePredatesReleaseError('mailbox', repair.refused);
    else if (repair === null) init();

    if (unmade && this.storageRefusal === undefined) writeStamp(stamps, 'mailbox');
    this.outbox = new EmailOutbox(ctx.storage.sql, (at) => this.arm(at));
    this.store = new MailStore({
      sql: ctx.storage.sql, blobs: this.blobs(), domain: env.EMAIL_DOMAIN ?? '', now: () => Date.now(), id: () => crypto.randomUUID(),
      parse: parseMail, digest: sha256,
    });
    installAnalyticsDiagnostics(env);
  }

  /** Who the account is: null until its address is opened. */
  private identity(): v.InferOutput<typeof IdentityRow> | null {
    const [row] = this.ctx.storage.sql.exec('SELECT user_id, email FROM mail_box WHERE id = 1').toArray();

    return row === undefined ? null : v.parse(IdentityRow, row);
  }

  /** The account's R2 prefix, named by the user id the box was opened with. */
  private blobs(): MailBlobs {
    const key = (relative: string): string => `mail/${this.identity()?.user_id ?? 'unopened'}/${relative}`;

    const bucket = (): R2Bucket => {
      if (this.env.MAIL_BUCKET === undefined) throw new KinuError('unavailable', 'This deployment has no MAIL_BUCKET.');

      return this.env.MAIL_BUCKET;
    };

    return {
      put: async (relative, value) => { await bucket().put(key(relative), value); },
      text: async (relative) => (await bucket().get(key(relative)))?.text() ?? null,
      delete: async (keys) => { if (keys.length > 0) await bucket().delete(keys.map(key)); },
    };
  }

  private ready(): void {
    if (this.storageRefusal !== undefined) throw this.storageRefusal;
  }

  /** The alarm serves both clocks: the outbox's next retry and the Trash's next emptying. */
  private async arm(at: number | null = null): Promise<void> {
    const due = [at, this.outbox.nextRetryAt(), this.store.nextPurgeAt()].filter((each): each is number => each !== null);
    const soonest = due.length === 0 ? null : Math.min(...due);
    const armed = await this.ctx.storage.getAlarm();

    if (soonest !== null && (armed === null || soonest < armed)) await this.ctx.storage.setAlarm(soonest);
  }

  override async alarm(): Promise<void> {
    this.ready();

    if (this.env.EMAIL !== undefined) await this.outbox.reconcile(this.env.EMAIL, Date.now());
    await this.store.purge();
    await this.arm();
  }

  open(account: { userId: string; email: string; username: string; assistant: { workspace: string; actorId: string } | null }): Promise<MailBox> {
    this.ready();

    return Promise.resolve(this.store.open(account));
  }

  boxFor(owner: { kind: 'workspace' | 'agent'; workspace: string; name: string; actorId: string }): Promise<MailBox> {
    this.ready();

    return Promise.resolve(this.store.boxFor(owner));
  }

  boxes(): Promise<readonly MailBox[]> {
    this.ready();

    return Promise.resolve(this.store.boxes());
  }

  deliver(input: { raw: Uint8Array; envelopeFrom: string; recipient: MailRecipient }): Promise<MailDelivery | null> {
    this.ready();

    return this.store.deliver(input);
  }

  list(query: MailListQuery): Promise<MailListing> {
    this.ready();

    return Promise.resolve(this.store.list(query));
  }

  thread(id: string): Promise<MailThreadView | null> {
    this.ready();

    return this.store.thread(id);
  }

  async update(id: string, change: { read?: boolean; trashed?: boolean; important?: string | null }): Promise<MailThreadSummary> {
    this.ready();
    const summary = this.store.update(id, change);

    if (change.trashed === true) await this.arm();

    return summary;
  }

  draft(outgoing: MailOutgoing & { threadId?: string }): Promise<MailMessageView> {
    this.ready();

    return this.store.draft(outgoing);
  }

  async send(outgoing: MailOutgoing & { threadId?: string }): Promise<MailMessageView> {
    this.ready();

    if (!isMailOperator(this.env, this.identity()?.email ?? '') && this.store.sentToday() >= DAILY_SEND_CAP) {
      throw new KinuError('budget', `This account has sent ${String(DAILY_SEND_CAP)} messages in the last day; mail goes again as the day's first ones age out.`);
    }

    if (this.env.EMAIL === undefined) throw new KinuError('unavailable', 'This deployment cannot send mail yet: it has no Email Sending binding.');

    const { view, headerId, from } = await this.store.queue(outgoing);

    const sent = await this.outbox.send(this.env.EMAIL, `mail:${view.id}`, {
      from, to: [...outgoing.to], subject: outgoing.subject, text: outgoing.text, headers: replyHeaders(headerId, outgoing.inReplyTo ?? null),
    }, Date.now());

    // Not yet sent is still queued: the outbox retries on this object's alarm.
    if (sent.status !== 'failed') this.store.markSent(view.id, 'sent');
    else await this.arm();

    return { ...view, sendState: sent.status === 'failed' ? 'queued' : 'sent' };
  }

  setWake(path: string, wake: MailWake, allow?: readonly string[]): Promise<MailBox> {
    this.ready();

    return Promise.resolve(this.store.setWake(path, wake, allow));
  }
}
