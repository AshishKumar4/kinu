/**
 * Workspaces an agent creates in its owner's account. Creating, starting and steering the owner's own workspaces is
 * the agent's to do without asking (the owner, 2026-10-19: no asking for what stays inside their Kinu); each one it
 * makes is kept here, so the Changelog says what was made, by which agent, and where it is. Creation itself is the
 * host's: one call into the same path `POST /api/user/workspaces` takes.
 */
import { markStoreChanged } from '@kinu.run/agent-utils';
import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { attempt } from '../obs/effect';
import { renderSoulMarkdown } from './soul';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';

/** The display name's longest form: a title, never a paragraph. */
const AGENT_WORKSPACE_NAME_MAX = 80;

/** What the agent asks for: `name` titles the workspace, `brief` is its mission, `soul` the rest of its SOUL.md. */
export interface AgentWorkspaceInput {
  readonly name: string;
  readonly soul: string;
  readonly brief: string;
}

/** One workspace an agent made, as the ledger keeps it. */
export interface AgentWorkspace {
  readonly actorId: string;
  /** Its address. */
  readonly workspace: string;
  readonly name: string;
  readonly brief: string;
  readonly createdAt: number;
}

/** What `agent.createWorkspace` answers: the workspace exists, and where. */
export interface AgentWorkspaceReceipt {
  readonly workspace: string;
  readonly url: string;
}

/** The SOUL.md the new workspace starts with. */
function agentWorkspaceSoul(input: AgentWorkspaceInput): string {
  const head = renderSoulMarkdown({ name: input.name, mission: input.brief });
  const body = input.soul.trim();

  return body === '' ? head : `${head}\n\n${body}`;
}

export function initAgentWorkspacesTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS agent_workspaces (
    actor_id    TEXT NOT NULL,
    workspace   TEXT NOT NULL,
    name        TEXT NOT NULL,
    brief       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (actor_id, workspace)
  )`);
}

interface AgentWorkspaceRow {
  actor_id: string;
  workspace: string;
  name: string;
  brief: string;
  created_at: number;
}

/** Rows in `agent_workspaces`. */
export class AgentWorkspaceStore {
  constructor(private readonly sql: SqlExecutor) {}

  record(row: AgentWorkspace): void {
    void this.sql`INSERT OR IGNORE INTO agent_workspaces (actor_id, workspace, name, brief, created_at)
      VALUES (${row.actorId}, ${row.workspace}, ${row.name}, ${row.brief}, ${row.createdAt})`;
    markStoreChanged(this.sql);
  }

  /** What `actorId` made, newest first. */
  madeBy(actorId: string, limit: number): AgentWorkspace[] {
    return this.sql<AgentWorkspaceRow>`
      SELECT actor_id, workspace, name, brief, created_at FROM agent_workspaces
      WHERE actor_id = ${actorId} ORDER BY created_at DESC, workspace ASC LIMIT ${limit}`
      .map((row) => ({ actorId: row.actor_id, workspace: row.workspace, name: row.name, brief: row.brief, createdAt: row.created_at }));
  }
}

export interface AgentWorkspaceDeps {
  /** Creates the workspace through the account's one creation path; answers its address. */
  create(input: { readonly displayName: string; readonly purpose: string; readonly soul: string }): Promise<{ readonly name: string }>;
  /** Keeps what was made, in the ledger and Activity. */
  made(input: { readonly workspace: string; readonly name: string; readonly brief: string }): void;
  /** The page a workspace opens at. */
  link(workspace: string): string;
}

/** A new workspace in the owner's account, created now: its first turn acts on the brief. */
export function createAgentWorkspace(deps: AgentWorkspaceDeps, input: AgentWorkspaceInput): Effect.Effect<AgentWorkspaceReceipt, KinuError> {
  return Effect.gen(function* () {
    const name = input.name.trim().replace(/\s+/g, ' ');
    const brief = input.brief.trim();

    if (name === '' || name.length > AGENT_WORKSPACE_NAME_MAX) {
      return yield* new KinuError('bad_input', `a workspace's name is one line of at most ${String(AGENT_WORKSPACE_NAME_MAX)} characters`);
    }

    if (brief === '') return yield* new KinuError('bad_input', 'the brief says what the new workspace is for; it is its mission');

    const created = yield* attempt({ doing: `creating the workspace "${name}"`, otherwise: 'unavailable' },
      () => deps.create({ displayName: name, purpose: brief, soul: agentWorkspaceSoul({ name, brief, soul: input.soul }) }));

    deps.made({ workspace: created.name, name, brief });

    return { workspace: created.name, url: deps.link(created.name) };
  });
}
