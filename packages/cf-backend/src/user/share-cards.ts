/**
 * The cards a share's recipients hold, kept by the owner's account. Every overview a workspace pushes, and every
 * teardown, reconciles what each recipient should hold against what it was sent; each difference is a Lifecycle job,
 * one per recipient and share, retried until the recipient's account takes it. A recipient's Drive reads its cards and
 * wakes no owner's workspace.
 */
import * as v from 'valibot';
import { LifecycleCapability, type LifecycleJobContext, type LifecycleJobOutcome } from 'agents/lifecycle';
import { ShareCardSchema, type ShareCard, type SqlExec, type UserCaller, type WorkspaceOverviewShare } from '@kinu.run/core';
import { deriveUserId } from '../auth/store';
import { retriedLater } from '../advice-jobs';

const SHARE_CARD_JOB = 'share-card';

const WriteKey = { recipient: v.string(), owner: v.string(), workspace: v.string(), share: v.string() };

const ShareCardWriteSchema = v.variant('op', [
  v.object({ op: v.literal('put'), ...WriteKey, card: ShareCardSchema }),
  v.object({ op: v.literal('remove'), ...WriteKey }),
]);

type ShareCardWrite = v.InferOutput<typeof ShareCardWriteSchema>;

/** A card as its recipient's account stores it. */
export const ReceivedShareSchema = v.object({ ownerUserId: v.string(), workspace: v.string(), shareId: v.string(), card: ShareCardSchema });

export type ReceivedShare = v.InferOutput<typeof ReceivedShareSchema>;

const SentRowSchema = v.object({ share_id: v.string(), recipient_user_id: v.string(), card: v.string() });

/** A share as its people's Drive shows it; `owner` is the sharing account's email. */
function shareCardOf(share: WorkspaceOverviewShare, owner: string): ShareCard {
  return {
    kind: share.kind, title: share.title, description: share.description, createdAt: share.createdAt, owner,
    ...(share.visibility !== undefined && { visibility: share.visibility }),
    ...(share.fork !== undefined && { fork: share.fork }),
  };
}

/** What a delivery asks of the recipient's account. */
export interface ShareCardRecipient {
  shareCards_put(caller: UserCaller, row: ReceivedShare): Promise<void>;
  shareCards_remove(caller: UserCaller, ownerUserId: string, workspace: string, shareId: string): Promise<void>;
}

export interface ShareCardDeps {
  readonly sql: SqlExec;
  /** This account: its id, and the email its recipients see. */
  readonly owner: () => { readonly userId: string; readonly email: string };
  readonly recipient: (userId: string) => ShareCardRecipient;
  /** The deployment's owner authority, as one account writes another's cards. */
  readonly caller: () => Promise<UserCaller>;
}

export class ShareCardJobs extends LifecycleCapability {
  readonly #deps: ShareCardDeps;

  /** Deliveries mid-send, which a withdrawal lets land before the recipients are told to forget. */
  readonly #sending = new Set<Promise<void>>();

  constructor(deps: ShareCardDeps) {
    super('kinu-share-cards');
    this.#deps = deps;
  }

  /**
   * Brings `workspace`'s recipients to `shares` (empty for a workspace torn down). A write's job and its sent row land
   * in the same turn, so a death between them leaves neither.
   */
  async reconcile(workspace: string, shares: readonly WorkspaceOverviewShare[]): Promise<void> {
    const { sql } = this.#deps;
    const owner = this.#deps.owner();
    const wanted = new Map<string, { share: string; recipient: string; card: ShareCard; text: string }>();

    for (const share of shares) {
      const card = shareCardOf(share, owner.email);

      for (const email of share.users) {
        const recipient = await deriveUserId(email.toLowerCase());

        if (recipient !== owner.userId) wanted.set(JSON.stringify([share.share, recipient]), { share: share.share, recipient, card, text: JSON.stringify(card) });
      }
    }

    const sent = sql.exec(`SELECT share_id, recipient_user_id, card FROM share_cards_sent WHERE workspace = ?`, workspace).toArray()
      .map((row) => v.parse(SentRowSchema, row));

    const held = new Map(sent.map((row) => [JSON.stringify([row.share_id, row.recipient_user_id]), row.card]));
    const pushes: Promise<unknown>[] = [];

    for (const row of sent) {
      if (wanted.has(JSON.stringify([row.share_id, row.recipient_user_id]))) continue;
      sql.exec(`DELETE FROM share_cards_sent WHERE workspace = ? AND share_id = ? AND recipient_user_id = ?`, workspace, row.share_id, row.recipient_user_id);
      pushes.push(this.queue({ op: 'remove', recipient: row.recipient_user_id, owner: owner.userId, workspace, share: row.share_id }));
    }

    for (const [key, want] of wanted) {
      if (held.get(key) === want.text) continue;
      sql.exec(
        `INSERT INTO share_cards_sent (workspace, share_id, recipient_user_id, card) VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace, share_id, recipient_user_id) DO UPDATE SET card = excluded.card`,
        workspace, want.share, want.recipient, want.text,
      );
      pushes.push(this.queue({ op: 'put', recipient: want.recipient, owner: owner.userId, workspace, share: want.share, card: want.card }));
    }

    await Promise.all(pushes);
  }

  /**
   * For the account-delete sweep: every account that holds or is owed a card is named, every delivery not yet made
   * is cancelled, and a delivery mid-send has landed. A pending removal's recipient has no sent row, only its job, so
   * both are read before the jobs go; the forget that follows is then the last word each recipient hears.
   */
  async withdraw(): Promise<string[]> {
    const jobs = this.lifecycle.jobs.list().filter((job) => job.fn === SHARE_CARD_JOB);
    const owed = jobs.map((job) => v.parse(ShareCardWriteSchema, job.payload).recipient);

    const sent = this.#deps.sql.exec(`SELECT DISTINCT recipient_user_id FROM share_cards_sent`).toArray()
      .map((row) => v.parse(v.object({ recipient_user_id: v.string() }), row).recipient_user_id);

    await Promise.all(jobs.map((job) => this.lifecycle.jobs.cancel(job.id)));
    await Promise.allSettled(this.#sending);

    return [...new Set([...sent, ...owed])];
  }

  /** One job per recipient and share: a newer write replaces an older one not yet delivered, since only the last counts. */
  private async queue(write: ShareCardWrite): Promise<void> {
    await this.lifecycle.jobs.push({
      id: `${SHARE_CARD_JOB}:${JSON.stringify([write.recipient, write.workspace, write.share])}`, fn: SHARE_CARD_JOB, time: Date.now(), payload: write,
    });
  }

  /**
   * One attempt at a delivery. The driver retries an attempt with the job it read at dispatch, so each attempt first
   * asks for the job's durable row: one cancelled since, or replaced by a newer write, sends nothing. That check and
   * the send's start share one turn, so a withdrawal either finds the job to cancel or the send to wait for.
   */
  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn !== SHARE_CARD_JOB) return undefined;
    const write = v.parse(ShareCardWriteSchema, job.payload);
    const recipient = this.#deps.recipient(write.recipient);
    const caller = await this.#deps.caller();
    const current = this.lifecycle.jobs.get(job.id);

    if (current === undefined || JSON.stringify(current.payload) !== JSON.stringify(job.payload)) return undefined;

    const sending = write.op === 'put'
      ? recipient.shareCards_put(caller, { ownerUserId: write.owner, workspace: write.workspace, shareId: write.share, card: write.card })
      : recipient.shareCards_remove(caller, write.owner, write.workspace, write.share);

    this.#sending.add(sending);

    try {
      await sending;
    } finally {
      this.#sending.delete(sending);
    }

    return undefined;
  }

  /** A recipient's account that refused every retry, as during a deploy's version skew, is asked again a lap later. */
  readonly onJobError = retriedLater('delivering a share card');
}
