/**
 * A workspace's email: the arrivals its account's Mailbox wakes it for (docs/MAIL.md §3), the receipt the owner's
 * instruction gets, and the away-channel notes the owner is sent. The workspace object keeps the methods its routes
 * reach and answers each from here.
 */
import {
  EmailInbox, planOwnerNotification,
  type EmailInboxDeps, type EmailOutbox, type MailAdmission, type MailArrival,
  sendInboundEmailReceipt, sendOwnerEmail,
} from '@kinu.run/core';
import type { Effect } from 'effect';
import { logged } from '@kinu.run/core/obs';
import type { UserHubClient } from './account-reads';
import type { UserCaller } from '@kinu.run/core';

export interface WorkspaceEmailHost extends Omit<EmailInboxDeps, 'ownerEmail'> {
  readonly env: { readonly EMAIL?: SendEmail; readonly EMAIL_DOMAIN?: string };
  readonly name: string;
  outbox(): EmailOutbox;
  displayName(): string;
  /** Whether the owner reads mail as the away channel; off unless they turned it on. */
  notifications(): boolean;
  setNotifications(enabled: boolean): void;
  /** Email is the away channel: never sent while an operator socket is live. */
  operatorConnected(): boolean;
  owned(): boolean;
  hub(): Promise<{ stub: UserHubClient; caller: UserCaller }>;
  /** Runs `work` past this call, on the workspace's own lifetime. */
  detach(work: Effect.Effect<void>): void;
}

/** Whether the owner is mailed while away. Its addresses and who may wake it are the Mailbox's (mail/routes.ts). */
export interface EmailIngress {
  notifications: boolean;
}

export class WorkspaceEmail {
  /** Held across the activation, like the in-memory inbound rate window it owns. */
  readonly inbox: EmailInbox;

  constructor(private readonly host: WorkspaceEmailHost) {
    this.inbox = new EmailInbox({ ...host, ownerEmail: () => this.ownerEmail() });
  }

  /** Null means unclaimed or no profile email. A failed lookup must throw, not read as null
   * and silently refuse the owner's own mail. A slate another workspace shares with this one's owner to edit knows
   * them by it too. */
  async ownerEmail(): Promise<string | null> {
    if (!this.host.owned()) return null;
    const { stub, caller } = await this.host.hub();

    return (await stub.getProfile(caller))?.email ?? null;
  }

  /** Publish and reply thread run here atomically. Receipt is awaited (floating promises die on eviction) and sent only
   * on the owner's fresh instruction: input never mails its sender back. */
  async accept(arrival: MailArrival, actorId: string): Promise<MailAdmission> {
    const admission = await this.inbox.accept(arrival, actorId);

    if (admission.admitted && !admission.duplicate && admission.thread !== null) {
      await sendInboundEmailReceipt({
        email: this.host.env.EMAIL,
        agentDisplayName: this.host.displayName(),
        outbox: this.host.outbox(),
      }, admission.thread, admission.event_id);
    }

    return admission;
  }

  ingress(): EmailIngress {
    return { notifications: this.host.notifications() };
  }

  notify(enabled: boolean): Pick<EmailIngress, 'notifications'> {
    this.host.setNotifications(enabled);

    return { notifications: this.host.notifications() };
  }

  /** Skipped when notifications are off, platform pieces are missing, or an operator socket is live
   * (email is the away channel, not a duplicate feed). */
  ownerNotification(subject: string, text: string): void {
    const notification = planOwnerNotification({ enabled: this.host.notifications(), operatorConnected: this.host.operatorConnected(), subject, text });

    if (!notification) return;
    this.host.detach(logged('email.owner_notification_failed', { doing: 'sending the owner an away-channel notification', otherwise: 'unavailable' },
      async () => {
        await sendOwnerEmail({
          email: this.host.env.EMAIL,
          emailDomain: this.host.env.EMAIL_DOMAIN,
          agentName: this.host.name,
          agentDisplayName: this.host.displayName(),
          ownerEmail: await this.ownerEmail(),
          outbox: this.host.outbox(),
        }, notification);
      }, { subject }));
  }
}
