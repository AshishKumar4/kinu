import type { TextareaRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';

import { renderThrownChain } from '@kinu.run/core/obs';

import type {
  ProviderConnectId,
  ProviderConnectOutcome,
  ProviderConnectPort,
  ProviderConnectionState,
} from '../commands/provider-connect';
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
import { useTuiTheme, type ThemeAppearance, type ThemeSelection } from './theme';

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
  listProviders(): Promise<readonly ProviderConnectionState[]>;
  /** Runs the provider's own credential flow against the step's port: the
   *  step reports its progress and answers its questions. */
  connectProvider(id: ProviderConnectId, port: ProviderConnectPort): Promise<ProviderConnectOutcome>;
  configureTiers: () => void | Promise<void>;
  selectTheme(selection: ThemeSelection): void | Promise<void>;
  selectKeymap(presetId: KeymapPresetId): void | Promise<void>;
  createWorkspace(input: OnboardingWorkspaceInput): void | Promise<void>;
  skip(step: OnboardingStepId): void | Promise<void>;
}

const THEME_APPEARANCES: readonly ThemeAppearance[] = Object.freeze(['light', 'dark']);

const THEME_GROUP_LABELS: Readonly<Record<ThemeAppearance, string>> = Object.freeze({
  light: 'Light',
  dark: 'Dark',
});

type ProviderQuestion = Parameters<ProviderConnectPort['ask']>[0];

interface ThemeChoiceRow {
  readonly appearance: ThemeAppearance;
  readonly label: string;
  readonly selection: ThemeSelection;
}

interface DerivedOnboardingState {
  readonly activeStep: OnboardingStepId | null;
  readonly activeIndex: number;
  readonly ready: boolean;
}

function deriveOnboardingState(readiness: OnboardingReadiness): DerivedOnboardingState {
  for (let index = 0; index < ONBOARDING_STEP_IDS.length; index += 1) {
    const step = ONBOARDING_STEP_IDS[index];

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
  const [providers, setProviders] = useState<readonly ProviderConnectionState[]>([]);
  const [progress, setProgress] = useState<readonly string[]>([]);
  const [outcome, setOutcome] = useState<ProviderConnectOutcome | null>(null);
  const [question, setQuestion] = useState<ProviderQuestion | null>(null);
  const [answer, setAnswer] = useState('');
  const answerRef = useRef<((value: string) => void) | null>(null);
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

  const loadProviders = useCallback(async () => {
    setProviders(await props.operations.listProviders());
  }, [props.operations]);

  useEffect(() => {
    if (activeStep !== 'connection') return;
    startTransition(async () => {
      try {
        await loadProviders();
      } catch (cause) {
        setError(renderThrownChain({ cause }));
      }
    });
  }, [activeStep, loadProviders, startTransition]);

  /**
   * What a provider flow writes to and reads from while it runs. The secret
   * never reaches a renderable: the step holds the typed answer and paints
   * dots, and the flow receives it only when Enter resolves the question.
   */
  const port = useMemo<ProviderConnectPort>(() => ({
    report: (line) => setProgress((lines) => [...lines, line]),
    ask: (request) => {
      const { promise, resolve } = Promise.withResolvers<string>();
      setQuestion(request);
      setAnswer('');

      answerRef.current = (value) => {
        answerRef.current = null;
        setQuestion(null);
        setAnswer('');
        resolve(value);
      };

      return promise;
    },
  }), []);

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

  const settled = useCallback(() => setBusy(false), []);

  const failed = useCallback((cause: Error) => {
    setError(renderThrownChain({ cause }));
    setBusy(false);
  }, []);

  /**
   * The connect flow runs OUTSIDE `startTransition`: it stops on a question
   * and waits for the person's keystrokes, and React holds every update made
   * inside an async transition until that transition settles — which would
   * paint the prompt only after the answer it is asking for.
   */
  const runConnect = useCallback((operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void operation().then(refresh).then(settled, failed);
  }, [busy, failed, refresh, settled]);

  const { registry } = useTuiTheme();

  // Light first, then dark, each group in registry order: the step is a flat
  // cursor over the themes with the two headings drawn between them, so the
  // selected index never has to skip a row that cannot be chosen.
  const themeChoices = useMemo<readonly ThemeChoiceRow[]>(() => (
    THEME_APPEARANCES.flatMap((appearance) => registry.themes
      .filter((theme) => theme.appearance === appearance)
      .map((theme) => ({
        appearance,
        label: theme.label,
        selection: { mode: 'theme' as const, themeId: theme.id },
      })))
  ), [registry]);

  /** The rows the active step offers, in the order they are shown. */
  function stepChoices(): readonly string[] {
    switch (activeStep) {
      case 'location': return ['cloud', 'local', 'both'];
      case 'connection': return providers.map((state) => state.descriptor.id);
      case 'theme': return themeChoices.map((choice) => choice.label);
      case 'keymap': return KEYMAP_PRESET_IDS;
      case 'workspace': return props.roles.map((role) => role.id);
      case 'tiers':
      case null: return [];
    }
  }

  const choices = stepChoices();

  const activate = useCallback(() => {
    if (readiness === null || activeStep === null) return;

    switch (activeStep) {
      case 'location': {
        const locations: readonly WorkspaceLocationChoice[] = ['cloud', 'local', 'both'];
        const location = locations[selectedIndex];

        if (location !== undefined) run(() => props.operations.chooseLocation(location));

        return;
      }

      case 'connection': {
        const provider = providers[selectedIndex];

        if (provider === undefined) return;
        setProgress([]);
        setOutcome(null);
        runConnect(async () => {
          setOutcome(await props.operations.connectProvider(provider.descriptor.id, port));
          await loadProviders();
        });

        return;
      }

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
  }, [activeStep, choices, loadProviders, mission, port, props.operations, props.roles, providers, readiness, roleIndex, run, runConnect, selectedIndex, themeChoices]);

  useKeyboard((event) => {
    if (question !== null) {
      event.preventDefault();

      if (event.name === 'return' || event.name === 'enter') {
        answerRef.current?.(answer === '' ? question.fallback ?? '' : answer);

        return;
      }

      // Escape answers nothing, which every flow reads as "no credential" and
      // reports as blocked — the step stays where it is.
      if (event.name === 'escape') {
        answerRef.current?.('');

        return;
      }

      if (event.name === 'backspace') {
        setAnswer((current) => current.slice(0, -1));

        return;
      }

      if (!event.ctrl && !event.meta && event.sequence.length === 1 && event.sequence >= ' ') {
        setAnswer((current) => current + event.sequence);
      }

      return;
    }

    const result = dispatcher.feed(event, ['home']);

    if (result.pending) {
      event.preventDefault();

      return;
    }

    const action = result.actionId;

    if (action === 'home.exit') {
      event.preventDefault();
      props.onExit();

      return;
    }

    if (action === 'onboarding.skip') {
      if (activeStep === null) return;
      event.preventDefault();
      run(() => props.operations.skip(activeStep));

      return;
    }

    if (action === 'home.previous') {
      if (activeStep === 'workspace') return;
      event.preventDefault();
      setSelectedIndex((current) => (current - 1 + Math.max(1, choices.length)) % Math.max(1, choices.length));

      return;
    }

    if (action === 'home.next') {
      if (activeStep === 'workspace') return;
      event.preventDefault();
      setSelectedIndex((current) => (current + 1) % Math.max(1, choices.length));

      return;
    }

    if (action === 'home.focus-next') {
      if (activeStep !== 'workspace' || props.roles.length === 0) return;
      event.preventDefault();
      setRoleIndex((current) => (current + 1) % props.roles.length);

      return;
    }

    if (action === 'home.activate') {
      if (activeStep === 'workspace') return;
      event.preventDefault();
      activate();
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
            <text><strong fg={colors.text.strong}>Connect a provider</strong></text>
            <ReadinessRow label="Kinu account" ready={readiness.accountConnected} />
            <ReadinessRow label="Local provider" ready={readiness.providerConnected} />
            <box flexDirection="column" style={{ marginTop: 1 }}>
              {providers.map((state, index) => (
                <ProviderRow key={state.descriptor.id} state={state} selected={index === selectedIndex} />
              ))}
            </box>
            {progress.map((line, index) => (
              <text key={`${String(index)}-${line}`}><span fg={colors.intent.info}>{line}</span></text>
            ))}
            {question !== null && (
              <text>
                <span fg={colors.text.muted}>{question.label}: </span>
                <span fg={colors.text.strong}>{question.secret === true ? '•'.repeat(answer.length) : answer}</span>
                <span fg={colors.intent.accent}>▌</span>
              </text>
            )}
            {outcome !== null && (
              <text>
                <span fg={outcome.kind === 'connected' ? colors.intent.success : colors.intent.warning}>
                  {outcome.kind === 'connected' ? outcome.summary : `${outcome.reason} ${outcome.hint}`}
                </span>
              </text>
            )}
          </>
        )}
        {activeStep === 'tiers' && (
          <>
            <text><strong fg={colors.text.strong}>Choose the default model</strong></text>
            <text><span fg={colors.text.muted}>The fast and deep tiers use this model until you change them.</span></text>
            <ReadinessRow label={readiness.defaultModel ?? 'Default model'} ready={readiness.defaultModel !== undefined} />
          </>
        )}
        {activeStep === 'theme' && (
          <>
            <text><strong fg={colors.text.strong}>Choose a theme</strong></text>
            <text><span fg={colors.text.muted}>/theme changes it later.</span></text>
            {themeChoices.map((choice, index) => (
              <box key={choice.selection.themeId} flexDirection="column">
                {themeChoices[index - 1]?.appearance !== choice.appearance && (
                  <text><span fg={colors.text.muted}>{THEME_GROUP_LABELS[choice.appearance]}</span></text>
                )}
                <ChoiceRow label={choice.label} selected={index === selectedIndex} />
              </box>
            ))}
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

function ProviderRow(props: { readonly state: ProviderConnectionState; readonly selected: boolean }) {
  const { colors } = useTuiTheme();
  const { descriptor, connected, detail } = props.state;

  return (
    <text>
      <span fg={props.selected ? colors.intent.accent : colors.text.muted}>{props.selected ? '› ' : '  '}</span>
      <span fg={connected ? colors.intent.success : colors.text.muted}>{connected ? '✓ ' : '○ '}</span>
      <span fg={props.selected ? colors.text.strong : colors.text.primary}>{descriptor.label}</span>
      <span fg={colors.text.muted}> · {connected ? detail : 'not connected'}</span>
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
