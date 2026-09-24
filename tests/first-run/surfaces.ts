/**
 * Every user-facing surface, and the first-run rows that drive it on the
 * deployed product.
 *
 * The surfaces are the product's own lists, so a new one arrives unmapped and
 * fails the type check here: the router's `APP_ROUTES`, the workspace strip's
 * `SURFACES` beside Activity, a Slate and a preview, and the entry points that
 * are not pages. The capabilities a surface only reaches through an agent are
 * listed by what the owner asked a deployed proof of.
 *
 * A surface the eval identity cannot reach names why instead of a row: no
 * deployed row can drive what the account it runs as is refused.
 */
import type { APP_ROUTES } from '../../packages/core/src/read-models/app-routes';
import type { SURFACES } from '@kinu.run/core';
import type { FirstRunCase } from './first-run';

type Rows = readonly FirstRunCase[];

interface Unreachable {
  readonly unreachable: string;
}

/** Every page the router serves. */
export const PAGE_ROWS = {
  home: ['workspace-title', 'agent-chats-persist'],
  welcome: ['account-settings'],
  workspaces: ['workspace-title'],
  plugins: ['blueprint-fork'],
  devices: ['device-link', 'two-machines'],
  userSettings: ['account-settings'],
  userMcp: ['blueprint-fork'],
  workspace: ['snapshot-after-turn', 'approve-clears', 'enter-sends'],
  workspaceAgent: ['agent-tab', 'agent-chats-persist', 'agent-dismissed-chat'],
  explore: ['exploration'],
  control: { unreachable: 'the operator console answers only an operator the admin gate admits (control-plane/admin-caller.ts), and the eval identity is not one' },
  agentSettings: ['workspace-settings'],
  triggers: ['workspace-panes'],
  drive: ['drive'],
  driveFolder: ['drive'],
  shared: ['blueprint-fork'],
  sharedBlueprint: ['blueprint-fork'],
  deploy: ['deploy-door'],
  updates: { unreachable: 'the update offer answers only the deployment\'s recorded owner and 404s everyone else (updates/routes.ts), and the eval identity is not the owner' },
} as const satisfies Record<keyof typeof APP_ROUTES, Rows | Unreachable>;

/** Every pane of the workspace strip. */
export const STRIP_ROWS = {
  Work: ['approve-clears', 'background-settle', 'background-wake'],
  Diffs: ['workspace-panes'],
  Files: ['files-outside-tree', 'drive', 'every-tool'],
  Releases: ['workspace-panes'],
  Swarms: ['exploration'],
  Agent: ['snapshot-after-turn', 'every-tool'],
  Environment: ['sandbox-mount-write', 'device-link'],
  Activity: ['every-tool', 'codemode-craft'],
  slate: ['slate', 'public-share', 'share-capability-cut', 'blueprint-fork'],
  preview: ['preview-address', 'slate'],
} as const satisfies Record<(typeof SURFACES)[number] | 'Activity' | 'slate' | 'preview', Rows>;

/** The ways in that are not pages. */
export const ENTRY_ROWS = {
  tui: ['enter-sends'],
  cli: ['workspace-title', 'preview-address', 'command-refusal'],
  daemon: ['device-link', 'two-machines', 'approve-clears'],
  shareHost: ['public-share', 'share-capability-cut'],
} as const satisfies Record<string, Rows>;

/** What the owner asked a deployed proof of, beyond a page answering. */
export const CAPABILITY_ROWS = {
  'subagent chat tabs': ['agent-tab', 'agent-chats-persist'],
  'subagent created by the user': ['agent-tab', 'agent-chats-persist'],
  'subagent confined to its workspace': ['agent-confined'],
  'subagent assigned a task by the orchestrator': ['delegation', 'delegation-tree'],
  'nested hosted delegation, settling at uneven depths': ['delegation-tree'],
  'a dismissed subagent\'s kept chat': ['agent-dismissed-chat'],
  'cloud workspace consent, machine not connected and connected': ['machine-consent'],
  'a swarm whose nodes run as hosted agents and settle': ['exploration'],
  'a live web search': ['web-search'],
  'an internal address refused on every fetch path': ['capability-isolation'],
  'a correction sent while the agent works': ['steer-correction'],
} as const satisfies Record<string, Rows>;
