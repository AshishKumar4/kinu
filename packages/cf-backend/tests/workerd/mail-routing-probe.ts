/**
 * Mail on a subdomain of its zone, as deployed: the account's Mailbox and the mail names, with the routing grant the
 * deploy run mints, over Email Routing faked Node-side (`mail-rules-fake.ts`). The control entrypoint resets and reads
 * that fake, whose state is shared across workers.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { MailRulesState } from './mail-rules-fake';

export { MailboxDO } from '../../src/mail/mailbox-do';

export { MailNameDO } from '../../src/mail/mailname-do';

export class MailRulesFakeControl extends WorkerEntrypoint {
  async reset(): Promise<MailRulesState> {
    return this.hit('/reset');
  }

  async state(): Promise<MailRulesState> {
    return this.hit('/state');
  }

  /** Cloudflare's 200 rules a domain, lowered so a test reaches it. */
  async cap(rules: number): Promise<MailRulesState> {
    return this.hit(`/cap?n=${String(rules)}`);
  }

  private async hit(path: string): Promise<MailRulesState> {
    const answer = await fetch(`http://mail-rules-control.invalid${path}`, { method: 'POST' });

    return answer.json();
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
