/** The workspace's GitHub record, one row per fact; a refresh appends `observed` rows, and the newest word wins. */
import * as v from 'valibot';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { GitHubFact } from './recognize';

/** `observed`: a refresh's reading of GitHub, not anything an agent did. */
export type GitHubSource = 'egress' | 'mcp' | 'refresh';

export function initGitHubActivityTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS github_activity (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        INTEGER NOT NULL,
    actor_id  TEXT,
    source    TEXT NOT NULL,
    action    TEXT NOT NULL,
    subject   TEXT NOT NULL,
    repo      TEXT NOT NULL,
    number    INTEGER,
    url       TEXT,
    title     TEXT,
    ref       TEXT,
    state     TEXT,
    ci        TEXT
  )`);
}

/** `actorId` null: the seam could not say which agent acted, and nothing guesses for it. */
export function recordGitHubActivity(
  sql: SqlExecutor,
  facts: readonly GitHubFact[],
  origin: { readonly actorId: string | null; readonly source: GitHubSource; readonly at: number },
): void {
  for (const fact of facts) {
    void sql`INSERT INTO github_activity (at, actor_id, source, action, subject, repo, number, url, title, ref, state)
      VALUES (${origin.at}, ${origin.actorId}, ${origin.source}, ${fact.action}, ${fact.subject}, ${fact.repo},
        ${fact.number ?? null}, ${fact.url ?? null}, ${fact.title ?? null}, ${fact.ref ?? null}, ${fact.state ?? null})`;
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
    void sql`INSERT INTO github_activity (at, actor_id, source, action, subject, repo, number, title, ref, state, ci)
      VALUES (${at}, NULL, 'refresh', 'observed', ${one.subject}, ${one.repo}, ${one.number ?? null}, ${one.title ?? null},
        ${one.ref ?? null}, ${one.state ?? null}, ${one.ci ?? null})`;
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

interface Row {
  readonly at: number;
  readonly actorId: string | null;
  readonly source: GitHubSource;
  readonly action: string;
  readonly subject: string;
  readonly repo: string;
  readonly number: number | null;
  readonly url: string | null;
  readonly title: string | null;
  readonly ref: string | null;
  readonly state: string | null;
  readonly ci: string | null;
}

/** The newest rows only, so the fold stays bounded. */
const READ_LIMIT = 2000;


/** `remotes`: the `owner/name` of each of the workspace's git remotes on github.com. */
export function readGitHubActivity(sql: SqlExecutor, remotes: readonly string[]): WorkspaceGitHub {
  const rows = sql<Row>`SELECT at, actor_id AS actorId, source, action, subject, repo, number, url, title, ref, state, ci
    FROM (SELECT * FROM github_activity ORDER BY id DESC LIMIT ${READ_LIMIT}) ORDER BY id`;

  const items = new Map<string, { -readonly [K in keyof GitHubItem]: GitHubItem[K] }>();
  const repos = new Map<string, { -readonly [K in keyof GitHubRepo]: GitHubRepo[K] } & { observedBranch: string | null }>();
  let observedAt: number | null = null;

  const repoOf = (repo: string) => {
    let entry = repos.get(repo);

    if (entry === undefined) {
      entry = { repo, remote: false, lastPush: null, fetchedAt: null, branch: null, ci: null, observedBranch: null };
      repos.set(repo, entry);
    }

    return entry;
  };

  for (const repo of remotes) repoOf(repo).remote = true;

  for (const row of rows) {
    const observed = row.action === 'observed';

    if (observed) observedAt = Math.max(observedAt ?? 0, row.at);

    if (row.subject === 'repo') {
      const entry = repoOf(row.repo);

      if (row.action === 'pushed' && row.ref !== null) entry.lastPush = { ref: row.ref, at: row.at };

      if (row.action === 'fetched') entry.fetchedAt = row.at;

      if (observed && row.ref !== null) entry.observedBranch = row.ref;

      if (observed && v.is(CiSchema, row.ci)) entry.ci = { state: row.ci, at: row.at };
      continue;
    }

    if ((row.subject !== 'issue' && row.subject !== 'pr') || row.number === null) continue;

    const key = `${row.repo}#${String(row.number)}`;

    const item = items.get(key) ?? {
      subject: row.subject, repo: row.repo, number: row.number, title: null, state: null, actors: [], unattributed: false, lastAt: row.at,
      url: `https://github.com/${row.repo}/${row.subject === 'pr' ? 'pull' : 'issues'}/${String(row.number)}`,
    };

    items.set(key, {
      ...item,
      title: row.title ?? item.title,
      url: row.url ?? item.url,
      state: row.state ?? item.state,
      actors: row.actorId === null || item.actors.includes(row.actorId) ? item.actors : [...item.actors, row.actorId],
      unattributed: item.unattributed || (!observed && row.actorId === null),
      lastAt: observed ? item.lastAt : row.at,
    });
    repoOf(row.repo);
  }

  return {
    repos: [...repos.values()].map(({ observedBranch, ...repo }) => ({ ...repo, branch: repo.lastPush?.ref ?? observedBranch })),
    items: [...items.values()].sort((a, b) => b.lastAt - a.lastAt),
    observedAt,
  };
}
