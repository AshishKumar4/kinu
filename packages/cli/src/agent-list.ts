import {
  agentDbPath,
  listAgentDirs,
  listConfiguredAgentRefs,
  listLocalRefsAllProjects,
  readWorkspaceDisplayName,
  requireAuthConfig,
  updateConfigFile,
  type KinuAgentConfig,
} from './config';
import { workspaceDisplayTitle } from '@kinu.run/core';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';
import { listCloudAgents, type CloudAgent } from './cloud-api';

interface ListedAgentFields {
  name: string;
  label: string;
  /** Typed reason the title could not be read, so callers need not parse the label. */
  readError?: string;
}

export type ListedAgent = ListedAgentFields & (
  { mode: 'local'; localName: string; cwd: string; workspaceId: string; cloudName?: never }
  | { mode: 'cloud'; cloudName: string; localName?: never; cwd?: never; workspaceId?: never }
);

interface AgentWorkspaceGroup<T extends ListedAgent = ListedAgent> {
  readonly cwd: string;
  readonly workspaceId: string;
  readonly agents: readonly T[];
}

interface GroupedAgentWorkspaces<T extends ListedAgent = ListedAgent> {
  readonly projectRoot: string;
  readonly workspaces: readonly AgentWorkspaceGroup<T>[];
  readonly remote: readonly T[];
}

/** `null` for cloud, else the peers' `{cwd, workspaceId}` pair. */
export function agentWorkspaceKey(agent: Extract<ListedAgent, { mode: 'local' }>): string;
export function agentWorkspaceKey(agent: ListedAgent): string | null;
export function agentWorkspaceKey(agent: ListedAgent): string | null {
  if (agent.mode === 'cloud') return null;

  return `${agent.cwd}\u0000${agent.workspaceId}`;
}

/** Current project's workspaces first, then other projects, then cloud. Rows keep their order in a group. */
export function groupAgentWorkspaces<T extends ListedAgent>(
  agents: readonly T[],
  projectRoot: string,
): GroupedAgentWorkspaces<T> {
  const groups = new Map<string, { cwd: string; workspaceId: string; agents: T[] }>();
  const remote: T[] = [];

  for (const agent of agents) {
    if (agent.mode === 'cloud') {
      remote.push(agent);
      continue;
    }

    const key = agentWorkspaceKey(agent);
    const cwd = agent.cwd;
    const group = groups.get(key) ?? { cwd, workspaceId: agent.workspaceId, agents: [] };
    group.agents.push(agent);
    groups.set(key, group);
  }

  const ordered = [...groups.values()].sort((left, right) =>
    Number(right.cwd === projectRoot) - Number(left.cwd === projectRoot));

  return { projectRoot, workspaces: ordered, remote };
}

/** The slug is the address `kinu chat <name>` takes, never the title shown. */
function localDisplay(dirName: string): Pick<ListedAgent, 'label' | 'readError'> {
  try {
    return { label: workspaceDisplayTitle({ name: dirName, displayName: readWorkspaceDisplayName(agentDbPath(dirName)) }) };
  } catch (error) {
    const reason = renderThrownChain({ cause: error });
    diagnostics.failure(
      'workspace.read_failed',
      toKinuError({ doing: 'reading a local workspace title', cause: error, otherwise: 'io' }),
      { workspace: dirName },
    );

    return { label: `(unreadable: ${reason})`, readError: reason };
  }
}

/** Opens under the ref's config name when one exists, so aliases and cloud links stay attached. */
function localRow(configured: Extract<KinuAgentConfig, { mode: 'local' }>): ListedAgent {
  return {
    name: configured.name,
    ...localDisplay(configured.localName),
    mode: 'local',
    localName: configured.localName,
    cwd: configured.cwd,
    workspaceId: configured.workspaceId,
  };
}

function localRefsByDirName(refs: readonly KinuAgentConfig[]): Map<string, Extract<KinuAgentConfig, { mode: 'local' }>> {
  return new Map(refs
    .filter((agent) => agent.mode === 'local')
    .map((agent) => [agent.localName, agent]));
}

function localRows(refs: ReadonlyMap<string, Extract<KinuAgentConfig, { mode: 'local' }>>, names: Iterable<string>): ListedAgent[] {
  return [...names].flatMap((name) => {
    const ref = refs.get(name);

    return ref === undefined ? [] : [localRow(ref)];
  });
}

/** The one roster `kinu list`, `kinu transcripts` and the chat picker all read. */
export function listLocalAgentNames(cwd = process.cwd()): string[] {
  return listAgentDirs(cwd);
}

/** A cloud ref sharing a local agent's name stays listed: they are different workspaces. */
export function listSidebarAgents(cwd = process.cwd()): ListedAgent[] {
  const refs = listConfiguredAgentRefs();
  const byDirName = localRefsByDirName(refs);
  const localNames = new Set(listLocalAgentNames(cwd));

  return [
    ...localRows(byDirName, localNames),
    ...refs
      .filter((agent) => agent.mode === 'cloud')
      .map((agent) => ({
        name: agent.name,
        label: workspaceDisplayTitle({ name: agent.name, displayName: agent.displayName }),
        mode: 'cloud' as const,
        cloudName: agent.cloudName,
      })),
  ];
}

export function reconcileAgentRefs(
  localAgentNames: readonly string[],
  configuredAgents: readonly KinuAgentConfig[],
  cloudAgents: readonly CloudAgent[],
): ListedAgent[] {
  const localConfig = localRefsByDirName(configuredAgents);
  const localNames = new Set(localAgentNames);
  const local = localRows(localConfig, localNames);

  const seenCloudNames = new Set<string>();

  const cloud = cloudAgents.flatMap((agent) => {
    if (seenCloudNames.has(agent.name)) return [];
    seenCloudNames.add(agent.name);

    return [{
      name: agent.name,
      label: workspaceDisplayTitle({ name: agent.name, displayName: agent.displayName }),
      mode: 'cloud' as const,
      cloudName: agent.name,
    }];
  });

  return [...local, ...cloud];
}

/** This project's workspaces, then every other placed one, then the cloud's; one without a folder is refused at open, so never offered. */
export function listKnownAgents(): ListedAgent[] {
  const refs = listConfiguredAgentRefs();
  const byDirName = localRefsByDirName(refs);
  const placed = new Set([...listLocalAgentNames(), ...listLocalRefsAllProjects().map((ref) => ref.name)]);

  return [
    // The label comes from the workspace database, where renames and auto-titles land, not the `config.json` mirror.
    ...localRows(byDirName, placed),
    ...refs.filter((agent) => agent.mode === 'cloud').map((agent) => ({
      name: agent.name,
      label: workspaceDisplayTitle({ name: agent.name, displayName: agent.displayName }),
      mode: agent.mode,
      cloudName: agent.cloudName,
    })),
  ];
}

/** A server workspace whose name a local ref already holds. The local ref stands: flipping its mode would
 * drop a placed agent out of its project, peer group and scheduler roster. */
export interface CloudRefCollision {
  name: string;
  localName: string;
  cloudDisplayName: string;
}

interface CloudRefSync {
  agents: ListedAgent[];
  /** A name here reached neither roster as cloud, so a caller showing the roster must show these too. */
  collisions: CloudRefCollision[];
}

export async function syncCloudAgentRefs(): Promise<CloudRefSync> {
  const { origin, token } = requireAuthConfig();
  const cloudAgents = await listCloudAgents(origin, token);
  const now = new Date().toISOString();
  const collisions: CloudRefCollision[] = [];
  await updateConfigFile((config) => {
    const current = config.agents ?? {};
    const cloudNames = new Set(cloudAgents.map((agent) => agent.name));
    const next: Record<string, KinuAgentConfig> = {};

    for (const [name, agent] of Object.entries(current)) {
      if (agent.mode === 'cloud' && !cloudNames.has(agent.cloudName)) continue;
      next[name] = agent;
    }

    for (const agent of cloudAgents) {
      const existing = next[agent.name];

      if (existing?.mode === 'local') {
        collisions.push({
          name: agent.name,
          localName: existing.localName,
          cloudDisplayName: agent.displayName,
        });
        continue;
      }

      next[agent.name] = {
        ...existing,
        name: agent.name,
        mode: 'cloud',
        displayName: agent.displayName,
        cloudName: agent.name,
        createdAt: existing?.createdAt ?? new Date(agent.createdAt || Date.now()).toISOString(),
        updatedAt: now,
      };
    }

    config.agents = next;

    if (config.aliases) {
      for (const [alias, target] of Object.entries(config.aliases)) {
        const agent = next[target];

        if (!agent || (agent.mode === 'cloud' && !cloudNames.has(agent.cloudName))) {
          delete config.aliases[alias];
        }
      }
    }
  });

  return { agents: listKnownAgents(), collisions };
}
