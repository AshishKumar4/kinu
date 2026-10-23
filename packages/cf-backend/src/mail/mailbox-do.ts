/**
 * One account's mail (docs/MAIL.md §2): every box it has (its person, workspaces and agents), their threads, messages
 * and search, over this object's SQLite; bytes in R2 under `mail/<user_id>/`. Sends go out through `EmailOutbox` on
 * the `send_email` binding, retried on this object's alarm, which also empties the Trash. Only the Worker holds its
 * stub: the router delivers, and the account's routes and its workspaces' `mail.*` tools read and write.
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import {
  objectNamed,
  durableStamps, EmailOutbox, initMailboxTables, mailboxEmail, sha256Hex, openSchema, writeStamp,
  type MailAgentMessage, type MailBox, type MailboxAgentCalls, type MailboxCalls, type MailCaller, type MailDelivery, type MailListing, type MailListQuery, type MailMessageView, type MailOutgoing,
  type MailBoxOwner, type MailRecipient, type MailThreadSummary, type MailThreadView, type MailTriaged, type MailTriageItem, type MailTriagePick, type MailWake,
  MailStore, type MailBlobs, type ArmedRestore, type OpsCaller, type RestoreTarget, requireOps,
  bookmarkNow, missingBytes, restartedForRestore, restoreArmed, type MissingBytes,
} from '@kinu.run/core';
import { installAnalyticsDiagnostics } from '@kinu.run/core/analytics';
import { Effect, Exit } from 'effect';
import { authoredRefusal, diagnostics, hold, KinuError, settle, settleSync } from '@kinu.run/core/obs';
import { mailRoutesOf, type MailRoutes } from '@kinu.run/core/deploy';
import { parseMail } from './parse';
import { isListedOperator } from '../control-plane/admin-caller';

/** A message's send in the outbox: this prefix and the message's id. */
const MAIL_SEND_KEY = 'mail:';

/** Sends a day for an account that is not one of the deployment's operators (the owner, 2026-10-19). */
const DAILY_SEND_CAP = 100;

const IdentityRow = v.object({ user_id: v.string(), email: v.string(), username: v.string() });

/** The routing grant this account's addresses were last routed under (core deploy/mail-rules.ts). */
const ROUTED_UNDER = 'mail:routed-under';

/**
 * The name this box's claim finished for: its acknowledgment of its own two-object step (its rows, then MailName's
 * claim), not a mirror of MailName's ownership. Until it names the box's username, a call first finishes the claim.
 */
const CLAIMED = 'mail:claimed';

/**
 * MailName's own denial, across RPC: the name another account's, or Cloudflare's rule for it refused. Only that proves no
 * claim was made; a lost reply, a reset or a store that could not be read proves nothing.
 */
const ClaimDenied = v.object({ remote: v.literal(true), _tag: v.literal('KinuError'), code: v.literal('denied') });

export class MailboxDO extends DurableObject<Env> implements MailboxCalls, MailboxAgentCalls {
  private readonly store: MailStore;

  private readonly outbox: EmailOutbox;

  /** Why this account's mail may not be read: its repair could not bring it to this build, or the deployment has no
   *  bucket for its bytes. Every call answers it before reading anything. */
  private readonly refusal: KinuError | undefined;

  private readonly bucket: R2Bucket | null;

  /** Null where the deployment's mail is on its zone's apex, whose catch-all routes every address (core deploy/mail-rules.ts). */
  private readonly routes: MailRoutes | null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.routes = mailRoutesOf(env);
    // Storage a release left behind is repaired first, before any method reads it (core state/schema-repair.ts).
    const opened = openSchema(ctx.storage, 'mailbox', () => { initMailboxTables(ctx.storage.sql); }, `mailbox ${ctx.id.toString()}`);

    this.bucket = env.MAIL_BUCKET ?? null;

    if (opened.refused !== null) this.refusal = opened.refused;

    // A deployment with no bucket for mail's bytes answers no call; its rows wait for one.
    if (this.bucket === null) this.refusal ??= new KinuError('unavailable', 'This deployment has no MAIL_BUCKET.');
    // A message the service sent keeps the Message-ID it wrote, which replies name; its send state is the outbox's alone.
    this.outbox = new EmailOutbox(ctx.storage.sql, (at) => this.arm(at), (key, messageId) => {
      if (key.startsWith(MAIL_SEND_KEY)) this.store.sentAs(key.slice(MAIL_SEND_KEY.length), messageId);
    });
    this.store = new MailStore({
      sql: ctx.storage.sql, blobs: this.blobs(), domain: env.EMAIL_DOMAIN ?? '', now: () => Date.now(), id: () => crypto.randomUUID(),
      parse: parseMail, digest: async (bytes) => sha256Hex(bytes), sendState: (messageId) => this.outbox.stateOf(`${MAIL_SEND_KEY}${messageId}`),
    });
    installAnalyticsDiagnostics(env);
  }

  /** Who the account is: null until its address is opened. */
  private identity(): v.InferOutput<typeof IdentityRow> | null {
    const [row] = this.ctx.storage.sql.exec('SELECT user_id, email, username FROM mail_box WHERE id = 1').toArray();

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

  /** A call's answer from the store, or the refusal every call answers first; a caller's once its boxes are routed. */
  private served<Answer>(work: () => Answer | Promise<Answer>, caller?: MailCaller): Effect.Effect<Answer, KinuError> {
    return this.asCaller(this.refusal === undefined ? this.fenced(Effect.promise(async () => await work())) : Effect.fail(this.refusal), caller);
  }

  /**
   * Mail on a subdomain (core deploy/mail-rules.ts), before a call: the account's addresses routed again where they were
   * last routed under another grant (its domain moved onto this one), then each address the call would make (`planned`)
   * routed, then made, in one block so nothing comes between a rule and its row. Every address the account has is made
   * here: the person's as its box is opened, each workspace's and agent's as a call first reads it. A rule Cloudflare refuses, the 201st
   * among them, leaves its box unmade, keeps those routed before it, and refuses the call in its words; the refusal is
   * answered outside the block, where a thrown one would reset the object. An apex routes nothing, and a grant with no
   * token (`under` empty) routes nothing again: it only refuses new boxes.
   */
  private addressed(planned: () => readonly { readonly address: string; readonly make: () => void }[]): Effect.Effect<void, KinuError> {
    const routes = this.routes;

    if (this.refusal !== undefined) return Effect.void;

    const unclaimed = () => {
      const owner = this.identity();

      return owner !== null && this.ctx.storage.kv.get(CLAIMED) !== owner.username ? owner : null;
    };

    const stale = () => routes !== null && routes.under !== '' && this.ctx.storage.kv.get(ROUTED_UNDER) !== routes.under;

    const routing = async (): Promise<Exit.Exit<void, KinuError>> => {
      const owner = unclaimed();
      const claimed = owner === null ? Exit.void : await this.claimed(owner.username, owner.user_id);

      if (Exit.isFailure(claimed) || routes === null) return claimed;

      if (stale()) {
        const again = await hold(routes.routed(this.store.boxes().map((box) => box.address)));

        if (Exit.isFailure(again)) return again;
        this.ctx.storage.kv.put(ROUTED_UNDER, routes.under);
      }

      for (const { address, make } of planned()) {
        const routed = await hold(routes.routed([address]));

        if (Exit.isFailure(routed)) return routed;
        make();
      }

      return Exit.void;
    };

    const due = () => unclaimed() !== null || stale() || (routes !== null && planned().length > 0);

    return Effect.flatMap(this.fenced(Effect.promise(async () => (due() ? this.ctx.blockConcurrencyWhile(routing) : Exit.void))), (exit) => exit);
  }

  /**
   * The box's name claimed (MailName's `claim`, which routes it on a subdomain), and acknowledged once it is. MailName's
   * denial proves no claim was made, so the rows that recorded the name go, where they hold nothing yet; anything else
   * proves nothing, so they stay and the next call claims again.
   */
  private async claimed(username: string, userId: string): Promise<Exit.Exit<void, KinuError>> {
    const [answered] = await Promise.allSettled([objectNamed(this.env.MAILNAME, username).claim(username, userId)]);

    if (answered?.status !== 'rejected') {
      this.ctx.storage.kv.put(CLAIMED, username);

      return Exit.void;
    }

    if (v.is(ClaimDenied, answered.reason)) this.store.unopen();

    return Exit.fail(authoredRefusal({ doing: `claiming ${username}`, cause: answered.reason }));
  }


  /** The boxes `owners` would have made, each with its address and how it is made. */
  private boxesPlanned(owners: readonly MailBoxOwner[]): () => readonly { readonly address: string; readonly make: () => void }[] {
    return () => this.store.unmade(owners).map(({ owner, address }) => ({ address, make: () => { this.store.boxFor(owner); } }));
  }

  /** `work`, once the boxes `caller` reads, if any, are routed. */
  private asCaller<Answer>(work: Effect.Effect<Answer, KinuError>, caller: MailCaller | undefined): Effect.Effect<Answer, KinuError> {
    return Effect.andThen(this.addressed(this.boxesPlanned(caller === undefined ? [] : this.store.ownersOf(caller))), work);
  }

  /** Work under way, which a deletion waits out before it sweeps: a delivery writes its bytes across awaits. */
  private readonly working = new Set<Promise<void>>();

  /** Set while the box is deleted: no new work starts. */
  private deleting = false;

  /** `work`, refused once the box is being deleted, and waited out by a deletion that began while it ran. */
  private fenced<Answer>(work: Effect.Effect<Answer, KinuError>): Effect.Effect<Answer, KinuError> {
    return Effect.suspend(() => {
      if (this.deleting) return Effect.fail(new KinuError('unavailable', 'This mailbox is being deleted.'));
      const done = Promise.withResolvers<void>();

      this.working.add(done.promise);

      return Effect.ensuring(work, Effect.sync(() => {
        this.working.delete(done.promise);
        done.resolve();
      }));
    });
  }

  /**
   * The account's mail deleted, as the account is (docs/MAIL.md §11): its names retired first, while the box still
   * records them, so a retry finds them again; then, once the work under way has ended, every object under its R2
   * prefix, its rows, its outbox and its alarm. Again, it finds nothing.
   */
  /**
   * The operator's restore (`/ops/restore`, ARCHITECTURE-DECISIONS W7): this mailbox's storage, every box of the
   * account in it, armed to go back to `target` at its next start; `opsRestart` ends it at once. Only `/ops/*` holds
   * the capability.
   */
  async opsRestore(caller: OpsCaller, target: RestoreTarget): Promise<ArmedRestore> {
    return await restoreArmed(this.ctx, this.env, caller, target);
  }

  /** Ends this activation, so an armed restore lands. */
  async opsRestart(caller: OpsCaller): Promise<void> {
    await restartedForRestore(this.ctx, this.env, caller);
  }

  /** Where this object's history stands now. */
  async opsBookmark(caller: OpsCaller): Promise<string> {
    return await bookmarkNow(this.ctx, this.env, caller);
  }

  /** The mail bodies and attachments this mailbox's rows name that R2 no longer holds: after a restore, what it could not
   *  bring back. */
  async opsMissing(caller: OpsCaller): Promise<MissingBytes> {
    await requireOps(this.env, caller);
    const prefix = `mail/${this.identity()?.user_id ?? 'unopened'}/`;

    return await missingBytes(this.bucket, prefix, this.store.namedBlobKeys().map((key) => `${prefix}${key}`));
  }

  async deleteBox(userId: string): Promise<void> {
    this.deleting = true;
    const [box] = this.ctx.storage.sql.exec('SELECT username FROM mail_box WHERE id = 1').toArray();

    const username = box === undefined ? undefined : v.parse(v.object({ username: v.string() }), box).username;

    // Its name let go while the box still records it, so a retry finds it again: MailName decides, serialized with any
    // claim, whether it was this account's to unroute and retire (`release`).
    if (username !== undefined) await objectNamed(this.env.MAILNAME, username).release(username, userId);
    await Promise.all(this.working);
    const bucket = this.bucket ?? undefined;

    // The prefix, not the rows' keys: bytes an interrupted delivery left unreferenced are the account's too.
    for (let page = await bucket?.list({ prefix: `mail/${userId}/` }); page !== undefined && page.objects.length > 0; page = await bucket?.list({ prefix: `mail/${userId}/` })) {
      await bucket?.delete(page.objects.map((object) => object.key));
    }

    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // As made: a call that comes after meets an empty box, not missing tables, and may open one anew.
    initMailboxTables(this.ctx.storage.sql);
    writeStamp(durableStamps(this.ctx.storage.kv), 'mailbox');
    this.deleting = false;
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

    // A box being deleted has no retry or emptying left to do.
    if (this.deleting) return;

    return settle(this.fenced(Effect.promise(async () => {
      if (this.env.EMAIL !== undefined) await this.outbox.reconcile(this.env.EMAIL, Date.now());

      const emptied = await this.store.purge();

      if (emptied > 0) diagnostics.event('mail.trash_emptied', { threads: emptied });
      await this.arm();
    })));
  }

  /**
   * The person's address: its rows written first, as the one record of the name, then the name claimed, in one block so
   * no call makes a box under a name not yet claimed (`claimed`). A refused claim unwrites the rows, so the account
   * records no name it does not hold; one interrupted is finished by the next call.
   */
  open(account: { userId: string; email: string; username: string; assistant: { workspace: string; actorId: string } | null }): Promise<MailBox> {
    const opening = async (): Promise<Exit.Exit<MailBox, KinuError>> => {
      const box = this.store.open(account);
      const claimed = await this.claimed(box.address.slice(0, box.address.lastIndexOf('@')), account.userId);

      return Exit.isFailure(claimed) ? Exit.failCause(claimed.cause) : Exit.succeed(box);
    };

    return settle(this.refusal === undefined
      ? Effect.flatMap(this.fenced(Effect.promise(async () => this.ctx.blockConcurrencyWhile(opening))), (exit) => exit)
      : Effect.fail(this.refusal));
  }


  boxFor(owner: MailBoxOwner): Promise<MailBox> {
    return settle(Effect.andThen(this.addressed(this.boxesPlanned([owner])), this.served(() => this.store.boxFor(owner))));
  }

  readBy(reader: { workspace: string; actorId: string }): Promise<MailBox | null> {
    return settle(this.served(() => this.store.readBy(reader)));
  }

  untriagedFor(caller: MailCaller, limit: number, skip?: readonly string[]): Promise<readonly MailTriageItem[]> {
    return settle(this.served(() => this.store.untriagedFor(caller, limit, skip), caller));
  }

  triagedFor(caller: MailCaller, thread: string, version: number, pick: MailTriagePick): Promise<MailTriaged> {
    return settle(this.served(() => this.store.triagedFor(caller, thread, version, pick), caller));
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

  update(id: string, change: { read?: boolean; trashed?: boolean; important?: string | null }): Promise<MailThreadSummary> {
    return settle(this.changed(change, () => this.store.update(id, change)));
  }

  /** The one way a thread changes, the person's or an agent's: one moved to Trash arms the alarm that empties it. */
  private changed(change: { trashed?: boolean }, apply: () => MailThreadSummary, caller?: MailCaller): Effect.Effect<MailThreadSummary, KinuError> {
    return Effect.tap(this.served(apply, caller), () => (change.trashed === true ? Effect.promise(async () => this.arm()) : Effect.void));
  }

  draft(outgoing: MailOutgoing & { threadId?: string }): Promise<MailMessageView> {
    return settle(this.served(() => this.store.draft(outgoing)));
  }

  send(outgoing: MailOutgoing & { threadId?: string }): Promise<MailMessageView> {
    return settle(this.sendOut(() => this.store.queue(outgoing)));
  }

  /** Files it (`file`) and hands it to the outbox, within the account's daily cap (none for operators). */
  private sendOut(
    file: () => Promise<{ view: MailMessageView; from: string; inReplyTo: string | null; references: string | null; outgoing: MailOutgoing }>,
    caller?: MailCaller,
  ): Effect.Effect<MailMessageView, KinuError> {
    const { env, store, outbox, refusal } = this;
    const sender = this.identity()?.email ?? '';
    const arm = async (): Promise<void> => this.arm();

    return this.asCaller(this.fenced(Effect.gen(function* () {
      if (refusal !== undefined) return yield* Effect.fail(refusal);

      if (!isListedOperator(env, sender) && store.sentToday() >= DAILY_SEND_CAP) {
        return yield* Effect.fail(new KinuError('budget', `This account has sent ${String(DAILY_SEND_CAP)} messages in the last day; mail goes again as the day's first ones age out.`));
      }

      const binding = env.EMAIL;

      if (binding === undefined) return yield* Effect.fail(new KinuError('unavailable', 'This deployment cannot send mail yet: it has no Email Sending binding.'));

      const { view, from, inReplyTo, references, outgoing } = yield* Effect.promise(file);

      const sent = yield* Effect.promise(async () => outbox.send(binding, `${MAIL_SEND_KEY}${view.id}`, mailboxEmail({
        from, to: outgoing.to, cc: outgoing.cc ?? [], subject: outgoing.subject, text: outgoing.text, inReplyTo, references,
      }), Date.now()));

      // A send refused for good (a suppressed recipient) is the person's answer, the message kept as failed. Not yet sent
      // is still queued: the outbox retries on this object's alarm, and the view reads its state from it.
      if (sent.status === 'failed' && sent.final) return yield* Effect.fail(new KinuError('denied', `Not sent: ${sent.error}`));

      if (sent.status === 'failed') yield* Effect.promise(arm);

      return (yield* Effect.promise(async () => store.messageView(view.threadId, view.id))) ?? view;
    })), caller);
  }

  /* ——— An agent's calls (docs/MAIL.md §3): only the boxes it reads ——— */

  readableBy(caller: MailCaller): Promise<readonly MailBox[]> {
    return settle(this.served(() => this.store.readableBy(caller), caller));
  }

  findFor(caller: MailCaller, query: Omit<MailListQuery, 'path'> & { box?: string; unread?: boolean }): Promise<MailListing> {
    return settle(this.served(() => this.store.findFor(caller, query), caller));
  }

  readFor(caller: MailCaller, thread: string): Promise<MailThreadView | null> {
    return settle(this.served(() => this.store.readFor(caller, thread), caller));
  }

  draftFor(caller: MailCaller, message: MailAgentMessage): Promise<MailMessageView> {
    return settle(this.served(async () => this.store.draft(this.store.messageFor(caller, message)), caller));
  }

  sendFor(caller: MailCaller, message: MailAgentMessage): Promise<MailMessageView> {
    return settle(this.sendOut(async () => this.store.queue(this.store.messageFor(caller, message)), caller));
  }

  updateFor(caller: MailCaller, thread: string, change: { read?: boolean; trashed?: boolean; important?: string | null }): Promise<MailThreadSummary> {
    return settle(this.changed(change, () => this.store.updateFor(caller, thread, change), caller));
  }

  setWake(path: string, wake: MailWake, allow?: readonly string[]): Promise<MailBox> {
    return settle(this.served(() => this.store.setWake(path, wake, allow)));
  }
}
