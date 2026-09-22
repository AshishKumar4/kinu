/** Scene and modal tables are separate: a modal scope may answer an id the scene would not. */
import { tierIdsOf, TIER_IDS, type TierId } from '@kinu.run/core';
import type { KeyEvent, ScrollBoxRenderable } from '@opentui/core';
import type { TuiActionId } from './actions';
import type { TuiHubData, TuiHubView } from './hubs';
import type { ActiveSurface } from './chat-app';

function historyScroll(
  actionId: TuiActionId,
  history: ScrollBoxRenderable | null,
): boolean {
  const page = actionId === 'history.page-up' || actionId === 'history.page-down';

  if (history === null) return false;
  const direction = actionId === 'history.page-up' || actionId === 'history.line-up' ? -1 : 1;
  const viewportFraction = page ? 0.5 : 0.2;
  const delta = Math.max(1, Math.floor(history.viewport.height * viewportFraction));
  history.scrollTo(history.scrollTop + direction * delta);

  return true;
}

export interface SurfaceKeyDeps {
  activeSurface: ActiveSurface;
  setActiveSurface(surface: ActiveSurface): void;
  /** Walk-back is a surface too: modal.close dismisses it like the rest. */
  walkbackOpen: boolean;
  closeWalkback(): void;
  settingsOpen: boolean;
  commandPalette: boolean;
  /** Wide layouts toggle the sidebar preference; narrow ones the overlay. */
  wideLayout: boolean;
  setNavigationOpen(updater: (open: boolean) => boolean): void;
  toggleWideSidebar(): void;
  /** A workspace switch is refused while a turn or client action is live. */
  busy(): boolean;
  addMessage(message: { role: 'system'; content: string }): void;
  lastUrl(): string | null;
  openBrowser(url: string): void;
  openModelPicker(): void | Promise<void>;
  hub: { data: TuiHubData } | null;
  nextTier: TierId | null;
  turnTier: TierId | undefined;
  setNextTier(tier: TierId): void;
  toggleToolDetails(): void;
  cycleReasoningEffort(): void | Promise<void>;
  history: ScrollBoxRenderable | null;
  rememberScroll(): void;
  /** The hub offers its key only when set. */
  createNewAgent?: () => Promise<void>;
  /** The model overlay re-reads on close, so it asks for another open. */
  bumpModelRequest(): void;
}

/** Wraps; an unknown current starts from the first. */
function cycledTier(tiers: readonly TierId[], current: TierId | undefined, delta: 1 | -1): TierId {
  const index = (Math.max(0, current === undefined ? -1 : tiers.indexOf(current)) + delta + tiers.length) % tiers.length;

  return tiers[index] ?? 'default';
}

export type SceneKeyHandler = (key: KeyEvent) => void | Promise<void>;

const tierCatalog = (deps: SurfaceKeyDeps): readonly TierId[] =>
  deps.hub ? tierIdsOf(deps.hub.data.profile.envelope.catalog) : TIER_IDS;

/** Opens even while the hub read is in flight: a switch clears and re-reads the hub, and a dropped key would vanish silently. */
const openHub = (deps: SurfaceKeyDeps, view: TuiHubView) => (key: KeyEvent): void => {
  key.preventDefault();
  deps.setActiveSurface({ kind: 'hub', view });
};

const cycleTier = (deps: SurfaceKeyDeps, delta: 1 | -1) => (key: KeyEvent): void => {
  key.preventDefault();
  deps.setNextTier(cycledTier(tierCatalog(deps), deps.nextTier ?? deps.turnTier, delta));
};

const scrollTranscript = (deps: SurfaceKeyDeps, actionId: TuiActionId) => (key: KeyEvent): void => {
  if (historyScroll(actionId, deps.history)) {
    key.preventDefault();
    deps.rememberScroll();
  }
};

export function sceneKeyHandlers(deps: SurfaceKeyDeps): Partial<Record<TuiActionId, SceneKeyHandler>> {
  return {
    'settings.toggle': (key) => {
      key.preventDefault();
      deps.setActiveSurface(deps.settingsOpen ? null : { kind: 'settings' });
    },
    'palette.toggle': (key) => {
      key.preventDefault();
      deps.setActiveSurface(deps.commandPalette ? null : { kind: 'commands' });
    },
    'workspace.toggle': (key) => {
      key.preventDefault();

      if (deps.busy()) {
        deps.addMessage({ role: 'system', content: 'Finish or stop the active workspace action before switching.' });
      } else if (deps.wideLayout) {
        deps.toggleWideSidebar();
      } else {
        deps.setNavigationOpen((open) => !open);
      }
    },
    'link.open-last': (key) => {
      key.preventDefault();
      const url = deps.lastUrl();

      if (url) deps.openBrowser(url);
    },
    'model.open': (key) => {
      key.preventDefault();

      return deps.openModelPicker();
    },
    'tier.cycle': cycleTier(deps, 1),
    'tier.cycle-reverse': cycleTier(deps, -1),
    'hub.agents': openHub(deps, 'agents'),
    'hub.roles': openHub(deps, 'roles'),
    'hub.tiers': openHub(deps, 'tiers'),
    'tier.quick': openHub(deps, 'tiers'),
    'tool.toggle': (key) => {
      key.preventDefault();
      deps.toggleToolDetails();
    },
    'effort.cycle': (key) => {
      key.preventDefault();

      return deps.cycleReasoningEffort();
    },
    'history.page-up': scrollTranscript(deps, 'history.page-up'),
    'history.page-down': scrollTranscript(deps, 'history.page-down'),
    'history.line-up': scrollTranscript(deps, 'history.line-up'),
    'history.line-down': scrollTranscript(deps, 'history.line-down'),
  };
}

export function modalKeyHandlers(deps: SurfaceKeyDeps): Partial<Record<TuiActionId, SceneKeyHandler>> {
  return {
    'hub.new-agent': (key) => {
      if (deps.activeSurface?.kind !== 'hub' || deps.activeSurface.view !== 'agents' || deps.createNewAgent === undefined) return;
      key.preventDefault();
      deps.setActiveSurface(null);

      return deps.createNewAgent();
    },
    'modal.close': (key) => {
      key.preventDefault();

      if (deps.activeSurface?.kind === 'model') deps.bumpModelRequest();
      deps.setActiveSurface(null);

      if (deps.walkbackOpen) deps.closeWalkback();
    },
  };
}
