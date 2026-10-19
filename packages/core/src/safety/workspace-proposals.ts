/**
 * A workspace the agent proposes and its owner approves once, in the Work tab, before it exists. The proposal is a
 * durable row while it waits, so an activation that never saw the ask still shows it; once decided the row goes, and
 * the decision wakes the agent with the outcome: the new workspace's link, the decline, or why the create failed. Creation itself is the host's: one call into the
 * same path `POST /api/user/workspaces` takes.
 */
import { markStoreChanged } from '@kinu.run/agent-utils';
import { Cause, Effect, Exit } from 'effect';
import { KinuError, renderThrownChain } from '../obs/error';
import { attempt } from '../obs/effect';
import { renderSoulMarkdown } from '../identity/soul';
import type { AgentInbox } from '../types/signals';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';

const WORKSPACE_PROPOSAL_SIGNAL = 'workspace_proposal';

/** The display name's longest form: a title, never a paragraph. */
const WORKSPACE_PROPOSAL_NAME_MAX = 80;

/** An open proposal's state: waiting on the owner, or approved with its create cut short by an eviction. */
type WorkspaceProposalStatus = 'pending' | 'creating';

export type WorkspaceProposalAnswer = 'approve' | 'decline';

/** What the agent proposes: `name` titles the workspace, `brief` is its mission, `soul` the rest of its SOUL.md. */
export interface WorkspaceProposalInput {
  readonly name: string;
  readonly soul: string;
  readonly brief: string;
}

export interface WorkspaceProposal extends WorkspaceProposalInput {
  readonly id: string;
  readonly status: WorkspaceProposalStatus;
  readonly requestedAt: number;
  readonly decidedAt: number | null;
}

/** The owner's decision as `decide` answers it; none of it is stored, since the row goes once it settles. */
export interface WorkspaceProposalDecision extends Omit<WorkspaceProposal, 'status'> {
  readonly status: 'declined' | 'created' | 'failed';
  /** The created workspace's address. */
  readonly workspace: string | null;
  readonly error: string | null;
}

/** What the call answers: nothing exists yet, and the decision wakes the agent. */
export interface WorkspaceProposalReceipt {
  readonly status: 'pending';
  readonly proposal: string;
  readonly note: string;
}

/** The SOUL.md the new workspace starts with, exactly as the owner reads it before approving. */
export function proposedSoul(input: WorkspaceProposalInput): string {
  const head = renderSoulMarkdown({ name: input.name, mission: input.brief });
  const body = input.soul.trim();

  return body === '' ? head : `${head}\n\n${body}`;
}

export function initWorkspaceProposalsTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS workspace_proposals (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    soul          TEXT NOT NULL,
    brief         TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    requested_at  INTEGER NOT NULL,
    decided_at    INTEGER
  )`);
}

interface ProposalRow {
  id: string;
  name: string;
  soul: string;
  brief: string;
  status: WorkspaceProposalStatus;
  requested_at: number;
  decided_at: number | null;
}

function toProposal(row: ProposalRow): WorkspaceProposal {
  return {
    id: row.id, name: row.name, soul: row.soul, brief: row.brief, status: row.status,
    requestedAt: row.requested_at, decidedAt: row.decided_at,
  };
}

/** Rows in `workspace_proposals`. */
export class WorkspaceProposalStore {
  constructor(private readonly sql: SqlExecutor) {}

  /** What waits on the owner, oldest first: a pending ask, or a create an eviction cut short. */
  open(): WorkspaceProposal[] {
    return this.sql<ProposalRow>`
      SELECT id, name, soul, brief, status, requested_at, decided_at
      FROM workspace_proposals ORDER BY requested_at ASC, rowid ASC`.map(toProposal);
  }

  insert(proposal: WorkspaceProposal): void {
    void this.sql`INSERT INTO workspace_proposals (id, name, soul, brief, status, requested_at)
      VALUES (${proposal.id}, ${proposal.name}, ${proposal.soul}, ${proposal.brief}, 'pending', ${proposal.requestedAt})`;
    markStoreChanged(this.sql);
  }

  /** Moves an open row to `creating`; null when there is none, so one decision creates once. */
  take(id: string, now: number): WorkspaceProposal | null {
    const rows = this.sql<ProposalRow>`
      UPDATE workspace_proposals SET status = 'creating', decided_at = ${now}
      WHERE id = ${id}
      RETURNING id, name, soul, brief, status, requested_at, decided_at`;

    if (rows.length > 0) markStoreChanged(this.sql);

    return rows[0] === undefined ? null : toProposal(rows[0]);
  }

  /** A decided proposal leaves the queue; its outcome is the decision's answer and the agent's wake, never a row. */
  settle(id: string): void {
    void this.sql`DELETE FROM workspace_proposals WHERE id = ${id}`;
    markStoreChanged(this.sql);
  }
}

export interface WorkspaceProposalDeps {
  readonly store: WorkspaceProposalStore;
  newId(): string;
  now(): number;
  /** Creates the workspace through the account's one creation path; answers its address. */
  create(input: { readonly displayName: string; readonly purpose: string; readonly soul: string }): Promise<{ readonly name: string }>;
  /** The page a workspace opens at. */
  link(workspace: string): string;
  /** The agent's inbox: the decision is delivered as a wake. */
  readonly inbox: Pick<AgentInbox, 'send'>;
  /** Told after every change to the queue, so the owner's page re-reads it. */
  announce(): void;
}

/** The ask, and the owner's decision on it. */
export class WorkspaceProposals {
  /** Creates in flight in this activation; a `creating` row not among them was cut short by an eviction. */
  private readonly creating = new Set<string>();

  constructor(private readonly deps: WorkspaceProposalDeps) {}

  open(): WorkspaceProposal[] {
    return this.deps.store.open().filter((proposal) => !this.creating.has(proposal.id));
  }

  propose(input: WorkspaceProposalInput): Effect.Effect<WorkspaceProposalReceipt, KinuError> {
    const deps = this.deps;

    return Effect.gen(function* () {
      const name = input.name.trim().replace(/\s+/g, ' ');

      if (name === '' || name.length > WORKSPACE_PROPOSAL_NAME_MAX) {
        return yield* new KinuError('bad_input', `a workspace's name is one line of at most ${String(WORKSPACE_PROPOSAL_NAME_MAX)} characters`);
      }

      if (input.brief.trim() === '') return yield* new KinuError('bad_input', 'the brief says what the new workspace is for; it is its mission');
      const id = deps.newId();

      deps.store.insert({
        id, name, soul: input.soul.trim(), brief: input.brief.trim(), status: 'pending',
        requestedAt: deps.now(), decidedAt: null,
      });
      deps.announce();

      return {
        status: 'pending' as const,
        proposal: id,
        note: `Nothing is created yet: "${name}" waits for your owner's approval in the Work tab. The decision wakes you, `
          + 'with the new workspace\'s link when it is approved.',
      };
    });
  }

  /** One decision per proposal: a second answer, or one for a proposal already settled, decides nothing. */
  decide(id: string, answer: WorkspaceProposalAnswer): Effect.Effect<WorkspaceProposalDecision | null, KinuError> {
    const deps = this.deps;
    const creating = this.creating;

    return Effect.gen(function* () {
      if (creating.has(id)) return null;
      const taken = deps.store.take(id, deps.now());

      if (taken === null) return null;

      if (answer === 'decline') {
        deps.store.settle(id);
        deps.announce();
        yield* Effect.promise(() => deps.inbox.send({
          kind: WORKSPACE_PROPOSAL_SIGNAL,
          text: `Your owner declined the workspace you proposed, "${taken.name}". Nothing was created.`,
          metadata: { proposal: id, decision: 'declined', name: taken.name },
        }));

        return { ...taken, status: 'declined' as const, workspace: null, error: null };
      }

      creating.add(id);
      deps.announce();

      const created = yield* Effect.exit(attempt({ doing: `creating the workspace "${taken.name}"`, otherwise: 'unavailable' },
        () => deps.create({ displayName: taken.name, purpose: taken.brief, soul: proposedSoul(taken) })));

      creating.delete(id);

      if (Exit.isFailure(created)) {
        const error = renderThrownChain({ cause: Cause.squash(created.cause) });

        deps.store.settle(id);
        deps.announce();
        yield* Effect.promise(() => deps.inbox.send({
          kind: WORKSPACE_PROPOSAL_SIGNAL,
          text: `Your owner approved the workspace "${taken.name}", but creating it failed: ${error}. Nothing was created.`,
          metadata: { proposal: id, decision: 'failed', name: taken.name },
        }));

        return { ...taken, status: 'failed' as const, workspace: null, error };
      }

      const workspace = created.value.name;
      const url = deps.link(workspace);

      deps.store.settle(id);
      deps.announce();
      yield* Effect.promise(() => deps.inbox.send({
        kind: WORKSPACE_PROPOSAL_SIGNAL,
        text: `Your owner approved the workspace "${taken.name}". It exists now, and its first turn acts on the brief. Its link: ${url}`,
        metadata: { proposal: id, decision: 'created', name: taken.name, workspace, url },
      }));

      return { ...taken, status: 'created' as const, workspace, error: null };
    });
  }
}
