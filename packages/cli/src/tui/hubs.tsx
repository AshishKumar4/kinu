import { tierIdsOf,
  deriveRoleLabel,
  effectiveRoleCatalog,
  type ProfileCatalogEnvelope,
  type ResolvedTurnProfile,
  type RoleId,
  type SubordinateChild,
  type WorkspaceWork,
  taskTreePhase,
  type JobOutputTail,
  evolutionHelper, jobName, lastOutputLines, ownerFacingSubordinate,
} from '@kinu.run/core';
import type { AgentJobSummary } from '../agent-client';
import type { ScrollBoxRenderable } from '@opentui/core';
import { agentWorkspaceKey } from '../agent-list';
import type { TuiAgentStatus, TuiAgentSummary, TuiSubordinate } from './tui-shell';
import { agentDisplayLabel } from '@kinu.run/core/tui';
import { MessageList, type DisplayMessage } from './messages';
import * as v from 'valibot';
import { useTuiTheme, type TuiThemeColors } from './theme';

export type TuiHubView = 'agents' | 'roles' | 'tiers';

export interface TuiAgentHubEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: 'main' | 'subordinate' | 'swarm-node';
  readonly status: 'idle' | 'running' | 'needs-you' | 'failed' | 'settled';

  /** A peer's database is not opened just to label a row. */
  readonly roleId?: string;
  readonly tierId?: string;
  readonly workspace: string;
  readonly task?: string;
  readonly current?: boolean;
  /** Set only where its conversation can be read. */
  readonly path?: readonly string[];
}

type HubEntryDraft = { -readonly [Key in keyof TuiAgentHubEntry]: TuiAgentHubEntry[Key] };

export interface TuiHubRow extends Pick<TuiAgentHubEntry, 'id' | 'label' | 'path'> {
  readonly actorId?: string;
}

export interface TuiWorkEntry extends TuiHubRow {
  readonly title: string;
  readonly status: TuiAgentHubEntry['status'];
  readonly printed?: string;
  readonly output?: JobOutputTail;
}

type WorkEntryDraft = { -readonly [Key in keyof TuiWorkEntry]: TuiWorkEntry[Key] };

export function workFromWorkspace(work: WorkspaceWork): TuiWorkEntry[] {
  const entries = [...work.tasks, ...work.plans].flatMap(({ owner, tasks }) => tasks.map((task): TuiWorkEntry => {
    const entry: WorkEntryDraft = {
      id: `task:${owner.actorId}:${task.id}`, title: task.title, label: owner.name, actorId: owner.actorId, status: taskTreePhase(task),
    };

    if (owner.path !== null && owner.path.length > 0) entry.path = owner.path;

    return entry;
  }));

  return [...entries.filter((entry) => entry.status !== 'settled'), ...entries.filter((entry) => entry.status === 'settled')];
}

export function newerTail(held: JobOutputTail | undefined, listed: JobOutputTail | undefined): JobOutputTail | undefined {
  return held === undefined || (listed !== undefined && listed.seq > held.seq) ? listed : held;
}

export function lastPrinted(output: JobOutputTail | undefined): string | undefined {
  const printed = lastOutputLines(output, 1).join(' ');

  return printed === '' ? undefined : printed;
}

export interface TuiJobOwner {
  readonly name: string;
  readonly label: string;
  readonly actorId: string;
}

export function jobOwners(entries: readonly SubordinateChild[]): TuiJobOwner[] {
  return entries.flatMap((entry) => (entry.status === 'dismissed' || entry.actorReference === null ? [] : [{
    name: entry.name, label: agentDisplayLabel({ name: entry.name, label: entry.displayName }), actorId: entry.actorReference.actorId,
  }]));
}

/** `owner` absent: the workspace's own jobs. */
export function jobWork(jobs: readonly AgentJobSummary[], owner?: TuiJobOwner): TuiWorkEntry[] {
  return jobs.filter((job) => job.status === 'running' || job.status === 'serving').map((job) => {
    const { title, shortId } = jobName(job);
    const entry: WorkEntryDraft = { id: `job:${job.id}`, title, label: `${owner === undefined ? '' : `${owner.label} · `}${shortId} · ${job.status}`, status: 'running' };

    if (owner !== undefined) {
      entry.path = [owner.name];
      entry.actorId = owner.actorId;
    }

    const printed = lastPrinted(job.output);

    if (printed !== undefined) entry.printed = printed;

    if (job.output !== undefined) entry.output = job.output;

    return entry;
  });
}

const HELPER_WORK_STATUS = {
  idle: 'settled',
  working: 'running',
  awaiting_input: 'needs-you',
  dismissed: 'settled',
} as const satisfies Record<SubordinateChild['status'], TuiWorkEntry['status']>;

export function evolutionWork(entries: readonly SubordinateChild[]): TuiWorkEntry[] {
  return entries.flatMap((entry): TuiWorkEntry[] => (evolutionHelper(entry) && entry.actorReference !== null ? [{
    id: `helper:${entry.actorReference.actorId}`, title: entry.currentTask ?? 'refining from recent turns',
    label: agentDisplayLabel({ name: entry.name, label: entry.displayName }), path: [entry.name], actorId: entry.actorReference.actorId,
    status: HELPER_WORK_STATUS[entry.status],
  }] : []));
}

export interface TuiHelperRef {
  readonly name: string;
  readonly actorId: string;
}

const AnsweredHelperSchema = v.looseObject({ agent: v.string(), lifetime: v.literal('task') });

/** Newest first. */
export function answeredHelpers(messages: readonly DisplayMessage[], helpers: readonly TuiHelperRef[]): TuiHubRow[] {
  const rows: TuiHubRow[] = [];

  for (const message of [...messages].reverse()) {
    if (message.role !== 'tool_result' || message.toolName !== 'agents') continue;
    const answered = v.safeParse(v.pipe(v.string(), v.parseJson(), AnsweredHelperSchema), message.content);
    const helper = answered.success ? helpers.find((entry) => entry.name === answered.output.agent) : undefined;

    if (helper !== undefined && !rows.some((row) => row.actorId === helper.actorId)) {
      rows.push({ id: `helper:${helper.actorId}`, label: helper.name, path: [helper.name], actorId: helper.actorId });
    }
  }

  return rows;
}

type SubordinateDraft = { -readonly [Key in keyof TuiSubordinate]: TuiSubordinate[Key] };

const AGENT_KIND_LABEL = {
  main: 'main',
  subordinate: 'agent',
  'swarm-node': 'swarm node',
} as const satisfies Record<TuiAgentHubEntry['kind'], string>;

/** Cloud workspaces list the open workspace only: the CLI holds no facet roster. */
export function buildAgentHubEntries(input: {
  items: readonly TuiAgentSummary[];
  current: { name: string; mode: 'local' | 'cloud' };
  currentEntry: TuiAgentHubEntry;
  subordinates: readonly TuiSubordinate[];
  projectRoot: string;
}): TuiAgentHubEntry[] {
  const { items, current, currentEntry, projectRoot } = input;
  const currentRow = items.find((item) => item.name === current.name && item.mode === current.mode);
  const groupKey = currentRow ? agentWorkspaceKey(currentRow, projectRoot) : null;

  const sameProject = current.mode === 'local' && currentRow !== undefined && groupKey !== null;
  const alone = currentRow === undefined ? [] : [currentRow];

  const members = sameProject
    ? items.filter((item) => item.mode === 'local' && agentWorkspaceKey(item, projectRoot) === groupKey)
    : alone;

  const nestedUnder = (parentId: string, own: boolean, workspace: string, subordinates: readonly TuiSubordinate[]) =>
    subordinates.map((subordinate): TuiAgentHubEntry => {
      const row: HubEntryDraft = {
        id: `${parentId}/${subordinate.id}`,
        label: agentDisplayLabel({ name: subordinate.id, label: subordinate.label }),
        kind: 'subordinate',
        status: subordinate.status,
        workspace,
      };

      if (subordinate.task !== undefined) row.task = subordinate.task;

      if (own) row.path = [subordinate.id];

      // Role and tier render as one pair: knowing only half shows neither.
      if (subordinate.roleId !== undefined && subordinate.tierId !== undefined) {
        row.roleId = subordinate.roleId;
        row.tierId = subordinate.tierId;
      }

      return row;
    });

  if (members.length === 0) return [currentEntry, ...nestedUnder(currentEntry.id, true, currentEntry.workspace, input.subordinates)];

  const workspace = current.mode === 'local'
    ? (currentRow?.workspaceId ?? currentEntry.workspace)
    : currentEntry.workspace;

  return members.flatMap((member) => {
    const own = member.name === current.name && member.mode === current.mode;

    // The roster label is the display authority; the live entry adds only role/tier and status.
    const row: TuiAgentHubEntry = own
      ? { ...currentEntry, label: agentDisplayLabel(member), workspace, current: true }
      : {
          id: `${member.mode}:${member.name}`,
          label: agentDisplayLabel(member),
          kind: 'main',
          status: member.status ?? 'idle',
          workspace,
        };

    return [row, ...nestedUnder(`${member.mode}:${member.name}`, own, workspace, own ? input.subordinates : (member.subordinates ?? []))];
  });
}

interface TuiProfileHubData {
  readonly envelope: ProfileCatalogEnvelope;
  readonly activeRoleId: RoleId;
  readonly allowedRoleIds: readonly RoleId[];
  readonly resolved?: ResolvedTurnProfile;
}

export interface TuiHubData {
  readonly agents: readonly TuiAgentHubEntry[];
  readonly subordinates: readonly TuiSubordinate[];
  readonly subordinatesError?: string;
  readonly work: readonly TuiWorkEntry[];
  readonly workError?: string;
  readonly helpers: readonly TuiHelperRef[];
  readonly answered?: readonly TuiHubRow[];
  readonly profile: TuiProfileHubData;
}

const ROSTER_STATUS = {
  idle: 'idle',
  working: 'running',
  awaiting_input: 'needs-you',
} as const satisfies Record<Exclude<SubordinateChild['status'], 'dismissed'>, TuiAgentStatus>;

export function subordinatesFromRoster(entries: readonly SubordinateChild[]): TuiSubordinate[] {
  return entries.flatMap((entry): TuiSubordinate[] => {
    if (entry.status === 'dismissed' || entry.deleteRequested || !ownerFacingSubordinate(entry)) return [];
    const seed = entry.birth?.seed;

    const subordinate: SubordinateDraft = {
      id: entry.name,
      label: agentDisplayLabel({ name: entry.name, label: entry.displayName }),
      status: ROSTER_STATUS[entry.status],
    };

    if (entry.currentTask !== null) subordinate.task = entry.currentTask;

    if (seed?.tier !== undefined) {
      subordinate.roleId = seed.role;
      subordinate.tierId = seed.tier;
    }

    return [subordinate];
  });
}

const WORK_MARK = { running: '● ', idle: '○ ', 'needs-you': '○ ', failed: '○ ', settled: '✓ ' } as const satisfies Record<TuiWorkEntry['status'], string>;

const HUB_TITLES = { agents: 'Agent Hub', roles: 'Role Hub', tiers: 'Tier Hub' } as const;

function roleStateColor(colors: TuiThemeColors, active: boolean, available: boolean): string {
  if (active) return colors.intent.accent;

  return available ? colors.intent.success : colors.text.muted;
}

function roleStateMark(active: boolean, available: boolean): string {
  if (active) return '● ';

  return available ? '○ ' : '× ';
}

export function HubOverlay(props: {
  readonly view: TuiHubView;
  readonly data: TuiHubData;
  readonly width: number;
  readonly height: number;
  /** Absent without `onNewAgent`. */
  readonly newAgentHint?: string;
  readonly selectedAgentId?: string | null;
}) {
  const { colors } = useTuiTheme();
  const panelWidth = Math.min(Math.max(34, Math.floor(props.width * 0.72)), 88, Math.max(1, props.width - 2));
  const panelHeight = Math.min(Math.max(12, Math.floor(props.height * 0.72)), 28, Math.max(3, props.height - 2));
  const title = HUB_TITLES[props.view];

  return (
    <box
      flexDirection="column"
      style={{
        position: 'absolute',
        zIndex: 71,
        top: Math.max(1, Math.floor((props.height - panelHeight) / 2)),
        left: Math.max(1, Math.floor((props.width - panelWidth) / 2)),
        width: panelWidth,
        height: panelHeight,
        border: true,
        borderStyle: 'rounded',
        borderColor: colors.border.strong,
        backgroundColor: colors.background.overlay,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 1,
        paddingBottom: 1,
      }}
      title={`${title} · Esc close`}
    >
      <text>
        <span fg={props.view === 'agents' ? colors.intent.accent : colors.text.muted}>Agents</span>
        <span fg={colors.border.strong}> · </span>
        <span fg={props.view === 'roles' ? colors.intent.accent : colors.text.muted}>Roles</span>
        <span fg={colors.border.strong}> · </span>
        <span fg={props.view === 'tiers' ? colors.intent.accent : colors.text.muted}>Tiers</span>
      </text>
      {props.view === 'agents' && (
        <AgentHubRows data={props.data} newAgentHint={props.newAgentHint} selectedAgentId={props.selectedAgentId ?? null} />
      )}
      {props.view === 'roles' && <RoleHubRows data={props.data.profile} />}
      {props.view === 'tiers' && <TierHubRows data={props.data.profile} />}
    </box>
  );
}

function AgentHubRows({ data, newAgentHint, selectedAgentId }: {
  readonly data: TuiHubData;
  readonly newAgentHint?: string | undefined;
  readonly selectedAgentId: string | null;
}) {
  const { colors } = useTuiTheme();

  const hint = newAgentHint !== undefined && (
    <text>
      <span fg={colors.intent.accent}>{newAgentHint}</span>
      <span fg={colors.text.muted}> new agent. It names itself from your first message</span>
    </text>
  );

  if (data.agents.length === 0) {
    return (
      <box flexDirection="column" style={{ marginTop: 1 }}>
        <text><span fg={colors.text.muted}>No other agents are active in this workspace.</span></text>
        {hint}
      </box>
    );
  }

  const workspaces: { name: string; agents: TuiAgentHubEntry[] }[] = [];

  for (const agent of data.agents) {
    const group = workspaces.find((entry) => entry.name === agent.workspace);

    if (group === undefined) workspaces.push({ name: agent.workspace, agents: [agent] });
    else group.agents.push(agent);
  }

  return (
    <box flexDirection="column" style={{ marginTop: 1 }}>
      {workspaces.map((workspace) => (
        <box key={workspace.name} flexDirection="column" style={{ marginBottom: 1 }}>
          <text><span fg={colors.text.muted}>{workspace.name}</span></text>
          {workspace.agents.map((agent) => (
            <box key={agent.id} flexDirection="column" style={{ backgroundColor: agent.id === selectedAgentId ? colors.background.selection : colors.background.recessed, paddingLeft: 1, paddingRight: 1 }}>
              <text>
                {agent.kind !== 'main' && <span fg={colors.border.strong}>└ </span>}
                <span fg={statusColor(agent.status, colors)}>{agent.status === 'running' ? '● ' : '○ '}</span>
                <strong fg={colors.text.strong}>{agent.label}</strong>
                <span fg={colors.text.muted}> · {AGENT_KIND_LABEL[agent.kind]}{agent.roleId !== undefined && agent.tierId !== undefined ? ` · ${agent.roleId}/${agent.tierId}` : ''}{agent.current === true ? ' · open' : ''}</span>
              </text>
              {agent.task !== undefined && <text><span fg={colors.text.muted}>{agent.kind === 'main' ? '' : '  '}{agent.task}</span></text>}
            </box>
          ))}
        </box>
      ))}
      {data.work.length > 0 && (
        <box flexDirection="column" style={{ marginBottom: 1 }}>
          <text><span fg={colors.text.muted}>Work</span></text>
          {data.work.map((item) => (
            <box key={item.id} style={{ backgroundColor: item.id === selectedAgentId ? colors.background.selection : colors.background.recessed, paddingLeft: 1, paddingRight: 1 }}>
              <text>
                <span fg={statusColor(item.status, colors)}>{WORK_MARK[item.status]}</span>
                <strong fg={colors.text.strong}>{item.title}</strong>
                <span fg={colors.text.muted}> · {item.label}</span>
              </text>
              {item.printed !== undefined && <text><span fg={colors.text.muted}>  {item.printed}</span></text>}
            </box>
          ))}
        </box>
      )}
      {(data.answered?.length ?? 0) > 0 && (
        <box flexDirection="column" style={{ marginBottom: 1 }}>
          <text><span fg={colors.text.muted}>Answered</span></text>
          {data.answered?.map((row) => (
            <box key={row.id} style={{ backgroundColor: row.id === selectedAgentId ? colors.background.selection : colors.background.recessed, paddingLeft: 1, paddingRight: 1 }}>
              <text><span fg={colors.text.muted}>{WORK_MARK.settled}</span><strong fg={colors.text.strong}>{row.label}</strong></text>
            </box>
          ))}
        </box>
      )}
      {data.subordinatesError !== undefined && (
        <text><span fg={colors.intent.danger}>{data.subordinatesError}</span></text>
      )}
      {data.workError !== undefined && (
        <text><span fg={colors.intent.danger}>{data.workError}</span></text>
      )}
      {[...data.agents, ...data.work, ...(data.answered ?? [])].some((row) => row.path !== undefined) && (
        <text><span fg={colors.text.muted}>↑↓ choose · Enter opens a subagent's conversation</span></text>
      )}
      {hint}
    </box>
  );
}

function RoleHubRows({ data }: { readonly data: TuiProfileHubData }) {
  const { colors } = useTuiTheme();
  const allowed = new Set(data.allowedRoleIds);
  const roles = effectiveRoleCatalog(data.envelope.catalog);

  return (
    <box flexDirection="column" style={{ marginTop: 1 }}>
      {Object.entries(roles).map(([roleId, role]) => {
        const active = roleId === data.activeRoleId;
        const available = allowed.has(roleId);

        return (
          <box key={roleId} flexDirection="column" style={{ height: 2, marginBottom: 1, backgroundColor: active ? colors.background.selection : colors.background.recessed, paddingLeft: 1, paddingRight: 1 }}>
            <text>
              <span fg={roleStateColor(colors, active, available)}>{roleStateMark(active, available)}</span>
              <strong fg={active ? colors.text.strong : colors.text.primary}>{role.label ?? deriveRoleLabel(roleId)}</strong>
              <span fg={colors.text.muted}> · {role.tier} · {role.preset}</span>
            </text>
            <text><span fg={colors.text.muted}>{role.description}</span></text>
          </box>
        );
      })}
      <text><span fg={colors.text.muted}>A role sets an agent's instructions and tier. /role changes this agent's.</span></text>
    </box>
  );
}

function TierHubRows({ data }: { readonly data: TuiProfileHubData }) {
  const { colors } = useTuiTheme();
  const defaultAssignment = data.envelope.catalog.tiers.default;

  return (
    <box flexDirection="column" style={{ marginTop: 1 }}>
      {tierIdsOf(data.envelope.catalog).map((tierId) => {
        const configured = data.envelope.catalog.tiers[tierId];
        const assignment = configured ?? defaultAssignment;
        const active = data.resolved?.tier.id === tierId;

        return (
          <box key={tierId} flexDirection="column" style={{ marginBottom: 1, backgroundColor: active ? colors.background.selection : colors.background.recessed, paddingLeft: 1, paddingRight: 1 }}>
            <text>
              <span fg={active ? colors.intent.accent : colors.text.primary}>{tierId}{configured === undefined && tierId !== 'default' ? ' → default' : ''}</span>
              <span fg={colors.text.muted}> · {assignment.model} · {assignment.reasoningEffort ?? 'provider effort'}</span>
            </text>
          </box>
        );
      })}
      <text><span fg={colors.text.muted}>A tier is a model and an effort you named. /model and /effort set this workspace's own.</span></text>
    </box>
  );
}

export interface TuiSubagentChat {
  readonly name: string;
  readonly label: string;
  /** Null while loading. */
  readonly messages: DisplayMessage[] | null;
  readonly error: string | null;
}

export function SubagentChatOverlay(props: {
  readonly chat: TuiSubagentChat;
  readonly width: number;
  readonly height: number;
  readonly scrollRef: (value: ScrollBoxRenderable | null) => void;
}) {
  const { colors } = useTuiTheme();
  const { chat } = props;
  const panelWidth = Math.max(1, Math.min(120, props.width - 2));
  const panelHeight = Math.max(3, props.height - 2);
  const note = (fg: string, text: string) => <text><span fg={fg}>{text}</span></text>;
  let body = note(colors.text.muted, 'Reading its conversation…');

  if (chat.error !== null) body = note(colors.intent.danger, chat.error);
  else if (chat.messages?.length === 0) body = note(colors.text.muted, 'No messages yet.');
  else if (chat.messages !== null) {
    body = (
      <scrollbox
        ref={props.scrollRef}
        stickyScroll={true}
        stickyStart="bottom"
        style={{
          flexGrow: 1,
          rootOptions: { backgroundColor: colors.background.overlay },
          viewportOptions: { backgroundColor: colors.background.overlay },
          contentOptions: { backgroundColor: colors.background.overlay },
        }}
      >
        <MessageList messages={chat.messages} />
      </scrollbox>
    );
  }

  return (
    <box
      flexDirection="column"
      style={{
        position: 'absolute',
        zIndex: 72,
        top: 1,
        left: Math.max(0, Math.floor((props.width - panelWidth) / 2)),
        width: panelWidth,
        height: panelHeight,
        border: true,
        borderStyle: 'rounded',
        borderColor: colors.border.strong,
        backgroundColor: colors.background.overlay,
        paddingLeft: 1,
        paddingRight: 1,
      }}
      title={`${agentDisplayLabel({ name: chat.name, label: chat.label })} · subagent · ↑↓ scroll · Esc back`}
    >
      {body}
    </box>
  );
}

function statusColor(status: TuiAgentHubEntry['status'], colors: TuiThemeColors): string {
  if (status === 'running') return colors.intent.accent;

  if (status === 'needs-you') return colors.intent.warning;

  if (status === 'failed') return colors.intent.danger;

  if (status === 'settled') return colors.intent.success;

  return colors.text.muted;
}
