/** The agent hub's one owner: what it shows for the open workspace, read on a switch, read again when a frame names a
 *  read it shows, and its jobs' printed tails followed live. ChatApp draws it and feeds it the frames. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Effect } from 'effect';
import {
  DEFAULT_ROLE_ID, effectiveRoleCatalog, followJobOutput, ROSTER_READS, tierIdsOf,
  type JobOutputFrame, type JobOutputTail, type LiveRead, type SeekCursor, type SubordinateChild,
} from '@kinu.run/core';
import { detach, diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';
import type { AgentClient } from '../agent-client';
import { loadActiveProfile } from '../default-model';
import {
  answeredHelpers, buildAgentHubEntries, evolutionWork, jobOwners, jobWork, lastPrinted, newerTail, subordinatesFromRoster,
  workFromWorkspace, type TuiHubData, type TuiHubView, type TuiJobOwner, type TuiWorkEntry,
} from './hubs';
import type { DisplayMessage } from './messages';
import type { TuiAgentRoster } from './tui-shell';

const HUB_READS: ReadonlySet<string> = new Set<LiveRead>([...ROSTER_READS, 'listWorkspaceWork', 'listBackgroundJobs']);

export function useHub({ client, seed, readHub, view, roster, label, running, projectRoot, messages }: {
  client: AgentClient;
  /** What the host already read for the first workspace. */
  seed: TuiHubData | undefined;
  readHub: ((client: AgentClient) => Promise<TuiHubData>) | undefined;
  view: TuiHubView | null;
  roster: TuiAgentRoster;
  /** The open workspace's own name, once its status has answered. */
  label: string | undefined;
  running: boolean;
  projectRoot: string;
  messages: readonly DisplayMessage[];
}) {
  // The hub carries its workspace's identity so a switch resets it alongside other per-client state.
  const [hub, setHub] = useState<{ identity: string; data: TuiHubData } | null>(
    () => (seed ? { identity: `${client.mode}:${client.agentName}`, data: seed } : null),
  );

  useEffect(() => {
    const identity = `${client.mode}:${client.agentName}`;

    if (hub !== null && hub.identity === identity) return;
    const abort = new AbortController();
    detach(Effect.promise(async () => {
      try {
        const fresh = await (readHub ?? loadHubData)(client);

        if (!abort.signal.aborted) setHub({ identity, data: fresh });
      } catch (cause) {
        diagnostics.failure(
          'tui.hub_refresh_failed',
          toKinuError({ doing: 'refreshing the agent hub', cause, otherwise: 'unavailable' }),
          { workspace: client.agentName },
        );
      }
    }));

    return () => { abort.abort(); };
  }, [client, hub, readHub]);

  // Only the open agent's roster is read.
  const shownRoster = useMemo(() => {
    const subordinates = hub?.identity === `${client.mode}:${client.agentName}` ? hub.data.subordinates : [];

    if (subordinates.length === 0) return roster;

    const items = roster.page.items.map((item) => (item.name === client.agentName && item.mode === client.mode
      ? { ...item, subordinates }
      : item));

    return { ...roster, page: { ...roster.page, items } };
  }, [client, hub, roster]);

  const [jobTails, setJobTails] = useState<Readonly<Record<string, JobOutputTail>>>({});
  const listedTails = useRef<Readonly<Record<string, JobOutputTail>>>({});

  useEffect(() => {
    listedTails.current = Object.fromEntries((hub?.data.work ?? []).flatMap((item) => (item.output === undefined ? [] : [[item.id.replace(/^job:/, ''), item.output]])));
  }, [hub]);

  const live = useMemo<TuiHubData | undefined>(() => !hub ? undefined : {
    ...hub.data,
    work: hub.data.work.map((item) => {
      const printed = lastPrinted(newerTail(jobTails[item.id.replace(/^job:/, '')], item.output));

      return item.id.startsWith('job:') && printed !== undefined ? { ...item, printed } : item;
    }),
    agents: buildAgentHubEntries({
      items: roster.page.items,
      subordinates: hub.identity === `${client.mode}:${client.agentName}` ? hub.data.subordinates : [],
      current: { name: client.agentName, mode: client.mode },
      currentEntry: {
        ...(hub.data.agents[0] ?? { kind: 'main' as const }),
        id: `${client.mode}:${client.agentName}`,
        label: label ?? client.agentName,
        kind: 'main',
        status: running ? 'running' : 'idle',
        workspace: hub.data.agents[0]?.workspace ?? client.agentName,
      },
      projectRoot,
    }),
  }, [hub, roster.page.items, client, label, running, projectRoot, jobTails]);

  const answered = useMemo(() => answeredHelpers(messages, hub?.data.helpers ?? []), [messages, hub]);
  // Bumped by each frame naming a read the hub shows, so the hub reads again.
  const [hubReadsMoved, setHubReadsMoved] = useState(0);

  const readsChanged = useCallback((reads: readonly string[]) => {
    if (reads.some((read) => HUB_READS.has(read))) setHubReadsMoved((moves) => moves + 1);
  }, []);

  useEffect(() => {
    if (view !== 'agents') return;
    const identity = `${client.mode}:${client.agentName}`;
    let open = true;

    detach(Effect.promise(async () => {
      const read = await readRoster(client);

      if (!open) return;

      setHub((current) => (current?.identity === identity
        ? { ...current, data: { agents: current.data.agents, profile: current.data.profile, ...read } }
        : current));
    }));

    return () => { open = false; };
  }, [client, view, hubReadsMoved]);
  const reset = useCallback(() => setHub(null), []);

  const jobOutput = useCallback((frame: JobOutputFrame) => {
    setJobTails((tails) => ({ ...tails, [frame.jobId]: followJobOutput(newerTail(tails[frame.jobId], listedTails.current[frame.jobId]), frame) }));
  }, []);

  return { hub, live, shownRoster, answered, reset, jobOutput, readsChanged };
}

/** Everything the hub shows for `client`'s workspace, read once: its profile, its agents and their work. */
export async function loadHubData(client: AgentClient): Promise<TuiHubData> {
  const workspace = client.agentName;
  const [envelope, status, roster] = await Promise.all([loadActiveProfile(), client.status(), readRoster(client)]);
  const roles = effectiveRoleCatalog(envelope.catalog);
  const activeRoleId = status.roleId && roles[status.roleId] ? status.roleId : DEFAULT_ROLE_ID;
  const tierId = status.tierId && tierIdsOf(envelope.catalog).includes(status.tierId) ? status.tierId : roles[activeRoleId]?.tier ?? 'default';

  return {
    agents: [{
      id: workspace,
      label: status.name,
      kind: 'main',
      status: 'idle',
      roleId: activeRoleId,
      tierId,
      workspace,
    }],
    ...roster,
    profile: {
      envelope,
      activeRoleId,
      allowedRoleIds: Object.keys(roles),
    },
  };
}

async function readRoster(client: AgentClient): Promise<Pick<TuiHubData, 'subordinates' | 'subordinatesError' | 'work' | 'workError' | 'helpers'>> {
  const [subordinates, work] = await Promise.allSettled([readSubordinates(client), client.workspaceWork()]);
  const owners = subordinates.status === 'fulfilled' ? subordinates.value.owners : [];
  // Each agent's own jobs, the workspace's first, each under the agent that runs it.
  const jobs = await Promise.allSettled([client.listJobs(20), ...owners.map((owner) => client.listJobs(20, owner.name))]);
  const jobRows = jobs.flatMap((listed, at) => (listed.status === 'fulfilled' ? jobWork(listed.value, owners[at - 1]) : []));
  const evolution = [...jobRows, ...subordinates.status === 'fulfilled' ? subordinates.value.evolution : []];

  return {
    ...(subordinates.status === 'fulfilled'
      ? { subordinates: subordinates.value.subordinates, helpers: subordinates.value.helpers }
      : { subordinates: [], helpers: [], subordinatesError: `Subagents could not be read: ${renderThrownChain({ cause: subordinates.reason })}` }),
    ...(work.status === 'fulfilled'
      ? { work: [...workFromWorkspace(work.value), ...evolution] }
      : { work: evolution, workError: `Work could not be read: ${renderThrownChain({ cause: work.reason })}` }),
  };
}

async function readSubordinates(client: AgentClient): Promise<Pick<TuiHubData, 'subordinates' | 'helpers'> & { evolution: TuiWorkEntry[]; owners: TuiJobOwner[] }> {
  const entries: SubordinateChild[] = [];
  let cursor: SeekCursor | undefined;

  do {
    const result = await client.inspectSubordinate({ path: [], view: 'children', page: cursor === undefined ? {} : { cursor } });

    if (result.view !== 'children') break;
    entries.push(...result.page.items);
    cursor = result.page.status === 'more' ? result.page.next : undefined;
  } while (cursor !== undefined);

  const helpers = entries.flatMap((entry) => entry.lifetime === 'task' && entry.actorReference !== null
    ? [{ name: entry.name, actorId: entry.actorReference.actorId }]
    : []);

  return { subordinates: subordinatesFromRoster(entries), helpers, evolution: evolutionWork(entries), owners: jobOwners(entries) };
}
