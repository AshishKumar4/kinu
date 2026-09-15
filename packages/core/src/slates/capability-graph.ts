/**
 * The capability graph: what a slate could do if a viewer opened it, rendered
 * so the share dialog can show it and the owner can approve over it.
 *
 * One graph answers the two questions sharing has to answer honestly: WHAT a
 * grant would admit (the members, each classified read or mutating by
 * `members.ts`) and WHY a mutating one is worth a second thought (the risk
 * text, worded once per visibility). An `app` binding extends the walk into
 * the slate it names — a viewer that opens the root can hop — so `slates` is
 * the walk order the grant's admission set is cut from.
 */
import { KinuError } from '../obs/error';
import {
  memberEffect, MEMORY_MEMBER_EFFECTS, TASKS_MEMBER_EFFECTS, toolActionEffect, toolMembers,
  TOOL_ACTION_EFFECTS, WEB_MEMBER_EFFECTS,
} from './members';
import type { SlateBinding, SlateProject } from './project';
import type {
  ShareGrant, ShareGrantMember, SlateCapability, SlateCapabilityGraph, SlateGraphBinding, SlateGraphMember,
} from './sharing';

/** What the workspace can actually satisfy a binding with — the catalog the
 *  graph is drawn against, so a binding that names something absent is a
 *  `problem` on its row rather than a silent blank. */
export interface SlateBindingCatalog {
  readonly executors: readonly { readonly namespace: string; readonly members: readonly string[] }[];
  readonly mcp: readonly {
    readonly server: string;
    readonly title: string;
    readonly tools: readonly { readonly name: string; readonly readOnly: boolean }[];
  }[];
  /** Crafted tool names beside the native ones. */
  readonly tools: readonly string[];
  readonly tiers: readonly string[];
  /** Every slate in the workspace by id, for app hops. */
  readonly slates: Readonly<Record<string, SlateProject>>;
}

const DELEGATION_PROBLEM = 'a slate cannot delegate or control its calling agent';

/** A `paths`-scoped workspace binding narrows to the file members — the same
 *  five `routeNamespaceCall` will admit at call time. */
const PATH_SCOPED_FILE_MEMBERS = ['readFile', 'writeFile', 'editFile', 'readdir', 'exists'] as const;

interface Risk {
  readonly public: string;
  readonly users: string;
}

/** What one member on one capability does to the owner, once per visibility.
 *  A read member has no risk to state. The wording is per member — never a
 *  generic "this may change things" — because the dialog is the consent the
 *  grant is cut from, and a warning that does not name the act consents to
 *  nothing. */
function riskOf(capability: SlateCapability, member: string, effect: 'read' | 'mutate', workspace: string): Risk {
  if (effect === 'read') return { public: '', users: '' };
  let body: string;

  switch (capability.kind) {
    case 'executor':
      if (member === 'exec') {
        body = `Runs shell commands in workspace ${workspace} as you. A command can change or delete anything there.`;
      } else if (member === 'writeFile' || member === 'editFile' || member === 'mkdir' || member === 'remove') {
        body = `Writes, edits or deletes files in workspace ${workspace} as you.`;
      } else if (member === 'saveNote') {
        body = 'Writes notes into your workspace memory as you.';
      } else if (member === 'createTool') {
        body = `Adds crafted tools to workspace ${workspace} as you; every agent there can call them afterwards.`;
      } else if (member === 'slate') {
        body = `Changes the slates of workspace ${workspace} as you.`;
      } else if (member === 'git') {
        body = `Runs git in workspace ${workspace} as you, including pushes with your credentials.`;
      } else {
        body = `Runs ${member} in workspace ${workspace} as you.`;
      }

      break;
    case 'mcp':
      body = `Calls ${member} on ${capability.title} with your credentials. The server does not mark it read-only, so it can create or change data there.`;
      break;
    case 'tool':
      if (capability.name === 'file' && (member === 'write' || member === 'edit')) {
        body = `Writes, edits or deletes files in workspace ${workspace} as you.`;
      } else if (capability.name === 'run') {
        body = `Runs shell commands in workspace ${workspace} as you. A command can change or delete anything there.`;
      } else if (capability.name === 'eval') {
        body = `Runs a program with your whole tool surface in workspace ${workspace}.`;
      } else if (capability.name === 'report') {
        body = 'Sends reports to your agent as you.';
      } else if (capability.name === 'memory') {
        body = 'Changes your workspace memory as you: notes and remembered facts your agent reads back later.';
      } else if (capability.name === 'tasks') {
        body = "Changes your agent's task list and role as you.";
      } else {
        body = `Runs your crafted tool ${capability.name} as you, with whatever it reaches.`;
      }

      break;
    case 'memory':
      body = 'Changes your workspace memory as you: notes and remembered facts your agent reads back later.';
      break;
    case 'tasks':
      body = "Changes your agent's task list and role as you.";
      break;
    case 'agent':
      body = `Sends a message to your agent's inbox as this slate. Your agent reads it and acts on it in workspace ${workspace}.`;
      break;
    case 'model':
      body = `Runs a model call on your ${capability.tier} tier. Every call spends your inference.`;
      break;
    default:
      body = `Calls ${member} as you.`;
  }

  return {
    public: `${body} Anyone who opens this share can trigger it.`,
    users: `${body} Anyone you named on this share can trigger it.`,
  };
}

function graphMember(
  capability: SlateCapability, member: string, effect: 'read' | 'mutate', workspace: string,
): SlateGraphMember {
  return { member, effect, risk: riskOf(capability, member, effect, workspace) };
}

/** One binding as its row on the graph: the capability it reaches, every
 *  member a grant could name classified by effect, and the reason the row
 *  cannot be honoured when the workspace cannot honour it. A problem row
 *  still carries its members — the grant cut includes them, so the call
 *  refuses for the real reason rather than for absence from the grant. */
function graphBinding(
  slate: string, name: string, binding: SlateBinding, catalog: SlateBindingCatalog, workspace: string,
): SlateGraphBinding {
  const row = (capability: SlateCapability, members: SlateGraphMember[], problem?: string): SlateGraphBinding => {
    const result: SlateGraphBinding = { slate, name, kind: binding.kind, capability, members };

    if (problem !== undefined) return { ...result, problem };

    return result;
  };

  const namespaceRow = (declared: Extract<SlateBinding, { kind: 'namespace' }>): SlateGraphBinding => {
    const capability: SlateCapability = { kind: 'executor', namespace: declared.namespace };

    if (declared.namespace === 'agent' || declared.namespace === 'agents') {
      return row(capability, [], DELEGATION_PROBLEM);
    }

    const executor = catalog.executors.find((entry) => entry.namespace === declared.namespace);
    let members = declared.members ?? executor?.members ?? [];

    if (declared.paths !== undefined) {
      members = members.filter((member) => PATH_SCOPED_FILE_MEMBERS.some((file) => file === member));
    }

    return row(
      capability,
      members.map((member) => graphMember(capability, member, memberEffect('namespace', member), workspace)),
      executor === undefined ? `no executor named ${declared.namespace} is available in this workspace` : undefined,
    );
  };

  const mcpRow = (declared: Extract<SlateBinding, { kind: 'mcp' }>): SlateGraphBinding => {
    const server = catalog.mcp.find((entry) => entry.server === declared.server);
    const capability: SlateCapability = { kind: 'mcp', server: declared.server, title: server?.title ?? declared.server };
    const members = declared.tools ?? server?.tools.map((tool) => tool.name) ?? [];
    const known = new Map((server?.tools ?? []).map((tool) => [tool.name, tool.readOnly]));

    return row(
      capability,
      members.map((tool) => graphMember(capability, tool, known.get(tool) === true ? 'read' : 'mutate', workspace)),
      server === undefined ? `MCP server ${declared.server} is not connected` : undefined,
    );
  };

  const toolRow = (declared: Extract<SlateBinding, { kind: 'tool' }>): SlateGraphBinding => {
    const capability: SlateCapability = { kind: 'tool', name: declared.name };

    if (declared.name === 'agents') return row(capability, [], DELEGATION_PROBLEM);

    if (declared.name === 'eval') return row(capability, [], 'a slate cannot run eval');

    return row(
      capability,
      toolMembers(declared.name).map((member) => graphMember(capability, member, toolActionEffect(declared.name, member), workspace)),
      !Object.hasOwn(TOOL_ACTION_EFFECTS, declared.name) && !catalog.tools.includes(declared.name)
        ? `no tool named ${declared.name} is available`
        : undefined,
    );
  };

  const aiRow = (declared: Extract<SlateBinding, { kind: 'ai' }>): SlateGraphBinding => {
    const capability: SlateCapability = { kind: 'model', tier: declared.tier ?? 'default' };

    return row(
      capability,
      [graphMember(capability, 'run', 'mutate', workspace)],
      declared.tier !== undefined && !catalog.tiers.includes(declared.tier)
        ? `you have no ${declared.tier} tier`
        : undefined,
    );
  };

  const appRow = (declared: Extract<SlateBinding, { kind: 'app' }>): SlateGraphBinding => row(
    { kind: 'slate', id: declared.id }, [],
    Object.hasOwn(catalog.slates, declared.id) ? undefined : `no slate named ${declared.id}`,
  );

  switch (binding.kind) {
    case 'namespace': return namespaceRow(binding);
    case 'memory':
    case 'tasks':
    case 'web': {
      const capability: SlateCapability = { kind: binding.kind };

      const members = binding.members
        ?? Object.keys({ memory: MEMORY_MEMBER_EFFECTS, tasks: TASKS_MEMBER_EFFECTS, web: WEB_MEMBER_EFFECTS }[binding.kind]);

      return row(
        capability,
        members.map((member) => graphMember(capability, member, memberEffect(binding.kind, member), workspace)),
      );
    }

    case 'rpc': {
      const capability: SlateCapability = { kind: 'rpc' };

      return row(
        capability,
        binding.methods.map((method) => graphMember(capability, method, 'read', workspace)),
      );
    }

    case 'mcp': return mcpRow(binding);
    case 'tool': return toolRow(binding);
    case 'agent': {
      const capability: SlateCapability = { kind: 'agent' };

      return row(capability, [graphMember(capability, 'send', 'mutate', workspace)]);
    }

    case 'ai': return aiRow(binding);
    case 'app': return appRow(binding);
  }
}

/**
 * The grant surface of sharing `slate` live: its own bindings plus, behind
 *  each `app` binding's row, the bindings of the slate it names — `slates`
 *  holds the walk order, root first, a slate already walked never walked
 *  again.
 */
export function slateCapabilityGraph(input: {
  readonly slate: string;
  readonly workspace: string;
  readonly catalog: SlateBindingCatalog;
}): SlateCapabilityGraph {
  const { slate, workspace, catalog } = input;
  const root = Object.hasOwn(catalog.slates, slate) ? catalog.slates[slate] : undefined;

  if (root === undefined) throw new KinuError('missing', `No slate named ${slate}`);
  const bindings: SlateGraphBinding[] = [];
  const slates: string[] = [];
  const walked = new Set<string>();

  const walk = (id: string, project: SlateProject): void => {
    walked.add(id);
    slates.push(id);

    for (const [name, binding] of Object.entries(project.slate.bindings)) {
      bindings.push(graphBinding(id, name, binding, catalog, workspace));

      if (binding.kind !== 'app' || walked.has(binding.id) || !Object.hasOwn(catalog.slates, binding.id)) continue;
      walk(binding.id, catalog.slates[binding.id]);
    }
  };

  walk(slate, root);

  return { slate, slates, bindings };
}

/**
 * The grant a dialog's approval cuts from the graph: every read member, plus
 *  each approved mutating member. An approval that names a member the graph
 *  does not carry — or a read member — refuses rather than silently widening
 *  the grant.
 */
export function cutShareGrant(
  graph: SlateCapabilityGraph,
  approved: readonly { slate: string; binding: string; member: string }[],
): ShareGrant {
  const members: ShareGrantMember[] = [];
  const seen = new Set<string>();

  const admit = (slate: string, binding: string, member: string, effect: 'read' | 'mutate'): void => {
    const key = JSON.stringify([slate, binding, member]);

    if (seen.has(key)) return;
    seen.add(key);
    members.push({ slate, binding, member, effect });
  };

  for (const binding of graph.bindings) {
    for (const member of binding.members) {
      if (member.effect === 'read') admit(binding.slate, binding.name, member.member, 'read');
    }
  }

  for (const entry of approved) {
    const member = graph.bindings
      .find((binding) => binding.slate === entry.slate && binding.name === entry.binding)
      ?.members.find((candidate) => candidate.member === entry.member);

    if (member === undefined || member.effect !== 'mutate') {
      throw new KinuError('bad_input', `${entry.binding}.${entry.member} is not a mutating member of slate ${entry.slate}`);
    }

    admit(entry.slate, entry.binding, entry.member, 'mutate');
  }

  return { slates: [...graph.slates], members };
}

/** The grant's entry for exactly this (slate, binding, member), or null when
 *  the grant does not admit it. */
export function grantAdmits(grant: ShareGrant, slate: string, binding: string, member: string): ShareGrantMember | null {
  return grant.members.find((entry) => entry.slate === slate && entry.binding === binding && entry.member === member) ?? null;
}
