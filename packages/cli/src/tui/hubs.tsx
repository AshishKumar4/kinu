import {
  TIER_IDS,
  deriveRoleLabel,
  effectiveRoleCatalog,
  type ProfileCatalogEnvelope,
  type ResolvedTurnProfile,
  type RoleId,
} from '@kinu.run/core';
import { agentWorkspaceKey } from '../agent-list';
import type { TuiAgentSummary } from './tui-shell';
import { agentDisplayLabel } from './format';
import { useTuiTheme, type TuiThemeColors } from './theme';

export type TuiHubView = 'agents' | 'roles' | 'tiers';

export interface TuiAgentHubEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: 'main' | 'subordinate' | 'swarm-node';
  readonly status: 'idle' | 'running' | 'needs-you' | 'failed' | 'settled';
  /** Role/tier are shown when known — the open agent's come from its live
   *  status; a peer's own database is not opened just to label a row. */
  readonly roleId?: string;
  readonly tierId?: string;
  readonly workspace: string;
  readonly task?: string;
  /** The conversation this TUI session has open. */
  readonly current?: boolean;
}

/**
 * The Agent Hub's rows, projected live from the navigator roster: the current
 * VIRTUAL WORKSPACE's members — peers as equals, their subordinates nested —
 * with the open agent carrying its live role/tier. Cloud workspaces list the
 * open workspace only: the CLI holds no facet roster for one.
 */
export function buildAgentHubEntries(input: {
  items: readonly TuiAgentSummary[];
  current: { name: string; mode: 'local' | 'cloud' };
  /** The open agent's own live row (role/tier from its status). */
  currentEntry: TuiAgentHubEntry;
  projectRoot: string;
}): TuiAgentHubEntry[] {
  const { items, current, currentEntry, projectRoot } = input;
  const currentRow = items.find((item) => item.name === current.name && item.mode === current.mode);
  const groupKey = currentRow ? agentWorkspaceKey(currentRow, projectRoot) : null;
  const members = current.mode === 'local' && currentRow && groupKey !== null && groupKey !== 'unplaced'
    ? items.filter((item) => item.mode === 'local' && agentWorkspaceKey(item, projectRoot) === groupKey)
    : currentRow ? [currentRow] : [];
  if (members.length === 0) return [currentEntry];
  const workspace = current.mode === 'local'
    ? (currentRow?.workspaceId ?? currentEntry.workspace)
    : currentEntry.workspace;
  return members.flatMap((member) => {
    const own = member.name === current.name && member.mode === current.mode;
    // The roster's label is the display authority (an untitled agent carries
    // ''); the live entry keeps only role/tier and the running status.
    const row: TuiAgentHubEntry = own
      ? { ...currentEntry, label: agentDisplayLabel(member.label), workspace, current: true }
      : {
          id: `${member.mode}:${member.name}`,
          label: agentDisplayLabel(member.label),
          kind: 'main',
          status: member.status ?? 'idle',
          workspace,
        };
    const nested = (member.subordinates ?? []).map((subordinate): TuiAgentHubEntry => {
      const base = {
        id: `${member.mode}:${member.name}/${subordinate.id}`,
        label: agentDisplayLabel(subordinate.label),
        kind: 'subordinate',
        status: subordinate.status,
        workspace,
      } satisfies TuiAgentHubEntry;
      // Role and tier render as one `role/tier` pair, so they are carried as
      // one: a row that knows only half shows neither.
      if (subordinate.roleId === undefined || subordinate.tierId === undefined) return base;
      return { ...base, roleId: subordinate.roleId, tierId: subordinate.tierId };
    });
    return [row, ...nested];
  });
}

export interface TuiProfileHubData {
  readonly envelope: ProfileCatalogEnvelope;
  readonly activeRoleId: RoleId;
  readonly allowedRoleIds: readonly RoleId[];
  readonly resolved?: ResolvedTurnProfile;
}

export interface TuiHubData {
  readonly agents: readonly TuiAgentHubEntry[];
  readonly profile: TuiProfileHubData;
}

export function HubOverlay(props: {
  readonly view: TuiHubView;
  readonly data: TuiHubData;
  readonly width: number;
  readonly height: number;
  /** The keybinding hint for one-click creation, shown on the agents view.
   *  Absent when the host wired no creator (`onNewAgent`). */
  readonly newAgentHint?: string;
}) {
  const { colors } = useTuiTheme();
  const panelWidth = Math.min(Math.max(34, Math.floor(props.width * 0.72)), 88, Math.max(1, props.width - 2));
  const panelHeight = Math.min(Math.max(12, Math.floor(props.height * 0.72)), 28, Math.max(3, props.height - 2));
  const title = props.view === 'agents' ? 'Agent Hub' : props.view === 'roles' ? 'Role Hub' : 'Tier Hub';
  return (
    <>
      <box style={{ position: 'absolute', zIndex: 70, top: 0, left: 0, width: '100%', height: '100%', backgroundColor: colors.background.canvas, opacity: 0.78 }} />
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
          borderColor: colors.border.focus,
          backgroundColor: colors.background.surface,
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
          <AgentHubRows data={props.data} newAgentHint={props.newAgentHint} />
        )}
        {props.view === 'roles' && <RoleHubRows data={props.data.profile} />}
        {props.view === 'tiers' && <TierHubRows data={props.data.profile} />}
      </box>
    </>
  );
}

function AgentHubRows({ data, newAgentHint }: {
  readonly data: TuiHubData;
  readonly newAgentHint?: string | undefined;
}) {
  const { colors } = useTuiTheme();
  const hint = newAgentHint !== undefined && (
    <text>
      <span fg={colors.intent.accent}>{newAgentHint}</span>
      <span fg={colors.text.muted}> new agent — one click, no form; it names itself from your first message</span>
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
            <box key={agent.id} flexDirection="column" style={{ backgroundColor: colors.background.recessed, paddingLeft: 1, paddingRight: 1 }}>
              <text>
                {agent.kind !== 'main' && <span fg={colors.border.strong}>└ </span>}
                <span fg={statusColor(agent.status, colors)}>{agent.status === 'running' ? '● ' : '○ '}</span>
                <strong fg={colors.text.strong}>{agent.label}</strong>
                <span fg={colors.text.muted}> · {agent.kind}{agent.roleId !== undefined && agent.tierId !== undefined ? ` · ${agent.roleId}/${agent.tierId}` : ''}{agent.current === true ? ' · open' : ''}</span>
              </text>
              {agent.task !== undefined && <text><span fg={colors.text.muted}>{agent.kind === 'main' ? '' : '  '}{agent.task}</span></text>}
            </box>
          ))}
        </box>
      ))}
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
          <box key={roleId} flexDirection="column" style={{ height: 2, marginBottom: 1, backgroundColor: active ? colors.background.selectionStrong : colors.background.recessed, paddingLeft: 1, paddingRight: 1 }}>
            <text>
              <span fg={active ? colors.intent.accent : available ? colors.intent.success : colors.text.muted}>{active ? '● ' : available ? '○ ' : '× '}</span>
              <strong fg={active ? colors.text.strong : colors.text.primary}>{role.label ?? deriveRoleLabel(roleId)}</strong>
              <span fg={colors.text.muted}> · {role.tier} · {role.preset}</span>
            </text>
            <text><span fg={colors.text.muted}>{role.description}</span></text>
          </box>
        );
      })}
      <text><span fg={colors.text.muted}>Roles narrow capabilities. They never widen owner permissions.</span></text>
    </box>
  );
}

function TierHubRows({ data }: { readonly data: TuiProfileHubData }) {
  const { colors } = useTuiTheme();
  const defaultAssignment = data.envelope.catalog.tiers.default;
  return (
    <box flexDirection="column" style={{ marginTop: 1 }}>
      {TIER_IDS.map((tierId) => {
        const configured = data.envelope.catalog.tiers[tierId];
        const assignment = configured ?? defaultAssignment;
        const active = data.resolved?.tier.id === tierId;
        return (
          <box key={tierId} flexDirection="column" style={{ marginBottom: 1, backgroundColor: active ? colors.background.selectionStrong : colors.background.recessed, paddingLeft: 1, paddingRight: 1 }}>
            <text>
              <span fg={active ? colors.intent.accent : colors.text.primary}>{tierId}{configured === undefined && tierId !== 'default' ? ' → default' : ''}</span>
              <span fg={colors.text.muted}> · {assignment.model} · {assignment.reasoningEffort ?? 'provider effort'}</span>
            </text>
          </box>
        );
      })}
      <text><span fg={colors.text.muted}>Tier names are configured routes. They do not infer price, speed, or quality.</span></text>
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
