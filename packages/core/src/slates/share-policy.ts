/**
 * Who a shared slate's calls act as (docs/SLATE-SHARING-NIMBUS.md §2–§3), as pure decisions the host applies on every
 * call: what the shared server may use, whether a personal part's call may use its viewer's connection, and the one
 * effect each approval admits. `lean/Kinu/SharingNimbus` states and proves these.
 */
import { isJsonObject, type JsonObject, type JsonValue } from '../utils/json';
import { sha256Hex, stableStringify } from '../safety/argument-digest';
import type { ShareGrant, SharePreapproval } from './sharing';
import { settleSync } from '../obs/effect';
import { KinuError } from '../obs/error';
import { Effect } from 'effect';
import type { ShareMode, SlateConsent } from './share-modes';
import type { ConsentAsk, EffectAsk } from './personal-parts';
import type { SlateBuilds } from './builds';
import { slateAuthority } from './authority';
import { ROOT_SLATE_CALLER } from './caller';

/**
 * A slate's revision: the source digest its durable app's image was last built from as the workspace root, which
 * every edit changes. Consents and an `owner` share's approval name it; null before the slate ever built.
 */
export function slateRevision(builds: Pick<SlateBuilds, 'good'>, slate: string): string | null {
  return builds.good(slate, slateAuthority(ROOT_SLATE_CALLER.cred))?.key ?? null;
}

/** One live share of the slate, as the server's authority reads it. */
export interface LiveShareAuthority {
  readonly mode: ShareMode;
  readonly grant: ShareGrant;
  /** `owner` mode: the revision whose reach the owner approved; null in `own` mode. */
  readonly grantRevision: string | null;
  /** Someone the owner added to edit changed the slate, and the owner has not approved what it reaches since: who. */
  readonly editedBy?: string;
}

/**
 * What the slate's server acts with, whoever called it: the owner's own authority while it is shared with no one;
 * nothing while any share is `own`; else the members every `owner` share grants at this revision, and nothing once one
 * of them was approved for another revision (an edit suspends it until the owner approves again).
 */
export type ServerAuthority =
  | { readonly kind: 'owner' }
  | { readonly kind: 'none' }
  | { readonly kind: 'grant'; readonly grant: ShareGrant };

export function serverAuthority(shares: readonly LiveShareAuthority[], revision: string): ServerAuthority {
  if (shares.length === 0) return { kind: 'owner' };

  if (shares.some((share) => share.mode === 'own' || share.grantRevision !== revision)) return { kind: 'none' };
  const [first, ...rest] = shares.map((share) => share.grant);
  const key = (member: ShareGrant['members'][number]) => JSON.stringify([member.slate, member.namespace, member.member]);
  const members = (first?.members ?? []).filter((member) => rest.every((grant) => grant.members.some((other) => key(other) === key(member))));
  const preapprovalKey = (entry: SharePreapproval) => JSON.stringify([entry.slate, entry.namespace, entry.member, canonicalRoot(entry.root), entry.revision]);

  // Pre-approved only where every share of the one server pre-approved it, at the revision the server runs.
  const preapproved = (first?.preapproved ?? []).filter((entry) => entry.revision === revision
    && rest.every((grant) => (grant.preapproved ?? []).some((other) => preapprovalKey(other) === preapprovalKey(entry))));

  return { kind: 'grant', grant: { slates: first?.slates ?? [], members, fork: false, ...(preapproved.length > 0 && { preapproved }) } };
}

/** Whether `grant` pre-approves `call` at `revision`: that slate's exact tool on that root, at that revision. */
export function preapprovedEffect(
  grant: ShareGrant, call: { readonly slate: string; readonly namespace: string; readonly member: string; readonly root: Readonly<Record<string, string>> }, revision: string,
): boolean {
  return (grant.preapproved ?? []).some((entry) => entry.revision === revision && entry.slate === call.slate
    && entry.namespace === call.namespace && entry.member === call.member && canonicalRoot(entry.root) === canonicalRoot(call.root));
}

/**
 * `value` as plain data, the one form an approval, a consent and a send all read it in: null, booleans, finite numbers,
 * strings, arrays and plain objects, copied. Anything else (a Date, a Map, a class instance, a typed array, a function,
 * a non-finite number) is refused, so no two different values can read as one.
 */
export function plainData(value: JsonValue): JsonValue {
  return settleSync(plain(value, '$'));
}

/** `value` checked to its prototypes, where the wire may have handed a Date or an instance typed as data. */
function plain(value: JsonValue, at: string): Effect.Effect<JsonValue, KinuError> {
  const kind: string = typeof value;

  if (value === null || kind === 'string' || kind === 'boolean') return Effect.succeed(value);

  if (typeof value === 'number') return Number.isFinite(value) ? Effect.succeed(value) : Effect.fail(new KinuError('bad_input', `${at} is not a finite number`));

  if (Array.isArray(value)) return Effect.forEach(value, (item, index) => plain(item, `${at}[${index}]`));

  if (kind !== 'object') return Effect.fail(new KinuError('bad_input', `${at} is a ${kind}, not data`));
  const proto: unknown = Object.getPrototypeOf(value);

  if (proto !== Object.prototype && proto !== null) return Effect.fail(new KinuError('bad_input', `${at} is not plain data (${Object.prototype.toString.call(value)})`));

  return Effect.map(
    Effect.forEach(Object.entries(value), ([key, item]) => Effect.map(plain(item, `${at}.${key}`), (copied) => [key, copied] as const)),
    (entries) => Object.fromEntries(entries),
  );
}

/** A connection's tool as its catalog knows it: the preset the connection was made from, if any, and the tool's name. */
export interface ToolContract {
  readonly preset: string | null;
  readonly tool: string;
}

/**
 * Tools whose handler selects the resource of each operation inside the repository its `owner` and `repo` name, and
 * reaches nothing outside it: a `/repos/{owner}/{repo}/…` path, or a GraphQL query rooted at that repository whose IDs
 * every later step derives from it (or checks against it). Read off each handler at github/github-mcp-server
 * e3809fe91c75 (`pkg/github`), not its tool reference: a tool's arguments say nothing of what its handler ignores. Most
 * do so for every operation (`'every'`); for the rest, only the operations their `method` names here, the others
 * selecting a node by its global ID and ignoring both. A tool or operation not named here is scoped to its whole
 * connection, however its arguments look.
 */
const REPOSITORY_TOOLS: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string> | 'every'>> = new Map([['github', new Map<string, ReadonlySet<string> | 'every'>([
  ...[
    // Reads. With no `repo`, `list_discussions`, `list_discussion_categories`, `list_issue_fields` and
    // `list_issue_types` read the owner's organization; such a call names no repository, so it has no root.
    'get_file_contents', 'get_repository_tree', 'get_commit', 'list_commits', 'list_branches', 'list_tags', 'get_tag',
    'list_releases', 'get_latest_release', 'get_release_by_tag', 'list_issues', 'list_issue_fields', 'list_issue_types',
    'get_label', 'list_label', 'pull_request_read', 'list_pull_requests', 'get_discussion', 'get_discussion_comments', 'list_discussions',
    'list_discussion_categories', 'actions_get', 'actions_list', 'get_job_logs', 'get_code_scanning_alert', 'list_code_scanning_alerts',
    'get_code_quality_finding', 'get_dependabot_alert', 'list_dependabot_alerts', 'get_secret_scanning_alert', 'list_secret_scanning_alerts',
    'list_repository_security_advisories', 'list_repository_collaborators',
    // Writes to that repository alone.
    'add_issue_comment', 'update_issue_comment', 'label_write', 'create_branch', 'create_or_update_file', 'delete_file', 'push_files',
    'merge_pull_request', 'update_pull_request', 'update_pull_request_branch', 'add_comment_to_pending_review', 'add_reply_to_pull_request_comment',
  ].map((tool) => [tool, 'every'] as const),
  // `update`, `delete`, `mark_answer` and `unmark_answer` take the comment by `commentNodeID` alone (discussions.go);
  // `reply` reads it so, then refuses one outside the repository's discussion before it writes.
  ['discussion_comment_write', new Set(['add', 'reply'])],
  // `resolve_thread` and `unresolve_thread` take the thread by `threadId` alone (pullrequests.go).
  ['pull_request_review_write', new Set(['create', 'submit_pending', 'delete_pending'])],
  // `get_parent` and `get_sub_issues` answer the related issues wherever they are, and `get` adds its parent and the
  // pull requests that close it from any repository (issues.go): a sub-issue may live in another repository.
  ['issue_read', new Set(['get_comments', 'get_labels'])],
])]]);

/**
 * The root a call is consented, approved or pre-approved for: the repository a known repository-scoped operation's
 * `owner` and `repo` name (`REPOSITORY_TOOLS`); else nothing, which is its whole connection. A root is never inferred
 * from fields its handler may ignore.
 */
export function partCallRoot(contract: ToolContract | null, args: JsonValue): Record<string, string> {
  const operations = contract === null || contract.preset === null ? undefined : REPOSITORY_TOOLS.get(contract.preset)?.get(contract.tool);

  if (operations === undefined || args === null || typeof args !== 'object' || Array.isArray(args)) return {};
  const { owner, repo, method } = args;
  const scoped = operations === 'every' || (typeof method === 'string' && operations.has(method));

  return scoped && typeof owner === 'string' && typeof repo === 'string' && owner !== '' && repo !== '' ? { owner, repo } : {};
}

/** A root as the consent row keys it: its entries in key order. */
export function canonicalRoot(root: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(root).sort(([a], [b]) => a.localeCompare(b))));
}

/** One call a personal part's run makes with its viewer's connection. */
export interface PartCall {
  readonly server: string;
  readonly root: Readonly<Record<string, string>>;
  readonly tool: string;
  /**
   * Whether the call stays where it was consented: a tool its server marks read-only and closed-world
   * (`openWorldHint: false`), so what its arguments carry reaches that server alone. Anything else (a send, a URL
   * fetch, any tool that may reach other destinations) discloses what it carries, and dispatches only once its viewer
   * approves that exact payload.
   */
  readonly contained: boolean;
}

/** Whether a tool's call stays with its own server: read-only and closed-world by its server's own marks. */
function containedTool(descriptor: { readonly readOnly?: true; readonly closedWorld?: true }): boolean {
  return descriptor.readOnly === true && descriptor.closedWorld === true;
}

/** A connection's tool as a part call resolves it: the viewer's own MCP descriptor, by its server's name. */
interface PartToolDescriptor {
  readonly serverName: string;
  readonly name: string;
  readonly presetId?: string;
  readonly readOnly?: true;
  readonly closedWorld?: true;
}

/** A personal part's call as the viewer's connections resolve it: the one rule running it and replaying it both read. */
export type ResolvedPartCall<D extends PartToolDescriptor> =
  | { readonly kind: 'missing' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'resolved'; readonly descriptor: D; readonly payload: JsonObject; readonly call: PartCall };

/** A part's `workspace.ai` call: the viewer's own models, contained, with no root. */
export function partAiCall(tool: 'run' | 'stream'): PartCall {
  return { server: 'ai', root: {}, tool, contained: true };
}

/**
 * `mcp.<server>.<tool>(object)` on the viewer's connections: the descriptor it names (none: `missing`), its one JSON
 * object argument (anything else: `malformed`), and the call its consent is checked for.
 */
export function resolvePartCall<D extends PartToolDescriptor>(
  descriptors: readonly D[], request: { readonly server: string; readonly tool: string; readonly args: readonly JsonValue[] },
): ResolvedPartCall<D> {
  const { server, tool, args } = request;
  const descriptor = server.startsWith('mcp.') ? descriptors.find((item) => item.serverName === server.slice('mcp.'.length) && item.name === tool) : undefined;

  if (descriptor === undefined) return { kind: 'missing' };
  const [payload] = args;

  if (args.length !== 1 || payload === undefined || !isJsonObject(payload)) return { kind: 'malformed' };

  return {
    kind: 'resolved', descriptor, payload,
    call: { server, root: partCallRoot({ preset: descriptor.presetId ?? null, tool }, payload), tool, contained: containedTool(descriptor) },
  };
}

export type PartCallVerdict =
  | { readonly kind: 'run' }
  | { readonly kind: 'needs-consent'; readonly ask: ConsentAsk }
  | { readonly kind: 'needs-approval' };

function sameRoot(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  return canonicalRoot(a) === canonicalRoot(b);
}

/**
 * Whether the viewer's consent for this slate lets this call run at this revision: the tool among those they allowed,
 * on that root, for this very revision (an edit asks again). A call that is not contained needs their consent to ask
 * (`effects`), and then runs only once they approve it, its payload and destination shown: a read as much as a send.
 */
export function partCallVerdict(consent: SlateConsent | null, call: PartCall, revision: string, approved: boolean): PartCallVerdict {
  const held = consent !== null && consent.server === call.server && sameRoot(consent.root, call.root) && consent.revision === revision;

  if (!held || !consent.tools.includes(call.tool) || (!call.contained && !consent.effects)) {
    const tools = held ? [...new Set([...consent.tools, call.tool])] : [call.tool];

    return { kind: 'needs-consent', ask: { server: call.server, root: call.root, tools, effects: !call.contained || (held && consent.effects), revision } };
  }

  return !call.contained && !approved ? { kind: 'needs-approval' } : { kind: 'run' };
}

/** A disclosing call as its approval names it: the slate, its revision, its destination (server, tool, root) and its exact payload. */
export interface EffectCall {
  readonly workspace: string;
  readonly slate: string;
  readonly revision: string;
  readonly server: string;
  readonly tool: string;
  readonly root: Readonly<Record<string, string>>;
  readonly payload: JsonValue;
}

/**
 * The effects one viewer's personal parts asked to run, each named by its exact call, approved or not, and taken once:
 * one approval admits that one effect with that payload. Held in memory by the viewer's account; they live and die
 * with the transient runs that ask them.
 */
export class EffectApprovals {
  private readonly asked = new Map<string, { readonly call: EffectCall; approved: boolean }>();

  static idOf(call: EffectCall): string {
    return sha256Hex(stableStringify(plainData({ ...call, root: { ...call.root } })), 32);
  }

  ask(call: EffectCall): EffectAsk {
    const id = EffectApprovals.idOf(call);

    if (!this.asked.has(id)) this.asked.set(id, { call, approved: false });

    return { id, server: call.server, tool: call.tool, root: call.root, payload: call.payload };
  }

  /** The viewer's decision: approved, it waits for its run; declined, it is forgotten. */
  decide(id: string, approve: boolean): boolean {
    const asked = this.asked.get(id);

    if (asked === undefined) return false;

    if (approve) asked.approved = true;
    else this.asked.delete(id);

    return true;
  }

  /** Whether `call` was approved, which uses the approval up. */
  take(call: EffectCall): boolean {
    const id = EffectApprovals.idOf(call);

    if (this.asked.get(id)?.approved !== true) return false;
    this.asked.delete(id);

    return true;
  }
}
