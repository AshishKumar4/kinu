/** One row per GitHub subject, each fact folded in. */
import * as v from 'valibot';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { GitHubFact, GitHubSubjectFact } from './recognize';

export type GitHubSource = 'egress' | 'mcp' | 'refresh';

export function initGitHubActivityTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS github_items (
    repo         TEXT NOT NULL,
    number       INTEGER NOT NULL,
    subject      TEXT NOT NULL,
    title        TEXT,
    url          TEXT,
    state        TEXT,
    actors       TEXT NOT NULL,
    unattributed INTEGER NOT NULL,
    last_at      INTEGER NOT NULL,
    observed_at  INTEGER,
    PRIMARY KEY (repo, number)
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS github_repos (
    repo            TEXT PRIMARY KEY,
    push_ref        TEXT,
    push_at         INTEGER,
    fetched_at      INTEGER,
    observed_branch TEXT,
    ci              TEXT,
    ci_at           INTEGER,
    observed_at     INTEGER
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS github_nodes (
    node_id TEXT PRIMARY KEY,
    repo    TEXT NOT NULL,
    subject TEXT NOT NULL,
    number  INTEGER NOT NULL,
    at      INTEGER NOT NULL
  )`);
}

const NODE_LIMIT = 500;

interface ItemRow {
  readonly subject: string;
  readonly title: string | null;
  readonly url: string | null;
  readonly state: string | null;
  readonly actors: string;
  readonly unattributed: number;
  readonly lastAt: number;
}

const Actors = v.pipe(v.string(), v.parseJson(), v.array(v.string()));

function resolved(sql: SqlExecutor, fact: GitHubFact): GitHubSubjectFact | null {
  if ('repo' in fact) return fact;
  const [named] = sql<{ repo: string; number: number }>`SELECT repo, number FROM github_nodes WHERE node_id = ${fact.node}`;

  return named === undefined ? null : { action: fact.action, subject: fact.subject, repo: named.repo, number: named.number, ...(fact.state !== undefined && { state: fact.state }) };
}

function recordItem(sql: SqlExecutor, fact: GitHubSubjectFact & { readonly number: number }, actorId: string | null, at: number): void {
  const [held] = sql<ItemRow>`SELECT subject, title, url, state, actors, unattributed, last_at AS lastAt FROM github_items
    WHERE repo = ${fact.repo} AND number = ${fact.number}`;

  const before = v.safeParse(Actors, held?.actors);
  const actors = before.success ? before.output : [];
  const after = actorId === null || actors.includes(actorId) ? actors : [...actors, actorId];

  void sql`INSERT OR REPLACE INTO github_items (repo, number, subject, title, url, state, actors, unattributed, last_at, observed_at)
    VALUES (${fact.repo}, ${fact.number}, ${held?.subject ?? fact.subject}, ${fact.title ?? held?.title ?? null}, ${fact.url ?? held?.url ?? null},
      ${fact.state ?? held?.state ?? null}, ${JSON.stringify(after)}, ${actorId === null || held?.unattributed === 1 ? 1 : 0}, ${at},
      (SELECT observed_at FROM github_items WHERE repo = ${fact.repo} AND number = ${fact.number}))`;
  void sql`INSERT OR IGNORE INTO github_repos (repo) VALUES (${fact.repo})`;
}

/** `actorId` null: the seam could not say which agent acted, and nothing guesses for it. */
export function recordGitHubActivity(
  sql: SqlExecutor,
  facts: readonly GitHubFact[],
  origin: { readonly actorId: string | null; readonly source: GitHubSource; readonly at: number },
): void {
  for (const each of facts) {
    if (each.action === 'identified') {
      if ('repo' in each && each.node !== undefined && each.number !== undefined && each.subject !== 'repo') {
        void sql`INSERT OR REPLACE INTO github_nodes (node_id, repo, subject, number, at) VALUES (${each.node}, ${each.repo}, ${each.subject}, ${each.number}, ${origin.at})`;
        void sql`DELETE FROM github_nodes WHERE node_id NOT IN (SELECT node_id FROM github_nodes ORDER BY at DESC LIMIT ${NODE_LIMIT})`;
      }

      continue;
    }

    const fact = resolved(sql, each);

    if (fact === null) continue;

    if (fact.subject === 'repo') {
      void sql`INSERT OR IGNORE INTO github_repos (repo) VALUES (${fact.repo})`;

      if (fact.action === 'pushed' && fact.ref !== undefined) void sql`UPDATE github_repos SET push_ref = ${fact.ref}, push_at = ${origin.at} WHERE repo = ${fact.repo}`;

      if (fact.action === 'fetched') void sql`UPDATE github_repos SET fetched_at = ${origin.at} WHERE repo = ${fact.repo}`;
      continue;
    }

    if (fact.number !== undefined) recordItem(sql, { ...fact, number: fact.number }, origin.actorId, origin.at);
  }
}

/** An issue's or pull request's state now, or a branch's CI. */
export interface GitHubObservation {
  readonly subject: 'issue' | 'pr' | 'repo';
  readonly repo: string;
  readonly number?: number;
  readonly title?: string;
  readonly state?: string;
  readonly ref?: string;
  readonly ci?: GitHubCi;
}

const CiSchema = v.picklist(['success', 'failure', 'pending', 'none']);

/** Check runs folded to one word: any failure fails, any still running is pending. */
export type GitHubCi = v.InferOutput<typeof CiSchema>;

export function recordGitHubObservations(sql: SqlExecutor, observed: readonly GitHubObservation[], at: number): void {
  for (const one of observed) {
    if (one.subject === 'repo') {
      void sql`INSERT OR IGNORE INTO github_repos (repo) VALUES (${one.repo})`;
      void sql`UPDATE github_repos SET observed_at = ${at}, observed_branch = COALESCE(${one.ref ?? null}, observed_branch),
        ci = COALESCE(${one.ci ?? null}, ci), ci_at = CASE WHEN ${one.ci ?? null} IS NULL THEN ci_at ELSE ${at} END WHERE repo = ${one.repo}`;
    } else if (one.number !== undefined) {
      void sql`UPDATE github_items SET observed_at = ${at}, title = COALESCE(${one.title ?? null}, title), state = COALESCE(${one.state ?? null}, state)
        WHERE repo = ${one.repo} AND number = ${one.number}`;
    }
  }
}

export interface GitHubItem {
  readonly subject: 'issue' | 'pr';
  readonly repo: string;
  readonly number: number;
  readonly title: string | null;
  readonly url: string;
  /** open, closed or merged; null until GitHub said. */
  readonly state: string | null;
  /** The agents that acted on it, first first. */
  readonly actors: readonly string[];
  /** Something on it came through a seam that cannot name its agent. */
  readonly unattributed: boolean;
  readonly lastAt: number;
}

export interface GitHubRepo {
  readonly repo: string;
  /** One of the workspace's git remotes. */
  readonly remote: boolean;
  readonly lastPush: { readonly ref: string; readonly at: number } | null;
  readonly fetchedAt: number | null;
  /** The branch shown: the last one pushed, else the one a refresh read. */
  readonly branch: string | null;
  readonly ci: { readonly state: GitHubCi; readonly at: number } | null;
}

export interface WorkspaceGitHub {
  readonly repos: readonly GitHubRepo[];
  readonly items: readonly GitHubItem[];
  /** When GitHub was last read for state; null when it never was. */
  readonly observedAt: number | null;
}

interface RepoRow {
  readonly repo: string;
  readonly pushRef: string | null;
  readonly pushAt: number | null;
  readonly fetchedAt: number | null;
  readonly observedBranch: string | null;
  readonly ci: string | null;
  readonly ciAt: number | null;
}

/** `remotes`: the `owner/name` of each of the workspace's git remotes on github.com. */
export function readGitHubActivity(sql: SqlExecutor, remotes: readonly string[]): WorkspaceGitHub {
  const items = sql<ItemRow & { repo: string; number: number }>`SELECT repo, number, subject, title, url, state, actors, unattributed, last_at AS lastAt
    FROM github_items ORDER BY last_at DESC, rowid DESC`;

  const rows = sql<RepoRow>`SELECT repo, push_ref AS pushRef, push_at AS pushAt, fetched_at AS fetchedAt, observed_branch AS observedBranch, ci, ci_at AS ciAt
    FROM github_repos ORDER BY rowid`;

  const [seen] = sql<{ at: number | null }>`SELECT MAX(at) AS at FROM (SELECT MAX(observed_at) AS at FROM github_items UNION ALL SELECT MAX(observed_at) FROM github_repos)`;

  const held = new Map(rows.map((row) => [row.repo, row]));

  const ordered = [...remotes.map((repo): RepoRow => held.get(repo) ?? {
    repo, pushRef: null, pushAt: null, fetchedAt: null, observedBranch: null, ci: null, ciAt: null,
  }), ...rows.filter((row) => !remotes.includes(row.repo))];

  const repos: GitHubRepo[] = ordered.map((row) => ({
    repo: row.repo,
    remote: remotes.includes(row.repo),
    lastPush: row.pushRef === null || row.pushAt === null ? null : { ref: row.pushRef, at: row.pushAt },
    fetchedAt: row.fetchedAt,
    branch: row.pushRef ?? row.observedBranch,
    ci: v.is(CiSchema, row.ci) && row.ciAt !== null ? { state: row.ci, at: row.ciAt } : null,
  }));

  return {
    repos,
    items: items.flatMap((row): GitHubItem[] => {
      const actors = v.safeParse(Actors, row.actors);

      if (row.subject !== 'issue' && row.subject !== 'pr') return [];

      return [{
        subject: row.subject, repo: row.repo, number: row.number, title: row.title, state: row.state,
        url: row.url ?? `https://github.com/${row.repo}/${row.subject === 'pr' ? 'pull' : 'issues'}/${String(row.number)}`,
        actors: actors.success ? actors.output : [], unattributed: row.unattributed === 1, lastAt: row.lastAt,
      }];
    }),
    observedAt: seen?.at ?? null,
  };
}
