/**
 * `mail.*` served over the account's Mailbox for one agent (docs/MAIL.md §3). It reads only the boxes that agent reads;
 * drafts need no approval; a message leaves only with the owner's approval of that exact message, which its next send
 * takes, so one approval sends it once and a changed word asks anew. Every agent send asks: none stands.
 */
import { Effect } from 'effect';
import type { CodemodeProvider } from '../types/codemode';
import type { MailboxAgentCalls, MailCaller, MailThreadSummary } from '../mail/mailbox-api';
import { mailSendText, type MailSend } from '../safety/approval-kind';
import type { ApprovalSpend, ApprovalSpendOutcome } from '../safety/approval-gate';
import { sha256Hex } from '../safety/argument-digest';
import { attempt, diagnostics, KinuError, settle } from '../obs/index';
import { MAX_MAIL_IN_CONTEXT, mailInContext, type MailInContext } from '../mail/in-context';
import type { ActiveRoster } from '../types/dynamic-context';
import { serve, type Served } from '../operations/operation';
import { codemodeNamespace } from './operation-surfaces';
import { MAIL } from '../operations/mail';

/** Where an agent's message waits on the owner: the workspace's approval queue, as every parked action does. */
export interface MailSendApprovals {
  ask(id: string, send: MailSend): { readonly outcome: 'approved' } | { readonly outcome: 'asked' | 'denied'; readonly approval: string };
  /** The approval taken as the message is sent; null where it is no longer approved. */
  take(id: string): ApprovalSpend | null;
  settle(spend: ApprovalSpend, outcome: ApprovalSpendOutcome): Promise<boolean>;
}

export interface MailDeps {
  /** Read per call: the workspace's title can change; a box's label is fixed when it is made. */
  readonly caller: () => MailCaller;
  /** Read per call: the account's Mailbox. */
  readonly mailbox: () => MailboxAgentCalls;
  readonly approvals: MailSendApprovals;
}

/** An agent's unread mail for its turn's context (docs/MAIL.md §8): none on a failed read, which is said. */
export function unreadMailForTurn(mail: MailDeps, workspace: string): Promise<ActiveRoster<MailInContext> | undefined> {
  return settle(Effect.catch(
    attempt({ doing: 'reading the agent\'s unread mail for its turn', otherwise: 'unavailable' }, async () => mailInContext(
      await mail.mailbox().findFor(mail.caller(), { view: 'all', unread: true, limit: MAX_MAIL_IN_CONTEXT }),
    )),
    (failure) => Effect.sync(() => {
      diagnostics.failure('mail.context_read_failed', failure, { workspace });

      return undefined;
    }),
  ));
}

const summaryOf = (thread: MailThreadSummary) => ({
  id: thread.id, box: thread.path, subject: thread.subject, from: [...thread.from], at: thread.at, unread: thread.unread,
  important: thread.important, verified: thread.verified, snippet: thread.snippet,
});

function serveMail({ caller: callerNow, mailbox, approvals }: MailDeps): readonly Served[] {
  const caller = (): MailCaller => callerNow();

  return [
    serve(MAIL.address, async () => {
      const boxes = await mailbox().readableBy(caller());

      return { own: boxes[0]?.address ?? '', boxes: boxes.map((box) => ({ path: box.path, address: box.address })) };
    }),
    serve(MAIL.find, async ({ view = 'all', ...query }) => {
      const listing = await mailbox().findFor(caller(), { ...query, view });

      return { threads: listing.threads.map(summaryOf), unread: listing.unread };
    }),
    serve(MAIL.read, ({ thread }) => Effect.gen(function* () {
      const read = yield* Effect.promise(async () => mailbox().readFor(caller(), thread));

      if (read === null) return yield* Effect.fail(new KinuError('missing', `No thread "${thread}" in a box you read.`));

      return {
        id: read.thread.id, box: read.thread.path, subject: read.thread.subject, untrusted: true as const,
        messages: read.messages.filter((message) => message.sendState !== 'draft').map((message) => ({
          id: message.id, from: message.from, to: [...message.to], at: message.at, verified: message.verified, text: message.text,
          attachments: message.attachments.map((file) => ({ filename: file.filename, contentType: file.contentType, size: file.size })),
          sentBy: message.writtenBy,
        })),
      };
    })),
    serve(MAIL.draft, async ({ replyTo, ...message }) => {
      const draft = await mailbox().draftFor(caller(), { ...message, ...replyTo !== undefined && { thread: replyTo } });

      return { draft: draft.id, thread: draft.threadId };
    }),
    serve(MAIL.send, ({ replyTo, ...message }) => Effect.gen(function* () {
      const boxes = yield* Effect.promise(async () => mailbox().readableBy(caller()));
      const from = (message.box === undefined ? boxes[0] : boxes.find((box) => box.path === message.box))?.address;

      if (from === undefined) return yield* Effect.fail(new KinuError('denied', `You do not read the box "${message.box ?? ''}".`));

      const who = caller();
      const by = who.actorId === who.mainActorId ? who.title : who.name;
      const send: MailSend = { by, from, to: message.to, cc: message.cc ?? [], subject: message.subject, text: message.text, thread: replyTo ?? null };
      const id = `mail-${sha256Hex(mailSendText(send), 32)}`;
      const verdict = approvals.ask(id, send);

      if (verdict.outcome !== 'approved') return { status: verdict.outcome, approval: verdict.approval } as const;

      const spend = approvals.take(id);

      // Approved a moment ago and taken since: another send of the same message went first.
      if (spend === null) return { status: 'asked' as const, approval: id };

      const sent = yield* Effect.promise(async () => mailbox().sendFor(caller(), { ...message, ...replyTo !== undefined && { thread: replyTo } }));

      yield* Effect.promise(async () => approvals.settle(spend, 'spent'));

      return { status: 'sent' as const, message: sent.id, thread: sent.threadId };
    })),
    serve(MAIL.update, async ({ thread, ...change }) => summaryOf(await mailbox().updateFor(caller(), thread, change))),
    serve(MAIL.trash, async ({ thread, restore }) => summaryOf(await mailbox().updateFor(caller(), thread, { trashed: restore !== true }))),
  ];
}

/** `mail.*` for an agent's programs. */
export function createMailCodemodeProvider(deps: MailDeps): CodemodeProvider {
  return codemodeNamespace('mail', 'Your mail: read the boxes you read, keep drafts, and send with the owner\'s approval.', serveMail(deps));
}
