import { createCliRenderer, type TextareaRenderable } from '@opentui/core';
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BUILTIN_ROLE_DEFINITIONS, deriveRoleLabel, type ReasoningEffort,
} from '@kinu.run/core';
import {
  createCliAgent,
  defaultCreateMode,
  isCloudAuthConfigured,
  isLocalModelConfigured,
  suggestAgentIdentityFromMission,
} from '../agent-create';
import {
  listKnownAgents, listSidebarAgents, syncCloudAgentRefs, type CloudRefCollision,
} from '../agent-list';
import { listCloudAvailableModels } from '../cloud-api';
import { authenticateCli } from '../commands/auth';
import {
  loadConfigFile,
  resolveCloudOrigin,
  type AgentMode,
} from '../config';
import { createConfiguredLocalModelResolver } from '../local-model-resolver';
import { installTurnDiagnostics } from '../turn-log';
import { EMPTY_MODEL_MENU, normalizeModelMenu, type AgentModelEntry, type AgentModelMenu } from '../model-catalog';
import { requireInteractiveTerminal } from '../prompt';
import { VERSION } from '../display';
import {
  loadActiveProfile,
  loadCachedAccountProfile,
  loadLocalProfileAuthority,
  resolveProfileAuthority,
  updateDefaultTier,
} from '../profiles';
import { createKeyDispatcher, openTuiKeyBindings } from './actions';
import { GuidedOnboarding, type OnboardingRoleChoice, type TuiOnboardingOperations } from './onboarding';
import { createFileTuiPreferenceStore } from './preferences';
import { DeviceConnectOverlay, ModelPickerOverlay } from './overlays';
import { clipText } from './format';
import { useDeviceConnectPrompt } from './use-device-connect';
import { useTuiTheme } from './theme';
import {
  TuiProductProvider,
  TuiShell,
  tuiLayoutForWidth,
  useTuiProduct,
  useAgentRoster,
  agentSourceFromList,
  type TuiRuntimeOptions,
  type TuiAgentSource,
  type TuiAgentSummary,
} from './tui-shell';
import { renderThrownChain } from '@kinu.run/core/obs';

export type HomeTuiAction =
  | { type: 'open-agent'; name: string }
  | { type: 'exit' };

export interface HomeTuiOptions {
  model?: string;
  baseUrl?: string;
  auth?: string;
  origin?: string;
  tui?: TuiRuntimeOptions;
  workspaceSource?: TuiAgentSource;
  onboarding?: {
    readonly operations: TuiOnboardingOperations;
    readonly roles: readonly OnboardingRoleChoice[];
  };
}

let finishHome: ((action: HomeTuiAction) => void) | null = null;
type HomeFocus = 'agents' | 'mission' | 'mode' | 'model' | 'effort';
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

export function HomeApp({ opts }: { opts: HomeTuiOptions }) {
  return (
    <TuiProductProvider runtime={opts.tui}>
      <HomeScene opts={opts} />
    </TuiProductProvider>
  );
}

function HomeScene({ opts }: { opts: HomeTuiOptions }) {
  const { width, height } = useTerminalDimensions();
  const { colors } = useTuiTheme();
  const { keybindings, preferences, updatePreferences } = useTuiProduct();
  const dispatcher = useMemo(() => createKeyDispatcher(keybindings), [keybindings]);
  const workspaceSource = useMemo(
    () => opts.workspaceSource ?? agentSourceFromList(listSidebarAgents),
    [opts.workspaceSource],
  );
  const roster = useAgentRoster(workspaceSource);
  const agents = roster.page.items;
  const [navigationOpen, setNavigationOpen] = useState(false);
  const initialDefaults = useMemo(() => {
    const config = loadConfigFile();
    const authority = resolveProfileAuthority();
    const profile = authority.kind === 'local'
      ? loadLocalProfileAuthority()
      : loadCachedAccountProfile(authority.accountId);
    return {
      model: profile?.catalog.tiers.default.model ?? config.model ?? '',
      reasoningEffort: profile?.catalog.tiers.default.reasoningEffort ?? config.reasoningEffort ?? 'medium',
    };
  }, []);
  const [mode, setMode] = useState<AgentMode>(() => defaultCreateMode());
  const [defaultModel, setDefaultModelState] = useState(initialDefaults.model);
  const [reasoningEffort, setReasoningEffortState] = useState<ReasoningEffort>(initialDefaults.reasoningEffort);
  const [modelPicker, setModelPicker] = useState<{ menu: AgentModelMenu; loading: boolean; error: string | null } | null>(null);
  const [catalogHint, setCatalogHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Both things that make the roster on screen less than the whole truth: a
  // refresh that failed, and a name the two stores contest.
  const [cloudSyncNotice, setCloudSyncNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [focusArea, setFocusArea] = useState<HomeFocus>('mission');
  const modelPickerRequestRef = useRef(0);
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const initialFocusApplied = useRef(false);
  const deviceConnect = useDeviceConnectPrompt();
  const cloudReady = isCloudAuthConfigured();
  const localReady = isLocalModelConfigured();
  const setupRequired = !cloudReady && !localReady;
  const defaultOnboarding = useMemo(() => createDefaultOnboarding(opts), [opts]);
  const defaultOnboardingRef = useRef(
    opts.onboarding ?? (setupRequired && agents.length === 0 ? defaultOnboarding : undefined),
  );
  const onboarding = defaultOnboardingRef.current;
  const [onboardingReady, setOnboardingReady] = useState(onboarding === undefined);
  const compactHome = height < 34;
  const layout = tuiLayoutForWidth(width);
  const overlayNavigation = navigationOpen && layout !== 'wide';
  const sidebarFocusable = agents.length > 0 && layout === 'wide' && preferences.wideSidebarOpen;
  const panelWidth = Math.min(Math.max(28, width - 4), Math.max(52, Math.floor(width * 0.72)), 104);
  const promptHeight = compactHome ? 3 : Math.min(Math.max(4, Math.floor(height * 0.15)), 7);

  useEffect(() => () => {
    modelPickerRequestRef.current += 1;
  }, []);
  useEffect(() => {
    if (initialFocusApplied.current || !sidebarFocusable) return;
    initialFocusApplied.current = true;
    setFocusArea('agents');
  }, [sidebarFocusable]);
  // A hidden sidebar cannot hold focus: Alt+W off or a resize below the wide
  // threshold hands focus back to the mission field.
  useEffect(() => {
    if (focusArea === 'agents' && !sidebarFocusable) setFocusArea('mission');
  }, [focusArea, sidebarFocusable]);


  useEffect(() => {
    if (!cloudReady) return;
    let cancelled = false;
    void syncCloudAgentRefs()
      .then(async (sync) => {
        if (cancelled) return;
        await roster.reload();
        if (cancelled) return;
        // A contested name reached the roster as neither store's cloud row.
        // Saying nothing would read as "you have no such cloud workspace".
        setCloudSyncNotice(sync.collisions.length === 0 ? null : collisionNotice(sync.collisions));
      })
      .catch((err) => {
        if (cancelled) return;
        // A list that could not be refreshed must not read as the list itself.
        setCloudSyncNotice(`Cloud workspaces could not be refreshed: ${renderThrownChain({ cause: err })}`);
      });
    return () => { cancelled = true; };
  }, [cloudReady, roster.reload]);

  const modeLabel = useMemo(() => {
    if (mode === 'cloud') return cloudReady ? 'Cloud workspace' : 'Cloud workspace - sign in required';
    return localReady ? 'Local workspace' : 'Local workspace - provider required';
  }, [cloudReady, localReady, mode]);


  const openModelPicker = useCallback(async () => {
    const request = ++modelPickerRequestRef.current;
    setFocusArea('model');
    setCatalogHint(null);
    setModelPicker({ menu: EMPTY_MODEL_MENU, loading: true, error: null });
    try {
      const menu = await loadHomeModelCatalog(mode, opts);
      // A menu with failures explains itself in the picker; only a menu with
      // nothing at all to show is a catalog error.
      if (menu.models.length === 0 && menu.failures.length === 0) {
        throw new Error(`No ${mode} models are available.`);
      }
      if (modelPickerRequestRef.current !== request) return;
      setModelPicker({ menu, loading: false, error: null });
    } catch (err) {
      if (modelPickerRequestRef.current !== request) return;
      const detail = renderThrownChain({ cause: err });
      const current = defaultModel || 'provider default';
      const message = `Catalog unavailable: ${detail} Current default: ${current}. ${keybindings.hint('modal.close')} keeps it.`;
      setCatalogHint('Catalog unavailable — the current default remains active.');
      setModelPicker({ menu: EMPTY_MODEL_MENU, loading: false, error: message });
    }
  }, [defaultModel, keybindings, mode, opts]);

  const selectModel = useCallback((model: AgentModelEntry) => {
    void updateDefaultTier({ model: model.spec })
      .then(() => {
        modelPickerRequestRef.current += 1;
        setDefaultModelState(model.spec);
        setCatalogHint(null);
        setModelPicker(null);
        setError(null);
      })
      .catch((error) => setError(renderThrownChain({ cause: error })));
  }, []);

  const selectReasoningEffort = useCallback((effort: ReasoningEffort) => {
    void updateDefaultTier({ reasoningEffort: effort })
      .then(() => {
        setReasoningEffortState(effort);
        setError(null);
      })
      .catch((error) => setError(renderThrownChain({ cause: error })));
  }, []);

  const moveReasoningEffort = useCallback((delta: number) => {
    const index = REASONING_EFFORTS.indexOf(reasoningEffort);
    const next = REASONING_EFFORTS[(index + delta + REASONING_EFFORTS.length) % REASONING_EFFORTS.length] ?? reasoningEffort;
    selectReasoningEffort(next);
  }, [reasoningEffort, selectReasoningEffort]);

  const submit = useCallback(async () => {
    const mission = (textareaRef.current?.plainText ?? draft).trim();
    if (!mission || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (setupRequired) throw new Error('Run kinu setup to connect your account or a local model provider.');
      if (mode === 'cloud' && !cloudReady) throw new Error('Sign in first with kinu auth, then create a cloud workspace.');
      if (mode === 'local' && !localReady) throw new Error('Connect a local provider with kinu provider connect, or switch to cloud after sign-in.');
      // Cloud naming is server-side (async display-name generation after
      // create); only local agents need a locally generated identity.
      const identity = mode === 'local' ? await suggestAgentIdentityFromMission(mission, opts) : undefined;
      const created = await createCliAgent({
        ...opts,
        name: identity?.name,
        displayName: identity?.displayName,
        nameOrigin: identity?.nameOrigin,
        purpose: mission,
        mode,
        allowInteractiveAuth: false,
      });
      // A new cloud agent with no connected PC: offer to connect this one
      // before the chat opens (the modal resolves immediately otherwise).
      if (created.mode === 'cloud') await deviceConnect.offerIfUnconnected();
      finishHome?.({ type: 'open-agent', name: created.name });
    } catch (err) {
      setError(renderThrownChain({ cause: err }));
      setBusy(false);
    }
  }, [busy, cloudReady, defaultModel, deviceConnect.offerIfUnconnected, draft, localReady, mode, opts, reasoningEffort, setupRequired]);

  useKeyboard((key) => {
    if (deviceConnect.handleKey(key) || busy) return;
    if (overlayNavigation) return;
    const result = dispatcher.feed(key, modelPicker ? ['modal'] : focusArea === 'mission' ? ['editor', 'home', 'global'] : ['home', 'global']);
    if (result.pending) {
      key.preventDefault();
      return;
    }
    const actionId = result.actionId;
    if (actionId === null) return;
    if (modelPicker) {
      if (actionId === 'modal.close') {
        key.preventDefault();
        modelPickerRequestRef.current += 1;
        setModelPicker(null);
      }
      return;
    }
    if (actionId === 'workspace.toggle') {
      key.preventDefault();
      if (layout === 'wide') {
        updatePreferences((current) => ({ ...current, wideSidebarOpen: !current.wideSidebarOpen }));
      } else {
        setNavigationOpen((open) => !open);
      }
      return;
    }
    if (actionId === 'model.open') {
      key.preventDefault();
      void openModelPicker();
      return;
    }
    if (actionId === 'home.exit') {
      key.preventDefault();
      finishHome?.({ type: 'exit' });
      return;
    }
    if (actionId === 'home.focus-next') {
      key.preventDefault();
      setFocusArea((current) => nextFocus(current, sidebarFocusable));
      return;
    }
    if (focusArea === 'mission' || focusArea === 'agents') return;
    const direction = actionId === 'home.previous' ? -1 : actionId === 'home.next' ? 1 : 0;
    if (direction !== 0) {
      key.preventDefault();
      if (focusArea === 'mode') setMode((current) => current === 'cloud' ? 'local' : 'cloud');
      else if (focusArea === 'model') void openModelPicker();
      else moveReasoningEffort(direction);
      return;
    }
    if (actionId !== 'home.activate') return;
    key.preventDefault();
    if (focusArea === 'mode') setMode((current) => current === 'cloud' ? 'local' : 'cloud');
    else if (focusArea === 'model') void openModelPicker();
    else if (focusArea === 'effort') moveReasoningEffort(1);
  });

  const openAgent = (agent: TuiAgentSummary) => {
    finishHome?.({ type: 'open-agent', name: agent.name });
  };
  if (!onboardingReady && onboarding !== undefined) {
    return (
      <TuiShell
        scene="onboarding"
        roster={roster}
        navigationOverlayOpen={navigationOpen}
        onNavigationOverlayChange={setNavigationOpen}
        onAgentSelect={openAgent}
      >
        <GuidedOnboarding
          operations={onboarding.operations}
          roles={onboarding.roles}
          onReady={() => setOnboardingReady(true)}
          onExit={() => finishHome?.({ type: 'exit' })}
        />
      </TuiShell>
    );
  }

  return (
    <TuiShell
      scene="home"
      roster={roster}
      navigationOverlayOpen={navigationOpen}
      onNavigationOverlayChange={setNavigationOpen}
      navigationFocused={focusArea === 'agents'}
      onAgentSelect={openAgent}
    >
    <box
      flexDirection="column"
      alignItems="center"
      justifyContent={height < 32 ? 'flex-start' : 'center'}
      style={{ height: '100%', backgroundColor: colors.background.canvas, paddingLeft: 2, paddingRight: 2 }}
    >
      <box style={{ width: panelWidth, marginBottom: 1 }}>
        <text>
          <strong fg={colors.intent.accentStrong}>Kinu</strong>{' '}
          <span fg={colors.text.muted}>workspaces · cli {VERSION}</span>
        </text>
      </box>

      <box
        flexDirection="column"
        style={{
          width: panelWidth,
          border: true,
          borderStyle: 'single',
          borderColor: colors.border.default,
          backgroundColor: colors.background.chrome,
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: 1,
          paddingBottom: 1,
        }}
      >
        <text>
          <strong fg={colors.text.strong}>{agents.length === 0 ? 'What is this workspace for?' : 'Open a workspace, or start a new one'}</strong>{'\n'}
          <span fg={colors.text.muted}>
            {setupRequired
              ? 'Connect Kinu once, then this screen can create and open workspaces directly.'
              : agents.length === 0
              ? "Describe what the workspace is for. It becomes the workspace's SOUL.md and its name; nothing runs until you send the first message."
              : 'Select a workspace, or write a mission to create a new one.'}
          </span>
        </text>

        {setupRequired && (
          <box flexDirection="column" style={{ marginTop: 1, marginBottom: 1, border: true, borderStyle: 'single', borderColor: colors.border.subtle, paddingLeft: 1, paddingRight: 1 }}>
            <text><strong fg={colors.text.primary}>Setup required</strong></text>
            <text><span fg={colors.text.muted}>  kinu setup</span> <span fg={colors.text.primary}>connect account and optional local provider</span></text>
            <text><span fg={colors.text.muted}>  kinu auth</span>  <span fg={colors.text.primary}>connect cloud workspaces only</span></text>
            <text><span fg={colors.text.muted}>  kinu provider connect codex</span> <span fg={colors.text.primary}>connect local model access</span></text>
          </box>
        )}


        {!setupRequired && (
          <box
            style={{
              height: promptHeight,
              border: true,
              borderStyle: 'single',
              borderColor: busy ? colors.border.strong : focusArea === 'mission' ? colors.border.focus : colors.border.default,
              backgroundColor: colors.background.recessed,
              paddingLeft: 1,
              paddingRight: 1,
            }}
            title={busy ? 'Creating...' : 'Mission'}
            onMouseDown={() => {
              setFocusArea('mission');
              textareaRef.current?.focus();
            }}
          >
            <textarea
              ref={(value) => { textareaRef.current = value; }}
              focused={!busy && focusArea === 'mission' && !overlayNavigation}
              placeholder='A standing brief, not a task. "Own the checkout service..."'
              wrapMode="word"
              keyBindings={[
                ...openTuiKeyBindings(keybindings, 'editor.submit'),
                ...openTuiKeyBindings(keybindings, 'editor.newline'),
              ]}
              onContentChange={() => setDraft(textareaRef.current?.plainText ?? '')}
              onSubmit={() => { void submit(); }}
            />
          </box>
        )}

        <box flexDirection="column" style={{ marginTop: 1 }}>
          <text>
            <span fg={colors.intent.accentStrong}>Mode: </span>
            <span fg={mode === 'cloud' ? (cloudReady ? colors.text.primary : colors.intent.warningMuted) : (localReady ? colors.text.primary : colors.intent.warningMuted)}>
              {modeLabel}
            </span>
            <span fg={colors.text.muted}>  {focusArea === 'mode' ? `${keybindings.hint('home.next')} switches` : `${keybindings.hint('home.focus-next')} to focus`}</span>
          </text>
          {!compactHome && (
            <box flexDirection="row" style={{ height: 3, marginTop: 1 }}>
              <ModeSegment
                label="Cloud"
                selected={mode === 'cloud'}
                focused={focusArea === 'mode'}
                ready={cloudReady}
                onSelect={() => {
                  setFocusArea('mode');
                  setMode('cloud');
                }}
              />
              <box style={{ width: 2 }} />
              <ModeSegment
                label="Local"
                selected={mode === 'local'}
                focused={focusArea === 'mode'}
                ready={localReady}
                onSelect={() => {
                  setFocusArea('mode');
                  setMode('local');
                }}
              />
            </box>
          )}
          <text>
            <span fg={colors.text.muted}>
              {setupRequired
                ? `Use the guided setup above, then return here · ${keybindings.hint('home.exit')} exit`
                : `${keybindings.hint('workspace.toggle')} workspaces · ${keybindings.hint('editor.submit')} create · ${keybindings.hint('home.exit')} exit`}
            </span>
          </text>
          <box flexDirection="column" style={{ marginTop: compactHome ? 0 : 1 }}>
            <text>
              <strong fg={colors.text.strong}>Defaults</strong>
              <span fg={colors.text.muted}>  saved globally for new workspaces</span>
            </text>
            <box
              style={{
                height: 1,
                backgroundColor: focusArea === 'model' ? colors.background.selectionStrong : colors.background.chrome,
                paddingLeft: 1,
                paddingRight: 1,
              }}
              onMouseDown={(event) => {
                event.stopPropagation();
                void openModelPicker();
              }}
            >
              <text>
                <span fg={focusArea === 'model' ? colors.intent.accentStrong : colors.intent.accentStrong}>Model: </span>
                <span fg={colors.text.primary}>{clipText(defaultModel || 'provider default', Math.max(8, panelWidth - 30))}</span>
                <span fg={colors.text.muted}>  {focusArea === 'model' ? `${keybindings.hint('home.activate')} browse` : `${keybindings.hint('home.focus-next')} to focus`}</span>
              </text>
            </box>
            <box flexDirection="row" style={{ height: 1, paddingLeft: 1 }}>
              <text><span fg={focusArea === 'effort' ? colors.intent.accentStrong : colors.intent.accentStrong}>Effort: </span></text>
              {REASONING_EFFORTS.map((effort) => (
                <box
                  key={effort}
                  style={{
                    width: effort.length + 3,
                    backgroundColor: effort === reasoningEffort ? colors.background.selection : colors.background.chrome,
                    paddingLeft: 1,
                    paddingRight: 1,
                  }}
                  onMouseDown={(event) => {
                    event.stopPropagation();
                    setFocusArea('effort');
                    selectReasoningEffort(effort);
                  }}
                >
                  <text>
                    <span fg={effort === reasoningEffort ? colors.text.strong : colors.text.muted}>{effort}</span>
                  </text>
                </box>
              ))}
              <text><span fg={colors.text.muted}>  {focusArea === 'effort' ? `${keybindings.hint('home.next')} select` : `${keybindings.hint('home.focus-next')} to focus`}</span></text>
            </box>
            {catalogHint && <text><span fg={colors.intent.warningMuted}>  {catalogHint}</span></text>}
          </box>
          {compactHome && (
            <text>
              <span fg={cloudReady ? colors.intent.success : colors.text.muted}>{cloudReady ? '●' : '○'} Cloud account</span>
              <span fg={colors.text.muted}>  </span>
              <span fg={localReady ? colors.intent.success : colors.text.muted}>{localReady ? '●' : '○'} Local provider</span>
            </text>
          )}
          {cloudSyncNotice && (
            <text><span fg={colors.intent.warningMuted}>{clipText(cloudSyncNotice, Math.max(8, panelWidth - 2))}</span></text>
          )}
        </box>

        {error && (
          <box style={{ marginTop: 1 }}>
            <text><span fg={colors.intent.danger}>{error}</span></text>
          </box>
        )}
      </box>

      {modelPicker && (
        <ModelPickerOverlay
          models={modelPicker.menu.models}
          failures={modelPicker.menu.failures}
          currentSpec={defaultModel || null}
          terminal={{ width, height }}
          loading={modelPicker.loading}
          error={modelPicker.error}
          onSelect={selectModel}
        />
      )}
      {deviceConnect.state && <DeviceConnectOverlay prompt={deviceConnect.state} terminal={{ width, height }} />}
    </box>
    </TuiShell>
  );
}

function ModeSegment(props: {
  label: string;
  selected: boolean;
  focused: boolean;
  ready: boolean;
  onSelect: () => void;
}) {
  const { colors } = useTuiTheme();
  const borderColor = props.selected
    ? props.focused ? colors.intent.accent : colors.border.focus
    : colors.border.default;
  const textColor = props.ready
    ? props.selected ? colors.text.strong : colors.text.primary
    : colors.intent.warningMuted;
  return (
    <box
      style={{
        width: 18,
        height: 3,
        border: true,
        borderStyle: 'single',
        borderColor,
        backgroundColor: props.selected ? colors.background.selectionStrong : colors.background.recessed,
        paddingLeft: 1,
        paddingRight: 1,
        alignItems: 'center',
      }}
      onMouseDown={(event) => {
        event.stopPropagation();
        props.onSelect();
      }}
    >
      <text>
        <span fg={props.selected ? colors.intent.success : colors.text.muted}>{props.selected ? '●' : '○'}</span>
        {' '}
        <strong fg={textColor}>{props.label}</strong>
      </text>
    </box>
  );
}

function createDefaultOnboarding(
  opts: HomeTuiOptions,
): NonNullable<HomeTuiOptions['onboarding']> {
  const preferences = createFileTuiPreferenceStore();
  const roles: OnboardingRoleChoice[] = Object.entries(BUILTIN_ROLE_DEFINITIONS)
    .map(([id, role]) => ({
      id,
      label: deriveRoleLabel(id),
      description: role.description,
    }));
  const operations: TuiOnboardingOperations = {
    async readReadiness() {
      const current = preferences.read();
      const accountConnected = isCloudAuthConfigured();
      const localConnected = isLocalModelConfigured();
      const location = current.onboardingLocation;
      const providerConnected = location === 'cloud'
        ? accountConnected
        : location === 'local'
          ? localConnected
          : accountConnected || localConnected;
      const profile = providerConnected ? await loadActiveProfile() : null;
      return {
        location,
        accountConnected,
        providerConnected,
        defaultModel: profile?.catalog.tiers.default.model,
        tierAliasesResolved: profile !== null,
        themeSelected: true,
        keymapSelected: true,
        workspaceCount: listKnownAgents().length,
        skippedSteps: current.skippedOnboardingSteps,
      };
    },
    chooseLocation() {},
    async connectAccount() {
      await authenticateCli({ origin: opts.origin });
    },
    async connectProvider() {
      const location = preferences.read().onboardingLocation;
      if ((location === 'cloud' || location === 'both') && isCloudAuthConfigured()) return;
      if (isLocalModelConfigured()) return;
      throw new Error('No local provider is connected. Use cloud sign-in, or run `kinu provider connect codex`.');
    },
    async configureTiers() {
      await loadActiveProfile();
    },
    selectTheme(themeId) {
      const current = preferences.read();
      preferences.write({ ...current, theme: { mode: 'theme', themeId } });
    },
    selectKeymap(presetId) {
      const current = preferences.read();
      preferences.write({ ...current, keymapPreset: presetId });
    },
    async createWorkspace(input) {
      const current = preferences.read();
      const location = current.onboardingLocation;
      const mode: AgentMode = location === 'cloud'
        ? 'cloud'
        : location === 'local'
          ? 'local'
          : defaultCreateMode();
      const identity = mode === 'local'
        ? await suggestAgentIdentityFromMission(input.mission, opts)
        : null;
      const created = await createCliAgent({
        ...opts,
        purpose: input.mission,
        mode,
        name: identity?.name,
        displayName: identity?.displayName,
        nameOrigin: identity?.nameOrigin,
        role: input.roleId,
      });
      finishHome?.({ type: 'open-agent', name: created.name });
    },
    skip(step) {
      const current = preferences.read();
      preferences.write({
        ...current,
        skippedOnboardingSteps: [...new Set([...current.skippedOnboardingSteps, step])],
      });
    },
  };
  return { operations, roles };
}

export async function runHomeTui(opts: HomeTuiOptions = {}): Promise<HomeTuiAction> {
  // The home screen is an interactive surface like chat and run: its stderr is
  // the person's own screen, so diagnostics go to cli.log, not between us.
  installTurnDiagnostics();
  requireInteractiveTerminal();
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);
  const { promise, resolve } = Promise.withResolvers<HomeTuiAction>();
  const complete = (action: HomeTuiAction) => {
    process.off('SIGINT', onSigint);
    root.render(<box />);
    renderer.destroy();
    resolve(action);
  };
  const onSigint = () => complete({ type: 'exit' });
  finishHome = complete;
  process.on('SIGINT', onSigint);
  root.render(<HomeApp opts={opts} />);
  return await promise.finally(() => {
    finishHome = null;
  });
}

function nextFocus(current: HomeFocus, sidebarFocusable: boolean): HomeFocus {
  const order: HomeFocus[] = sidebarFocusable
    ? ['mission', 'agents', 'mode', 'model', 'effort']
    : ['mission', 'mode', 'model', 'effort'];
  const index = order.indexOf(current);
  return order[(index + 1) % order.length] ?? order[0]!;
}

/**
 * What a contested name costs the reader: the cloud workspace is not on the
 * roster, the local one kept the name, and only a rename settles it — the
 * same posture `resolveAgentTarget` takes when a bare name has two candidates.
 *
 * Names first, because this row is clipped to the panel width and the names
 * are the part the reader cannot reconstruct from anything else on screen.
 */
function collisionNotice(collisions: readonly CloudRefCollision[]): string {
  const names = collisions.map((hit) => hit.name).join(', ');
  return collisions.length === 1
    ? `${names}: a local workspace holds this name, so the cloud one is not listed. Rename one of them.`
    : `${names}: local workspaces hold these names, so their cloud ones are not listed. Rename one side.`;
}

async function loadHomeModelCatalog(mode: AgentMode, opts: HomeTuiOptions): Promise<AgentModelMenu> {
  return normalizeModelMenu({
    payload: mode === 'cloud'
      ? await loadCloudHomeModels(opts.origin)
      : await createConfiguredLocalModelResolver(opts).resolver.listModels(),
  });
}

async function loadCloudHomeModels(originOverride: string | undefined) {
  const config = loadConfigFile();
  if (!config.accessToken) throw new Error('Sign in with kinu auth to browse cloud models.');
  return listCloudAvailableModels(resolveCloudOrigin({ origin: originOverride }), config.accessToken);
}

