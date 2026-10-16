/**
 * Everything waiting on the owner, as rows pointing at each item's home; never a second place to decide.
 * Security: must never join `SLATE_READ_MODELS`: a Slate could draw a fake of this queue (`slates/read-models.ts`).
 */

import type { AccountMemoryProposal } from '../memory/account';
import type { DeferredApproval } from '../safety/deferred-approval';
import { proposedSoul, type WorkspaceProposal } from '../safety/workspace-proposals';
import { boundWriteOf } from '../safety/bound-write';
import { describeExecutionContext } from '../safety/approval-gate';
import type { PendingConsent } from '../protocol';
import type { PlanReview } from '../types/plans';
import { planTitle } from '../plans/review';
import type { AskingAgent } from '../plans/owner-questions';

export type PendingActionKind =
  /** Decided here: the queue is this action's only home. */
  | 'deferred_action'
  | 'scaffold_version'
  /** Skills the agent wrote for itself, held for the owner's approval in the Agent tab's journal. */
  | 'change_approval'
  /** Decided here: the agent's proposed workspace, approved or declined once. */
  | 'workspace_proposal'
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
  /** A proposed workspace: the SOUL.md it would start with, exactly as approving writes it. */
  readonly proposal?: { readonly name: string; readonly brief: string; readonly soul: string };
  /** The actor whose ask it is, by id (a parked command, a plan); absent, the workspace's own (a proposal). */
  readonly raisedBy?: string;
}

/** What a workspace asks of the person now. */
export interface PersonAsks {
  readonly pendingActions: readonly PendingAction[];
  readonly pendingConsents: readonly PendingConsent[];
  readonly activePlan: PlanReview | null;
  /** The workspace agent's and its hosted agents' questions; the open ones wait on the person. */
  readonly ownerQuestions: readonly AskingAgent[];
}

/** Rows holding the person's work until they decide; the agent's own proposals and notes do not (#21). */
const HOLDS_THE_PERSON = {
  deferred_action: true,
  workspace_proposal: true,
  plan_review: true,
  scaffold_version: false,
  change_approval: false,
} satisfies Record<PendingActionKind, boolean>;

/** What the inspector opens for on its own: an action or a consent to approve, a plan to review, or a question. */
export function needsTheUser(asks: PersonAsks): boolean {
  return asks.pendingActions.some((action) => HOLDS_THE_PERSON[action.kind])
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
  const held: OwnerAsk[] = asks.pendingActions.filter((action) => HOLDS_THE_PERSON[action.kind])
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
  readonly scaffoldVersions: ReadonlyArray<{
    version: number; status: string; rationale: string; written_at: number;
  }>;
  /** Still-queued only (safety/deferred-approval.ts). */
  readonly deferredActions: readonly DeferredApproval[];
  /** The journal's changes that wait on the owner (`awaitingTheOwner`); what the agent did by itself is not counted. */
  readonly changeApprovals: { count: number; latestAt: number };
  /** Still-open only (safety/workspace-proposals.ts). */
  readonly workspaceProposals: readonly WorkspaceProposal[];
  /** Workspace-wide and retired-inclusive: a subordinate's plan asks the same owner. `actor`: its owner's id. */
  readonly pendingPlans: ReadonlyArray<{
    owner: string; actor: string; id: string; revision: number; content: string; updatedAt: number;
  }>;
}

export function buildPendingActions(input: PendingActionInputs): PendingAction[] {
  const actions: PendingAction[] = [];

  for (const action of input.deferredActions) {
    if (action.status !== 'queued') continue;
    const write = boundWriteOf(action.command);
    const where = describeExecutionContext(action.context);

    actions.push(write === null ? {
      id: action.id,
      kind: 'deferred_action',
      // Name the machine: commands against the agent's own sandbox never reach this queue.
      title: `Approve: a command the agent wants to run on ${action.executor}`,
      detail: action.command,
      at: action.requestedAt,
      raisedBy: action.actor,
      ...(where !== '' && { where }),
    } : {
      id: action.id,
      kind: 'deferred_action',
      title: `Replace ${write.path}`,
      detail: null,
      at: action.requestedAt,
      raisedBy: action.actor,
      write: { path: write.path },
    });
  }

  for (const proposal of input.workspaceProposals) {
    actions.push({
      id: proposal.id,
      kind: 'workspace_proposal',
      title: `Create a workspace: ${proposal.name}`,
      detail: proposal.brief,
      at: proposal.requestedAt,
      proposal: { name: proposal.name, brief: proposal.brief, soul: proposedSoul(proposal) },
    });
  }

  for (const version of input.scaffoldVersions) {
    if (version.status !== 'pending') continue;
    actions.push({
      id: `scaffold-v${version.version}`,
      kind: 'scaffold_version',
      title: `Scaffold v${version.version} is waiting to be promoted or rolled back`,
      detail: version.rationale || null,
      at: version.written_at,
    });
  }

  const { count: approvals, latestAt } = input.changeApprovals;

  if (approvals > 0) {
    actions.push({
      id: 'change-approvals',
      kind: 'change_approval',
      title: approvals === 1 ? 'A skill the agent wrote waits for your approval' : `${String(approvals)} skills the agent wrote wait for your approval`,
      detail: 'Approve or decline in the Agent tab.',
      at: latestAt,
    });
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
