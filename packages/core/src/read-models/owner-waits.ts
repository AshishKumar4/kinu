/**
 * What waits on the owner, as an agent's program reads it (`agent.waitingOnOwner`): the rows the attention stack holds
 * the person on (pending-actions.ts `ownerAsks`), from the same reads, each named by its own fields, never by the prose
 * a card shows. The workspace's own agent reads every one; a hire, only its own. An account-memory proposal is not
 * here: the owner's account holds it, and the workspace is never told when it is decided.
 */
import type { DeferredApproval } from '../safety/deferred-approval';
import { approvalKindOf, type ApprovalKind } from '../safety/approval-kind';
import type { PendingConsent } from '../protocol';
import type { WorkspaceProposal } from '../safety/workspace-proposals';
import type { AskingAgent } from '../plans/owner-questions';
import { planTitle } from '../plans/review';
import { cardWords } from './event-summary';
import type { OwnerWait, OwnerWaitWatch } from '../types/owner-waits';
import type { AgentConfigStore } from '../config/store';
import type { AgentSignal } from '../types/signals';
import type { OwnerWaitsHost } from '../tools/agent-self';
import { nanoid } from '../utils/nanoid';
import { Effect } from 'effect';
import type { KinuError } from '../obs/error';

/** One row with whose ask it is, by actor id: the scope a hire's read is cut to. */
export interface ScopedOwnerWait {
  readonly wait: OwnerWait;
  /** Null for the workspace's own: no hire's. */
  readonly raisedBy: string | null;
}

export interface OwnerWaitSources {
  /** Still queued (deferred-approval.ts `list`): parked commands and writes. */
  readonly deferred: readonly DeferredApproval[];
  readonly plans: ReadonlyArray<{ readonly actor: string; readonly id: string; readonly revision: number; readonly content: string; readonly updatedAt: number }>;
  readonly proposals: readonly WorkspaceProposal[];
  readonly consents: readonly PendingConsent[];
  readonly questions: readonly AskingAgent[];
  /** An agent's name by its actor id, as it asks under it. */
  readonly nameOf: (actorId: string) => string;
}

/** Every row that waits on the owner, newest first, each with whose it is. */
export function ownerWaits(sources: OwnerWaitSources): ScopedOwnerWait[] {
  const commands = sources.deferred.filter((action) => action.status === 'queued').map((action): ScopedOwnerWait => {
    const parked = approvalKindOf(action);

    return {
      raisedBy: action.actor,
      wait: { key: `action:${action.id}`, kind: parked.kind === 'write' ? 'write' : 'command', what: waitText(parked), since: action.requestedAt, askedBy: sources.nameOf(action.actor) },
    };
  });

  const plans = sources.plans.map((plan): ScopedOwnerWait => ({
    raisedBy: plan.actor,
    wait: { key: `plan:${plan.actor}:${plan.id}:${String(plan.revision)}`, kind: 'plan', what: planTitle(plan.content), since: plan.updatedAt, askedBy: sources.nameOf(plan.actor) },
  }));

  const proposals = sources.proposals.map((proposal): ScopedOwnerWait => ({
    raisedBy: null, wait: { key: `action:${proposal.id}`, kind: 'workspace', what: proposal.name, since: proposal.requestedAt, askedBy: null },
  }));

  const consents = sources.consents.map((consent): ScopedOwnerWait => ({
    raisedBy: null,
    wait: { key: `consent:${consent.consentId}`, kind: 'consent', what: `${consent.method} on ${consent.deviceLabel}: ${consent.command}`, since: consent.createdAt, askedBy: null },
  }));

  const questions = sources.questions.filter((asking) => asking.asked.status === 'open').map((asking): ScopedOwnerWait => ({
    raisedBy: asking.actor,
    wait: {
      key: `question:${asking.asked.id}`, kind: 'question', what: asking.asked.questions.map((question) => question.question).join(' '),
      since: asking.asked.askedAt, askedBy: asking.agent,
    },
  }));

  return [...commands, ...plans, ...proposals, ...consents, ...questions].sort((a, b) => b.wait.since - a.wait.since || a.wait.key.localeCompare(b.wait.key));
}

/** What `actorId` reads of them: the workspace's own agent every row; a hire only the rows it asked itself. */
function ownerWaitsFor(waits: readonly ScopedOwnerWait[], reader: { readonly actorId: string; readonly workspaceAgent: boolean }): OwnerWait[] {
  return waits.filter((row) => reader.workspaceAgent || row.raisedBy === reader.actorId).map((row) => row.wait);
}

/** Whether the watch is met by what its agent reads now. */
function ownerWaitMet(watch: Pick<OwnerWaitWatch, 'key'>, waits: readonly OwnerWait[]): boolean {
  return watch.key === null ? waits.length === 0 : !waits.some((wait) => wait.key === watch.key);
}

/** The system event a met watch wakes its agent with. */
const OWNER_WAITS_SIGNAL = 'owner_waits_cleared';

/** An agent as a wait reads and keeps it: who it is, and its config, where its watch is kept. */
export interface OwnerWaitReader {
  readonly actorId: string;
  readonly workspaceAgent: boolean;
  readonly config: Pick<AgentConfigStore, 'getOwnerWaitsWatch' | 'setOwnerWaitsWatch'>;
}

/**
 * One agent's `agent.waitingOnOwner` and `agent.wakeWhenOwnerDone`, over `read`, every row that waits on the owner
 * now. `armed` tells the host a watch exists, so it reads again at the next change.
 */
export function ownerWaitsHost(input: {
  readonly reader: OwnerWaitReader;
  readonly read: () => Promise<readonly ScopedOwnerWait[]>;
  readonly armed: () => void;
  readonly now?: () => number;
}): OwnerWaitsHost {
  const { reader } = input;
  const list = async () => ownerWaitsFor(await input.read(), reader);

  return {
    list,
    async wakeWhenDone(key) {
      const waits = await list();

      if (ownerWaitMet({ key }, waits)) return { already: true };
      const what = key === null ? null : waits.find((wait) => wait.key === key)?.what ?? null;

      reader.config.setOwnerWaitsWatch({ id: nanoid(), key, what, armedAt: input.now?.() ?? Date.now() });
      input.armed();

      return { armed: true };
    },
  };
}

/** The wake a met watch sends: keyed on the watch, so a second pass over the same change announces it once. */
function ownerWaitsSignal(watch: OwnerWaitWatch): AgentSignal {
  const text = watch.what === null
    ? 'Your owner has handled everything that waited on them from you.'
    : `Your owner has handled what you waited on: ${watch.what}`;

  return { kind: OWNER_WAITS_SIGNAL, text, idempotencyKey: `${OWNER_WAITS_SIGNAL}:${watch.id}`, metadata: { key: watch.key, what: watch.what === null ? null : cardWords(watch.what) } };
}

/**
 * Each armed watch the rows now meet: its agent woken, then its row gone, so a crash between the two wakes it again
 * under the same key, which delivers once. Answers whether any watch is still armed.
 */
export function wakeMetOwnerWaits(input: {
  readonly readers: readonly OwnerWaitReader[];
  readonly rows: () => Promise<readonly ScopedOwnerWait[]>;
  readonly wake: (actorId: string, signal: AgentSignal) => Effect.Effect<void, KinuError>;
}): Effect.Effect<boolean, KinuError> {
  return Effect.gen(function* () {
    const armed = input.readers.flatMap((reader) => {
      const watch = reader.config.getOwnerWaitsWatch();

      return watch === null ? [] : [{ reader, watch }];
    });

    if (armed.length === 0) return false;
    const rows = yield* Effect.promise(input.rows);
    let stillArmed = false;

    for (const { reader, watch } of armed) {
      if (!ownerWaitMet(watch, ownerWaitsFor(rows, reader))) {
        stillArmed = true;
        continue;
      }

      yield* input.wake(reader.actorId, ownerWaitsSignal(watch));
      reader.config.setOwnerWaitsWatch(null);
    }

    return stillArmed;
  });
}

/** What a parked action is, in words: a write's file, a shared slate's effect as what it would do, or the command. */
function waitText(parked: ApprovalKind): string {
  switch (parked.kind) {
    case 'write': return parked.write.path;
    case 'slate-effect': return `slate ${parked.effect.slate}: ${parked.effect.tool} on ${parked.effect.server}`;
    case 'mail-send': return `mail from ${parked.send.from} to ${parked.send.to.join(', ')}: ${parked.send.subject}`;
    case 'command': return parked.command;
  }
}
