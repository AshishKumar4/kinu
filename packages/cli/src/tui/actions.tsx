import { createContext, useContext, type ReactNode } from 'react';

export const KEYMAP_PRESET_IDS = ['pi-omp', 'kinu', 'opencode'] as const;
export type KeymapPresetId = (typeof KEYMAP_PRESET_IDS)[number];

const KEY_SCOPES = ['consent', 'device', 'modal', 'home', 'editor', 'conversation', 'global'] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

export interface TuiKeyEvent {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  readonly meta?: boolean;
  readonly super?: boolean;
  preventDefault?: () => void;
}

const TUI_ACTIONS = {
  'consent.once': { scope: 'consent', label: 'Allow once' },
  'consent.always': { scope: 'consent', label: 'Always allow' },
  'consent.deny': { scope: 'consent', label: 'Deny' },
  'device.connect': { scope: 'device', label: 'Connect device' },
  'device.ssh': { scope: 'device', label: 'Show SSH command' },
  'device.dismiss': { scope: 'device', label: 'Dismiss device prompt' },
  'device.not-now': { scope: 'device', label: 'Close device prompt' },
  'modal.close': { scope: 'modal', label: 'Close overlay' },
  'modal.previous': { scope: 'modal', label: 'Previous item' },
  'modal.next': { scope: 'modal', label: 'Next item' },
  'modal.activate': { scope: 'modal', label: 'Choose item' },
  'modal.collapse': { scope: 'modal', label: 'Collapse group' },
  'modal.expand': { scope: 'modal', label: 'Expand group' },
  'modal.page-previous': { scope: 'modal', label: 'Previous page' },
  'modal.page-next': { scope: 'modal', label: 'Next page' },
  'modal.focus-next': { scope: 'modal', label: 'Next field' },
  'hub.new-agent': { scope: 'modal', label: 'New agent' },
  'home.exit': { scope: 'home', label: 'Exit' },
  'home.focus-next': { scope: 'home', label: 'Next field' },
  'home.previous': { scope: 'home', label: 'Previous choice' },
  'home.next': { scope: 'home', label: 'Next choice' },
  'home.activate': { scope: 'home', label: 'Choose' },
  'home.page-previous': { scope: 'home', label: 'Previous page' },
  'home.page-next': { scope: 'home', label: 'Next page' },
  'onboarding.skip': { scope: 'home', label: 'Skip this step' },
  'editor.submit': { scope: 'editor', label: 'Send message' },
  'editor.newline': { scope: 'editor', label: 'Insert newline' },
  'editor.external': { scope: 'editor', label: 'Open external editor' },
  'effort.cycle': { scope: 'editor', label: 'Cycle reasoning effort' },
  'tier.cycle': { scope: 'editor', label: 'Cycle tier' },
  'tier.cycle-reverse': { scope: 'editor', label: 'Cycle tier backwards' },
  'tier.quick': { scope: 'global', label: 'Next-turn tier picker' },
  'tool.toggle': { scope: 'conversation', label: 'Toggle tool details' },
  'conversation.cancel': { scope: 'conversation', label: 'Interrupt or close' },
  'conversation.branch': { scope: 'conversation', label: 'Branch with draft' },
  'queue.add': { scope: 'conversation', label: 'Queue draft' },
  'queue.edit-last': { scope: 'conversation', label: 'Edit last queued draft' },
  'history.page-up': { scope: 'conversation', label: 'Scroll transcript up' },
  'history.page-down': { scope: 'conversation', label: 'Scroll transcript down' },
  'history.line-up': { scope: 'conversation', label: 'Scroll transcript up one step' },
  'history.line-down': { scope: 'conversation', label: 'Scroll transcript down one step' },
  'link.open-last': { scope: 'conversation', label: 'Open last link' },
  'palette.toggle': { scope: 'global', label: 'Command palette' },
  'workspace.toggle': { scope: 'global', label: 'Workspace navigator' },
  'settings.toggle': { scope: 'global', label: 'Settings' },
  'model.open': { scope: 'global', label: 'Model picker' },
  'hub.agents': { scope: 'global', label: 'Agent Hub' },
  'hub.roles': { scope: 'global', label: 'Role Hub' },
  'hub.tiers': { scope: 'global', label: 'Tier Hub' },
} as const satisfies Record<string, { readonly scope: KeyScope; readonly label: string }>;

export type TuiActionId = keyof typeof TUI_ACTIONS;
export function isTuiActionId(value: string): value is TuiActionId {
  return value in TUI_ACTIONS;
}
export type KeymapOverrides = Partial<Readonly<Record<TuiActionId, readonly string[]>>>;

interface KeyStroke {
  readonly name: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
  readonly super: boolean;
}

interface ActionBinding {
  readonly actionId: TuiActionId;
  readonly scope: KeyScope;
  readonly sequence: readonly KeyStroke[];
  readonly display: string;
}

export interface KeybindingRegistry {
  readonly presetId: KeymapPresetId;
  readonly actionIds: readonly TuiActionId[];
  readonly bindings: readonly ActionBinding[];
  bindingsFor(actionId: TuiActionId): readonly string[];
  hint(actionId: TuiActionId): string;
}

const COMMON_BINDINGS = {
  'consent.once': ['o', 'y', 'return'],
  'consent.always': ['a'],
  'consent.deny': ['n', 'escape'],
  'device.connect': ['c'],
  'device.ssh': ['s'],
  'device.dismiss': ['d'],
  'device.not-now': ['n', 'escape'],
  'modal.close': ['escape'],
  'modal.previous': ['up'],
  'modal.next': ['down'],
  'modal.activate': ['return'],
  'modal.focus-next': ['tab'],
  'modal.collapse': ['left'],
  'modal.expand': ['right'],
  'modal.page-previous': ['pageup'],
  'modal.page-next': ['pagedown'],
  'hub.new-agent': ['n'],
  'home.exit': ['escape'],
  'home.focus-next': ['tab'],
  'home.previous': ['up', 'left'],
  'home.next': ['down', 'right'],
  'home.activate': ['return'],
  'home.page-previous': ['pageup'],
  'home.page-next': ['pagedown'],
  'onboarding.skip': ['s'],
  'editor.submit': ['return'],
  'editor.newline': ['shift+return', 'ctrl+j'],
  'conversation.cancel': ['escape'],
  'queue.edit-last': ['backspace'],
  'history.page-up': ['pageup'],
  'history.page-down': ['pagedown'],
  'history.line-up': ['up'],
  'history.line-down': ['down'],
} as const satisfies KeymapOverrides;

const PRESET_BINDINGS = {
  'pi-omp': {
    'editor.external': ['ctrl+g'],
    'effort.cycle': ['shift+tab'],
    'tier.cycle': ['ctrl+p'],
    'tier.cycle-reverse': ['shift+ctrl+p'],
    'tier.quick': ['alt+p'],
    'tool.toggle': ['ctrl+o'],
    'conversation.branch': ['alt+b'],
    'queue.add': ['alt+return'],
    'link.open-last': ['alt+l'],
    'palette.toggle': ['ctrl+k'],
    'workspace.toggle': ['alt+w'],
    'settings.toggle': ['ctrl+,'],
    'model.open': ['ctrl+l'],
    'hub.agents': ['alt+a'],
    'hub.roles': ['alt+r'],
    'hub.tiers': ['alt+t'],
  },
  kinu: {
    'editor.external': ['ctrl+e'],
    'effort.cycle': ['alt+e'],
    'tier.cycle': ['alt+t'],
    'tier.quick': ['alt+p'],
    'tool.toggle': ['alt+o'],
    'conversation.branch': ['alt+b'],
    'queue.add': ['alt+return'],
    'link.open-last': ['alt+l'],
    'palette.toggle': ['ctrl+k'],
    'workspace.toggle': ['alt+w'],
    'settings.toggle': ['ctrl+,'],
    'model.open': ['ctrl+p'],
    'hub.agents': ['alt+a'],
    'hub.roles': ['alt+r'],
    'hub.tiers': ['alt+shift+t'],
  },
  opencode: {
    'editor.external': ['ctrl+x e'],
    'effort.cycle': ['ctrl+t'],
    'tier.quick': ['ctrl+x y'],
    'tool.toggle': ['ctrl+x h'],
    'conversation.branch': ['alt+b'],
    'queue.add': ['ctrl+x q'],
    'link.open-last': ['ctrl+x l'],
    'palette.toggle': ['ctrl+p'],
    'workspace.toggle': ['ctrl+x b'],
    'settings.toggle': ['ctrl+x s'],
    'model.open': ['ctrl+x m'],
    'hub.agents': ['ctrl+x a'],
    'hub.roles': ['ctrl+x r'],
    'hub.tiers': ['ctrl+x t'],
  },
} as const satisfies Record<KeymapPresetId, KeymapOverrides>;

const SCOPE_PRIORITY = {
  consent: 60,
  device: 60,
  modal: 50,
  home: 40,
  editor: 40,
  conversation: 30,
  global: 10,
} as const satisfies Record<KeyScope, number>;
const TUI_ACTION_IDS = (() => {
  const ids: TuiActionId[] = [];
  for (const actionId in TUI_ACTIONS) {
    if (isTuiActionId(actionId)) ids.push(actionId);
  }
  return Object.freeze(ids);
})();

function configuredBindings(config: KeymapOverrides, actionId: TuiActionId): readonly string[] | undefined {
  return config[actionId];
}

export function createKeybindingRegistry(input: {
  readonly presetId?: KeymapPresetId;
  readonly overrides?: KeymapOverrides;
} = {}): KeybindingRegistry {
  const presetId = input.presetId ?? 'pi-omp';
  if (!KEYMAP_PRESET_IDS.includes(presetId)) throw new Error(`Unknown keymap preset: ${presetId}`);
  for (const actionId of Object.keys(input.overrides ?? {})) {
    if (!isTuiActionId(actionId)) throw new Error(`Unknown TUI action override: ${actionId}`);
  }
  const bindings: ActionBinding[] = [];
  const presetBindings = PRESET_BINDINGS[presetId];
  for (const actionId of TUI_ACTION_IDS) {
    const configured = input.overrides?.[actionId]
      ?? configuredBindings(presetBindings, actionId)
      ?? configuredBindings(COMMON_BINDINGS, actionId)
      ?? [];
    for (const display of configured) {
      const sequence = parseSequence(display);
      bindings.push({ actionId, scope: TUI_ACTIONS[actionId].scope, sequence, display: formatSequence(sequence) });
    }
  }
  rejectConflicts(bindings);
  const byAction = new Map<TuiActionId, string[]>();
  for (const binding of bindings) {
    const current = byAction.get(binding.actionId) ?? [];
    current.push(binding.display);
    byAction.set(binding.actionId, current);
  }
  return Object.freeze({
    presetId,
    actionIds: TUI_ACTION_IDS,
    bindings: Object.freeze(bindings),
    bindingsFor: (actionId: TuiActionId) => Object.freeze(byAction.get(actionId) ?? []),
    hint: (actionId: TuiActionId) => byAction.get(actionId)?.[0] ?? '',
  });
}

function keyEventAction(
  registry: KeybindingRegistry,
  event: TuiKeyEvent,
  activeScopes: readonly KeyScope[],
): TuiActionId | null {
  const stroke = strokeOf(event);
  const active = new Set(activeScopes);
  return registry.bindings
    .filter((binding) => binding.sequence.length === 1 && active.has(binding.scope) && sameStroke(binding.sequence[0]!, stroke))
    .sort((left, right) => SCOPE_PRIORITY[right.scope] - SCOPE_PRIORITY[left.scope])[0]?.actionId ?? null;
}

export interface KeyDispatcherResult {
  readonly actionId: TuiActionId | null;
  readonly pending: boolean;
}

export interface TuiKeyDispatcher {
  feed(event: TuiKeyEvent, activeScopes: readonly KeyScope[]): KeyDispatcherResult;
  reset(): void;
}

export function createKeyDispatcher(registry: KeybindingRegistry): TuiKeyDispatcher {
  let prefix: KeyStroke[] = [];
  return {
    feed(event, activeScopes) {
      const stroke = strokeOf(event);
      const active = new Set(activeScopes);
      const nextPrefix = [...prefix, stroke];
      const candidates = registry.bindings
        .filter((binding) => active.has(binding.scope) && sequenceStartsWith(binding.sequence, nextPrefix))
        .sort((left, right) => SCOPE_PRIORITY[right.scope] - SCOPE_PRIORITY[left.scope]);
      const exact = candidates.find((binding) => binding.sequence.length === nextPrefix.length);
      if (exact) {
        prefix = [];
        return { actionId: exact.actionId, pending: false };
      }
      if (candidates.length > 0) {
        prefix = nextPrefix;
        return { actionId: null, pending: true };
      }
      prefix = [];
      const direct = keyEventAction(registry, event, activeScopes);
      return { actionId: direct, pending: false };
    },
    reset() {
      prefix = [];
    },
  };
}

export interface OpenTuiKeyBinding {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  action: 'submit' | 'newline';
}

export function openTuiKeyBindings(
  registry: KeybindingRegistry,
  actionId: 'editor.submit' | 'editor.newline',
): OpenTuiKeyBinding[] {
  const action = actionId === 'editor.submit' ? 'submit' : 'newline';
  return registry.bindings
    .filter((binding) => binding.actionId === actionId && binding.sequence.length === 1)
    .map((binding) => {
      const stroke = binding.sequence[0]!;
      const result: OpenTuiKeyBinding = {
        name: stroke.name,
        action,
      };
      if (stroke.ctrl) result.ctrl = true;
      if (stroke.shift) result.shift = true;
      if (stroke.meta || stroke.alt) result.meta = true;
      return result;
    });
}

const ActionRegistryContext = createContext<KeybindingRegistry>(createKeybindingRegistry());

export function KeybindingProvider(props: {
  readonly registry: KeybindingRegistry;
  readonly children: ReactNode;
}) {
  return <ActionRegistryContext.Provider value={props.registry}>{props.children}</ActionRegistryContext.Provider>;
}

export function useKeybindingRegistry(): KeybindingRegistry {
  return useContext(ActionRegistryContext);
}


function parseSequence(input: string): readonly KeyStroke[] {
  const value = input.trim().toLowerCase();
  if (value === '') throw new Error('Keybinding cannot be empty.');
  return Object.freeze(value.split(/\s+/u).map(parseStroke));
}

function parseStroke(input: string): KeyStroke {
  const parts = input.split('+');
  const name = parts.pop()?.trim() ?? '';
  if (name === '') throw new Error(`Invalid keybinding: ${input}`);
  const modifiers = new Set(parts);
  for (const modifier of modifiers) {
    if (!['ctrl', 'shift', 'alt', 'meta', 'super'].includes(modifier)) {
      throw new Error(`Unknown key modifier "${modifier}" in ${input}`);
    }
  }
  return Object.freeze({
    name: normalizeKeyName(name),
    ctrl: modifiers.has('ctrl'),
    shift: modifiers.has('shift'),
    alt: modifiers.has('alt'),
    meta: modifiers.has('meta'),
    super: modifiers.has('super'),
  });
}

function normalizeKeyName(name: string): string {
  if (name === 'enter') return 'return';
  if (name === 'esc') return 'escape';
  if (name === 'pgup') return 'pageup';
  if (name === 'pgdown') return 'pagedown';
  return name;
}

function strokeOf(event: TuiKeyEvent): KeyStroke {
  return {
    name: normalizeKeyName(event.name.toLowerCase()),
    ctrl: event.ctrl === true,
    shift: event.shift === true,
    alt: event.alt === true || (event.meta === true && process.platform !== 'darwin'),
    meta: event.meta === true && process.platform === 'darwin',
    super: event.super === true,
  };
}

function sameStroke(left: KeyStroke, right: KeyStroke): boolean {
  return left.name === right.name
    && left.ctrl === right.ctrl
    && left.shift === right.shift
    && left.alt === right.alt
    && left.meta === right.meta
    && left.super === right.super;
}

function sequenceStartsWith(sequence: readonly KeyStroke[], prefix: readonly KeyStroke[]): boolean {
  return prefix.length <= sequence.length && prefix.every((stroke, index) => sameStroke(stroke, sequence[index]!));
}

function sameSequence(left: readonly KeyStroke[], right: readonly KeyStroke[]): boolean {
  return left.length === right.length && sequenceStartsWith(left, right);
}

function formatSequence(sequence: readonly KeyStroke[]): string {
  return sequence.map((stroke) => [
    stroke.ctrl ? 'Ctrl' : '',
    stroke.shift ? 'Shift' : '',
    stroke.alt ? 'Alt' : '',
    stroke.meta ? 'Meta' : '',
    stroke.super ? 'Super' : '',
    displayKeyName(stroke.name),
  ].filter(Boolean).join('+')).join(' ');
}

function displayKeyName(name: string): string {
  if (name === 'return') return 'Enter';
  if (name === 'escape') return 'Esc';
  if (name === 'pageup') return 'PgUp';
  if (name === 'pagedown') return 'PgDn';
  return name.length === 1 ? name.toUpperCase() : name[0]!.toUpperCase() + name.slice(1);
}

function rejectConflicts(bindings: readonly ActionBinding[]): void {
  for (let leftIndex = 0; leftIndex < bindings.length; leftIndex += 1) {
    const left = bindings[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < bindings.length; rightIndex += 1) {
      const right = bindings[rightIndex]!;
      if (left.actionId === right.actionId) continue;
      if (!sameSequence(left.sequence, right.sequence) || !scopesOverlap(left.scope, right.scope)) continue;
      throw new Error(`Keybinding conflict for ${left.display}: ${left.actionId} and ${right.actionId} overlap.`);
    }
  }
}

function scopesOverlap(left: KeyScope, right: KeyScope): boolean {
  if (left === right) return true;
  if (left === 'global' || right === 'global') return true;
  return (left === 'editor' && right === 'conversation')
    || (left === 'conversation' && right === 'editor');
}
