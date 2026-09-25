import {
  agentDbPath,
  listAgentDirs,
  listConfiguredAgentRefs,
  listUnplacedAgentNames,
  readWorkspaceDisplayName,
  requireAuthConfig,
  updateConfigFile,
  type AgentMode,
  type KinuAgentConfig,
} from './config';
import { workspaceDisplayTitle } from '@kinu.run/core';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';
import { listCloudAgents, type CloudAgent } from './cloud-api';

export interface ListedAgent {
  name: string;
  label: string;
  mode: AgentMode;
  /** Typed reason the title could not be read, so callers need not parse the label. */
  readError?: string;
  localName?: string;
  cloudName?: string;
  /** Unplaced agents carry neither this nor `workspaceId`. */
  cwd?: string;
  /** Peers share the pair `{cwd, workspaceId}`. */
  workspaceId?: string;
}

interface AgentWorkspaceGroup<T extends ListedAgent = ListedAgent> {
  readonly cwd: string;
  readonly workspaceId: string;
  readonly agents: readonly T[];
}

interface GroupedAgentWorkspaces<T extends ListedAgent = ListedAgent> {
  readonly projectRoot: string;
  readonly workspaces: readonly AgentWorkspaceGroup<T>[];
  /** Local agents no ref places in any project (a `~/.kinu/<name>` directory). */
  readonly unplaced: readonly T[];
  readonly remote: readonly T[];
}

/** Display-only fallback when a ref records no `workspaceId`; placement always stores the real id. */
function workspaceIdForRoot(root: string): string {
  const base = root.replace(/\/+$/u, '').split('/').at(-1) ?? '';

  const candidate = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');

  return candidate === '' ? 'workspace' : candidate;
}

/** `'unplaced'` for a local agent no ref places, `null` for cloud, else the peers' `{cwd, workspaceId}` pair. */
export function agentWorkspaceKey(agent: ListedAgent, projectRoot: string): string | null {
  if (agent.mode === 'cloud') return null;

  if (agent.cwd === undefined && agent.workspaceId === undefined) return 'unplaced';
  const cwd = agent.cwd ?? projectRoot;

  return `${cwd}\u0000${agent.workspaceId ?? workspaceIdForRoot(cwd)}`;
}

/** Current project's workspaces first, then other projects, unplaced, cloud. Rows keep their order in a group. */
export function groupAgentWorkspaces<T extends ListedAgent>(
  agents: readonly T[],
  projectRoot: string,
): GroupedAgentWorkspaces<T> {
  const groups = new Map<string, { cwd: string; workspaceId: string; agents: T[] }>();
  const unplaced: T[] = [];
  const remote: T[] = [];

  for (const agent of agents) {
    const key = agentWorkspaceKey(agent, projectRoot);

    if (key === null) {
      remote.push(agent);
      continue;
    }

    if (key === 'unplaced') {
      unplaced.push(agent);
      continue;
    }

    const cwd = agent.cwd ?? projectRoot;
    const group = groups.get(key) ?? { cwd, workspaceId: key.slice(cwd.length + 1), agents: [] };
    group.agents.push(agent);
    groups.set(key, group);
  }

  const ordered = [...groups.values()].sort((left, right) =>
    Number(right.cwd === projectRoot) - Number(left.cwd === projectRoot));

  return { projectRoot, workspaces: ordered, unplaced, remote };
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
function localRow(configured: KinuAgentConfig | undefined, dirName: string): ListedAgent {
  return {
    name: configured?.name ?? dirName,
    ...localDisplay(dirName),
    mode: 'local',
    localName: dirName,
    cloudName: configured?.cloudName,
    cwd: configured?.cwd,
    workspaceId: configured?.workspaceId,
  };
}

function localRefsByDirName(refs: readonly KinuAgentConfig[]): Map<string, KinuAgentConfig> {
  return new Map(refs
    .filter((agent) => agent.mode === 'local')
    .map((agent) => [agent.localName ?? agent.name, agent]));
}

/** The one roster `kinu list`, `kinu transcripts` and the chat picker all read. */
export function listLocalAgentNames(cwd = process.cwd()): string[] {
  return [...new Set([...listAgentDirs(cwd), ...listUnplacedAgentNames()])];
}

/** A cloud ref sharing a local agent's name stays listed: they are different workspaces. */
export function listSidebarAgents(cwd = process.cwd()): ListedAgent[] {
  const refs = listConfiguredAgentRefs();
  const byDirName = localRefsByDirName(refs);

  return [
    ...listLocalAgentNames(cwd).map((name) => localRow(byDirName.get(name), name)),
    ...refs
      .filter((agent) => agent.mode === 'cloud')
      .map((agent) => ({
        name: agent.name,
        label: workspaceDisplayTitle({ name: agent.name, displayName: agent.displayName }),
        mode: 'cloud' as const,
        localName: agent.localName,
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
  const local = [...new Set(localAgentNames)].map((name) => localRow(localConfig.get(name), name));

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

export function listKnownAgents(): ListedAgent[] {
  const localAgents = new Set(listLocalAgentNames());
  const refs = listConfiguredAgentRefs();
  const byDirName = localRefsByDirName(refs);

  return [
    ...[...localAgents].map((name) => localRow(byDirName.get(name), name)),
    ...refs
      .filter((agent) => agent.mode === 'cloud' || !localAgents.has(agent.localName ?? agent.name))
      // The label comes from the workspace database, where renames and auto-titles land, not the `config.json` mirror.
      .map((agent) => (agent.mode === 'local'
        ? localRow(agent, agent.localName ?? agent.name)
        : {
          name: agent.name,
          label: workspaceDisplayTitle({ name: agent.name, displayName: agent.displayName }),
          mode: agent.mode,
          localName: agent.localName,
          cloudName: agent.cloudName,
          cwd: agent.cwd,
          workspaceId: agent.workspaceId,
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
      if (agent.mode === 'cloud' && !cloudNames.has(agent.cloudName ?? agent.name)) continue;
      next[name] = agent;
    }

    for (const agent of cloudAgents) {
      const existing = next[agent.name];

      if (existing?.mode === 'local') {
        collisions.push({
          name: agent.name,
          localName: existing.localName ?? existing.name,
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

        if (!agent || (agent.mode === 'cloud' && !cloudNames.has(agent.cloudName ?? agent.name))) {
          delete config.aliases[alias];
        }
      }
    }
  });

  return { agents: listKnownAgents(), collisions };
}
