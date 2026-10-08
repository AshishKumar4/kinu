/**
 * What a slate could do if a viewer opened it: each member it has called on its surface, with its impact and
 * per-visibility risk text. A call into another slate extends the walk; `slates` is the walk order.
 */
import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settleSync } from '../obs/effect';
import type { Impact } from '@agent-core/core/facets';
import { slateAddressImpact } from './members';
import type { ShareGrant, ShareGrantMember, SlateCapabilityGraph, SlateGraphMember, SlateGraphNamespace } from './sharing';

/** What the owner's workspace offers now; a namespace naming something absent becomes a `problem` row, never a blank. */
export interface SlateSurfaceCatalog {
  readonly mcp: readonly {
    readonly server: string;
    readonly title: string;
    readonly tools: readonly { readonly name: string; readonly readOnly: boolean }[];
  }[];
  /** The slates the workspace holds. */
  readonly slates: readonly string[];
}

/** A namespace's first name: `mcp` of `mcp.<server>`, `slates` of `slates.<id>`. */
export function namespaceHead(namespace: string): string {
  const dot = namespace.indexOf('.');

  return dot < 0 ? namespace : namespace.slice(0, dot);
}

/** What a namespace names after its head, dots and all: the server of `mcp.files.prod` is `files.prod`. */
function namespaceTarget(namespace: string): string {
  const dot = namespace.indexOf('.');

  return dot < 0 ? '' : namespace.slice(dot + 1);
}

/** A member a slate has called, once per slate: recorded where the host routes its owner's calls. */
export interface SlateUsage {
  readonly namespace: string;
  readonly member: string;
}

interface Risk {
  readonly public: string;
  readonly users: string;
}

/** What a `mutate` member changes, as its risk text names it. */
function changed(head: string): string {
  if (head === 'tasks') return "your agent's tasks";

  return head === 'db' ? 'your workspace tables' : 'files';
}

/** A member as its risk text names it: its namespace, how a person reads it, and the workspace it acts in. */
interface RiskSubject {
  readonly namespace: string;
  readonly title: string;
  readonly member: string;
  readonly workspace: string;
}

function riskBody({ namespace, title, member, workspace }: RiskSubject, impact: Exclude<Impact, 'observe'>): string {
  const head = namespaceHead(namespace);

  switch (impact) {
    case 'mutate':
      if (head === 'memory') return 'Changes your workspace memory as you: notes and remembered facts your agent reads back later.';

      return `Writes, edits or deletes ${changed(head)} in workspace ${workspace} as you.`;
    case 'externalSend':
      if (head === 'mcp') return `Calls ${member} on ${title} with your credentials. The server does not mark it read-only, so it can create or change data there.`;

      return `Sends ${namespace}.${member} out of workspace ${workspace} as you: your agent reads it and acts on it.`;
    case 'execute':
      if (head === 'ai') return 'Runs a model call on your inference. Every call spends it.';

      return `Runs ${namespace}.${member} in workspace ${workspace} as you. It can change or delete anything there.`;
    case 'delegate':
    case 'administer': return `Runs ${namespace}.${member} in workspace ${workspace} as you, with whatever it reaches.`;
  }
}

/** Worded per impact and namespace: the dialog is the consent, and a warning that does not name the act consents to nothing. */
function riskOf(subject: RiskSubject, impact: Impact): Risk {
  if (impact === 'observe') return { public: '', users: '' };
  const body = riskBody(subject, impact);

  return {
    public: `${body} Anyone who opens this share can trigger it.`,
    users: `${body} Anyone you named on this share can trigger it.`,
  };
}

interface GraphRowInput {
  readonly slate: string;
  readonly namespace: string;
  readonly members: readonly string[];
  readonly catalog: SlateSurfaceCatalog;
  readonly workspace: string;
}

/** A problem row still carries its members, so a call refuses for the real reason, not absence from the grant. */
function graphRow({ slate, namespace, members, catalog, workspace }: GraphRowInput): SlateGraphNamespace {
  const head = namespaceHead(namespace);
  const name = namespaceTarget(namespace);
  const server = head === 'mcp' ? catalog.mcp.find((entry) => entry.server === name) : undefined;
  const title = server?.title ?? namespace;

  const impactOf = (member: string): Impact | null => (server?.tools.find((tool) => tool.name === member)?.readOnly === true
    ? 'observe'
    : slateAddressImpact({ namespace, member }));

  const graphMembers = members.flatMap((member): SlateGraphMember[] => {
    const impact = impactOf(member);

    return impact === null ? [] : [{ member, impact, risk: riskOf({ namespace, title, member, workspace }, impact) }];
  });

  const row = { slate, namespace, title, members: graphMembers };

  if (head === 'mcp' && server === undefined) return { ...row, problem: `MCP server ${name} is not connected` };

  if (head === 'slates' && !catalog.slates.includes(name)) return { ...row, problem: `no slate named ${name}` };

  return row;
}

/** Walks the slates a slate has called, root first, each once. */
export function slateCapabilityGraph(input: {
  readonly slate: string;
  readonly workspace: string;
  readonly catalog: SlateSurfaceCatalog;
  readonly usage: (slate: string) => readonly SlateUsage[];
}): SlateCapabilityGraph {
  return settleSync(capabilityGraph(input));
}

function capabilityGraph(input: Parameters<typeof slateCapabilityGraph>[0]): Effect.Effect<SlateCapabilityGraph, KinuError> {
  const { slate, workspace, catalog } = input;

  if (!catalog.slates.includes(slate)) return Effect.fail(new KinuError('missing', `No slate named ${slate}`));
  const namespaces: SlateGraphNamespace[] = [];
  const slates: string[] = [];
  const walked = new Set<string>();

  const walk = (id: string): void => {
    walked.add(id);
    slates.push(id);
    const byNamespace = new Map<string, string[]>();

    for (const { namespace, member } of input.usage(id)) byNamespace.set(namespace, [...byNamespace.get(namespace) ?? [], member]);

    for (const [namespace, members] of byNamespace) {
      namespaces.push(graphRow({ slate: id, namespace, members, catalog, workspace }));
      const callee = namespaceTarget(namespace);

      if (namespaceHead(namespace) === 'slates' && !walked.has(callee) && catalog.slates.includes(callee)) walk(callee);
    }
  };

  walk(slate);

  return Effect.succeed({ slate, slates, namespaces });
}

/** Every observing member plus each approved one that acts; approving an unknown or observing member refuses. */
export function cutShareGrant(
  graph: SlateCapabilityGraph,
  approved: readonly { slate: string; namespace: string; member: string }[],
): ShareGrant {
  return settleSync(shareGrant(graph, approved));
}

function shareGrant(graph: SlateCapabilityGraph, approved: Parameters<typeof cutShareGrant>[1]): Effect.Effect<ShareGrant, KinuError> {
  const members: ShareGrantMember[] = [];
  const seen = new Set<string>();

  const admit = (slate: string, namespace: string, member: string, impact: Impact): void => {
    const key = JSON.stringify([slate, namespace, member]);

    if (seen.has(key)) return;
    seen.add(key);
    members.push({ slate, namespace, member, impact });
  };

  for (const row of graph.namespaces) {
    for (const member of row.members) {
      if (member.impact === 'observe') admit(row.slate, row.namespace, member.member, 'observe');
    }
  }

  for (const entry of approved) {
    const member = graph.namespaces
      .find((row) => row.slate === entry.slate && row.namespace === entry.namespace)
      ?.members.find((candidate) => candidate.member === entry.member);

    if (member === undefined || member.impact === 'observe') {
      return Effect.fail(new KinuError('bad_input', `${entry.namespace}.${entry.member} is not a member of slate ${entry.slate} that acts`));
    }

    admit(entry.slate, entry.namespace, entry.member, member.impact);
  }

  return Effect.succeed({ slates: [...graph.slates], members });
}

export function grantAdmits(grant: ShareGrant, slate: string, namespace: string, member: string): ShareGrantMember | null {
  return grant.members.find((entry) => entry.slate === slate && entry.namespace === namespace && entry.member === member) ?? null;
}
