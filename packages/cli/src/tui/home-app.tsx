import { createCliRenderer, type TextareaRenderable } from '@opentui/core';
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  createCliAgent,
  defaultCreateMode,
  isCloudAuthConfigured,
  isLocalModelConfigured,
  suggestAgentIdentityFromMission,
} from '../agent-create.js';
import { listKnownAgents, type ListedAgent } from '../agent-list.js';
import type { AgentMode } from '../config.js';

export type HomeTuiAction =
  | { type: 'open-agent'; name: string; initialPrompt?: string }
  | { type: 'exit' };

export interface HomeTuiOptions {
  model?: string;
  baseUrl?: string;
  auth?: string;
  origin?: string;
}

let finishHome: ((action: HomeTuiAction) => void) | null = null;
type HomeFocus = 'agents' | 'mission' | 'mode';

function HomeApp({ opts }: { opts: HomeTuiOptions }) {
  const { width, height } = useTerminalDimensions();
  const [agents] = useState<ListedAgent[]>(() => listKnownAgents());
  const [mode, setMode] = useState<AgentMode>(() => defaultCreateMode());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [focusArea, setFocusArea] = useState<HomeFocus>('mission');
  const [selectedAgentIndex, setSelectedAgentIndex] = useState(0);
  const [agentPage, setAgentPage] = useState(0);
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const cloudReady = isCloudAuthConfigured();
  const localReady = isLocalModelConfigured();
  const setupRequired = !cloudReady && !localReady;
  const panelWidth = Math.min(Math.max(28, width - 4), Math.max(52, Math.floor(width * 0.72)), 104);
  const promptHeight = Math.min(Math.max(7, Math.floor(height * 0.24)), 10);
  const agentPageSize = 9;
  const agentPageCount = Math.max(1, Math.ceil(agents.length / agentPageSize));
  const agentPageStart = agentPage * agentPageSize;
  const visibleAgents = agents.slice(agentPageStart, agentPageStart + agentPageSize);

  const modeLabel = useMemo(() => {
    if (mode === 'cloud') return cloudReady ? 'Cloud agent' : 'Cloud agent - sign in required';
    return localReady ? 'Local agent' : 'Local agent - provider required';
  }, [cloudReady, localReady, mode]);

  const selectAgentIndex = useCallback((index: number) => {
    const next = clamp(index, 0, Math.max(0, agents.length - 1));
    setSelectedAgentIndex(next);
    setAgentPage(Math.floor(next / agentPageSize));
  }, [agents.length]);

  const openSelectedAgent = useCallback(() => {
    const selected = agents[selectedAgentIndex];
    if (selected) finishHome?.({ type: 'open-agent', name: selected.name });
  }, [agents, selectedAgentIndex]);

  const submit = useCallback(async () => {
    const mission = (textareaRef.current?.plainText ?? draft).trim();
    if (!mission || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (setupRequired) throw new Error('Run proteus setup to connect your account or a local model provider.');
      if (mode === 'cloud' && !cloudReady) throw new Error('Sign in first with proteus auth, then create a cloud agent.');
      if (mode === 'local' && !localReady) throw new Error('Connect a local provider with proteus provider connect, or switch to cloud after sign-in.');
      const identity = await suggestAgentIdentityFromMission(mission, opts);
      const created = await createCliAgent({
        ...opts,
        name: identity.name,
        displayName: identity.displayName,
        nameOrigin: identity.nameOrigin,
        purpose: mission,
        mode,
        allowInteractiveAuth: false,
      });
      finishHome?.({ type: 'open-agent', name: created.name, initialPrompt: mission });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [busy, cloudReady, draft, localReady, mode, opts, setupRequired]);

  useKeyboard((key) => {
    if (busy) return;
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
      style={{ height: '100%', backgroundColor: '#0f0f23', paddingLeft: 2, paddingRight: 2 }}
    >
      <box style={{ width: panelWidth, marginBottom: 1 }}>
        <text>
          <strong fg="#c4b5fd">Proteus</strong>{' '}
          <span fg="#6b7280">agent workspace</span>
        </text>
      </box>

      <box
        flexDirection="column"
        style={{
          width: panelWidth,
          border: true,
          borderStyle: 'single',
          borderColor: '#3b3b5c',
          backgroundColor: '#171725',
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: 1,
          paddingBottom: 1,
        }}
      >
        <text>
          <strong fg="#e5e7eb">{agents.length === 0 ? 'Start with a mission' : 'What should Proteus do next?'}</strong>{'\n'}
          <span fg="#6b7280">
            {setupRequired
              ? 'Connect Proteus once, then this screen can create and open agents directly.'
              : agents.length === 0
              ? 'Describe the work. Proteus will create an agent and send this as its first turn.'
              : 'Select an agent, or write a mission to create a new one.'}
          </span>
        </text>

        {setupRequired && (
          <box flexDirection="column" style={{ marginTop: 1, marginBottom: 1, border: true, borderStyle: 'single', borderColor: '#2f2f46', paddingLeft: 1, paddingRight: 1 }}>
            <text><strong fg="#d1d5db">Setup required</strong></text>
            <text><span fg="#6b7280">  proteus setup</span> <span fg="#d1d5db">connect account and optional local provider</span></text>
            <text><span fg="#6b7280">  proteus auth</span>  <span fg="#d1d5db">connect cloud agents only</span></text>
            <text><span fg="#6b7280">  proteus provider connect codex</span> <span fg="#d1d5db">connect local model access</span></text>
          </box>
        )}

        {agents.length > 0 && (
          <box flexDirection="column" style={{ marginTop: 1, marginBottom: 1 }}>
            <text>
              <span fg={focusArea === 'agents' ? '#c4b5fd' : '#8b5cf6'}>Agents</span>
              <span fg="#6b7280">  {focusArea === 'agents' ? '↑/↓ select · Enter open' : 'Tab to focus'}</span>
            </text>
            {visibleAgents.map((agent, index) => {
              const absoluteIndex = agentPageStart + index;
              const selected = absoluteIndex === selectedAgentIndex;
              return (
                <box
                  key={agent.name}
                  style={{
                    height: 1,
                    backgroundColor: selected ? '#2d2259' : '#171725',
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
                    <span fg={selected ? '#c4b5fd' : '#6b7280'}>{selected ? '› ' : '  '}</span>
                    <span fg={selected ? '#e5e7eb' : '#d1d5db'}>{agent.label}</span>
                    <span fg="#6b7280">  {agent.mode}</span>
                  </text>
                </box>
              );
            })}
            {agentPageCount > 1 && (
              <text>
                <span fg="#6b7280">  Page {agentPage + 1}/{agentPageCount} · Left/Right or PgUp/PgDn</span>
              </text>
            )}
          </box>
        )}

        {!setupRequired && (
          <box
            style={{
              height: promptHeight,
              marginTop: 1,
              border: true,
              borderStyle: 'single',
              borderColor: busy ? '#4a4a6a' : focusArea === 'mission' ? '#7c3aed' : '#3b3b5c',
              backgroundColor: '#10101c',
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
              placeholder="Ask Proteus to investigate, build, audit, automate, or improve something..."
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
            <span fg="#8b5cf6">Mode: </span>
            <span fg={mode === 'cloud' ? (cloudReady ? '#d1d5db' : '#f59e0b') : (localReady ? '#d1d5db' : '#f59e0b')}>
              {modeLabel}
            </span>
            <span fg="#6b7280">  {focusArea === 'mode' ? '←/→ or Enter switches' : 'Tab to focus'}</span>
          </text>
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
          <text>
            <span fg="#6b7280">
              {setupRequired
                ? 'Run one setup command above, then return here · Esc exit'
                : `${agents.length > 0 ? 'Tab focus · ↑/↓ select · Enter open · ' : 'Tab focus mode · '}Ctrl/Alt+Enter create · Esc exit`}
            </span>
          </text>
          <text>
            <span fg={cloudReady ? '#4ade80' : '#6b7280'}>{cloudReady ? '●' : '○'} Cloud account</span>
            <span fg="#6b7280">  </span>
            <span fg={localReady ? '#4ade80' : '#6b7280'}>{localReady ? '●' : '○'} Local provider</span>
          </text>
        </box>

        {error && (
          <box style={{ marginTop: 1 }}>
            <text><span fg="#f87171">{error}</span></text>
          </box>
        )}
      </box>
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
    ? props.focused ? '#a78bfa' : '#7c3aed'
    : '#3b3b5c';
  const textColor = props.ready
    ? props.selected ? '#e5e7eb' : '#d1d5db'
    : '#f59e0b';
  return (
    <box
      style={{
        width: 18,
        height: 3,
        border: true,
        borderStyle: 'single',
        borderColor,
        backgroundColor: props.selected ? '#241b45' : '#10101c',
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
        <span fg={props.selected ? '#4ade80' : '#6b7280'}>{props.selected ? '●' : '○'}</span>
        {' '}
        <strong fg={textColor}>{props.label}</strong>
      </text>
    </box>
  );
}

export async function runHomeTui(opts: HomeTuiOptions = {}): Promise<HomeTuiAction> {
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
  const order: HomeFocus[] = hasAgents ? ['mission', 'agents', 'mode'] : ['mission', 'mode'];
  const index = order.indexOf(current);
  return order[(index + 1) % order.length] ?? order[0]!;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
