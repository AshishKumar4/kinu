import {
  agentDbPath,
  listAgentDirs,
  listConfiguredAgentRefs,
  listLegacyAgentNames,
  readWorkspaceDisplayName,
  requireAuthConfig,
  updateConfigFile,
  type AgentMode,
  type KinuAgentConfig,
} from './config';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';
import { listCloudAgents, type CloudAgent } from './cloud-api';

export interface ListedAgent {
  name: string;
  label: string;
  mode: AgentMode;
  localName?: string;
  cloudName?: string;
  /** Canonical project root this local agent is placed in; unplaced legacy
   *  agents carry neither this nor `workspaceId`. */
  cwd?: string;
  /** Virtual workspace inside `cwd`. Peers share the pair `{cwd, workspaceId}`. */
  workspaceId?: string;
}

/** One virtual workspace: peer agents sharing a `{cwd, workspaceId}` pair. */
export interface AgentWorkspaceGroup<T extends ListedAgent = ListedAgent> {
  readonly cwd: string;
  readonly workspaceId: string;
  readonly agents: readonly T[];
}

export interface GroupedAgentWorkspaces<T extends ListedAgent = ListedAgent> {
  readonly projectRoot: string;
  /** Virtual workspaces, the current project's first, in first-seen order. */
  readonly workspaces: readonly AgentWorkspaceGroup<T>[];
  /** Local agents no ref places in any project (pre-placement `~/.kinu/<name>`). */
  readonly unplaced: readonly T[];
  /** Remote cloud workspaces. */
  readonly remote: readonly T[];
}

/** The display label a placed local agent's workspace falls back to when its
 *  ref predates `workspaceId`: the same directory-basename slug placement
 *  writes. Display-only — placement itself always stores the real id. */
function workspaceIdForRoot(root: string): string {
  const base = root.replace(/\/+$/u, '').split('/').at(-1) ?? '';
  const candidate = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return candidate === '' ? 'workspace' : candidate;
}

/**
 * The virtual-workspace bucket an agent belongs to: `'unplaced'` for a legacy
 * local agent no ref places anywhere, `null` for cloud, otherwise the
 * `{cwd, workspaceId}` pair peers share.
 */
export function agentWorkspaceKey(agent: ListedAgent, projectRoot: string): string | null {
  if (agent.mode === 'cloud') return null;
  if (agent.cwd === undefined && agent.workspaceId === undefined) return 'unplaced';
  const cwd = agent.cwd ?? projectRoot;
  return `${cwd}\u0000${agent.workspaceId ?? workspaceIdForRoot(cwd)}`;
}

/**
 * Split a flat agent list into the sidebar's shape: virtual workspaces of the
 * current project first, then any group another project contributed, then
 * unplaced legacy agents, then cloud workspaces. Grouping is pure metadata —
 * rows are never reordered inside their group.
 */
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

function localDisplayLabel(dirName: string): string {
  try {
    return readWorkspaceDisplayName(agentDbPath(dirName)) ?? dirName;
  } catch (error) {
    const reason = renderThrownChain({ cause: error });
    diagnostics.failure(
      'workspace.read_failed',
      toKinuError({ doing: 'reading a local workspace title', cause: error, otherwise: 'io' }),
      { workspace: dirName },
    );
    return `(unreadable: ${reason})`;
  }
}

/** A local agent's row. `dirName` is the `~/.kinu/<name>` directory; the row
 *  opens under the ref's config name when a ref exists, so aliases and cloud
 *  links stay attached. The label is the workspace database's own title — the
 *  one place a rename or auto-title lands — falling back to the directory name
 *  until something names it. */
function localRow(configured: KinuAgentConfig | undefined, dirName: string): ListedAgent {
  return {
    name: configured?.name ?? dirName,
    label: localDisplayLabel(dirName),
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

/**
 * The TUI navigator roster for one directory: this project's placed agents,
 * unplaced legacy agents (openable here; opening one adopts it), and the
 * signed-in account's cloud workspaces. A cloud ref sharing a local agent's
 * name stays listed — the two are different workspaces, not one row.
 */
export function listSidebarAgents(cwd = process.cwd()): ListedAgent[] {
  const refs = listConfiguredAgentRefs();
  const byDirName = localRefsByDirName(refs);
  return [
    ...listAgentDirs(cwd).map((name) => localRow(byDirName.get(name), name)),
    ...listLegacyAgentNames().map((name) => localRow(byDirName.get(name), name)),
    ...refs
      .filter((agent) => agent.mode === 'cloud')
      .map((agent) => ({
        name: agent.name,
        label: agent.displayName ?? agent.name,
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
      label: agent.displayName,
      mode: 'cloud' as const,
      cloudName: agent.name,
    }];
  });

  return [...local, ...cloud];
}

export function listKnownAgents(): ListedAgent[] {
  const localAgents = new Set([...listAgentDirs(), ...listLegacyAgentNames()]);
  const refs = listConfiguredAgentRefs();
  const byDirName = localRefsByDirName(refs);
  return [
    ...[...localAgents].map((name) => localRow(byDirName.get(name), name)),
    ...refs
      .filter((agent) => agent.mode === 'cloud' || !localAgents.has(agent.localName ?? agent.name))
      .map((agent) => ({
        name: agent.name,
        label: agent.displayName ?? agent.name,
        mode: agent.mode,
        localName: agent.localName,
        cloudName: agent.cloudName,
        cwd: agent.cwd,
        workspaceId: agent.workspaceId,
      })),
  ];
}

/**
 * A server workspace whose name a local ref already holds on this machine.
 * The local ref stands and the cloud workspace is not recorded under that
 * name: the mode was chosen when the workspace was created, and flipping it
 * would drop a placed agent out of its project, its peer group and the
 * scheduler's roster while its files stayed on disk.
 */
export interface CloudRefCollision {
  /** The contested name, as the server spells it. */
  name: string;
  /** The local workspace directory holding it, which a ref may alias. */
  localName: string;
  cloudDisplayName: string;
}

export interface CloudRefSync {
  agents: ListedAgent[];
  /** Empty on the ordinary path. A name here reached neither store's roster
   *  as cloud, so a caller that shows the roster has to show these too. */
  collisions: CloudRefCollision[];
}

export async function syncCloudAgentRefs(): Promise<CloudRefSync> {
  const { origin, token } = requireAuthConfig();
  const cloudAgents = await listCloudAgents(origin, token);
  const now = new Date().toISOString();
  const collisions: CloudRefCollision[] = [];
  updateConfigFile((config) => {
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
