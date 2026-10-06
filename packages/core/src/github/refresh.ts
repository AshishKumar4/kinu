/** What GitHub says now, read with the account's token when the overview opens. Nothing polls. */
import { Effect } from 'effect';
import * as v from 'valibot';
import { attempt } from '../obs/effect';
import { diagnostics } from '../obs/log';
import type { GitHubCi, GitHubObservation, WorkspaceGitHub } from './activity';

/** Recent subjects only: one opening costs few requests. */
const ITEM_LIMIT = 20;

const REPO_LIMIT = 10;

const READ_CONCURRENCY = 6;

export type GitHubRefreshOutcome = 'refreshed' | 'denied' | 'unreachable';

/** What the overview reads: the record, and whether this reading asked GitHub first. */
export interface WorkspaceGitHubView extends WorkspaceGitHub {
  /** `skipped`: not asked to; `no-token`: the account holds no GitHub token, so the record is as last seen. */
  readonly refresh: 'skipped' | 'no-token' | GitHubRefreshOutcome;
}

export interface GitHubRefresh {
  readonly observed: readonly GitHubObservation[];
  /** `denied`: GitHub refused the token; `unreachable`: no read got an answer. */
  readonly outcome: GitHubRefreshOutcome;
}

type Read = { readonly status: number; readonly body: string } | { readonly unreachable: true };

const Issue = v.looseObject({ title: v.string(), state: v.string() });

const Pull = v.looseObject({ merged_at: v.nullable(v.string()) });

const Repository = v.looseObject({ default_branch: v.string() });

const CheckRuns = v.looseObject({
  total_count: v.number(),
  check_runs: v.array(v.looseObject({ status: v.string(), conclusion: v.nullable(v.string()) })),
});

const CombinedStatus = v.looseObject({ state: v.string(), total_count: v.number() });

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

/** Check runs first, else commit statuses; no checks at all is `none`. */
function ciOf(runs: Read, status: Read): GitHubCi | null {
  const checks = parsedFrom(CheckRuns, runs);
  const combined = parsedFrom(CombinedStatus, status);

  if (checks.success && checks.output.total_count > 0) {
    const all = checks.output.check_runs;

    if (all.some((run) => run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion))) return 'failure';

    return all.some((run) => run.status !== 'completed') ? 'pending' : 'success';
  }

  if (combined.success && combined.output.total_count > 0) {
    if (combined.output.state === 'success') return 'success';

    return combined.output.state === 'pending' ? 'pending' : 'failure';
  }

  return checks.success || combined.success ? 'none' : null;
}

/** A 2xx answer's JSON, read through `schema`; anything else fails the parse. */
function parsedFrom<TOutput>(schema: v.GenericSchema<unknown, TOutput>, read: Read): v.SafeParseResult<v.GenericSchema<string, TOutput>> {
  const body = 'status' in read && read.status >= 200 && read.status < 300 ? read.body : undefined;

  return v.safeParse(v.pipe(v.string(), v.parseJson(), schema), body);
}

const stateOf = (merged: boolean, issueState: string): 'merged' | 'closed' | 'open' => {
  if (merged) return 'merged';

  return issueState === 'closed' ? 'closed' : 'open';
};

export function refreshGitHub(input: {
  readonly authorization: string;
  readonly activity: WorkspaceGitHub;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
}): Effect.Effect<GitHubRefresh> {
  const headers = {
    authorization: input.authorization, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Kinu',
  };

  const read = (path: string): Effect.Effect<Read> => attempt({ doing: `reading ${path} from GitHub`, otherwise: 'unavailable' }, async () => {
    const response = await input.fetch(`https://api.github.com${path}`, { headers });

    return { status: response.status, body: response.ok ? await response.text() : '' };
  }).pipe(Effect.catch((failed) => Effect.sync((): Read => {
    diagnostics.failure('github.read_failed', failed);

    return { unreachable: true };
  })));

  interface Done { readonly answers: readonly Read[]; readonly observed: readonly GitHubObservation[] }

  const items = input.activity.items.slice(0, ITEM_LIMIT).map((item): Effect.Effect<Done> => Effect.gen(function* () {
    const answer = yield* read(`/repos/${item.repo}/issues/${String(item.number)}`);
    const issue = parsedFrom(Issue, answer);

    if (!issue.success) return { answers: [answer], observed: [] };
    const seen = { subject: item.subject, repo: item.repo, number: item.number, title: issue.output.title };

    if (item.subject === 'issue') return { answers: [answer], observed: [{ ...seen, state: issue.output.state === 'closed' ? 'closed' : 'open' }] };

    // An issue read says a pull request is closed; only the pull request says whether it merged.
    const pullAnswer = yield* read(`/repos/${item.repo}/pulls/${String(item.number)}`);
    const pull = parsedFrom(Pull, pullAnswer);
    const merged = pull.success && pull.output.merged_at !== null;

    return { answers: [answer, pullAnswer], observed: [{ ...seen, state: stateOf(merged, issue.output.state) }] };
  }));

  const repos = input.activity.repos.slice(0, REPO_LIMIT).map((repo): Effect.Effect<Done> => Effect.gen(function* () {
    const answers: Read[] = [];
    let branch = repo.branch;

    if (branch === null) {
      const about = yield* read(`/repos/${repo.repo}`);
      answers.push(about);
      const parsed = parsedFrom(Repository, about);

      if (!parsed.success) return { answers, observed: [] };
      branch = parsed.output.default_branch;
    }

    const ref = encodeURIComponent(branch);
    const [runs, status] = yield* Effect.all([read(`/repos/${repo.repo}/commits/${ref}/check-runs?per_page=100`), read(`/repos/${repo.repo}/commits/${ref}/status`)]);
    const ci = ciOf(runs, status);

    return { answers: [...answers, runs, status], observed: ci === null ? [] : [{ subject: 'repo', repo: repo.repo, ref: branch, ci }] };
  }));

  return Effect.all([...items, ...repos], { concurrency: READ_CONCURRENCY }).pipe(Effect.map((done): GitHubRefresh => {
    const answers = done.flatMap((one) => one.answers);
    const observed = done.flatMap((one) => one.observed);

    if (answers.some((answer) => 'status' in answer && answer.status === 401)) return { observed, outcome: 'denied' };

    return { observed, outcome: answers.length > 0 && answers.every((answer) => 'unreachable' in answer) ? 'unreachable' : 'refreshed' };
  }));
}
