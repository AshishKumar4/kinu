import { createCliRenderer, type TextareaRenderable } from '@opentui/core';
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReasoningEffort } from '@kinu.run/core';
import {
  createCliAgent,
  defaultCreateMode,
  isCloudAuthConfigured,
  isLocalModelConfigured,
  suggestAgentIdentityFromMission,
} from '../agent-create';
import { listKnownAgents, syncCloudAgentRefs, type ListedAgent } from '../agent-list';
import { listCloudAvailableModels } from '../cloud-api';
import {
  loadConfigFile,
  resolveCloudOrigin,
  setDefaultModel,
  setDefaultReasoningEffort,
  type AgentMode,
} from '../config';
import { createConfiguredLocalModelResolver } from '../local-model-resolver';
import { installTurnDiagnostics } from '../turn-log';
import { EMPTY_MODEL_MENU, normalizeModelMenu, type AgentModelEntry, type AgentModelMenu } from '../model-catalog';
import { requireInteractiveTerminal } from '../prompt';
import { VERSION } from '../display';
import { DeviceConnectOverlay, ModelPickerOverlay } from './overlays';
import { clipText } from './format';
import { useDeviceConnectPrompt } from './use-device-connect';
import { tuiColors } from './theme';
import { renderThrownChain } from '@kinu.run/core/obs';

export type HomeTuiAction =
  | { type: 'open-agent'; name: string }
  | { type: 'exit' };

export interface HomeTuiOptions {
  model?: string;
  baseUrl?: string;
  auth?: string;
  origin?: string;
}

let finishHome: ((action: HomeTuiAction) => void) | null = null;
type HomeFocus = 'agents' | 'mission' | 'mode' | 'model' | 'effort';
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

export function HomeApp({ opts }: { opts: HomeTuiOptions }) {
  const { width, height } = useTerminalDimensions();
  const initialDefaults = useMemo(() => loadConfigFile(), []);
  const [agents, setAgents] = useState<ListedAgent[]>(() => listKnownAgents());
  const [mode, setMode] = useState<AgentMode>(() => defaultCreateMode());
  const [defaultModel, setDefaultModelState] = useState(initialDefaults.model ?? '');
  const [reasoningEffort, setReasoningEffortState] = useState<ReasoningEffort>(initialDefaults.reasoningEffort ?? 'medium');
  const [modelPicker, setModelPicker] = useState<{ menu: AgentModelMenu; loading: boolean; error: string | null } | null>(null);
  const [catalogHint, setCatalogHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloudSyncError, setCloudSyncError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [focusArea, setFocusArea] = useState<HomeFocus>('mission');
  const [selectedAgentIndex, setSelectedAgentIndex] = useState(0);
  const [agentPage, setAgentPage] = useState(0);
  const modelPickerRequestRef = useRef(0);
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const deviceConnect = useDeviceConnectPrompt();
  const cloudReady = isCloudAuthConfigured();
  const localReady = isLocalModelConfigured();
  const setupRequired = !cloudReady && !localReady;
  const compactHome = height < 34;
  const panelWidth = Math.min(Math.max(28, width - 4), Math.max(52, Math.floor(width * 0.72)), 104);
  const promptHeight = compactHome ? 3 : Math.min(Math.max(4, Math.floor(height * 0.15)), 7);
  const agentPageSize = clamp(height - (compactHome ? 23 : 33), 1, 9);
  const agentPageCount = Math.max(1, Math.ceil(agents.length / agentPageSize));
  const agentPageStart = agentPage * agentPageSize;
  const visibleAgents = agents.slice(agentPageStart, agentPageStart + agentPageSize);

  useEffect(() => () => {
    modelPickerRequestRef.current += 1;
  }, []);

  useEffect(() => {
    if (!cloudReady) return;
    let cancelled = false;
    void syncCloudAgentRefs()
      .then((next) => {
        if (cancelled) return;
        setAgents(next);
        setCloudSyncError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        // A list that could not be refreshed must not read as the list itself.
        setCloudSyncError(`Cloud workspaces could not be refreshed: ${renderThrownChain({ cause: err })}`);
      });
    return () => { cancelled = true; };
  }, [cloudReady]);

  const modeLabel = useMemo(() => {
    if (mode === 'cloud') return cloudReady ? 'Cloud workspace' : 'Cloud workspace - sign in required';
    return localReady ? 'Local workspace' : 'Local workspace - provider required';
  }, [cloudReady, localReady, mode]);

  const selectAgentIndex = useCallback((index: number) => {
    const next = clamp(index, 0, Math.max(0, agents.length - 1));
    setSelectedAgentIndex(next);
    setAgentPage(Math.floor(next / agentPageSize));
  }, [agentPageSize, agents.length]);

  const openSelectedAgent = useCallback(() => {
    const selected = agents[selectedAgentIndex];
    if (selected) finishHome?.({ type: 'open-agent', name: selected.name });
  }, [agents, selectedAgentIndex]);

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
      const message = `Catalog unavailable: ${detail} Current default: ${current}. Esc keeps it.`;
      setCatalogHint('Catalog unavailable — the current default remains active.');
      setModelPicker({ menu: EMPTY_MODEL_MENU, loading: false, error: message });
    }
  }, [defaultModel, mode, opts]);

  const selectModel = useCallback((model: AgentModelEntry) => {
    try {
      setDefaultModel(model.spec);
      modelPickerRequestRef.current += 1;
      setDefaultModelState(model.spec);
      setCatalogHint(null);
      setModelPicker(null);
      setError(null);
    } catch (err) {
      setError(renderThrownChain({ cause: err }));
    }
  }, []);

  const selectReasoningEffort = useCallback((effort: ReasoningEffort) => {
    try {
      setDefaultReasoningEffort(effort);
      setReasoningEffortState(effort);
      setError(null);
    } catch (err) {
      setError(renderThrownChain({ cause: err }));
    }
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
        model: defaultModel || opts.model,
        reasoningEffort,
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
    if (deviceConnect.handleKey(key)) return;
    if (busy) return;
    if (modelPicker) {
      if (key.name === 'escape') {
        modelPickerRequestRef.current += 1;
        setModelPicker(null);
      }
      return;
    }
    if (key.name === 'escape') {
      finishHome?.({ type: 'exit' });
      return;
    }
    if (key.name === 'tab') {
      setFocusArea((current) => nextFocus(current, agents.length > 0));
      return;
    }
    if (focusArea === 'mission') return;
    if (focusArea === 'mode') {
      if (key.name === 'left' || key.name === 'right' || key.name === 'up' || key.name === 'down' || key.name === 'return') {
        setMode((current) => current === 'cloud' ? 'local' : 'cloud');
      }
      return;
    }
    if (focusArea === 'model') {
      if (key.name === 'return' || key.name === 'up' || key.name === 'down') void openModelPicker();
      return;
    }
    if (focusArea === 'effort') {
      if (key.name === 'up' || key.name === 'left') moveReasoningEffort(-1);
      else if (key.name === 'down' || key.name === 'right' || key.name === 'return') moveReasoningEffort(1);
      return;
    }
    if (agents.length === 0) return;
    if (key.name === 'return') {
      openSelectedAgent();
      return;
    }
    if (key.name === 'up') {
      selectAgentIndex(selectedAgentIndex - 1);
      return;
    }
    if (key.name === 'down') {
      selectAgentIndex(selectedAgentIndex + 1);
      return;
    }
    if (key.name === 'right' || key.name === 'pagedown') {
      selectAgentIndex(Math.min(agents.length - 1, (agentPage + 1) * agentPageSize));
      return;
    }
    if (key.name === 'left' || key.name === 'pageup') {
      selectAgentIndex(Math.max(0, (agentPage - 1) * agentPageSize));
    }
  });

  return (
    <box
      flexDirection="column"
      alignItems="center"
      justifyContent={height < 32 ? 'flex-start' : 'center'}
      style={{ height: '100%', backgroundColor: tuiColors.bg, paddingLeft: 2, paddingRight: 2 }}
    >
      <box style={{ width: panelWidth, marginBottom: 1 }}>
        <text>
          <strong fg={tuiColors.accentStrong}>Kinu</strong>{' '}
          <span fg={tuiColors.muted}>workspaces · cli {VERSION}</span>
        </text>
      </box>

      <box
        flexDirection="column"
        style={{
          width: panelWidth,
          border: true,
          borderStyle: 'single',
          borderColor: tuiColors.border,
          backgroundColor: tuiColors.panel,
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: 1,
          paddingBottom: 1,
        }}
      >
        <text>
          <strong fg={tuiColors.textStrong}>{agents.length === 0 ? 'What is this workspace for?' : 'Open a workspace, or start a new one'}</strong>{'\n'}
          <span fg={tuiColors.muted}>
            {setupRequired
              ? 'Connect Kinu once, then this screen can create and open workspaces directly.'
              : agents.length === 0
              ? "Describe what the workspace is for. It becomes the workspace's SOUL.md and its name; nothing runs until you send the first message."
              : 'Select a workspace, or write a mission to create a new one.'}
          </span>
        </text>

        {setupRequired && (
          <box flexDirection="column" style={{ marginTop: 1, marginBottom: 1, border: true, borderStyle: 'single', borderColor: tuiColors.borderSubtle, paddingLeft: 1, paddingRight: 1 }}>
            <text><strong fg={tuiColors.text}>Setup required</strong></text>
            <text><span fg={tuiColors.muted}>  kinu setup</span> <span fg={tuiColors.text}>connect account and optional local provider</span></text>
            <text><span fg={tuiColors.muted}>  kinu auth</span>  <span fg={tuiColors.text}>connect cloud workspaces only</span></text>
            <text><span fg={tuiColors.muted}>  kinu provider connect codex</span> <span fg={tuiColors.text}>connect local model access</span></text>
          </box>
        )}

        {agents.length > 0 && (
          <box flexDirection="column" style={{ marginTop: 1, marginBottom: 1 }}>
            <text>
              <span fg={focusArea === 'agents' ? tuiColors.accentStrong : tuiColors.accentDeep}>Workspaces</span>
              <span fg={tuiColors.muted}>  {focusArea === 'agents' ? '↑/↓ select · Enter open' : 'Tab to focus'}</span>
            </text>
            {visibleAgents.map((agent, index) => {
              const absoluteIndex = agentPageStart + index;
              const selected = absoluteIndex === selectedAgentIndex;
              return (
                <box
                  key={agent.name}
                  style={{
                    height: 1,
                    backgroundColor: selected ? tuiColors.selection : tuiColors.panel,
                    paddingLeft: 1,
                    paddingRight: 1,
                  }}
                  onMouseDown={(event) => {
                    event.stopPropagation();
                    selectAgentIndex(absoluteIndex);
                    finishHome?.({ type: 'open-agent', name: agent.name });
                  }}
                >
                  <text>
                    <span fg={selected ? tuiColors.accentStrong : tuiColors.muted}>{selected ? '› ' : '  '}</span>
                    <span fg={selected ? tuiColors.textStrong : tuiColors.text}>{agent.label}</span>
                    <span fg={tuiColors.muted}>  {agent.mode}</span>
                  </text>
                </box>
              );
            })}
            {agentPageCount > 1 && (
              <text>
                <span fg={tuiColors.muted}>  Page {agentPage + 1}/{agentPageCount} · Left/Right or PgUp/PgDn</span>
              </text>
            )}
          </box>
        )}

        {!setupRequired && (
          <box
            style={{
              height: promptHeight,
              border: true,
              borderStyle: 'single',
              borderColor: busy ? tuiColors.borderMuted : focusArea === 'mission' ? tuiColors.borderActive : tuiColors.border,
              backgroundColor: tuiColors.panelDeep,
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
              focused={!busy && focusArea === 'mission'}
              placeholder='A standing brief, not a task. "Own the checkout service..."'
              wrapMode="word"
              keyBindings={[
                { name: 'return', ctrl: true, action: 'submit' },
                { name: 'return', meta: true, action: 'submit' },
              ]}
              onKeyDown={(event) => {
                if (event.name === 'escape') finishHome?.({ type: 'exit' });
              }}
              onContentChange={() => setDraft(textareaRef.current?.plainText ?? '')}
              onSubmit={() => { void submit(); }}
            />
          </box>
        )}

        <box flexDirection="column" style={{ marginTop: 1 }}>
          <text>
            <span fg={tuiColors.accentDeep}>Mode: </span>
            <span fg={mode === 'cloud' ? (cloudReady ? tuiColors.text : tuiColors.amberDeep) : (localReady ? tuiColors.text : tuiColors.amberDeep)}>
              {modeLabel}
            </span>
            <span fg={tuiColors.muted}>  {focusArea === 'mode' ? '←/→ or Enter switches' : 'Tab to focus'}</span>
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
            <span fg={tuiColors.muted}>
              {setupRequired
                ? 'Run one setup command above, then return here · Esc exit'
                : `${agents.length > 0 ? '↑/↓ select · Enter open · ' : 'Tab focus mode · '}Ctrl+Enter create · Esc exit`}
            </span>
          </text>
          <box flexDirection="column" style={{ marginTop: compactHome ? 0 : 1 }}>
            <text>
              <strong fg={tuiColors.textStrong}>Defaults</strong>
              <span fg={tuiColors.muted}>  saved globally for new workspaces</span>
            </text>
            <box
              style={{
                height: 1,
                backgroundColor: focusArea === 'model' ? tuiColors.selectionDeep : tuiColors.panel,
                paddingLeft: 1,
                paddingRight: 1,
              }}
              onMouseDown={(event) => {
                event.stopPropagation();
                void openModelPicker();
              }}
            >
              <text>
                <span fg={focusArea === 'model' ? tuiColors.accentStrong : tuiColors.accentDeep}>Model: </span>
                <span fg={tuiColors.text}>{clipText(defaultModel || 'provider default', Math.max(8, panelWidth - 30))}</span>
                <span fg={tuiColors.muted}>  {focusArea === 'model' ? 'Enter browse' : 'Tab to focus'}</span>
              </text>
            </box>
            <box flexDirection="row" style={{ height: 1, paddingLeft: 1 }}>
              <text><span fg={focusArea === 'effort' ? tuiColors.accentStrong : tuiColors.accentDeep}>Effort: </span></text>
              {REASONING_EFFORTS.map((effort) => (
                <box
                  key={effort}
                  style={{
                    width: effort.length + 3,
                    backgroundColor: effort === reasoningEffort ? tuiColors.selection : tuiColors.panel,
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
                    <span fg={effort === reasoningEffort ? tuiColors.textStrong : tuiColors.muted}>{effort}</span>
                  </text>
                </box>
              ))}
              <text><span fg={tuiColors.muted}>  {focusArea === 'effort' ? '↑/↓ select' : 'Tab to focus'}</span></text>
            </box>
            {catalogHint && <text><span fg={tuiColors.amberDeep}>  {catalogHint}</span></text>}
          </box>
          {compactHome && (
            <text>
              <span fg={cloudReady ? tuiColors.green : tuiColors.muted}>{cloudReady ? '●' : '○'} Cloud account</span>
              <span fg={tuiColors.muted}>  </span>
              <span fg={localReady ? tuiColors.green : tuiColors.muted}>{localReady ? '●' : '○'} Local provider</span>
            </text>
          )}
          {cloudSyncError && (
            <text><span fg={tuiColors.amberDeep}>{clipText(cloudSyncError, Math.max(8, panelWidth - 2))}</span></text>
          )}
        </box>

        {error && (
          <box style={{ marginTop: 1 }}>
            <text><span fg={tuiColors.red}>{error}</span></text>
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
  );
}

function ModeSegment(props: {
  label: string;
  selected: boolean;
  focused: boolean;
  ready: boolean;
  onSelect: () => void;
}) {
  const borderColor = props.selected
    ? props.focused ? tuiColors.accent : tuiColors.borderActive
    : tuiColors.border;
  const textColor = props.ready
    ? props.selected ? tuiColors.textStrong : tuiColors.text
    : tuiColors.amberDeep;
  return (
    <box
      style={{
        width: 18,
        height: 3,
        border: true,
        borderStyle: 'single',
        borderColor,
        backgroundColor: props.selected ? tuiColors.selectionDeep : tuiColors.panelDeep,
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
        <span fg={props.selected ? tuiColors.green : tuiColors.muted}>{props.selected ? '●' : '○'}</span>
        {' '}
        <strong fg={textColor}>{props.label}</strong>
      </text>
    </box>
  );
}

export async function runHomeTui(opts: HomeTuiOptions = {}): Promise<HomeTuiAction> {
  // The home screen is an interactive surface like chat and run: its stderr is
  // the person's own screen, so diagnostics go to cli.log, not between us.
  installTurnDiagnostics();
  requireInteractiveTerminal();
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);
  return await new Promise<HomeTuiAction>((resolve) => {
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
  }).finally(() => {
    finishHome = null;
  });
}

function nextFocus(current: HomeFocus, hasAgents: boolean): HomeFocus {
  const order: HomeFocus[] = hasAgents
    ? ['mission', 'agents', 'mode', 'model', 'effort']
    : ['mission', 'mode', 'model', 'effort'];
  const index = order.indexOf(current);
  return order[(index + 1) % order.length] ?? order[0]!;
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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
