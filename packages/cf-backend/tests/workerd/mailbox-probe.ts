/**
 * The account's Mailbox as deployed, with one read a test needs and the product does not: when its alarm is due.
 */
import { MailboxDO } from '../../src/mail/mailbox-do';

export { MailNameDO } from '../../src/mail/mailname-do';

export class MailboxProbeDO extends MailboxDO {
  alarmAt(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
