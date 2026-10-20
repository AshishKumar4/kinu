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
  type MailAgentMessage, type MailBox, type MailboxAgentCalls, type MailboxCalls, type MailCaller, type MailDelivery, type MailListing, type MailListQuery, type MailMessageView, type MailOutgoing,
  type MailRecipient, type MailThreadSummary, type MailThreadView, type MailTriaged, type MailTriageItem, type MailTriagePick, type MailWake,
  MailStore, type MailBlobs,
} from '@kinu.run/core';
import { installAnalyticsDiagnostics } from '@kinu.run/core/analytics';
import { Effect } from 'effect';
import { diagnostics, KinuError, settle, settleSync } from '@kinu.run/core/obs';
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

export class MailboxDO extends DurableObject<Env> implements MailboxCalls, MailboxAgentCalls {
  private readonly store: MailStore;

  private readonly outbox: EmailOutbox;

  /** Why this account's mail may not be read: its repair could not bring it to this build, or the deployment has no
   *  bucket for its bytes. Every call answers it before reading anything. */
  private readonly refusal: KinuError | undefined;

  private readonly bucket: R2Bucket | null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Storage a release left behind is repaired first, before any method reads it (core state/schema-repair.ts).
    const stamps = durableStamps(ctx.storage.kv);
    const unmade = readStamp(stamps, ctx.storage.sql, 'mailbox') === 'unmade';
    const init = (): void => { initMailboxTables(ctx.storage.sql); };

    const repair = repairSchema(ctx.storage.sql, {
      schema: 'mailbox', tables: SCHEMA_TABLES.mailbox, stamps, transactionSync: (write) => ctx.storage.transactionSync(write), init,
    }, `mailbox ${ctx.id.toString()}`);

    this.bucket = env.MAIL_BUCKET ?? null;

    if (repair?.refused != null) this.refusal = new StoragePredatesReleaseError('mailbox', repair.refused);
    else if (repair === null) init();

    if (unmade && this.refusal === undefined) writeStamp(stamps, 'mailbox');

    // A deployment with no bucket for mail's bytes answers no call; its rows wait for one.
    if (this.bucket === null) this.refusal ??= new KinuError('unavailable', 'This deployment has no MAIL_BUCKET.');
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

    // Never null where it is reached: every call answers `refusal` first.
    const bucket = this.bucket;

    return {
      put: async (relative, value) => { await bucket?.put(key(relative), value); },
      text: async (relative) => (await bucket?.get(key(relative)))?.text() ?? null,
      delete: async (keys) => { if (keys.length > 0) await bucket?.delete(keys.map(key)); },
    };
  }

  /** A call's answer from the store, or the refusal every call answers first. */
  private served<Answer>(work: () => Answer | Promise<Answer>): Effect.Effect<Answer, KinuError> {
    return this.refusal === undefined ? Effect.promise(async () => await work()) : Effect.fail(this.refusal);
  }

  /** The alarm serves both clocks: the outbox's next retry and the Trash's next emptying. */
  private async arm(at: number | null = null): Promise<void> {
    const due = [at, this.outbox.nextRetryAt(), this.store.nextPurgeAt()].filter((each): each is number => each !== null);
    const soonest = due.length === 0 ? null : Math.min(...due);
    const armed = await this.ctx.storage.getAlarm();

    if (soonest !== null && (armed === null || soonest < armed)) await this.ctx.storage.setAlarm(soonest);
  }

  override async alarm(): Promise<void> {
    if (this.refusal !== undefined) return settleSync(Effect.fail(this.refusal));

    if (this.env.EMAIL !== undefined) await this.outbox.reconcile(this.env.EMAIL, Date.now());

    const emptied = await this.store.purge();

    if (emptied > 0) diagnostics.event('mail.trash_emptied', { threads: emptied });
    await this.arm();
  }

  open(account: { userId: string; email: string; username: string; assistant: { workspace: string; actorId: string } | null }): Promise<MailBox> {
    return settle(this.served(() => this.store.open(account)));
  }

  boxFor(owner: { kind: 'workspace' | 'agent'; workspace: string; name: string; actorId: string }): Promise<MailBox> {
    return settle(this.served(() => this.store.boxFor(owner)));
  }

  readBy(reader: { workspace: string; actorId: string }): Promise<MailBox | null> {
    return settle(this.served(() => this.store.readBy(reader)));
  }

  untriagedFor(caller: MailCaller, limit: number, skip?: readonly string[]): Promise<readonly MailTriageItem[]> {
    return settle(this.served(() => this.store.untriagedFor(caller, limit, skip)));
  }

  triagedFor(caller: MailCaller, thread: string, version: number, pick: MailTriagePick): Promise<MailTriaged> {
    return settle(this.served(() => this.store.triagedFor(caller, thread, version, pick)));
  }

  boxes(): Promise<readonly MailBox[]> {
    return settle(this.served(() => this.store.boxes()));
  }

  deliver(input: { raw: Uint8Array; envelopeFrom: string; recipient: MailRecipient }): Promise<MailDelivery | null> {
    return settle(this.served(() => this.store.deliver(input)));
  }

  list(query: MailListQuery): Promise<MailListing> {
    return settle(this.served(() => this.store.list(query)));
  }

  thread(id: string): Promise<MailThreadView | null> {
    return settle(this.served(() => this.store.thread(id)));
  }

  async update(id: string, change: { read?: boolean; trashed?: boolean; important?: string | null }): Promise<MailThreadSummary> {
    if (this.refusal !== undefined) return settleSync(Effect.fail(this.refusal));
    const summary = this.store.update(id, change);

    if (change.trashed === true) await this.arm();

    return summary;
  }

  draft(outgoing: MailOutgoing & { threadId?: string }): Promise<MailMessageView> {
    return settle(this.served(() => this.store.draft(outgoing)));
  }

  send(outgoing: MailOutgoing & { threadId?: string }): Promise<MailMessageView> {
    return settle(this.sendOut(async () => ({ ...await this.store.queue(outgoing), outgoing })));
  }

  /** Files it (`file`) and hands it to the outbox, within the account's daily cap (none for operators). */
  private sendOut(file: () => Promise<{ view: MailMessageView; headerId: string; from: string; inReplyTo: string | null; outgoing: MailOutgoing }>): Effect.Effect<MailMessageView, KinuError> {
    const { env, store, outbox, refusal } = this;
    const sender = this.identity()?.email ?? '';
    const arm = async (): Promise<void> => this.arm();

    return Effect.gen(function* () {
      if (refusal !== undefined) return yield* Effect.fail(refusal);

      if (!isMailOperator(env, sender) && store.sentToday() >= DAILY_SEND_CAP) {
        return yield* Effect.fail(new KinuError('budget', `This account has sent ${String(DAILY_SEND_CAP)} messages in the last day; mail goes again as the day's first ones age out.`));
      }

      const binding = env.EMAIL;

      if (binding === undefined) return yield* Effect.fail(new KinuError('unavailable', 'This deployment cannot send mail yet: it has no Email Sending binding.'));

      const { view, headerId, from, inReplyTo, outgoing } = yield* Effect.promise(file);

      const sent = yield* Effect.promise(async () => outbox.send(binding, `mail:${view.id}`, {
        from, to: [...outgoing.to], subject: outgoing.subject, text: outgoing.text, headers: replyHeaders(headerId, inReplyTo),
      }, Date.now()));

      // Not yet sent is still queued: the outbox retries on this object's alarm.
      if (sent.status !== 'failed') store.markSent(view.id, 'sent');
      else yield* Effect.promise(arm);

      return { ...view, sendState: sent.status === 'failed' ? 'queued' : 'sent' };
    });
  }

  /* ——— An agent's calls (docs/MAIL.md §3): only the boxes it reads ——— */

  readableBy(caller: MailCaller): Promise<readonly MailBox[]> {
    return settle(this.served(() => this.store.readableBy(caller)));
  }

  findFor(caller: MailCaller, query: Omit<MailListQuery, 'path'> & { box?: string; unread?: boolean }): Promise<MailListing> {
    return settle(this.served(() => this.store.findFor(caller, query)));
  }

  readFor(caller: MailCaller, thread: string): Promise<MailThreadView | null> {
    return settle(this.served(() => this.store.readFor(caller, thread)));
  }

  draftFor(caller: MailCaller, message: MailAgentMessage): Promise<MailMessageView> {
    return settle(this.served(() => this.store.draftFor(caller, message)));
  }

  sendFor(caller: MailCaller, message: MailAgentMessage): Promise<MailMessageView> {
    return settle(this.sendOut(() => this.store.queueFor(caller, message)));
  }

  updateFor(caller: MailCaller, thread: string, change: { read?: boolean; trashed?: boolean; important?: string | null }): Promise<MailThreadSummary> {
    return settle(this.served(() => this.store.updateFor(caller, thread, change)));
  }

  setWake(path: string, wake: MailWake, allow?: readonly string[]): Promise<MailBox> {
    return settle(this.served(() => this.store.setWake(path, wake, allow)));
  }
}
