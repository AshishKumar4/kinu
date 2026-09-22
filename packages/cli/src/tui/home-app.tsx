import { createCliRenderer, type TextareaRenderable } from '@opentui/core';
import { createRoot, flushSync, useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BUILTIN_ROLE_DEFINITIONS, deriveRoleLabel, offeredReasoningEfforts, type ReasoningEffort,
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
import { connectProvider, readProviderConnections } from '../commands/provider-connect';
import {
  loadConfigFile,
  resolveCloudOrigin,
  type AgentMode,
} from '../config';
import { createConfiguredLocalModelResolver } from '../local-model-resolver';
import { installTurnDiagnostics } from '../turn-log';
import { EMPTY_MODEL_MENU, normalizeModelMenu, type AgentModelEntry, type AgentModelMenu } from '@kinu.run/core';
import { requireInteractiveTerminal } from '../prompt';
import { VERSION } from '../display';
import {
  loadActiveProfile,
  loadCachedAccountProfile,
  loadLocalProfileAuthority,
  resolveProfileAuthority,
  updateDefaultTier,
} from '../profiles';
import { createKeyDispatcher, openTuiKeyBindings, type KeyScope, type TuiActionId } from './actions';
import { GuidedOnboarding, type OnboardingRoleChoice, type TuiOnboardingOperations } from './onboarding';
import { createFileTuiPreferenceStore, type WorkspaceLocationChoice } from './preferences';
import { DeviceConnectOverlay, ModelPickerOverlay } from './overlays';
import { clipText } from '@kinu.run/core';
import { useDeviceConnectPrompt } from './use-device-connect';
import { useTuiTheme, type TuiThemeColors } from './theme';
import {
  TuiProductProvider,
  TuiShell,
  tuiLayoutForWidth,
  useSceneWidth,
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

export function HomeApp({ opts }: { opts: HomeTuiOptions }) {
  return (
    <TuiProductProvider runtime={opts.tui}>
      <HomeScene opts={opts} />
    </TuiProductProvider>
  );
}

function HomeScene({ opts }: { opts: HomeTuiOptions }) {
  const { width, height } = useTerminalDimensions();
  const sceneWidth = useSceneWidth();
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
  // Effort-row catalog (#9), refreshed when the picker opens.
  const [catalog, setCatalog] = useState<AgentModelMenu>(EMPTY_MODEL_MENU);
  const [catalogHint, setCatalogHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Why the roster may be incomplete: a failed refresh, or a name the two stores contest.
  const [cloudSyncNotice, setCloudSyncNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [focusArea, setFocusArea] = useState<HomeFocus>('mission');
  const modelPickerRequestRef = useRef(0);
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const initialFocusApplied = useRef(false);
  // Effects return cleanup, not tasks; retain the task until it settles.
  const cloudSyncTaskRef = useRef<Promise<void> | null>(null);
  const catalogTaskRef = useRef<Promise<void> | null>(null);
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
  const panelWidth = Math.min(Math.max(28, sceneWidth - 4), Math.max(52, Math.floor(sceneWidth * 0.72)), 104);
  const promptHeight = compactHome ? 3 : Math.min(Math.max(4, Math.floor(height * 0.15)), 7);

  useEffect(() => () => {
    modelPickerRequestRef.current += 1;
  }, []);
  useEffect(() => {
    if (setupRequired) return;
    let live = true;
    catalogTaskRef.current = (async () => {
      try {
        const menu = await loadHomeModelCatalog(mode, opts);

        if (live) setCatalog(menu);
      } catch (cause) {
        if (live) setCatalogHint(`Catalog unavailable: ${renderThrownChain({ cause })}`);
      }
    })();

    return () => { live = false; };
  }, [mode, opts, setupRequired]);
  useEffect(() => {
    if (initialFocusApplied.current || !sidebarFocusable) return;
    initialFocusApplied.current = true;
    setFocusArea('agents');
  }, [sidebarFocusable]);
  // A hidden sidebar cannot hold focus; hand it back to the mission field.
  useEffect(() => {
    if (focusArea === 'agents' && !sidebarFocusable) setFocusArea('mission');
  }, [focusArea, sidebarFocusable]);


  useEffect(() => {
    if (!cloudReady) return;
    const abort = new AbortController();
    let task: Promise<void> | null = null;
    let settled = false;
    task = (async () => {
      // Only this effect's cleanup aborts the signal, so it decides whether a refresh failure has anywhere to land.
      let failure: { readonly cause: unknown } | undefined;

      try {
        const sync = await syncCloudAgentRefs();

        if (abort.signal.aborted) return;
        await roster.reload();

        if (abort.signal.aborted) return;
        // A contested name is neither store's cloud row; silence would read as "no such cloud workspace".
        setCloudSyncNotice(sync.collisions.length === 0 ? null : collisionNotice(sync.collisions));
      } catch (cause) {
        failure = { cause };
      } finally {
        settled = true;

        if (task !== null && cloudSyncTaskRef.current === task) cloudSyncTaskRef.current = null;
      }

      // A failed refresh must not read as the list; a torn-down scene shows nothing.
      if (failure !== undefined && !abort.signal.aborted) {
        setCloudSyncNotice(`Cloud workspaces could not be refreshed: ${renderThrownChain({ cause: failure.cause })}`);
      }
    })();
    cloudSyncTaskRef.current = task;

    if (settled && cloudSyncTaskRef.current === task) cloudSyncTaskRef.current = null;

    return () => { abort.abort(); };
  }, [cloudReady, roster.reload]);

  const modeLabel = useMemo(() => {
    if (mode === 'cloud') return cloudReady ? 'Cloud workspace' : 'Cloud workspace (sign in first)';

    return localReady ? 'Local workspace' : 'Local workspace (connect a provider first)';
  }, [cloudReady, localReady, mode]);


  const openModelPicker = useCallback(async () => {
    const request = ++modelPickerRequestRef.current;
    setFocusArea('model');
    setCatalogHint(null);
    setModelPicker({ menu: EMPTY_MODEL_MENU, loading: true, error: null });

    try {
      const menu = await loadHomeModelCatalog(mode, opts);

      // Only an empty menu is a catalog error; partial failures explain themselves in the picker.
      if (menu.models.length === 0 && menu.failures.length === 0) {
        throw new Error(`No ${mode} models are available.`);
      }

      if (modelPickerRequestRef.current !== request) return;
      setCatalog(menu);
      setModelPicker({ menu, loading: false, error: null });
    } catch (err) {
      if (modelPickerRequestRef.current !== request) return;
      const detail = renderThrownChain({ cause: err });
      const current = defaultModel || 'provider default';
      const message = `Catalog unavailable: ${detail} Current default: ${current}. ${keybindings.hint('modal.close')} keeps it.`;
      setCatalogHint('Catalog unavailable. The current default stays active.');
      setModelPicker({ menu: EMPTY_MODEL_MENU, loading: false, error: message });
    }
  }, [defaultModel, keybindings, mode, opts]);

  const selectModel = useCallback(async (model: AgentModelEntry) => {
    try {
      await updateDefaultTier({ model: model.spec });
      modelPickerRequestRef.current += 1;
      setDefaultModelState(model.spec);
      setCatalogHint(null);
      setModelPicker(null);
      setError(null);
    } catch (cause) {
      setError(renderThrownChain({ cause }));
    }
  }, []);

  const selectReasoningEffort = useCallback(async (effort: ReasoningEffort) => {
    try {
      await updateDefaultTier({ reasoningEffort: effort });
      setReasoningEffortState(effort);
      setError(null);
    } catch (cause) {
      setError(renderThrownChain({ cause }));
    }
  }, []);

  // The stored level stays listed if the catalog dropped it.
  const efforts = useMemo(
    () => offeredReasoningEfforts(
      catalog.models.find((model) => model.spec === defaultModel)?.reasoningEfforts,
      reasoningEffort,
    ),
    [catalog, defaultModel, reasoningEffort],
  );

  const moveReasoningEffort = useCallback((delta: number) => {
    const index = efforts.indexOf(reasoningEffort);
    const next = efforts[(index + delta + efforts.length) % efforts.length] ?? reasoningEffort;

    return selectReasoningEffort(next);
  }, [efforts, reasoningEffort, selectReasoningEffort]);

  const submit = useCallback(async () => {
    const mission = (textareaRef.current?.plainText ?? draft).trim();

    if (!mission || busy) return;
    setBusy(true);
    setError(null);

    try {
      if (setupRequired) throw new Error('Run kinu setup to connect your account or a local model provider.');

      if (mode === 'cloud' && !cloudReady) throw new Error('Cloud workspaces need a signed-in account. Run kinu auth, then try again.');

      if (mode === 'local' && !localReady) throw new Error('Local workspaces need a model provider. Run kinu provider connect <provider>, or switch to cloud.');
      // Cloud naming is server-side; only local agents need a generated identity.
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

      // New cloud agent with no connected PC: offer to connect this one before chat opens.
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
    const result = dispatcher.feed(key, keyScopes(modelPicker !== null, focusArea));

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

      return openModelPicker();
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
    const direction = stepDirection(actionId);

    if (direction !== 0) {
      key.preventDefault();

      if (focusArea === 'mode') {
        setMode((current) => current === 'cloud' ? 'local' : 'cloud');

        return;
      }

      if (focusArea === 'model') return openModelPicker();

      return moveReasoningEffort(direction);
    }

    if (actionId !== 'home.activate') return;
    key.preventDefault();

    if (focusArea === 'mode') {
      setMode((current) => current === 'cloud' ? 'local' : 'cloud');

      return;
    }

    if (focusArea === 'model') return openModelPicker();

    if (focusArea === 'effort') return moveReasoningEffort(1);
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
          borderStyle: 'rounded',
          borderColor: colors.border.default,
          backgroundColor: colors.background.surface,
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: 1,
          paddingBottom: 1,
        }}
      >
        <text>
          <strong fg={colors.text.strong}>{agents.length === 0 ? 'What is this workspace for?' : 'Open a workspace, or start a new one'}</strong>{'\n'}
          <span fg={colors.text.muted}>
            {subtitle(setupRequired, agents.length)}
          </span>
        </text>

        {setupRequired && (
          <box flexDirection="column" style={{ marginTop: 1, marginBottom: 1, border: true, borderStyle: 'rounded', borderColor: colors.border.subtle, paddingLeft: 1, paddingRight: 1 }}>
            <text><strong fg={colors.text.primary}>Setup required</strong></text>
            <text><span fg={colors.text.muted}>  kinu setup</span> <span fg={colors.text.primary}>sign in and pick a model provider</span></text>
            <text><span fg={colors.text.muted}>  kinu auth</span>  <span fg={colors.text.primary}>sign in for cloud workspaces only</span></text>
            <text><span fg={colors.text.muted}>  kinu provider connect codex</span> <span fg={colors.text.primary}>use ChatGPT Codex</span></text>
          </box>
        )}


        {!setupRequired && (
          <box
            style={{
              height: promptHeight,
              border: true,
              borderStyle: 'rounded',
              borderColor: composerBorder(colors, busy, focusArea === 'mission'),
              backgroundColor: colors.background.user,
              paddingLeft: 1,
              paddingRight: 1,
            }}
            title={busy ? 'Creating…' : 'Mission'}
            onMouseDown={() => {
              setFocusArea('mission');
              textareaRef.current?.focus();
            }}
          >
            <textarea
              ref={(value) => { textareaRef.current = value; }}
              focused={!busy && focusArea === 'mission' && !overlayNavigation}
              placeholder='An ongoing job, not a task. "Own the checkout service…"'
              wrapMode="word"
              keyBindings={[
                ...openTuiKeyBindings(keybindings, 'editor.submit'),
                ...openTuiKeyBindings(keybindings, 'editor.newline'),
              ]}
              onContentChange={() => setDraft(textareaRef.current?.plainText ?? '')}
              onSubmit={submit}
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
        )}

        <box flexDirection="column" style={{ marginTop: 1 }}>
          <text>
            <span fg={colors.intent.accentStrong}>Mode: </span>
            <span fg={(mode === 'cloud' ? cloudReady : localReady) ? colors.text.primary : colors.intent.warning}>
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
                ? `Run a command above, then come back · ${keybindings.hint('home.exit')} exit`
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
                backgroundColor: focusArea === 'model' ? colors.background.elevated : undefined,
                paddingLeft: 1,
                paddingRight: 1,
              }}
              onMouseDown={(event) => {
                event.stopPropagation();

                return openModelPicker();
              }}
            >
              <text>
                <span fg={focusArea === 'model' ? colors.intent.accentStrong : colors.intent.accentStrong}>Model: </span>
                <span fg={colors.text.primary}>{clipText(defaultModel || '(default)', Math.max(8, panelWidth - 30))}</span>
                <span fg={colors.text.muted}>  {focusArea === 'model' ? `${keybindings.hint('home.activate')} browse` : `${keybindings.hint('home.focus-next')} to focus`}</span>
              </text>
            </box>
            <box flexDirection="row" style={{ height: 1, paddingLeft: 1 }}>
              <text><span fg={focusArea === 'effort' ? colors.intent.accentStrong : colors.intent.accentStrong}>Effort: </span></text>
              {efforts.map((effort) => (
                <box
                  key={effort}
                  style={{
                    width: effort.length + 3,
                    backgroundColor: effort === reasoningEffort ? colors.background.elevated : undefined,
                    paddingLeft: 1,
                    paddingRight: 1,
                  }}
                  onMouseDown={(event) => {
                    event.stopPropagation();
                    setFocusArea('effort');

                    return selectReasoningEffort(effort);
                  }}
                >
                  <text>
                    <span fg={effort === reasoningEffort ? colors.text.strong : colors.text.muted}>{effort}</span>
                  </text>
                </box>
              ))}
              <text><span fg={colors.text.muted}>  {focusArea === 'effort' ? `${keybindings.hint('home.next')} select` : `${keybindings.hint('home.focus-next')} to focus`}</span></text>
            </box>
            {catalogHint && <text><span fg={colors.text.muted}>  {catalogHint}</span></text>}
          </box>
          {compactHome && (
            <text>
              <span fg={cloudReady ? colors.intent.success : colors.text.muted}>{cloudReady ? '●' : '○'} Cloud account</span>
              <span fg={colors.text.muted}>  </span>
              <span fg={localReady ? colors.intent.success : colors.text.muted}>{localReady ? '●' : '○'} Local provider</span>
            </text>
          )}
          {cloudSyncNotice && (
            <text><span fg={colors.text.muted}>{clipText(cloudSyncNotice, Math.max(8, panelWidth - 2))}</span></text>
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
          terminal={{ width: sceneWidth, height }}
          loading={modelPicker.loading}
          error={modelPicker.error}
          onSelect={selectModel}
        />
      )}
      {deviceConnect.state && <DeviceConnectOverlay prompt={deviceConnect.state} terminal={{ width: sceneWidth, height }} />}
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

  const selectedBorder = props.focused ? colors.intent.accent : colors.border.focus;
  const borderColor = props.selected ? selectedBorder : colors.border.default;
  const readyText = props.selected ? colors.text.strong : colors.text.primary;
  const textColor = props.ready ? readyText : colors.intent.warning;

  return (
    <box
      style={{
        width: 18,
        height: 3,
        border: true,
        borderStyle: 'rounded',
        borderColor,
        backgroundColor: props.selected ? colors.background.elevated : undefined,
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

      const providerConnected = connectedFor(location, accountConnected, localConnected);

      const profile = providerConnected ? await loadActiveProfile() : null;

      return {
        location,
        accountConnected,
        providerConnected,
        defaultModel: profile?.catalog.tiers.default.model,
        tierAliasesResolved: profile !== null,
        themeSelected: current.theme !== undefined,
        keymapSelected: true,
        workspaceCount: listKnownAgents().length,
        skippedSteps: current.skippedOnboardingSteps,
      };
    },
    chooseLocation() {},
    async listProviders() {
      return (await readProviderConnections()).states;
    },
    async connectProvider(id, port) {
      return await connectProvider(id, port, opts.origin === undefined ? {} : { origin: opts.origin });
    },
    async configureTiers() {
      await loadActiveProfile();
    },
    selectTheme(selection) {
      const current = preferences.read();
      preferences.write({ ...current, theme: selection });
    },
    selectKeymap(presetId) {
      const current = preferences.read();
      preferences.write({ ...current, keymapPreset: presetId });
    },
    async createWorkspace(input) {
      const current = preferences.read();
      const location = current.onboardingLocation;

      const mode: AgentMode = location === 'cloud' || location === 'local' ? location : defaultCreateMode();

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
  // Interactive surface: stderr is the person's screen, so diagnostics go to cli.log.
  installTurnDiagnostics();
  requireInteractiveTerminal();
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);
  const { promise, resolve } = Promise.withResolvers<HomeTuiAction>();

  const complete = (action: HomeTuiAction) => {
    process.off('SIGINT', onSigint);
    // Unmount synchronously (flushSync) before the renderer frees native state: a queued commit on a
    // destroyed renderer writes through a freed pointer and segfaults.
    flushSync(() => { root.unmount(); });
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

/** An open picker owns every key. */
function keyScopes(modelPickerOpen: boolean, focusArea: HomeFocus): readonly KeyScope[] {
  if (modelPickerOpen) return ['modal'];

  return focusArea === 'mission' ? ['editor', 'home', 'global'] : ['home', 'global'];
}

function stepDirection(actionId: TuiActionId | null): number {
  if (actionId === 'home.previous') return -1;

  return actionId === 'home.next' ? 1 : 0;
}

function subtitle(setupRequired: boolean, agentCount: number): string {
  if (setupRequired) return 'Run one of these once. After that you can create and open workspaces here.';

  if (agentCount === 0) {
    return 'Say what the workspace is for. Kinu names it from this and writes it to SOUL.md. Nothing runs until you send the first message.';
  }

  return 'Select a workspace, or write a mission to create a new one.';
}

function composerBorder(colors: TuiThemeColors, busy: boolean, focused: boolean): string {
  if (busy) return colors.border.strong;

  return focused ? colors.border.focus : colors.border.user;
}

/** `both` needs either. */
function connectedFor(location: WorkspaceLocationChoice | undefined, account: boolean, local: boolean): boolean {
  if (location === 'cloud') return account;

  if (location === 'local') return local;

  return account || local;
}

function nextFocus(current: HomeFocus, sidebarFocusable: boolean): HomeFocus {
  const order: HomeFocus[] = sidebarFocusable
    ? ['mission', 'agents', 'mode', 'model', 'effort']
    : ['mission', 'mode', 'model', 'effort'];

  const index = order.indexOf(current);

  return order[(index + 1) % order.length] ?? order[0];
}

/** Names first: the row clips. */
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

