/**
 * Scene and surface keys: the action ids that flip overlays, cycle tiers and
 * effort, scroll the transcript, and open browsers — everything a keystroke
 * does once it is past the composer. The scene's useKeyboard resolves the id
 * and looks it up here; the scene and modal tables are separate because a
 * modal scope may answer an id the scene would not.
 */
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
  /** The open modal surface, or null. */
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
  /** The hub read, or null while it is in flight. */
  hub: { data: TuiHubData } | null;
  nextTier: TierId | null;
  /** The turn's own tier, when the backend has reported one. */
  turnTier: TierId | undefined;
  setNextTier(tier: TierId): void;
  toggleToolDetails(): void;
  cycleReasoningEffort(): void | Promise<void>;
  history: ScrollBoxRenderable | null;
  /** Re-anchor the transcript after a programmatic scroll. */
  rememberScroll(): void;
  /** Host-provided one-click agent creation; the hub offers its key only then. */
  createNewAgent?: () => Promise<void>;
  /** The model overlay re-reads on close, so it asks for another open. */
  bumpModelRequest(): void;
}

/** The tier `delta` steps from `current` in the catalog's order, wrapping; an
 *  unknown or absent current starts from the first. */
function cycledTier(tiers: readonly TierId[], current: TierId | undefined, delta: 1 | -1): TierId {
  const index = (Math.max(0, current === undefined ? -1 : tiers.indexOf(current)) + delta + tiers.length) % tiers.length;

  return tiers[index] ?? 'default';
}

export type SceneKeyHandler = (key: KeyEvent) => void | Promise<void>;

const tierCatalog = (deps: SurfaceKeyDeps): readonly TierId[] =>
  deps.hub ? tierIdsOf(deps.hub.data.profile.envelope.catalog) : TIER_IDS;

/** A hub-opening chord: agents, roles, tiers, and the quick tier row all land
 *  on the same surface with a different first view. The key opens the hub
 *  even while its read is still in flight. Dropping it instead made a
 *  workspace switch swallow the next Alt+A outright: the switch clears the
 *  hub, the re-read is asynchronous (the profile authority is a network read
 *  on a signed-in machine), and a key that lands in that window left the
 *  surface closed with nothing said. The overlay paints as soon as the read
 *  answers; the composer hint carries the open surface meanwhile. */
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

/** Scene-scope handlers. Every handler owns its preventDefault for the same
 *  reason the composer handlers do: which keys still reach the editor is
 *  behaviour, not bookkeeping. */
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

/** Modal-scope handlers: the keys a surface answers while it owns the scene. */
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
