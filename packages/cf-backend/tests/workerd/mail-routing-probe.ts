/**
 * Mail on a subdomain of its zone, as deployed: the account's Mailbox and the mail names, with the routing grant the
 * deploy run mints, over Email Routing faked Node-side (`mail-rules-fake.ts`). The control entrypoint resets and reads
 * that fake, whose state is shared across workers.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { MailRulesState } from './mail-rules-fake';

import { MailboxDO } from '../../src/mail/mailbox-do';

export { MailNameDO } from '../../src/mail/mailname-do';

/** The account's Mailbox as deployed, which a test can tell its addresses were last routed under another grant. */
export class RoutedMailboxDO extends MailboxDO {
  /** As a deployment whose mail domain moved onto this grant leaves it: the key is the one MailboxDO keeps it under. */
  routedUnder(grant: string): void {
    this.ctx.storage.kv.put('mail:routed-under', grant);
  }
}

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
