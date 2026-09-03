import type { TextareaRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';

import { renderThrownChain } from '@kinu.run/core/obs';

import {
  KEYMAP_PRESET_IDS,
  createKeyDispatcher,
  openTuiKeyBindings,
  useKeybindingRegistry,
  type KeymapPresetId,
} from './actions';
import {
  ONBOARDING_STEP_IDS,
  type OnboardingStepId,
  type WorkspaceLocationChoice,
} from './preferences';
import { DEFAULT_TUI_THEME_SELECTION, useTuiTheme, type ThemeSelection } from './theme';

export interface OnboardingReadiness {
  readonly location?: WorkspaceLocationChoice;
  readonly accountConnected: boolean;
  readonly providerConnected: boolean;
  readonly defaultModel?: string;
  readonly tierAliasesResolved: boolean;
  readonly themeSelected: boolean;
  readonly keymapSelected: boolean;
  readonly workspaceCount: number;
  readonly skippedSteps: readonly OnboardingStepId[];
  readonly connectionProgress?: {
    readonly phase: 'starting' | 'waiting' | 'approved' | 'failed';
    readonly label: string;
  };
}

export interface OnboardingRoleChoice {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface OnboardingWorkspaceInput {
  readonly mission: string;
  readonly roleId: string;
}

export interface TuiOnboardingOperations {
  readReadiness(): OnboardingReadiness | Promise<OnboardingReadiness>;
  chooseLocation(location: WorkspaceLocationChoice): void | Promise<void>;
  connectAccount(): void | Promise<void>;
  connectProvider(): void | Promise<void>;
  configureTiers(): void | Promise<void>;
  selectTheme(selection: ThemeSelection): void | Promise<void>;
  selectKeymap(presetId: KeymapPresetId): void | Promise<void>;
  createWorkspace(input: OnboardingWorkspaceInput): void | Promise<void>;
  skip(step: OnboardingStepId): void | Promise<void>;
}

interface DerivedOnboardingState {
  readonly activeStep: OnboardingStepId | null;
  readonly activeIndex: number;
  readonly ready: boolean;
}

function deriveOnboardingState(readiness: OnboardingReadiness): DerivedOnboardingState {
  for (let index = 0; index < ONBOARDING_STEP_IDS.length; index += 1) {
    const step = ONBOARDING_STEP_IDS[index]!;
    if (readiness.skippedSteps.includes(step) || onboardingStepReady(step, readiness)) continue;
    return Object.freeze({ activeStep: step, activeIndex: index, ready: false });
  }
  return Object.freeze({ activeStep: null, activeIndex: ONBOARDING_STEP_IDS.length, ready: true });
}

function onboardingStepReady(step: OnboardingStepId, readiness: OnboardingReadiness): boolean {
  switch (step) {
    case 'location':
      return readiness.location !== undefined;
    case 'connection':
      if (readiness.location === 'cloud') return readiness.accountConnected;
      if (readiness.location === 'local') return readiness.providerConnected;
      if (readiness.location === 'both') return readiness.accountConnected && readiness.providerConnected;
      return false;
    case 'tiers':
      return readiness.defaultModel !== undefined && readiness.tierAliasesResolved;
    case 'theme':
      return readiness.themeSelected;
    case 'keymap':
      return readiness.keymapSelected;
    case 'workspace':
      return readiness.workspaceCount > 0;
  }
}

export function GuidedOnboarding(props: {
  readonly operations: TuiOnboardingOperations;
  readonly roles: readonly OnboardingRoleChoice[];
  readonly onReady: () => void;
  readonly onExit: () => void;
}) {
  const { colors } = useTuiTheme();
  const [, startTransition] = useTransition();
  const keybindings = useKeybindingRegistry();
  const dispatcher = useMemo(() => createKeyDispatcher(keybindings), [keybindings]);
  const [readiness, setReadiness] = useState<OnboardingReadiness | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mission, setMission] = useState('');
  const [roleIndex, setRoleIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missionRef = useRef<TextareaRenderable | null>(null);
  const derived = readiness === null ? null : deriveOnboardingState(readiness);
  const activeStep = derived?.activeStep ?? null;

  const refresh = useCallback(async () => {
    const next = await props.operations.readReadiness();
    setReadiness(next);
    if (deriveOnboardingState(next).ready) props.onReady();
  }, [props.onReady, props.operations]);

  useEffect(() => {
    startTransition(async () => {
      try {
        await refresh();
      } catch (cause) {
        setError(renderThrownChain({ cause }));
      }
    });
  }, [refresh, startTransition]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [activeStep]);

  const run = useCallback((operation: () => void | Promise<void>) => {
    if (busy) return;
    startTransition(async () => {
      setBusy(true);
      setError(null);
      try {
        await operation();
        await refresh();
      } catch (cause) {
        setError(renderThrownChain({ cause }));
      } finally {
        setBusy(false);
      }
    });
  }, [busy, refresh, startTransition]);

  const { registry } = useTuiTheme();
  const themeChoices = useMemo<ReadonlyArray<{ readonly label: string; readonly selection: ThemeSelection }>>(() => [
    { label: 'Follow the terminal', selection: DEFAULT_TUI_THEME_SELECTION },
    ...registry.themes.map((theme) => ({ label: theme.label, selection: { mode: 'theme' as const, themeId: theme.id } })),
  ], [registry]);
  const choices = activeStep === 'location'
    ? (['cloud', 'local', 'both'] as const)
    : activeStep === 'theme'
      ? themeChoices.map((choice) => choice.label)
      : activeStep === 'keymap'
        ? KEYMAP_PRESET_IDS
        : activeStep === 'workspace'
          ? props.roles.map((role) => role.id)
          : [];

  const activate = useCallback(() => {
    if (readiness === null || activeStep === null) return;
    switch (activeStep) {
      case 'location': {
        const locations: readonly WorkspaceLocationChoice[] = ['cloud', 'local', 'both'];
        const location = locations[selectedIndex];
        if (location !== undefined) run(() => props.operations.chooseLocation(location));
        return;
      }
      case 'connection':
        if ((readiness.location === 'cloud' || readiness.location === 'both') && !readiness.accountConnected) {
          run(props.operations.connectAccount);
        } else if ((readiness.location === 'local' || readiness.location === 'both') && !readiness.providerConnected) {
          run(props.operations.connectProvider);
        }
        return;
      case 'tiers':
        run(props.operations.configureTiers);
        return;
      case 'theme': {
        const choice = themeChoices[selectedIndex];
        if (choice !== undefined) run(() => props.operations.selectTheme(choice.selection));
        return;
      }
      case 'keymap': {
        const presetId = KEYMAP_PRESET_IDS[selectedIndex];
        if (presetId !== undefined) run(() => props.operations.selectKeymap(presetId));
        return;
      }
      case 'workspace': {
        const role = props.roles[roleIndex];
        const text = (missionRef.current?.plainText ?? mission).trim();
        if (role !== undefined && text !== '') run(() => props.operations.createWorkspace({ mission: text, roleId: role.id }));
        return;
      }
    }
  }, [activeStep, choices, mission, props.operations, props.roles, readiness, roleIndex, run, selectedIndex, themeChoices]);

  useKeyboard((event) => {
    const result = dispatcher.feed(event, ['home']);
    if (result.pending) {
      event.preventDefault();
      return;
    }
    switch (result.actionId) {
      case 'home.exit':
        event.preventDefault();
        props.onExit();
        return;
      case 'onboarding.skip':
        if (activeStep === null) return;
        event.preventDefault();
        run(() => props.operations.skip(activeStep));
        return;
      case 'home.previous':
        if (activeStep === 'workspace') return;
        event.preventDefault();
        setSelectedIndex((current) => (current - 1 + Math.max(1, choices.length)) % Math.max(1, choices.length));
        return;
      case 'home.next':
        if (activeStep === 'workspace') return;
        event.preventDefault();
        setSelectedIndex((current) => (current + 1) % Math.max(1, choices.length));
        return;
      case 'home.focus-next':
        if (activeStep !== 'workspace' || props.roles.length === 0) return;
        event.preventDefault();
        setRoleIndex((current) => (current + 1) % props.roles.length);
        return;
      case 'home.activate':
        if (activeStep === 'workspace') return;
        event.preventDefault();
        activate();
        return;
      default:
        return;
    }
  });

  if (readiness === null || derived === null) {
    return (
      <box flexDirection="column" style={{ paddingLeft: 2, paddingTop: 1 }}>
        {error === null
          ? <text><span fg={colors.text.muted}>Checking readiness…</span></text>
          : <text><span fg={colors.intent.danger}>{error}</span></text>}
      </box>
    );
  }

  if (activeStep === null) return null;
  const stepNumber = derived.activeIndex + 1;
  const selectedRole = props.roles[roleIndex];
  return (
    <box flexDirection="column" style={{ width: '100%', height: '100%', paddingLeft: 2, paddingRight: 2, paddingTop: 1, backgroundColor: colors.background.canvas }}>
      <text>
        <strong fg={colors.intent.accent}>Kinu setup</strong>
        <span fg={colors.text.muted}> · Step {stepNumber}/{ONBOARDING_STEP_IDS.length} · {activeStep}</span>
      </text>
      <box flexDirection="column" style={{ marginTop: 1, border: true, borderStyle: 'rounded', borderColor: colors.border.default, backgroundColor: colors.background.surface, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 }}>
        {activeStep === 'location' && (
          <>
            <text><strong fg={colors.text.strong}>Where will your workspaces live?</strong></text>
            <text><span fg={colors.text.muted}>Choose cloud, local, or both.</span></text>
            {choices.map((choice, index) => <ChoiceRow key={choice} label={choice} selected={index === selectedIndex} />)}
          </>
        )}
        {activeStep === 'connection' && (
          <>
            <text><strong fg={colors.text.strong}>Connect the required account or provider</strong></text>
            <ReadinessRow label="Kinu account" ready={readiness.accountConnected} />
            <ReadinessRow label="Local provider" ready={readiness.providerConnected} />
            {readiness.connectionProgress !== undefined && <text><span fg={colors.intent.info}>{readiness.connectionProgress.label}</span></text>}
          </>
        )}
        {activeStep === 'tiers' && (
          <>
            <text><strong fg={colors.text.strong}>Choose the default model</strong></text>
            <text><span fg={colors.text.muted}>Tiny, fast, slow, and deep use default until you remap them.</span></text>
            <ReadinessRow label={readiness.defaultModel ?? 'Default model'} ready={readiness.defaultModel !== undefined} />
          </>
        )}
        {activeStep === 'theme' && (
          <>
            <text><strong fg={colors.text.strong}>Choose a theme</strong></text>
            <text><span fg={colors.text.muted}>Follow the terminal takes the light or dark set to match it. /theme changes it later.</span></text>
            {themeChoices.map((choice, index) => <ChoiceRow key={choice.label} label={choice.label} selected={index === selectedIndex} />)}
          </>
        )}
        {activeStep === 'keymap' && (
          <>
            <text><strong fg={colors.text.strong}>Choose a keymap</strong></text>
            {KEYMAP_PRESET_IDS.map((presetId, index) => <ChoiceRow key={presetId} label={presetId} selected={index === selectedIndex} />)}
          </>
        )}
        {activeStep === 'workspace' && (
          <>
            <text><strong fg={colors.text.strong}>Create your first workspace</strong></text>
            <text><span fg={colors.text.muted}>Role: {selectedRole?.label ?? 'No configured role'} · Tab changes role</span></text>
            {selectedRole !== undefined && <text><span fg={colors.text.muted}>{selectedRole.description}</span></text>}
            <box style={{ height: 5, marginTop: 1, border: true, borderStyle: 'rounded', borderColor: colors.border.focus, backgroundColor: colors.background.user }}>
              <textarea
                ref={(value) => { missionRef.current = value; }}
                focused={!busy}
                placeholder="Describe the workspace mission…"
                keyBindings={[
                  ...openTuiKeyBindings(keybindings, 'editor.submit'),
                  ...openTuiKeyBindings(keybindings, 'editor.newline'),
                ]}
                onContentChange={() => setMission(missionRef.current?.plainText ?? '')}
                onSubmit={activate}
                style={{
                  backgroundColor: colors.background.user,
                  focusedBackgroundColor: colors.background.user,
                  textColor: colors.text.strong,
                  focusedTextColor: colors.text.strong,
                  placeholderColor: colors.text.muted,
                  cursorColor: colors.intent.accent,
                }}
              />
            </box>
          </>
        )}
      </box>
      {error !== null && <text><span fg={colors.intent.danger}>{error}</span></text>}
      <text>
        <span fg={colors.text.muted}>
          {busy ? 'Working…' : `${keybindings.hint('home.activate')} continue · ${keybindings.hint('onboarding.skip')} skip · ${keybindings.hint('home.exit')} exit`}
        </span>
      </text>
    </box>
  );
}

function ChoiceRow(props: { readonly label: string; readonly selected: boolean }) {
  const { colors } = useTuiTheme();
  return (
    <text>
      <span fg={props.selected ? colors.intent.accent : colors.text.muted}>{props.selected ? '› ' : '  '}</span>
      <span fg={props.selected ? colors.text.strong : colors.text.primary}>{props.label}</span>
    </text>
  );
}

function ReadinessRow(props: { readonly label: string; readonly ready: boolean }) {
  const { colors } = useTuiTheme();
  return (
    <text>
      <span fg={props.ready ? colors.intent.success : colors.intent.warning}>{props.ready ? '✓ ' : '○ '}</span>
      <span fg={colors.text.primary}>{props.label}</span>
    </text>
  );
}
