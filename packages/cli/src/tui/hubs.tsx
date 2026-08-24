import {
  TIER_IDS,
  deriveRoleLabel,
  effectiveRoleCatalog,
  type ProfileCatalogEnvelope,
  type ResolvedTurnProfile,
  type RoleId,
  type TierId,
} from '@kinu.run/core';
import { useTuiTheme, type TuiThemeColors } from './theme';

export type TuiHubView = 'agents' | 'roles' | 'tiers';

export interface TuiAgentHubEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: 'main' | 'subordinate' | 'swarm-node';
  readonly status: 'idle' | 'running' | 'needs-you' | 'failed' | 'settled';
  readonly roleId: RoleId;
  readonly tierId: TierId;
  readonly workspace: string;
  readonly task?: string;
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
        {props.view === 'agents' && <AgentHubRows data={props.data} />}
        {props.view === 'roles' && <RoleHubRows data={props.data.profile} />}
        {props.view === 'tiers' && <TierHubRows data={props.data.profile} />}
      </box>
    </>
  );
}

function AgentHubRows({ data }: { readonly data: TuiHubData }) {
  const { colors } = useTuiTheme();
  if (data.agents.length === 0) return <text><span fg={colors.text.muted}>No other agents are active in this workspace.</span></text>;
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
                <span fg={colors.text.muted}> · {agent.kind} · {agent.roleId}/{agent.tierId}</span>
              </text>
              {agent.task !== undefined && <text><span fg={colors.text.muted}>{agent.kind === 'main' ? '' : '  '}{agent.task}</span></text>}
            </box>
          ))}
        </box>
      ))}
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
