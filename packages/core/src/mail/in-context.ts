/** An agent's unread mail as its turn's context names it (docs/MAIL.md §8): who and what about, never a body. */
import type { MailListing } from './mailbox-api';
import type { ActiveRoster } from '../types/dynamic-context';

/** An unread thread as the agent's context names it; `from` and `subject` are the sender's words. */
export interface MailInContext {
  readonly from: string;
  readonly subject: string;
  readonly at: number;
  readonly verified: boolean;
}

export const MAX_MAIL_IN_CONTEXT = 5;

/** A box's unread listing as its context section: the newest few, and the count of all. Read once per turn. */
export function mailInContext(listing: MailListing): ActiveRoster<MailInContext> {
  return {
    items: listing.threads.filter((thread) => thread.unread).slice(0, MAX_MAIL_IN_CONTEXT).map((thread) => ({
      from: thread.from.at(-1)?.address ?? '', subject: thread.subject, at: thread.at, verified: thread.verified,
    })),
    total: listing.unread,
  };
}
