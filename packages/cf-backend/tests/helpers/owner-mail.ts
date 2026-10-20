import type { MailArrival } from '@kinu.run/core';

/** The owner's verified mail to a workspace, as the mail router hands it on once the account's Mailbox filed it. */
export function ownerMail(n: number, words: string): MailArrival {
  return {
    woke: 'owner', from: 'owner@example.com', to: 'workspace.owner@kinu.run', subject: `issue ${String(n)}`, instruction: words,
    message_id: `<m-${String(n)}@example.com>`, references: null, attachments: [],
    mail: { box: 'workspace', thread: `t-${String(n)}`, message: `m-${String(n)}` }, now: Date.now(),
  };
}
