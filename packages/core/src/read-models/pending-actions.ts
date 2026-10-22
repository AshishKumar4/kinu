/**
 * Everything waiting on the owner, as rows pointing at each item's home; never a second place to decide.
 * Security: must never join `SLATE_READ_MODELS`: a Slate could draw a fake of this queue (`slates/read-models.ts`).
 */

import type { AccountMemoryProposal } from '../memory/account';
import type { DeferredApproval } from '../safety/deferred-approval';
import { approvalKindOf, type MailSend } from '../safety/approval-kind';
import { describeExecutionContext } from '../safety/approval-gate';
import type { PendingConsent } from '../protocol';
import type { PlanReview } from '../types/plans';
import { planTitle } from '../plans/review';
import type { AskingAgent } from '../plans/owner-questions';

export type PendingActionKind =
  /** Decided here: the queue is this action's only home. */
  | 'deferred_action'
  /** Deep-links to the full-tab review. */
  | 'plan_review';

export interface PendingAction {
  /** The underlying row's id, so a re-read does not re-key and re-animate the list. */
  readonly id: string;
  readonly kind: PendingActionKind;
  readonly title: string;
  readonly detail: string | null;
  readonly at: number;
  /** Lets the click find the row in the work read without reparsing a formatted id. */
  readonly planRef?: { readonly owner: string; readonly id: string; readonly revision: number };
  /** A parked write over the user's file: its review is `reviewParkedWrite` of this id. */
  readonly write?: { readonly path: string };
  /** Where and how a parked command runs, as the owner reads it: part of what approving allows. */
  readonly where?: string;
  /** The actor whose ask it is, by id (a parked command, a plan); absent, the workspace's own. */
  readonly raisedBy?: string;
  /**
   * A shared slate's effect: the shared slate, the slate whose call it is, and the tool on its root. Answered "always",
   * that tool on that root stands allowed on the shared slate's shares on its owner's access until its code changes.
   */
  readonly effect?: { readonly slate: string; readonly caller: string; readonly server: string; readonly tool: string; readonly root: Readonly<Record<string, string>> };
  /** An agent's message, exactly as approving lets it leave once (docs/MAIL.md §3). Never answered "always". */
  readonly mail?: Omit<MailSend, 'thread'>;
}

/** What a workspace asks of the person now. */
export interface PersonAsks {
  readonly pendingActions: readonly PendingAction[];
  readonly pendingConsents: readonly PendingConsent[];
  readonly activePlan: PlanReview | null;
  /** The workspace agent's and its hosted agents' questions; the open ones wait on the person. */
  readonly ownerQuestions: readonly AskingAgent[];
}

/** What the inspector opens for on its own: an action or a consent to approve, a plan to review, or a question. */
export function needsTheUser(asks: PersonAsks): boolean {
  return asks.pendingActions.length > 0
    || asks.pendingConsents.length > 0
    || asks.activePlan?.status === 'pending'
    || asks.ownerQuestions.some((asking) => asking.asked.status === 'open');
}

/**
 * One thing waiting on the owner's answer: a queued row that holds them, a machine's consent, an account-memory
 * proposal (the account's own record of it, held by the owner's user object), or an agent's questions. `raisedBy`: the
 * actor whose ask it is, by id; null for the workspace's own.
 */
export type OwnerAsk =
  | { readonly key: string; readonly at: number; readonly raisedBy: string | null; readonly kind: 'action'; readonly action: PendingAction }
  | { readonly key: string; readonly at: number; readonly raisedBy: null; readonly kind: 'consent'; readonly consent: PendingConsent }
  | { readonly key: string; readonly at: number; readonly raisedBy: null; readonly kind: 'memory'; readonly memory: AccountMemoryProposal }
  | { readonly key: string; readonly at: number; readonly raisedBy: string | null; readonly kind: 'question'; readonly question: AskingAgent };

/**
 * What the chat's attention stack shows, newest first: every row that holds the person (the rule
 * {@link needsTheUser} reads) and every consent, from the same two reads the Work tab shows. The agent's notes and
 * proposals that hold nobody stay in Work. `raisedBy`: only that actor's asks, for its own pane.
 */
export function ownerAsks(
  asks: Pick<PersonAsks, 'pendingActions' | 'pendingConsents'> & {
    readonly accountProposals?: readonly AccountMemoryProposal[] | null;
    readonly questions?: readonly AskingAgent[] | null;
  },
  { raisedBy }: { readonly raisedBy?: string } = {},
): OwnerAsk[] {
  // Every row holds the person's work until they decide: what the agent did by itself never reaches the queue.
  const held: OwnerAsk[] = asks.pendingActions
    .map((action) => ({ key: `action:${action.id}`, at: action.at, raisedBy: action.raisedBy ?? null, kind: 'action', action }));

  const consents: OwnerAsk[] = asks.pendingConsents
    .map((consent) => ({ key: `consent:${consent.consentId}`, at: consent.createdAt, raisedBy: null, kind: 'consent', consent }));

  // The account's, held by the owner's user object: every workspace's chat shows them, its own agents' among them.
  const memory: OwnerAsk[] = (asks.accountProposals ?? [])
    .map((proposal) => ({ key: `memory:${proposal.id}`, at: proposal.createdAt, raisedBy: null, kind: 'memory', memory: proposal }));

  const questions: OwnerAsk[] = (asks.questions ?? []).filter((asking) => asking.asked.status === 'open')
    .map((asking) => ({ key: `question:${asking.asked.id}`, at: asking.asked.askedAt, raisedBy: asking.actor, kind: 'question', question: asking }));

  return [...held, ...consents, ...memory, ...questions]
    .filter((ask) => raisedBy === undefined || ask.raisedBy === raisedBy)
    .sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

export interface PendingActionInputs {
  /** Still-queued only (safety/deferred-approval.ts). */
  readonly deferredActions: readonly DeferredApproval[];
  /** Workspace-wide and retired-inclusive: a subagent's plan asks the same owner. `actor`: its owner's id. */
  readonly pendingPlans: ReadonlyArray<{
    owner: string; actor: string; id: string; revision: number; content: string; updatedAt: number;
  }>;
}

/** A parked action's card, by what it parks. */
function deferredCard(action: PendingActionInputs['deferredActions'][number]): PendingAction {
  const parked = approvalKindOf(action);
  const card = { id: action.id, kind: 'deferred_action', at: action.requestedAt } as const;

  switch (parked.kind) {
    case 'write': return { ...card, raisedBy: action.actor, title: `Replace ${parked.write.path}`, detail: null, write: { path: parked.write.path } };

    // The owner approves this one call, its payload drawn exactly as the shared slate's server sent it. No agent asked
    // it, so it names none.
    case 'slate-effect': {
      const { effect } = parked;

      return {
        ...card, title: `Approve: ${effect.tool} on ${effect.server}, for ${effect.viewer} through a share of ${effect.slate}`,
        detail: JSON.stringify(effect.payload, null, 2),
        effect: { slate: effect.slate, caller: effect.caller, server: effect.server, tool: effect.tool, root: effect.root },
      };
    }

    // The agent that asked sends it on its next call; the card is the message as it would leave.
    case 'mail-send': {
      const { send } = parked;

      return {
        ...card, raisedBy: action.actor, title: `Send mail to ${send.to.join(', ')}: ${send.subject}`, detail: null,
        mail: { by: send.by, from: send.from, to: send.to, cc: send.cc, subject: send.subject, text: send.text } satisfies Omit<MailSend, 'thread'>,
      };
    }

    case 'command': {
      const where = describeExecutionContext(action.context);

      // Name the machine: commands against the agent's own sandbox never reach this queue.
      return {
        ...card, raisedBy: action.actor, title: `Approve: a command the agent wants to run on ${action.executor}`, detail: action.command,
        ...(where !== '' && { where }),
      };
    }
  }
}

export function buildPendingActions(input: PendingActionInputs): PendingAction[] {
  const actions: PendingAction[] = [];

  for (const action of input.deferredActions) {
    if (action.status === 'queued') actions.push(deferredCard(action));
  }

  for (const plan of input.pendingPlans) {
    actions.push({
      id: `plan:${plan.owner}:${plan.id}:${plan.revision}`,
      kind: 'plan_review',
      title: `Approve the plan · ${planTitle(plan.content)}`,
      detail: plan.owner === 'main' ? null : `Submitted by ${plan.owner}`,
      at: plan.updatedAt,
      planRef: { owner: plan.owner, id: plan.id, revision: plan.revision },
      raisedBy: plan.actor,
    });
  }

  return actions.sort((a, b) => b.at - a.at);
}
