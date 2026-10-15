/**
 * A workspace's email: the mail its address admits, the receipt a fresh admission sends, the senders its owner allows,
 * and the away-channel notes the owner is sent. The workspace object keeps the methods its routes reach and answers
 * each from here.
 */
import {
  EmailInbox, planOwnerNotification, readEmailAllowlist, setEmailAllowlist,
  type EmailAdmission, type EmailInboxDeps, type EmailOutbox, type IncomingEmail,
} from '@kinu.run/core';
import type { Effect } from 'effect';
import { logged } from '@kinu.run/core/obs';
import { agentEmailAddress } from './email/inbound';
import { sendInboundEmailReceipt, sendOwnerEmail } from './email/outbound';
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

/** The workspace's address, the senders it admits beside the owner, and whether the owner is mailed while away. */
export interface EmailIngress {
  address: string | null;
  allowlist: string[];
  notifications: boolean;
}

export class WorkspaceEmail {
  /** Held across the activation, like the in-memory inbound rate window it owns. */
  readonly inbox: EmailInbox;

  constructor(private readonly host: WorkspaceEmailHost) {
    this.inbox = new EmailInbox({ ...host, ownerEmail: () => this.ownerEmail() });
  }

  /** Null means unclaimed or no profile email. A failed lookup must throw, not read as null
   * and silently refuse the owner's own mail. Every room of the workspace's names its owner by it too. */
  async ownerEmail(): Promise<string | null> {
    if (!this.host.owned()) return null;
    const { stub, caller } = await this.host.hub();

    return (await stub.getProfile(caller))?.email ?? null;
  }

  /** Trust gate, publish, and reply thread run here atomically. Receipt is awaited (floating promises die on eviction)
   * and sent only on fresh admission. */
  async accept(email: IncomingEmail): Promise<EmailAdmission> {
    const admission = await this.inbox.accept(email);

    if (admission.admitted && !admission.duplicate && admission.thread && admission.event_id) {
      await sendInboundEmailReceipt({
        email: this.host.env.EMAIL,
        agentDisplayName: this.host.displayName(),
        outbox: this.host.outbox(),
      }, admission.thread, admission.event_id);
    }

    return admission;
  }

  ingress(): EmailIngress {
    const domain = this.host.env.EMAIL_DOMAIN;

    return {
      address: domain ? agentEmailAddress(this.host.name, domain) : null,
      allowlist: readEmailAllowlist(this.host.triggers),
      notifications: this.host.notifications(),
    };
  }

  /** Owner's verified address is always allowed; an empty list revokes the email_route trigger. */
  async allow(allow: string[]): Promise<{ allowlist: string[] }> {
    return await setEmailAllowlist(this.host.triggers, allow, Date.now());
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
