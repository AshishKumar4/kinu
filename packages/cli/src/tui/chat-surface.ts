/** The scene's one overlay at a time: which is open, and the title the composer shows under it. */
import type { AlternateTakeSet, PendingDeviceConsent, AgentModelMenu, AskingAgent } from '@kinu.run/core';
import type { AgentChangelogView } from '../agent-client';
import type { DeviceConnectPromptState } from './use-device-connect';
import type { ApprovalPrompt } from './use-approvals';
import type { TuiHubView } from './hubs';

export type ActiveSurface =
  | { kind: 'commands' }
  | { kind: 'history' }
  | { kind: 'settings' }
  | { kind: 'theme' }
  | { kind: 'hub'; view: TuiHubView }
  | { kind: 'model'; menu: AgentModelMenu; loading: boolean; error: string | null }
  | { kind: 'changelog'; view: AgentChangelogView }
  | { kind: 'takes'; set: AlternateTakeSet }
  | { kind: 'questions'; asking: AskingAgent }
  | { kind: 'subagent'; path: readonly string[]; label: string; actorId: string | null }
  | null;

export function surfaceTitleFor(surface: ActiveSurface, walkbackOpen: boolean): string | null {
  if (surface === null) return walkbackOpen ? 'Walk back ›' : null;

  switch (surface.kind) {
    case 'settings': return 'Settings ›';
    case 'theme': return 'Theme ›';
    case 'commands': return 'Commands ›';
    case 'hub': return `${surface.view[0].toUpperCase()}${surface.view.slice(1)} ›`;
    case 'model': return 'Model picker ›';
    case 'changelog': return 'Changelog ›';
    case 'takes': return 'Takes ›';
    case 'questions': return 'Questions ›';
    case 'subagent': return 'Subagent ›';
    case 'history': return 'Prompt history ›';
  }
}

export function anyOverlayOpen(input: {
  activeSurface: ActiveSurface;
  navigationOpen: boolean;
  walkbackOpen: boolean;
  pendingConsent: PendingDeviceConsent | null;
  approval: ApprovalPrompt | null;
  deviceConnect: DeviceConnectPromptState | null;
}): boolean {
  return input.activeSurface !== null
    || input.navigationOpen
    || input.walkbackOpen
    || input.pendingConsent !== null
    || input.approval !== null
    || input.deviceConnect !== null;
}
