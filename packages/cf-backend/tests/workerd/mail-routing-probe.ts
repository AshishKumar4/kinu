/**
 * Mail on a subdomain of its zone, as deployed: the account's Mailbox and the mail names, with the routing grant the
 * deploy run mints, over Email Routing faked Node-side (`mail-rules-fake.ts`). The control entrypoint resets and reads
 * that fake, whose state is shared across workers.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { KinuError } from '@kinu.run/core/obs';
import { MAIL_RULES_WORKER, type MailRulesState } from './mail-rules-fake';

import { MailboxDO } from '../../src/mail/mailbox-do';
import { MailNameDO, type MailNameClaim } from '../../src/mail/mailname-do';

/**
 * The mail names as deployed, whose first answer for a label a test names goes wrong: `lostbefore…` is lost before the
 * claim is made, as a reset would, `lostrouted…` once Cloudflare has made its rule but before the claim is written,
 * and `lostafter…` once the claim is; `refusedstore…` is refused by a store that cannot be read, MailName's own refusal
 * but no denial.
 */
export class LossyMailNameDO extends MailNameDO {
  private readonly answered = new Set<string>();

  override async claim(label: string, userId: string, kind: 'username' | 'alias' = 'username', targetPath: string | null = null): Promise<MailNameClaim> {
    const first = !this.answered.has(label);

    this.answered.add(label);

    if (first && label.startsWith('lostbefore')) throw new Error('Network connection lost.');

    if (first && label.startsWith('refusedstore')) throw new KinuError('unavailable', 'This mail name\'s storage predates the release.');

    if (first && label.startsWith('lostrouted')) {
      await fetch(`https://api.cloudflare.com/client/v4/zones/${this.env.KINU_MAIL_ZONE ?? ''}/email/routing/rules`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.env.KINU_MAIL_ROUTING_TOKEN ?? ''}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: `Kinu ${label}`, enabled: true,
          matchers: [{ type: 'literal', field: 'to', value: `${label}@${this.env.EMAIL_DOMAIN ?? ''}` }], actions: [{ type: 'worker', value: [MAIL_RULES_WORKER] }],
        }),
      });

      throw new Error('Network connection lost.');
    }

    const claimed = await super.claim(label, userId, kind, targetPath);

    if (first && label.startsWith('lostafter')) throw new Error('Network connection lost.');

    return claimed;
  }
}

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

  /** The next listing of rules answered with `status`, once. */
  async refuseList(status: number): Promise<MailRulesState> {
    return this.hit(`/refuse-list?status=${String(status)}`);
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
