/** @jsxImportSource @opentui/react */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { describe, expect, test } from 'bun:test';

import { SLASH_COMMANDS } from '../src/slash-commands.js';
import { CommandHintOverlay, DeviceConnectOverlay, ModelPickerOverlay, WalkbackOverlay } from '../src/tui/overlays.js';
import type { AgentModelEntry } from '../src/model-catalog.js';
import { MessageList } from '../src/tui/messages.js';
import { tuiColors } from '../src/tui/theme.js';
import { StatusBar } from '../src/tui/status-bar.js';
import { handleHistoryScrollKey } from '../src/tui/chat-app.js';
import { VERSION } from '../src/display.js';

const repoRoot = resolve(__dirname, '../../..');

describe('CLI TUI layout', () => {
  test('status bar makes the model control discoverable and shows effort', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 110, height: 8, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      root.render(
        <StatusBar
          name="jarvis"
          mode="local"
          model="openai/gpt-5.5"
          reasoningEffort="high"
          connected={true}
          onModelSelect={() => {}}
        />,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      expect(frame).toContain('GPT 5.5');
      expect(frame).toContain('[Ctrl+P]');
      expect(frame).toContain('effort high');
      expect(frame).toContain(`cli ${VERSION}`);

      const statusSource = readFileSync(resolve(repoRoot, 'packages/cli/src/tui/status-bar.tsx'), 'utf8');
      const chatSource = readFileSync(resolve(repoRoot, 'packages/cli/src/tui/chat-app.tsx'), 'utf8');
      expect(statusSource).toContain('onMouseDown={onModelSelect}');
      expect(chatSource).toContain("key.name === 'p' && key.ctrl");
      expect(chatSource).toContain('setModelPreference(client, model.spec)');
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('status bar clips model metadata to narrow terminals and retains the CLI version', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 52, height: 6, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      root.render(
        <StatusBar
          name="a"
          mode="local"
          model="openai/a-very-long-model-name-that-cannot-fit"
          reasoningEffort="high"
          connected={true}
          scaffoldVersion={12}
          toolCount={42}
          autoEvolve={true}
          branchCount={2}
        />,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      expect(frame).toContain(`cli ${VERSION}`);
      expect(frame).toContain('…');
      expect(frame).not.toContain('A Very Long Model Name That Cannot Fit');
      for (const line of frame.split('\n')) {
        expect([...line].length).toBeLessThanOrEqual(52);
      }
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('CLI version has package.json as its single source', () => {
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'packages/cli/package.json'), 'utf8')) as { version: string };
    const displaySource = readFileSync(resolve(repoRoot, 'packages/cli/src/display.ts'), 'utf8');
    const programSource = readFileSync(resolve(repoRoot, 'packages/cli/src/program.ts'), 'utf8');
    const homeSource = readFileSync(resolve(repoRoot, 'packages/cli/src/tui/home-app.tsx'), 'utf8');

    expect(VERSION).toBe(packageJson.version);
    expect(displaySource).toContain("import cliPackage from '../package.json'");
    expect(programSource).toContain(".version(VERSION, '-v, --version')");
    expect(programSource).not.toContain(".version('0.1.0'");
    expect(homeSource).toContain('workspaces · cli {VERSION}');
  });

  test('model picker is an absolute overlay and does not move the input area', async () => {
    const withoutOverlay = await renderOverlayFrame(false);
    const withOverlay = await renderOverlayFrame(true);

    expect(lineContaining(withoutOverlay, 'INPUT-SENTINEL')).toBe(lineContaining(withOverlay, 'INPUT-SENTINEL'));
    expect(withOverlay).toContain('Select model');
    expect(withOverlay).toContain('Type to filter');
    expect(withOverlay).toContain('Filter models');
    expect(withOverlay).toContain('Kimi K2.6');
  });

  test('model picker forwards arrow and enter keys from its filter input', async () => {
    const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    let selected: AgentModelEntry | null = null;
    try {
      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <ModelPickerOverlay
            models={MODELS}
            currentSpec={MODELS[0]!.spec}
            terminal={{ width: 80, height: 24 }}
            onSelect={(model) => { selected = model; }}
          />
        </box>,
      );
      await renderSettled(renderOnce);

      mockInput.pressArrow('down');
      await renderSettled(renderOnce);
      expect(captureCharFrame()).toContain('Llama 3.3 70B');

      mockInput.pressEnter();
      await renderSettled(renderOnce);
      expect(selected?.spec).toBe(MODELS[1]!.spec);
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('chat history keys scroll without stealing multiline draft arrows', () => {
    const history = {
      scrollTop: 100,
      viewport: { height: 20 },
      scrollTo(position: number) {
        this.scrollTop = position;
      },
    };
    let prevented = 0;
    const key = (name: string) => ({
      name,
      preventDefault: () => { prevented += 1; },
    });

    expect(handleHistoryScrollKey(key('up'), '', history)).toBe(true);
    expect(history.scrollTop).toBe(96);
    expect(handleHistoryScrollKey(key('down'), 'line one\nline two', history)).toBe(false);
    expect(history.scrollTop).toBe(96);
    expect(handleHistoryScrollKey(key('pageup'), 'draft text', history)).toBe(true);
    expect(history.scrollTop).toBe(86);
    expect(handleHistoryScrollKey(key('pagedown'), 'draft text', history)).toBe(true);
    expect(history.scrollTop).toBe(96);
    expect(prevented).toBe(3);
  });

  test('slash command hints render as a palette without numeric hotkeys', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <CommandHintOverlay commands={SLASH_COMMANDS} terminal={{ width: 80, height: 24 }} />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      expect(frame).toContain('Commands');
      expect(frame).toContain('/help');
      expect(frame).toContain('/status');
      expect(frame).toContain('more commands');
      expect(frame).not.toContain('/sessions');
      expect(frame).not.toContain('/statusShShow');
      expect(frame).not.toContain('/helptoShow');
      expect(frame).not.toContain('1 /help');
      expect(frame).not.toContain('2 /status');
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('command palette clips rows inside the overlay frame', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 58, height: 18, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <CommandHintOverlay
            commands={[{
              name: '/very-long-command-name',
              description: 'This command description is intentionally too long to fit in a narrow overlay without clipping.',
            }]}
            terminal={{ width: 58, height: 18 }}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      for (const line of frame.split('\n')) {
        expect([...line].length).toBeLessThanOrEqual(58);
      }
      expect(frame).toContain('/very-long');
      expect(frame).not.toContain('without clipping');
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('chat messages render user bubbles and assistant markdown', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 96, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      root.render(
        <box style={{ width: '100%', height: '100%', backgroundColor: tuiColors.bg }}>
          <MessageList
            messages={[
              { id: 'u1', role: 'user', content: 'Review this module' },
              { id: 'a1', role: 'assistant', content: '### Plan\n\n- **Inspect** sources\n- Ship fix' },
            ]}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      expect(frame).toContain('You');
      expect(frame).toContain('Review this module');
      expect(frame).toContain('Agent');
      expect(frame).toContain('Plan');
      expect(frame).toContain('Inspect');
      expect(frame).not.toContain('**Inspect**');
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('text and tool calls render chronologically interleaved', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 96, height: 30, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      // The transcript order IS the chronological order: text, tool, text, tool.
      root.render(
        <box style={{ width: '100%', height: '100%', backgroundColor: tuiColors.bg }}>
          <MessageList
            messages={[
              { id: 'a1', role: 'assistant', content: 'FIRST text before the tool' },
              { id: 't1', role: 'tool_call', content: '', toolName: 'read_file' },
              { id: 'a2', role: 'assistant', content: 'SECOND text after the tool' },
              { id: 't2', role: 'tool_call', content: '', toolName: 'write_file' },
              { id: 'a3', role: 'assistant', content: 'THIRD text after the second tool' },
            ]}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      const at = (needle: string) => frame.indexOf(needle);
      // Each surface lands strictly after the one that preceded it in the stream.
      expect(at('FIRST')).toBeGreaterThanOrEqual(0);
      expect(at('read_file')).toBeGreaterThan(at('FIRST'));
      expect(at('SECOND')).toBeGreaterThan(at('read_file'));
      expect(at('write_file')).toBeGreaterThan(at('SECOND'));
      expect(at('THIRD')).toBeGreaterThan(at('write_file'));
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('a live assistant segment renders its streaming text in place', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 96, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      root.render(
        <box style={{ width: '100%', height: '100%', backgroundColor: tuiColors.bg }}>
          <MessageList
            messages={[
              { id: 't1', role: 'tool_call', content: '', toolName: 'read_file' },
              { id: 'a1', role: 'assistant', content: 'streaming reply in progress', live: true },
            ]}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      // The live segment sits AFTER the tool it followed, with its text visible.
      expect(frame.indexOf('streaming reply')).toBeGreaterThan(frame.indexOf('read_file'));
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('steered user messages carry the steering marker', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 96, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      root.render(
        <box style={{ width: '100%', height: '100%', backgroundColor: tuiColors.bg }}>
          <MessageList
            messages={[
              { id: 'u1', role: 'user', content: 'start the deploy' },
              { id: 'u2', role: 'user', content: 'use staging instead', steered: true },
            ]}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      expect(frame).toContain('use staging instead');
      expect(frame).toContain('↪ steering');
      // The marker belongs to the steered bubble only.
      expect(frame.split('↪ steering')).toHaveLength(2);
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('walk-back overlay lists recent user messages newest first', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 96, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <WalkbackOverlay
            candidates={[
              { text: 'now run step two', occurrenceFromEnd: 1 },
              { text: 'plan the migration', occurrenceFromEnd: 1 },
            ]}
            terminal={{ width: 96, height: 24 }}
            onSelect={() => {}}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      expect(frame).toContain('Walk back');
      expect(frame).toContain('Enter forks before that message');
      expect(frame).toContain('latest · now run step two');
      expect(frame).toContain('-1 · plan the migration');
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('device-connect overlay offers connect, session, not-now, and dismiss choices', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 96, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <DeviceConnectOverlay
            prompt={{ phase: 'ask', statusLine: 'No PC is connected to your account yet.' }}
            terminal={{ width: 96, height: 24 }}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      expect(frame).toContain('Let this agent use this PC?');
      expect(frame).toContain('No PC is connected to your account yet.');
      expect(frame).toContain('C connect & keep connected · S this session only');
      expect(frame).toContain("N not now · D don't ask again");
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('device-connect overlay shows connect progress and the result', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 96, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    try {
      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <DeviceConnectOverlay
            prompt={{ phase: 'connecting', session: true, ticks: 1 }}
            terminal={{ width: 96, height: 24 }}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      expect(captureCharFrame()).toContain('Waiting for the daemon to connect..');

      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <DeviceConnectOverlay
            prompt={{ phase: 'result', ok: true, message: 'Connected for this session.' }}
            terminal={{ width: 96, height: 24 }}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      expect(frame).toContain('✓ Connected for this session.');
      expect(frame).toContain('Press any key to continue');
    } finally {
      root.render(<box />);
      renderer.destroy();
    }
  });

  test('home screen has no global numeric agent selection path', () => {
    const source = readFileSync(resolve(repoRoot, 'packages/cli/src/tui/home-app.tsx'), 'utf8');

    expect(source).not.toContain('Number(key.name)');
    expect(source).not.toContain('1-9');
    expect(source).toContain("focusArea === 'mission'");
    expect(source).toContain('nextFocus');
    expect(source).toContain('onMouseDown');
  });

  test('home model and effort selections persist as global defaults', () => {
    const proteusHome = mkdtempSync(resolve(tmpdir(), 'proteus-home-tui-'));
    try {
      writeFileSync(resolve(proteusHome, 'config.json'), JSON.stringify({
        model: 'openai/gpt-5.5',
        reasoningEffort: 'medium',
        providers: { openai: { apiKey: 'sk-test' } },
      }));
      const script = `
        import { readFileSync } from 'node:fs';
        import { createElement } from 'react';
        import { createTestRenderer } from '@opentui/core/testing.js';
        import { createRoot } from '@opentui/react';
        import { CONFIG_PATH } from './packages/cli/src/config.ts';
        import { HomeApp } from './packages/cli/src/tui/home-app.tsx';

        globalThis.fetch = async () => new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
        const { renderer, mockInput, renderOnce } = await createTestRenderer({
          width: 100,
          height: 40,
          useThread: false,
          maxFps: Number.POSITIVE_INFINITY,
        });
        const root = createRoot(renderer);
        const settle = async (rounds = 10) => {
          for (let i = 0; i < rounds; i++) {
            await renderOnce();
            await Bun.sleep(10);
          }
        };
        root.render(createElement(HomeApp, { opts: {} }));
        await settle();
        mockInput.pressTab();
        await settle();
        mockInput.pressTab();
        await settle();
        mockInput.pressEnter();
        await settle(100);
        await mockInput.typeText('openai');
        await settle();
        mockInput.pressArrow('down');
        mockInput.pressEnter();
        await settle();
        mockInput.pressTab();
        await settle();
        mockInput.pressArrow('down');
        await settle();
        root.render(createElement('box'));
        renderer.destroy();
        console.log(readFileSync(CONFIG_PATH, 'utf8'));
      `;
      const env: Record<string, string | undefined> = { ...process.env, PROTEUS_HOME: proteusHome };
      for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'PROTEUS_TOKEN']) {
        delete env[name];
      }
      const proc = Bun.spawnSync({
        cmd: [process.execPath, '-e', script],
        cwd: repoRoot,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect({ exitCode: proc.exitCode, stderr: proc.stderr.toString() }).toEqual({ exitCode: 0, stderr: '' });
      const config = JSON.parse(proc.stdout.toString()) as Record<string, unknown>;
      expect(config).toMatchObject({ reasoningEffort: 'high' });
      expect(config.model).toStartWith('openai/');
      expect(config.model).not.toBe('openai/gpt-5.5');
    } finally {
      rmSync(proteusHome, { recursive: true, force: true });
    }
  });
});

async function renderOverlayFrame(showOverlay: boolean) {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
  const root = createRoot(renderer);
  try {
    root.render(
        <box flexDirection="column" style={{ width: '100%', height: '100%' }}>
          <box style={{ height: 3 }}>
          <text><span>HEADER</span></text>
        </box>
        <box style={{ flexGrow: 1 }}>
          <text><span>BODY</span></text>
        </box>
        <box style={{ height: 3 }} title="Input">
          <text><span>INPUT-SENTINEL</span></text>
        </box>
        {showOverlay && (
          <ModelPickerOverlay
            models={MODELS}
            currentSpec={MODELS[0]!.spec}
            terminal={{ width: 80, height: 24 }}
            onSelect={() => {}}
          />
        )}
      </box>,
    );
    await renderSettled(renderOnce);
    return captureCharFrame();
  } finally {
    root.render(<box />);
    renderer.destroy();
  }
}

async function renderSettled(renderOnce: () => Promise<void>) {
  for (let i = 0; i < 10; i++) {
    await renderOnce();
    await Bun.sleep(30);
  }
}

function lineContaining(frame: string, text: string) {
  const line = frame.split('\n').findIndex((candidate) => candidate.includes(text));
  expect(line).toBeGreaterThanOrEqual(0);
  return line;
}

const MODELS: AgentModelEntry[] = [
  {
    provider: 'workers-ai',
    id: '@cf/moonshotai/kimi-k2.6',
    label: 'Kimi K2.6',
    spec: 'workers-ai/@cf/moonshotai/kimi-k2.6',
    capabilities: ['tools', 'streaming'],
  },
  {
    provider: 'workers-ai',
    id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    label: 'Llama 3.3 70B',
    spec: 'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    capabilities: ['streaming'],
  },
];
