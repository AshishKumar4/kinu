/**
 * Mail into the deployment arrives. Where the eval account may hold a box (staging), it sends a message from its box
 * to its own address and waits for it to arrive there, through Email Sending, Email Routing's rule for the address and
 * the deployment's mail handler. Staging's inbound went unexercised for six days (2026-10-16 to 10-22): a rule could
 * stop reaching the Worker, or an address be suppressed after a bounce, and no row would say so.
 *
 * Where it may not (production: addresses are its operators' only, rc31 2026-10-23), it holds nothing to send from or
 * read, and never sends: a message to an address that refuses it bounces, and the bounce suppresses the address. It
 * reads instead what mail to the deployment's own addresses (MAIL_ALIASES) meets (mail-wiring.ts), and fails on
 * anything that keeps it from arriving: privacy@ reaching a username with no box is such a defect.
 *
 *   bun scripts/staging-mail-inbound.ts     the deployment KINU_EVAL_ORIGIN names, as every post-publish row;
 *                                           KINU_MAIL_ONBOARD_TOKEN reads Email Routing and Email Sending
 */
import * as v from 'valibot';
import { evalTargetVerdict } from '../packages/test-utils/src/eval-identity';
import { resolveWebIdentity, webHeaders } from '../evals/src/workspace-roster';
import { deploymentMailOf, readMailWiring, wiringProblems } from './mail-wiring';

/** Measured 2026-10-22 on staging: sent to filed in 3 s. A minute leaves room for the edge's queue. */
const ARRIVAL_MS = 60_000;

const POLL_MS = 3_000;

/** The username the eval account's box holds on staging, where its routing rule names it. */
const EVAL_USERNAME = 'eval';

const BoxesSchema = v.object({ enabled: v.boolean(), address: v.nullable(v.string()), canCreate: v.boolean() });

const SentSchema = v.object({ sendState: v.nullable(v.string()) });

const ThreadsSchema = v.object({ threads: v.array(v.object({ id: v.string(), subject: v.string() })) });

const ThreadSchema = v.object({ messages: v.array(v.object({ direction: v.picklist(['in', 'out']) })) });

const ErrorSchema = v.object({ error: v.string() });

async function main(): Promise<void> {
  const target = evalTargetVerdict(process.env.KINU_EVAL_ORIGIN);

  if (target.kind === 'refused') throw new Error(target.reason);
  const { origin } = target;
  const resolved = resolveWebIdentity(origin);

  if (resolved.kind !== 'ready') throw new Error(`staging-mail-inbound: no web identity for ${origin}`);
  const headers = { ...webHeaders(resolved.identity), 'content-type': 'application/json' };

  const call = async <T>(path: string, schema: v.GenericSchema<T>, init: { method?: string; body?: unknown } = {}): Promise<T> => {
    const request: RequestInit = { method: init.method ?? 'GET', headers };

    if (init.body !== undefined) request.body = JSON.stringify(init.body);
    const response = await fetch(`${origin}${path}`, request);

    const body: unknown = await response.json();

    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${String(response.status)} ${v.is(ErrorSchema, body) ? body.error : JSON.stringify(body)}`);

    return v.parse(schema, body);
  };

  const boxes = await call('/api/user/mail/boxes', BoxesSchema);

  if (!boxes.enabled) throw new Error(`${origin} has no mail domain, so nothing can arrive`);

  if (boxes.address === null && !boxes.canCreate) {
    const token = process.env.KINU_MAIL_ONBOARD_TOKEN?.trim();

    if (token === undefined || token === '') throw new Error('staging-mail-inbound: KINU_MAIL_ONBOARD_TOKEN reads what mail to this deployment meets, and this run has none');
    const deployment = deploymentMailOf(origin);
    const problems = wiringProblems(deployment, await readMailWiring(deployment, origin, headers, token));

    if (problems.length > 0) throw new Error(`staging-mail-inbound: mail to ${origin}'s own addresses does not arrive:\n- ${problems.join('\n- ')}`);
    console.log(`staging-mail-inbound: ${origin} may hold the check no address, so it sent nothing; mail to ${[...deployment.aliases.keys()].map((label) => `${label}@${deployment.domain}`).join(', ') || 'its own addresses'} reaches ${deployment.worker} and a box`);

    return;
  }

  const address = boxes.address ?? (await call('/api/user/mail/address', v.object({ address: v.string() }), { method: 'POST', body: { username: EVAL_USERNAME } })).address;
  const subject = `inbound check ${new Date().toISOString()} ${crypto.randomUUID().slice(0, 8)}`;

  // A suppressed recipient is refused at the send in its own words (EmailOutbox), never read as queued.
  const sent = await call('/api/user/mail/send', SentSchema, { method: 'POST', body: { path: '', to: [address], subject, text: 'A deploy check: this message should arrive.' } });

  console.log(`staging-mail-inbound: sent "${subject}" to ${address} (${sent.sendState ?? 'no state'})`);
  const started = Date.now();

  while (Date.now() - started < ARRIVAL_MS) {
    const { threads } = await call('/api/user/mail/threads?path=', ThreadsSchema);

    const held = await Promise.all(threads.filter((thread) => thread.subject === subject)
      .map(async (thread) => await call(`/api/user/mail/threads/${encodeURIComponent(thread.id)}`, ThreadSchema)));

    // Beside the copy it sent, in its thread or one of its own.
    if (held.some((thread) => thread.messages.some((message) => message.direction === 'in'))) {
      console.log(`staging-mail-inbound: arrived in ${String(Math.round((Date.now() - started) / 1000))} s`);

      return;
    }

    await new Promise((resolve) => { setTimeout(resolve, POLL_MS); });
  }

  throw new Error(`staging-mail-inbound: "${subject}" sent to ${address} did not arrive within ${String(ARRIVAL_MS / 1000)} s. `
    + "Check the address's routing rule reaches the deployment's Worker, and Email Sending's suppression list.");
}

await main();
