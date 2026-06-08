import { createCliRenderer, type TextareaRenderable } from '@opentui/core';
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  CLI_AGENT_STARTERS,
  createAgentNameFromMission,
  createCliAgent,
  defaultCreateMode,
  isCloudAuthConfigured,
  isLocalModelConfigured,
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
const STARTER_KEYS = ['i', 's', 'h', 'e'] as const;

function HomeApp({ opts }: { opts: HomeTuiOptions }) {
  const { width, height } = useTerminalDimensions();
  const [agents] = useState<ListedAgent[]>(() => listKnownAgents());
  const [mode, setMode] = useState<AgentMode>(() => defaultCreateMode());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [agentPage, setAgentPage] = useState(0);
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const cloudReady = isCloudAuthConfigured();
  const localReady = isLocalModelConfigured();
  const setupRequired = !cloudReady && !localReady;
  const panelWidth = Math.min(Math.max(28, width - 4), Math.max(52, Math.floor(width * 0.72)), 104);
  const compactStarters = panelWidth < 72;
  const starterCardWidth = compactStarters ? Math.max(24, panelWidth - 4) : Math.floor((panelWidth - 8) / 4);
  const promptHeight = Math.min(Math.max(7, Math.floor(height * 0.24)), 10);
  const agentPageSize = 9;
  const agentPageCount = Math.max(1, Math.ceil(agents.length / agentPageSize));
  const visibleAgents = agents.slice(agentPage * agentPageSize, agentPage * agentPageSize + agentPageSize);

  const modeLabel = useMemo(() => {
    if (mode === 'cloud') return cloudReady ? 'Cloud agent' : 'Cloud agent - sign in required';
    return localReady ? 'Local agent' : 'Local agent - provider required';
  }, [cloudReady, localReady, mode]);

  const setStarter = useCallback((index: number) => {
    if (setupRequired) return;
    const starter = CLI_AGENT_STARTERS[index];
    if (!starter) return;
    textareaRef.current?.setText(starter.prompt);
    setDraft(starter.prompt);
  }, [setupRequired]);

  const submit = useCallback(async () => {
    const mission = (textareaRef.current?.plainText ?? draft).trim();
    if (!mission || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (setupRequired) throw new Error('Run proteus setup to connect your account or a local model provider.');
      if (mode === 'cloud' && !cloudReady) throw new Error('Sign in first with proteus auth, then create a cloud agent.');
      if (mode === 'local' && !localReady) throw new Error('Connect a local provider with proteus provider connect, or switch to cloud after sign-in.');
      const name = createAgentNameFromMission(mission);
      const created = await createCliAgent({
        ...opts,
        name,
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
      setMode((current) => current === 'cloud' ? 'local' : 'cloud');
      return;
    }
    if ((key.name === 'right' || key.name === 'pagedown') && agents.length > agentPageSize) {
      setAgentPage((page) => Math.min(agentPageCount - 1, page + 1));
      return;
    }
    if ((key.name === 'left' || key.name === 'pageup') && agents.length > agentPageSize) {
      setAgentPage((page) => Math.max(0, page - 1));
      return;
    }
    if (key.name === 'n' && agents.length > 0) {
      textareaRef.current?.focus();
      return;
    }
    const numeric = Number(key.name);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 9) {
      if (visibleAgents[numeric - 1]) {
        finishHome?.({ type: 'open-agent', name: visibleAgents[numeric - 1]!.name });
        return;
      }
      if (agents.length === 0) setStarter(numeric - 1);
      return;
    }
    const starterIndex = STARTER_KEYS.findIndex((shortcut) => shortcut === key.name?.toLowerCase());
    if (starterIndex >= 0) {
      setStarter(starterIndex);
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
              : 'Open an existing agent with 1-9, or write a mission to create a new one.'}
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
            <text><span fg="#8b5cf6">Agents</span></text>
            {visibleAgents.map((agent, index) => (
              <text key={agent.name}>
                <span fg="#6b7280">  {index + 1}. </span>
                <span fg="#d1d5db">{agent.label}</span>
              </text>
            ))}
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
              borderColor: busy ? '#4a4a6a' : '#7c3aed',
              backgroundColor: '#10101c',
              paddingLeft: 1,
              paddingRight: 1,
            }}
            title={busy ? 'Creating...' : 'Mission'}
          >
            <textarea
              ref={(value) => { textareaRef.current = value; }}
              focused={!busy}
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
            <span fg="#6b7280">  Tab switches mode</span>
          </text>
          <text>
            <span fg="#6b7280">
              {setupRequired
                ? 'Run one setup command above, then return here · Esc exit'
                : `${agents.length > 0 ? '1-9 open agents · I/S/H/E starters' : '1-4 or I/S/H/E starters'} · Ctrl/Alt+Enter create · Esc exit`}
            </span>
          </text>
          <text>
            <span fg={cloudReady ? '#4ade80' : '#6b7280'}>{cloudReady ? '●' : '○'} Cloud account</span>
            <span fg="#6b7280">  </span>
            <span fg={localReady ? '#4ade80' : '#6b7280'}>{localReady ? '●' : '○'} Local provider</span>
          </text>
        </box>

        {!setupRequired && (
          <box flexDirection={compactStarters ? 'column' : 'row'} style={{ marginTop: 1 }}>
            {CLI_AGENT_STARTERS.map((starter, index) => (
              <box
                key={starter.title}
                style={{
                  width: starterCardWidth,
                  marginRight: compactStarters || index === CLI_AGENT_STARTERS.length - 1 ? 0 : 1,
                  marginBottom: compactStarters && index !== CLI_AGENT_STARTERS.length - 1 ? 1 : 0,
                  border: true,
                  borderStyle: 'single',
                  borderColor: '#2f2f46',
                  paddingLeft: 1,
                  paddingRight: 1,
                }}
              >
                <text>
                  <span fg="#8b5cf6">{agents.length === 0 ? index + 1 : STARTER_KEYS[index]!.toUpperCase()}</span>{' '}
                  <strong fg="#d1d5db">{starter.title}</strong>{'\n'}
                  <span fg="#6b7280">{starter.description.slice(0, 42)}</span>
                </text>
              </box>
            ))}
          </box>
        )}

        {error && (
          <box style={{ marginTop: 1 }}>
            <text><span fg="#f87171">{error}</span></text>
          </box>
        )}
      </box>
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
