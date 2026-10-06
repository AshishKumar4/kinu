/** What an agent did on GitHub, from a write GitHub answered with success, by egress or MCP alike. A read, a refusal or another host is nothing. */
import * as v from 'valibot';
import type { McpPresetId } from '../mcp/presets';
import { isJsonObject, JsonObjectSchema, type JsonObject, type JsonValue } from '../utils/json';

/** github/github-mcp-server: the only MCP calls read as GitHub work. */
export const GITHUB_MCP_PRESET = 'github' satisfies McpPresetId;

/** `identified`: a lookup named a node id, for a later write by id alone. */
export type GitHubAction = 'opened' | 'touched' | 'closed' | 'merged' | 'pushed' | 'fetched' | 'identified';

export type GitHubSubject = 'issue' | 'pr' | 'repo';

export interface GitHubSubjectFact {
  readonly action: GitHubAction;
  readonly subject: GitHubSubject;
  /** `owner/name`. */
  readonly repo: string;
  readonly number?: number;
  /** The issue's or pull request's own page. */
  readonly url?: string;
  readonly title?: string;
  /** A branch: the one pushed, or a pull request's head. */
  readonly ref?: string;
  readonly state?: string;
  readonly node?: string;
}

/** A write answered with a node id only. */
export interface GitHubNodeFact {
  readonly action: GitHubAction;
  readonly subject: 'issue' | 'pr';
  readonly node: string;
  readonly state?: string;
}

export type GitHubFact = GitHubSubjectFact | GitHubNodeFact;

const ACTIONS = ['opened', 'touched', 'closed', 'merged', 'pushed', 'fetched', 'identified'] as const;

/** Parsed again at the workspace object, never trusted as typed. */
export const GitHubFactSchema = v.union([
  v.object({
    action: v.picklist(ACTIONS),
    subject: v.picklist(['issue', 'pr', 'repo']),
    repo: v.pipe(v.string(), v.regex(/^[^/\s]+\/[^/\s]+$/u)),
    number: v.optional(v.pipe(v.number(), v.integer())),
    url: v.optional(v.string()),
    title: v.optional(v.string()),
    ref: v.optional(v.string()),
    state: v.optional(v.string()),
    node: v.optional(v.string()),
  }),
  v.object({ action: v.picklist(ACTIONS), subject: v.picklist(['issue', 'pr']), node: v.string(), state: v.optional(v.string()) }),
]) satisfies v.GenericSchema<unknown, GitHubFact>;

export interface GitHubHttpRequest {
  readonly method: string;
  readonly url: string;
  /** Read only where the answer does not say it all: a GraphQL mutation's title and branch. */
  readonly body?: string;
}

export interface GitHubHttpResponse {
  readonly status: number;
  /** As much of the answer as the seam read: a write's JSON, or a push's report. */
  readonly body?: string;
}

interface Page {
  readonly repo: string;
  readonly subject: 'issue' | 'pr';
  readonly number: number;
  /** Without a fragment: a comment's link is not its issue's page. */
  readonly url: string | undefined;
}

const PAGE = /^https:\/\/github\.com\/([^/\s]+)\/([^/#?\s]+)\/(issues|pull)\/(\d+)(#\S*)?$/u;

function pageOf(url: string | undefined): Page | null {
  const match = url === undefined ? null : PAGE.exec(url);

  if (match === null) return null;
  const [, owner = '', name = '', kind, number = '0', fragment] = match;

  return {
    repo: `${owner}/${name}`, subject: kind === 'pull' ? 'pr' : 'issue', number: Number(number),
    url: fragment === undefined ? `https://github.com/${owner}/${name}/${kind ?? ''}/${number}` : undefined,
  };
}

type FactFields = Pick<GitHubSubjectFact, 'action' | 'subject' | 'repo'> & {
  readonly [K in Exclude<keyof GitHubSubjectFact, 'action' | 'subject' | 'repo'>]?: GitHubSubjectFact[K] | undefined
};

/** Drops absent fields, so a fact holds only what GitHub said. */
function fact({ action, subject, repo, number, url, title, ref, state, node }: FactFields): GitHubSubjectFact {
  return {
    action, subject, repo,
    ...(number !== undefined && { number }), ...(url !== undefined && { url }), ...(title !== undefined && { title }),
    ...(ref !== undefined && { ref }), ...(state !== undefined && { state }), ...(node !== undefined && { node }),
  };
}

const Answer = v.looseObject({
  number: v.optional(v.number()),
  html_url: v.optional(v.string()),
  url: v.optional(v.string()),
  title: v.optional(v.string()),
  state: v.optional(v.string()),
  merged: v.optional(v.boolean()),
  head: v.optional(v.looseObject({ ref: v.optional(v.string()) })),
});

type Answer = v.InferOutput<typeof Answer>;

/** Null for text that is not such JSON, as a body cut short at the limit. */
function answerOf(text: string | undefined): Answer | null {
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), Answer), text);

  return parsed.success ? parsed.output : null;
}

/** The subject the answer describes, when it is an issue's or pull request's page. */
function described(answer: Answer, repo: string, subject: 'issue' | 'pr', number: number | undefined) {
  const page = pageOf(answer.html_url) ?? pageOf(answer.url);

  return {
    repo: page?.repo ?? repo, subject: page?.subject ?? subject, number: answer.number ?? page?.number ?? number,
    url: page?.url, title: answer.title, state: answer.state,
  };
}

const REST = /^\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)(?:\/(\d+)(?:\/([a-z_]+))?)?$/u;

/** Writes on api.github.com's REST surface: create, edit, comment, review, merge. */
function restFacts(method: string, path: string, answer: Answer): GitHubFact[] {
  const match = REST.exec(path);

  if (match === null) return [];
  const [, owner = '', name = '', collection, numbered, sub] = match;
  const repo = `${owner}/${name}`;
  const subject = collection === 'pulls' ? 'pr' : 'issue';
  const number = numbered === undefined ? undefined : Number(numbered);

  if (number === undefined) {
    if (method !== 'POST') return [];

    return [fact({ action: 'opened', ...described(answer, repo, subject, undefined), ref: answer.head?.ref })];
  }

  if (sub === undefined) {
    if (method !== 'PATCH') return [];
    const changed = described(answer, repo, subject, number);

    return [fact({ action: changed.state === 'closed' ? 'closed' : 'touched', ...changed })];
  }

  if (sub === 'merge') return method === 'PUT' && answer.merged === true ? [fact({ action: 'merged', subject: 'pr', repo, number, state: 'merged' })] : [];

  if (method !== 'POST' || !['comments', 'reviews', 'requested_reviewers', 'labels', 'assignees'].includes(sub)) return [];

  // An issue comment on a pull request comes back with the pull request's page in its link.
  return [fact({ action: 'touched', subject: pageOf(answer.html_url)?.subject ?? subject, repo, number })];
}

/** What each `gh` mutation did, by name. */
const MUTATIONS = new Map<string, GitHubAction>([
  ['createIssue', 'opened'], ['createPullRequest', 'opened'], ['mergePullRequest', 'merged'],
  ['closeIssue', 'closed'], ['closePullRequest', 'closed'], ['reopenIssue', 'touched'], ['reopenPullRequest', 'touched'],
  ['updateIssue', 'touched'], ['updatePullRequest', 'touched'], ['addComment', 'touched'], ['addPullRequestReview', 'touched'],
]);

const GraphQlRequest = v.pipe(v.string(), v.parseJson(), v.looseObject({
  query: v.string(),
  variables: v.optional(v.looseObject({
    input: v.optional(v.looseObject({ title: v.optional(v.string()), headRefName: v.optional(v.string()) })),
  })),
}));

const GraphQlAnswer = v.pipe(v.string(), v.parseJson(), v.looseObject({ data: JsonObjectSchema }));

/** Its own `url` and `id` fields, never text inside a title. */
const GraphQlNode = v.looseObject({ id: v.optional(v.string()), url: v.optional(v.string()) });

const NodeOf = (field: string) => v.looseObject({ [field]: GraphQlNode });

const PAYLOAD_SUBJECT = [
  v.pipe(NodeOf('issue'), v.transform((payload) => ({ node: payload.issue, subject: 'issue' as const }))),
  v.pipe(NodeOf('pullRequest'), v.transform((payload) => ({ node: payload.pullRequest, subject: 'pr' as const }))),
  v.pipe(NodeOf('pullRequestReview'), v.transform((payload) => ({ node: payload.pullRequestReview, subject: 'pr' as const }))),
  v.pipe(v.looseObject({ commentEdge: v.looseObject({ node: GraphQlNode }) }), v.transform((payload) => ({ node: payload.commentEdge.node, subject: 'issue' as const }))),
];

function payloadSubject(payload: JsonValue) {
  for (const schema of PAYLOAD_SUBJECT) {
    const parsed = v.safeParse(schema, payload);

    if (parsed.success) return parsed.output;
  }

  return null;
}

function namedNodes(value: JsonValue, found: GitHubSubjectFact[] = []): GitHubSubjectFact[] {
  if (Array.isArray(value)) {
    for (const entry of value) namedNodes(entry, found);
  } else if (isJsonObject(value)) {
    const node = v.safeParse(GraphQlNode, value);
    const page = node.success ? pageOf(node.output.url) : null;

    if (node.success && node.output.id !== undefined && page?.url !== undefined) {
      found.push(fact({ action: 'identified', subject: page.subject, repo: page.repo, number: page.number, node: node.output.id }));
    }

    for (const entry of Object.values(value)) namedNodes(entry, found);
  }

  return found;
}

function mutationFact(action: GitHubAction, payload: JsonValue, input: v.InferOutput<typeof GraphQlRequest>['variables']): GitHubFact | null {
  const named = payloadSubject(payload);

  if (named === null) return null;
  const page = pageOf(named.node.url);
  const state = action === 'merged' || action === 'closed' ? action : undefined;

  if (page === null) {
    if (named.node.id === undefined || named.node.url !== undefined) return null;

    return { action, subject: named.subject, node: named.node.id, ...(state !== undefined && { state }) };
  }

  const opened = action === 'opened';

  return fact({
    action, subject: page.subject, repo: page.repo, number: page.number, url: page.url,
    title: opened ? input?.input?.title : undefined, ref: opened && page.subject === 'pr' ? input?.input?.headRefName : undefined,
    state,
  });
}

function graphQlFacts(request: string | undefined, answer: string | undefined): GitHubFact[] {
  const sent = v.safeParse(GraphQlRequest, request);
  const got = v.safeParse(GraphQlAnswer, answer);

  if (!sent.success || !got.success) return [];

  if (!/^\s*mutation\b/u.test(sent.output.query)) return namedNodes(got.output.data);

  return Object.entries(got.output.data).flatMap(([field, payload]) => {
    const action = MUTATIONS.get(field);
    const made = action === undefined ? null : mutationFact(action, payload, sent.output.variables);

    return made === null ? [] : [made];
  });
}

const GIT = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(git-receive-pack|git-upload-pack)$/u;

/**
 * The refs GitHub accepted, from the push's report-status: `ok <ref>`, one pkt-line each, inside side-band framing
 * when the client asked for it. A refused ref reads `ng <ref> <reason>` and is no push.
 */
function acceptedRefs(report: string): string[] {
  return [...report.matchAll(/[0-9a-f]{4}ok (refs\/[^\s\0]+)/gu)].map(([, ref = '']) => ref.replace(/^refs\/heads\//u, ''));
}

function gitFacts(path: string, request: GitHubHttpRequest, response: GitHubHttpResponse): GitHubFact[] {
  const match = GIT.exec(path);

  if (match === null || request.method !== 'POST') return [];
  const [, owner = '', name = '', service] = match;
  const repo = `${owner}/${name}`;

  if (service === 'git-upload-pack') return [fact({ action: 'fetched', subject: 'repo', repo })];

  return acceptedRefs(response.body ?? '').map((ref) => fact({ action: 'pushed', subject: 'repo', repo, ref }));
}

export function recognizeGitHubHttp(request: GitHubHttpRequest, response: GitHubHttpResponse): readonly GitHubFact[] {
  if (response.status < 200 || response.status >= 300 || !URL.canParse(request.url)) return [];
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (url.hostname === 'github.com') return gitFacts(url.pathname, { ...request, method }, response);

  if (url.hostname !== 'api.github.com' || method === 'GET' || method === 'HEAD') return [];

  if (url.pathname === '/graphql') return graphQlFacts(request.body, response.body);

  const answer = answerOf(response.body);

  return answer === null ? [] : restFacts(method, url.pathname, answer);
}

const McpArgs = v.looseObject({
  owner: v.optional(v.string()),
  repo: v.optional(v.string()),
  title: v.optional(v.string()),
  state: v.optional(v.string()),
  head: v.optional(v.string()),
  branch: v.optional(v.string()),
  method: v.optional(v.string()),
  issue_number: v.optional(v.union([v.number(), v.pipe(v.string(), v.transform(Number))])),
  pullNumber: v.optional(v.union([v.number(), v.pipe(v.string(), v.transform(Number))])),
});

const McpResult = v.pipe(v.string(), v.parseJson(), v.looseObject({
  isError: v.optional(v.boolean()),
  content: v.optional(v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()) }))),
}));

const numberOf = (value: number | undefined): number | undefined => (value !== undefined && Number.isInteger(value) ? value : undefined);

type McpTool = (args: v.InferOutput<typeof McpArgs>, repo: string, answer: Answer) => GitHubFact | null;

/** Each tool of github/github-mcp-server that changes GitHub, as the fact it makes. */
const MCP_TOOLS = new Map<string, McpTool>(Object.entries({
  create_issue: (args, repo, answer) => fact({ action: 'opened', ...described(answer, repo, 'issue', undefined), title: answer.title ?? args.title }),
  update_issue: (args, repo, answer) => edited(args, described(answer, repo, 'issue', numberOf(args.issue_number))),
  issue_write: (args, repo, answer) => (args.method === 'create'
    ? fact({ action: 'opened', ...described(answer, repo, 'issue', undefined), title: answer.title ?? args.title })
    : edited(args, described(answer, repo, 'issue', numberOf(args.issue_number)))),
  add_issue_comment: (args, repo, answer) => fact({
    action: 'touched', subject: pageOf(answer.html_url ?? answer.url)?.subject ?? 'issue', repo, number: numberOf(args.issue_number),
  }),
  create_pull_request: (args, repo, answer) => fact({
    action: 'opened', ...described(answer, repo, 'pr', undefined), title: answer.title ?? args.title, ref: args.head,
  }),
  update_pull_request: (args, repo, answer) => edited(args, described(answer, repo, 'pr', numberOf(args.pullNumber))),
  merge_pull_request: (args, repo, answer) => (answer.merged === false
    ? null
    : fact({ action: 'merged', subject: 'pr', repo, number: numberOf(args.pullNumber), state: 'merged' })),
  push_files: (args, repo) => pushedTo(args, repo),
  create_or_update_file: (args, repo) => pushedTo(args, repo),
  delete_file: (args, repo) => pushedTo(args, repo),
} satisfies Record<string, McpTool>));

function edited(args: v.InferOutput<typeof McpArgs>, subject: ReturnType<typeof described>): GitHubFact {
  const state = subject.state ?? args.state;

  return fact({ action: state === 'closed' ? 'closed' : 'touched', ...subject, state });
}

function pushedTo(args: v.InferOutput<typeof McpArgs>, repo: string): GitHubFact | null {
  return args.branch === undefined ? null : fact({ action: 'pushed', subject: 'repo', repo, ref: args.branch });
}

/** `result`: the MCP content array as JSON, as `userMcp_callTool` returns it. */
export function recognizeGitHubMcp(tool: string, args: JsonObject, result: string): readonly GitHubFact[] {
  const recognize = MCP_TOOLS.get(tool);
  const called = v.safeParse(McpArgs, args);
  const answered = v.safeParse(McpResult, result);

  if (recognize === undefined || !called.success || !answered.success || answered.output.isError === true) return [];
  const { owner, repo } = called.output;

  if (owner === undefined || repo === undefined) return [];
  const text = answered.output.content?.find((part) => part.type === 'text')?.text;
  const made = recognize(called.output, `${owner}/${repo}`, answerOf(text) ?? {});

  return made === null ? [] : [made];
}

const REMOTE = /^(?:(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?|[^@/\s]+@)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u;

/** `owner/name` for a github.com remote in any of git's URL forms; else null. */
export function githubRepoOfRemote(url: string): string | null {
  const match = REMOTE.exec(url.trim());

  return match === null ? null : `${match[1] ?? ''}/${match[2] ?? ''}`;
}
