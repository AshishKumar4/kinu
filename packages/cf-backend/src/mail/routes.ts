/**
 * `/api/user/mail/*`: the signed-in person's own mail (docs/MAIL.md §7). The account is the session's identity, never one
 * the request names; its Mailbox is reached by the Worker alone. Mounted behind the session gate, ahead of
 * `userRoutes`' catch-all.
 *
 * A person creates their address once, in setup or where Mail would show their mailbox: the deployment's operators
 * always, anyone else once `MAIL_ACCOUNTS` is `everyone`. The person reads, sends from any of their boxes and keeps
 * drafts; Important is the assistant's pick, set through its `mail.update`, so the person cannot set it here. A thread
 * they send to one of their workspaces goes there behind the workspace gate, which proves they own it. Their own box
 * is read by their Personal assistant: it is handed over when they create their address if they have one, and at its
 * install when they do not yet.
 */
import { Hono, type Context } from 'hono';
import * as v from 'valibot';
import { Effect } from 'effect';
import {
  err, importantMail, json, MAIL_MESSAGE_FIELDS, mailDeploymentAliases, mailUsernameRefusal, MAIL_VIEWS, MAIL_WAKES, MailAddress, mailText, mailThreadText, objectNamed, ownerCaller, safeJson,
  type MailListQuery, type ObjectNamespace, type OwnerCapabilityEnv,
} from '@kinu.run/core';
import { attempt, diagnostics, settle } from '@kinu.run/core/obs';
import type { FamilyEnv } from '../api/context';
import { isListedOperator } from '../control-plane/admin-caller';
import type { OrchestratorAgent } from '../orchestrator';
import { installedAssistant } from '../user/blueprint-install';
import type { UserDO } from '../user/user-do';
import type { WorkspaceVariables } from '../api/workspace';
import type { MailboxDO } from './mailbox-do';
import type { MailNameDO } from './mailname-do';

type MailboxReach = Pick<MailboxDO, 'open' | 'boxes' | 'list' | 'thread' | 'update' | 'draft' | 'send' | 'setWake'>;

export interface MailRoutesEnv extends OwnerCapabilityEnv {
  readonly EMAIL_DOMAIN?: string;
  readonly MAIL_ACCOUNTS?: string;
  readonly MAIL_ALIASES?: string;
  readonly CONTROL_PLANE_ADMINS?: string;
  readonly MAILNAME: ObjectNamespace<unknown, Pick<MailNameDO, 'lookup' | 'claim'>>;
  readonly MAILBOX: ObjectNamespace<unknown, MailboxReach>;
  readonly UserDO: ObjectNamespace<unknown, Pick<UserDO, 'getConfig' | 'listActiveWorkspaces'>>;
  readonly OrchestratorAgent: ObjectNamespace<unknown, Pick<OrchestratorAgent, 'readOwnerMail'>>;
}

type MailContext = Context<FamilyEnv<MailRoutesEnv>>;

const Outgoing = v.object({
  path: v.pipe(v.string(), v.maxLength(41)),
  ...MAIL_MESSAGE_FIELDS,
  text: mailText('person'),
  inReplyTo: v.optional(v.nullable(v.string())),
  threadId: v.optional(v.string()),
});

const Username = v.object({ username: v.string() });

const Change = v.strictObject({ read: v.optional(v.boolean()), trashed: v.optional(v.boolean()) });

const Handed = v.object({ thread: v.pipe(v.string(), v.nonEmpty(), v.maxLength(64)) });

const Wake = v.object({
  path: v.pipe(v.string(), v.maxLength(41)),
  wake: v.picklist(MAIL_WAKES),
  allow: v.optional(v.pipe(v.array(MailAddress), v.maxLength(200))),
});

/** Whether the signed-in person may hold an address on this deployment (docs/MAIL.md §1). */
function mayCreate(env: MailRoutesEnv, email: string): boolean {
  if (env.MAIL_ACCOUNTS === 'everyone') return true;

  return isListedOperator(env, email);
}

const mailbox = (c: MailContext): MailboxReach => objectNamed(c.env.MAILBOX, c.get('identity').userId);

/** Their Personal assistant, if they have one, reads their box; a failed hand-over is said, and the address stands. */
function handToAssistant(c: MailContext): Effect.Effect<void> {
  const { userId } = c.get('identity');

  return attempt({ doing: 'giving the assistant the owner\'s mail', otherwise: 'unavailable' }, async () => {
    const assistant = await installedAssistant(objectNamed(c.env.UserDO, userId), await ownerCaller(c.env));

    if (assistant !== null) await objectNamed(c.env.OrchestratorAgent, assistant).readOwnerMail();
  }).pipe(Effect.catch((failure) => Effect.sync(() => { diagnostics.failure('mail.assistant_unlinked', failure, {}); })));
}

/** Whether this deployment has mail: a mail domain its deploy gave it. Without one there is no address to create or read. */
const mailOn = (c: MailContext): boolean => (c.env.EMAIL_DOMAIN ?? '') !== '';

/** The person's address, from the boxes their Mailbox holds; null before they create one. */
async function addressOf(c: MailContext): Promise<string | null> {
  return (await mailbox(c).boxes()).find((box) => box.path === '')?.address ?? null;
}

export const mailRoutes = new Hono<FamilyEnv<MailRoutesEnv>>();

mailRoutes.get('/api/user/mail/boxes', async (c) => {
  if (!mailOn(c)) return json({ body: { enabled: false, domain: null, address: null, canCreate: false, boxes: [] } });

  const address = await addressOf(c);
  const canCreate = address === null && mayCreate(c.env, c.get('identity').email);

  return json({ body: { enabled: true, domain: c.env.EMAIL_DOMAIN ?? '', address, canCreate, boxes: address === null ? [] : await mailbox(c).boxes() } });
});

/** Why `username` cannot be the person's: not a name or reserved (core's rules), or another account's; null when it can. */
async function usernameRefusal(c: MailContext, username: string): Promise<'invalid' | 'reserved' | 'taken' | null> {
  const refusal = mailUsernameRefusal(username);

  if (refusal !== null) return refusal;
  const aliases = mailDeploymentAliases(c.env.MAIL_ALIASES);

  // The deployment's own addresses are its config's; a mistaken config keeps every name until it is fixed.
  if (aliases === 'malformed' || aliases.has(username)) return 'reserved';
  const holder = await objectNamed(c.env.MAILNAME, username).lookup();

  return holder !== null && holder.user_id !== c.get('identity').userId ? 'taken' : null;
}

/** A refused username, in its status and words. */
function refused(refusal: 'invalid' | 'reserved' | 'taken'): Response {
  if (refusal === 'taken') return err(403, 'That name is taken.');

  return err(400, refusal === 'reserved' ? 'That name is kept for mail systems.' : 'A username is 1 to 20 lowercase letters, digits and inner hyphens.');
}

/** The address the person holds once this returns: created now, or the one they had; a refusal is its answer. */
async function createAddress(c: MailContext): Promise<{ address: string } | Response> {
  if (!mailOn(c)) return err(503, 'Mail is off on this deployment: it has no mail domain.');
  const identity = c.get('identity');
  const body = await safeJson(c.req.raw, Username);

  const named = body === null ? 'invalid' : mailUsernameRefusal(body.username);

  if (body === null || named !== null) return refused(named ?? 'invalid');

  if (!mayCreate(c.env, identity.email)) return err(403, 'Addresses on this deployment are its operators\' only.');

  const held = await addressOf(c);

  if (held !== null) return { address: held };
  const refusal = await usernameRefusal(c, body.username);

  // Said in its own words here; one that races another account still fails, in MailName's.
  if (refusal !== null) return refused(refusal);

  // The box records the name first, then claims it (MailboxDO.open).
  const box = await mailbox(c).open({ userId: identity.userId, email: identity.email, username: body.username, assistant: null });

  return { address: box.address };
}

/** Whether a username may be the person's, read as they type: it holds nothing. */
mailRoutes.get('/api/user/mail/address', async (c) => {
  if (!mailOn(c)) return err(503, 'Mail is off on this deployment: it has no mail domain.');
  const username = c.req.query('username') ?? '';
  const refusal = await usernameRefusal(c, username);

  return json({ body: { username, available: refusal === null, refusal } });
});

mailRoutes.post('/api/user/mail/address', async (c) => {
  const created = await createAddress(c);

  if (created instanceof Response) return created;

  return settle(Effect.as(handToAssistant(c), json({ body: created })));
});

mailRoutes.get('/api/user/mail/important', async (c) => {
  const limit = Math.min(20, Math.max(1, Number(c.req.query('limit') ?? '3') || 3));

  const boxes = mailOn(c) ? await mailbox(c).boxes() : [];

  if (!boxes.some((box) => box.path === '')) return json({ body: { enabled: mailOn(c), unread: 0, items: [] } });

  const listing = await mailbox(c).list({ view: 'important', limit });

  return json({ body: { enabled: true, unread: listing.unread, items: importantMail(listing.threads, boxes) } });
});

mailRoutes.get('/api/user/mail/threads', async (c) => {
  const view = v.safeParse(v.picklist(MAIL_VIEWS), c.req.query('view') ?? 'all');

  if (!view.success) return err(400, `view is one of ${MAIL_VIEWS.join(', ')}`);

  if (await addressOf(c) === null) return err(404, 'This account has no mail address yet.');

  const before = Number(c.req.query('before'));

  const query: MailListQuery = {
    view: view.output, path: c.req.query('path'), query: c.req.query('q'), before: Number.isFinite(before) && before > 0 ? before : undefined, limit: 50,
  };

  return json({ body: await mailbox(c).list(query) });
});

mailRoutes.get('/api/user/mail/threads/:id', async (c) => {
  const thread = await mailbox(c).thread(c.req.param('id'));

  return thread === null ? err(404, 'No such thread.') : json({ body: thread });
});

mailRoutes.patch('/api/user/mail/threads/:id', async (c) => {
  const change = await safeJson(c.req.raw, Change);

  if (change === null) return err(400, 'read and trashed (booleans) are what a person changes; Important is the assistant\'s.');

  return json({ body: await mailbox(c).update(c.req.param('id'), change) });
});

// A message the person writes: sent now, or kept as a draft. Both take the same fields.
for (const [path, act] of [['/api/user/mail/send', 'send'], ['/api/user/mail/drafts', 'draft']] as const) {
  mailRoutes.post(path, async (c) => {
    const outgoing = await safeJson(c.req.raw, Outgoing);

    if (outgoing === null) return err(400, 'path, to, subject and text are required.');

    return json({ body: await mailbox(c)[act](outgoing) });
  });
}

mailRoutes.put('/api/user/mail/boxes/wake', async (c) => {
  const body = await safeJson(c.req.raw, Wake);

  if (body === null) return err(400, 'wake is one of owner, allowlist, verified, never.');

  return json({ body: await mailbox(c).setWake(body.path, body.wake, body.allow) });
});

/** "Send to a workspace…" (docs/MAIL.md §8): the person's thread, as its agent reads it, to a workspace they own. */
export const mailHandRoutes = new Hono<FamilyEnv<MailRoutesEnv, WorkspaceVariables>>();

mailHandRoutes.post('/api/workspaces/:name/mail', async (c) => {
  const body = await safeJson(c.req.raw, Handed);

  if (body === null) return err(400, 'thread is required.');

  const read = await objectNamed(c.env.MAILBOX, c.get('identity').userId).thread(body.thread);

  if (read === null) return err(404, 'No such thread.');
  const { subject } = read.thread;
  const messages = read.messages.filter((message) => message.sendState !== 'draft');

  return json({ body: await c.get('workspace').agent.mailHanded({ subject, text: mailThreadText({ subject, messages }) }) });
});
