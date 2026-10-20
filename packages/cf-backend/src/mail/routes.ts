/**
 * `/api/user/mail/*`: the signed-in person's own mail (docs/MAIL.md §7). The account is the session's identity, never one
 * the request names; its Mailbox is reached by the Worker alone. Mounted behind the session gate, ahead of
 * `userRoutes`' catch-all.
 *
 * A person claims their address once: the deployment's operators always, anyone else once `MAIL_ACCOUNTS` is
 * `everyone`. The person reads, sends from any of their boxes and keeps drafts; Important is the assistant's pick, set
 * through its `mail.update`, so the person cannot set it here.
 */
import { Hono, type Context } from 'hono';
import * as v from 'valibot';
import {
  err, isMailLabel, json, mailAddressOf, objectNamed, publicError, safeJson,
  type MailListQuery, type MailView, type ObjectNamespace,
} from '@kinu.run/core';
import { Effect } from 'effect';
import { CODE_IS_REFUSAL, KinuError, settle, toKinuError } from '@kinu.run/core/obs';
import type { FamilyEnv } from '../api/context';
import type { MailboxDO } from './mailbox-do';
import type { MailNameDO } from './mailname-do';

type MailboxReach = Pick<MailboxDO, 'open' | 'boxes' | 'list' | 'thread' | 'update' | 'draft' | 'send' | 'setWake'>;

export interface MailRoutesEnv {
  readonly EMAIL_DOMAIN?: string;
  readonly MAIL_ACCOUNTS?: string;
  readonly CONTROL_PLANE_ADMINS?: string;
  readonly MAILNAME: ObjectNamespace<unknown, Pick<MailNameDO, 'lookup' | 'claim'>>;
  readonly MAILBOX: ObjectNamespace<unknown, MailboxReach>;
}

type MailContext = Context<FamilyEnv<MailRoutesEnv>>;

const VIEWS = ['important', 'all', 'sent', 'drafts', 'trash'] as const satisfies readonly MailView[];

const Address = v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email(), v.maxLength(254));

const Outgoing = v.object({
  path: v.pipe(v.string(), v.maxLength(41)),
  to: v.pipe(v.array(Address), v.minLength(1), v.maxLength(50)),
  cc: v.optional(v.pipe(v.array(Address), v.maxLength(50))),
  subject: v.pipe(v.string(), v.maxLength(998)),
  text: v.pipe(v.string(), v.maxLength(1_000_000)),
  inReplyTo: v.optional(v.nullable(v.string())),
  threadId: v.optional(v.string()),
});

const Claim = v.object({ username: v.string() });

const Change = v.strictObject({ read: v.optional(v.boolean()), trashed: v.optional(v.boolean()) });

const Wake = v.object({
  path: v.pipe(v.string(), v.maxLength(41)),
  wake: v.picklist(['owner', 'allowlist', 'verified', 'never']),
  allow: v.optional(v.pipe(v.array(Address), v.maxLength(200))),
});

/** Whether the signed-in person may hold an address on this deployment (docs/MAIL.md §1). */
function mayClaim(env: MailRoutesEnv, email: string): boolean {
  if (env.MAIL_ACCOUNTS === 'everyone') return true;

  return (env.CONTROL_PLANE_ADMINS ?? '').split(',').some((each) => each.trim().toLowerCase() === email.trim().toLowerCase());
}

const mailbox = (c: MailContext): MailboxReach => objectNamed(c.env.MAILBOX, c.get('identity').userId);

/** The person's address, from the boxes their Mailbox holds; null before they claimed one. */
async function addressOf(c: MailContext): Promise<string | null> {
  return (await mailbox(c).boxes()).find((box) => box.path === '')?.address ?? null;
}

/**
 * The route's answer, or its refusal. A refusal the Mailbox or MailName classified is answered in its own words, written
 * for the person (native RPC keeps the words where it drops the class); anything else in the generic text for its class.
 */
async function answer<Body>(work: () => Promise<Body>): Promise<Response> {
  return await settle(Effect.tryPromise({
    try: work,
    catch: (cause) => toKinuError({ doing: 'answering a mail request', cause, otherwise: 'io' }),
  }).pipe(Effect.match({
    onSuccess: (body) => json({ body }),
    onFailure: (failure) => publicError(CODE_IS_REFUSAL[failure.code] && failure.cause instanceof Error ? new KinuError(failure.code, failure.cause.message) : failure),
  })));
}

export const mailRoutes = new Hono<FamilyEnv<MailRoutesEnv>>();

mailRoutes.get('/api/user/mail/boxes', async (c) => answer(async () => {
  const address = await addressOf(c);

  return { address, canClaim: address === null && mayClaim(c.env, c.get('identity').email), boxes: address === null ? [] : await mailbox(c).boxes() };
}));

mailRoutes.post('/api/user/mail/claim', async (c) => {
  const identity = c.get('identity');
  const body = await safeJson(c.req.raw, Claim);

  if (body === null || !isMailLabel(body.username)) return err(400, 'A username is 1 to 20 lowercase letters, digits and inner hyphens.');

  if (!mayClaim(c.env, identity.email)) return err(403, 'Addresses on this deployment are its operators\' only.');

  return answer(async () => {
    const held = await addressOf(c);

    if (held !== null) return { address: held };

    await objectNamed(c.env.MAILNAME, body.username).claim(body.username, identity.userId);
    const box = await mailbox(c).open({ userId: identity.userId, email: identity.email, username: body.username, assistant: null });

    return { address: box.address };
  });
});

mailRoutes.get('/api/user/mail/important', async (c) => answer(async () => {
  const limit = Math.min(20, Math.max(1, Number(c.req.query('limit') ?? '3') || 3));

  if (await addressOf(c) === null) return { unread: 0, items: [] };
  const listing = await mailbox(c).list({ view: 'important', limit });

  return {
    unread: listing.unread,
    items: listing.threads.map((thread) => ({
      thread: thread.id, from: { name: thread.from[0]?.name ?? thread.from[0]?.address ?? '', address: thread.from[0]?.address ?? '' },
      to: mailAddressOf('', thread.path, c.env.EMAIL_DOMAIN ?? ''), subject: thread.subject, reason: thread.important ?? '', at: thread.at, unread: thread.unread,
    })),
  };
}));

mailRoutes.get('/api/user/mail/threads', async (c) => {
  const view = v.safeParse(v.picklist(VIEWS), c.req.query('view') ?? 'all');

  if (!view.success) return err(400, `view is one of ${VIEWS.join(', ')}`);

  if (await addressOf(c) === null) return err(404, 'This account has no mail address yet.');

  const before = Number(c.req.query('before'));

  const query: MailListQuery = {
    view: view.output, path: c.req.query('path'), query: c.req.query('q'), before: Number.isFinite(before) && before > 0 ? before : undefined, limit: 50,
  };

  return answer(() => mailbox(c).list(query));
});

mailRoutes.get('/api/user/mail/threads/:id', async (c) => answer(async () => {
  const thread = await mailbox(c).thread(c.req.param('id'));

  if (thread === null) throw new KinuError('missing', 'No such thread.');

  return thread;
}));

mailRoutes.patch('/api/user/mail/threads/:id', async (c) => {
  const change = await safeJson(c.req.raw, Change);

  if (change === null) return err(400, 'read and trashed (booleans) are what a person changes; Important is the assistant\'s.');

  return answer(() => mailbox(c).update(c.req.param('id'), change));
});

mailRoutes.post('/api/user/mail/send', async (c) => {
  const outgoing = await safeJson(c.req.raw, Outgoing);

  if (outgoing === null) return err(400, 'path, to, subject and text are required.');

  return answer(() => mailbox(c).send(outgoing));
});

mailRoutes.post('/api/user/mail/drafts', async (c) => {
  const outgoing = await safeJson(c.req.raw, Outgoing);

  if (outgoing === null) return err(400, 'path, to, subject and text are required.');

  return answer(() => mailbox(c).draft(outgoing));
});

mailRoutes.put('/api/user/mail/boxes/wake', async (c) => {
  const body = await safeJson(c.req.raw, Wake);

  if (body === null) return err(400, 'wake is one of owner, allowlist, verified, never.');

  return answer(() => mailbox(c).setWake(body.path, body.wake, body.allow));
});
