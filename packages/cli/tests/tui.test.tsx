/** @jsxImportSource @opentui/react */
import { runToExit } from '@kinu.run/test-utils';
import { scratchDir } from '../../test-utils/src/scratch';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';

import { resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot, flushSync } from '@opentui/react';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import type { ReactNode } from 'react';

import { createCLIRuntime } from '@kinu.run/cli-backend';
import { commandsForClient } from '../src/slash-commands';
import {
  ChangelogOverlay,
  CommandHintOverlay,
  CommandPaletteOverlay,
  DeviceConnectOverlay,
  ModelPickerOverlay,
  SettingsOverlay,
  WalkbackOverlay,
  TakesOverlay,
} from '../src/tui/overlays';

import type { AgentModelEntry } from '@kinu.run/core';
import type { KinuConfig } from '../src/config';
import { MessageList } from '../src/tui/messages';

import { BUILTIN_TUI_THEMES } from '../src/tui/theme';
import { StatusBar } from '../src/tui/status-bar';
import { ChatApp } from '../src/tui/chat-app';

import { fakeClient } from './helpers/chat-app-fixture';
import { VERSION } from '../src/display';

const TEST_TUI_BACKGROUND = BUILTIN_TUI_THEMES[0].colors.background.canvas;

const repoRoot = resolve(__dirname, '../../..');

describe('CLI TUI layout', () => {
  test('status bar makes the model control discoverable and shows effort without version noise', async () => {
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
      expect(frame).toContain('[Ctrl+L]');
      expect(frame).toContain('effort high');
      expect(frame).not.toContain('cli ');

    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });
  test('status bar drops the model control whole on narrow terminals and retains connection state', async () => {
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
      expect(frame).toContain('●');
      expect(frame).not.toContain('A Very Long Model Name That Cannot Fit');
      expect(frame).not.toContain('…');

      for (const line of frame.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(52);
      }
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });

  test('status bar keeps one coherent identity at twenty columns', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 20,
      height: 5,
      useThread: false,
      maxFps: Number.POSITIVE_INFINITY,
    });

    const root = createRoot(renderer);

    try {
      root.render(
        <StatusBar
          name="checkout-with-an-impossibly-long-name"
          mode="local"
          model="openai/gpt-5.5"
          reasoningEffort="high"
          connected={true}
          scaffoldVersion={12}
          toolCount={42}
        />,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      expect(frame).toContain('check');
      expect(frame).toContain('local');
      expect(frame).toContain('●');

      for (const line of frame.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(20);
      }
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });

  test('status bar keeps the mode visible while a long workspace name clips', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 56, height: 6, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);

    try {
      root.render(
        <StatusBar
          name="a-really-quite-long-workspace-name"
          mode="local"
          model="openai/gpt-5.5"
          reasoningEffort="high"
          connected={true}
        />,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      expect(frame).toContain('local');
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });
  test('status segments drop by liveness — statics first, transient last', async () => {
    const render = async (width: number, assertions: (frame: string) => void) => {
      const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width, height: 6, useThread: false, maxFps: Number.POSITIVE_INFINITY });
      const root = createRoot(renderer);

      try {
        root.render(
          <StatusBar
            name="checkout"
            mode="local"
            model="openai/gpt-5.5"
            reasoningEffort="high"
            connected={true}
            contextTokens={2300}
            contextWindow={128_000}
            toolCount={14}
            autoEvolve={false}
            branchCount={1}
          />,
        );
        await renderSettled(renderOnce);
        assertions(captureCharFrame());
      } finally {
        flushSync(() => { root.unmount(); });
        renderer.destroy();
      }
    };

    await render(72, (frame) => {
      expect(frame).toContain('⎇ branch');
      expect(frame).not.toContain('effort high');
    });
    await render(124, (frame) => {
      expect(frame).toContain('⎇ branch');
      expect(frame).toContain('ctx');
      expect(frame).toContain('effort high');
      expect(frame).toContain('evolve off');
      expect(frame).toContain('14 tools');
      expect(frame).toContain('[Ctrl+L]');
    });
  });

  test('the model control degrades whole — hint, then name, never a clipped bracket', async () => {
    const render = async (width: number, assertions: (frame: string) => void) => {
      const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width, height: 6, useThread: false, maxFps: Number.POSITIVE_INFINITY });
      const root = createRoot(renderer);

      try {
        root.render(
          <StatusBar
            name="checkout"
            mode="local"
            model="@cf/deepseek-ai/deepseek-v4-pro-0813"
            reasoningEffort="high"
            connected={true}
            contextTokens={2300}
            contextWindow={128_000}
            toolCount={14}
            autoEvolve={false}
            branchCount={1}
          />,
        );
        await renderSettled(renderOnce);
        assertions(captureCharFrame());
      } finally {
        flushSync(() => { root.unmount(); });
        renderer.destroy();
      }
    };

    await render(88, (frame) => {
      expect(frame).toContain('[Ctrl+L]');
    });
    await render(64, (frame) => {
      const line = frame.split('\n').find((row) => row.includes('Deepseek V4 Pro'));
      expect(line).toBeDefined();
      expect(line?.match(/\[[^\]]*…/)).toBeNull();
    });
  });

  // No emoji-presentation code points in chrome: they render unpredictably per terminal font.
  // ★ stays: Emoji_Presentation=No and monochrome everywhere.
  test('TUI chrome renders zero emoji', async () => {
    // FE0F is checked apart: inside a class it combines with the neighbour and lint flags it.
    const EMOJI = /[\u{1F000}-\u{1FFFF}\u{23E9}-\u{23FA}\u{2B00}-\u{2BFF}\u{2600}-\u{26FF}]/gu;
    const VARIATION_SELECTOR = /\uFE0F/u;
    const frames: string[] = [];

    const collect = async (width: number, element: ReactNode) => {
      const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
      const root = createRoot(renderer);

      try {
        root.render(element);
        await renderSettled(renderOnce);
        frames.push(captureCharFrame());
      } finally {
        flushSync(() => { root.unmount(); });
        renderer.destroy();
      }
    };

    await collect(96, (
      <StatusBar
        name="checkout"
        mode="cloud"
        model="openai/gpt-5.5"
        reasoningEffort="high"
        connected={true}
        scaffoldVersion={3}
        toolCount={14}
        autoEvolve={false}
        contextTokens={2300}
        contextWindow={128_000}
        branchCount={2}
      />
    ));
    await collect(96, (
      <box style={{ width: '100%', height: '100%', backgroundColor: TEST_TUI_BACKGROUND }}>
        <MessageList
          messages={[
            { id: 'u1', role: 'user', content: 'Run the suite', attachments: ['notes.md'] },
            { id: 'a1', role: 'assistant', content: 'On it.' },
            { id: 't1', role: 'tool_call', content: '', toolName: 'exec', args: '{"cmd":"bun test"}' },
            { id: 'r1', role: 'tool_result', content: JSON.stringify({ reason: 'denied', error: 'Outside this workspace.' }) },
            { id: 'e1', role: 'evolution', content: '[reflection] kept the fix minimal' },
          ]}
        />
      </box>
    ));

    for (const frame of frames) {
      const offenders = [...frame.matchAll(EMOJI)]
        .map((match) => match[0])
        .filter((char) => char !== '\u2605');

      expect(offenders).toEqual([]);
      expect(VARIATION_SELECTOR.test(frame)).toBe(false);
    }
  });

  test('CLI version has package.json as its single source', async () => {
    const packageJson = v.parse(
      v.object({ version: v.string() }),
      JSON.parse(readFileSync(resolve(repoRoot, 'packages/cli/package.json'), 'utf8')),
    );

    expect(VERSION).toBe(packageJson.version);

    const reported = await runToExit([process.execPath, resolve(repoRoot, 'packages/cli/bin/cli.ts'), '-v'], {
      cwd: repoRoot,
    });

    expect({ exitCode: reported.exitCode, stdout: reported.stdout.trim() })
      .toEqual({ exitCode: 0, stdout: VERSION });
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
    const selected: AgentModelEntry[] = [];

    try {
      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <ModelPickerOverlay
            models={MODELS}
            currentSpec={MODELS[0].spec}
            terminal={{ width: 80, height: 24 }}
            onSelect={(model) => { selected.push(model); }}
          />
        </box>,
      );
      await renderSettled(renderOnce);

      mockInput.pressArrow('down');
      await renderSettled(renderOnce);
      expect(captureCharFrame()).toContain('Llama 3.3 70B');

      mockInput.pressEnter();
      await renderSettled(renderOnce);
      expect(selected[0]?.spec).toBe(MODELS[1].spec);
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });

  test('history keys scroll the transcript, and a multiline draft keeps its own arrows', async () => {
    const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 80,
      height: 24,
      useThread: false,
      maxFps: Number.POSITIVE_INFINITY,
    });

    const root = createRoot(renderer);

    const transcript = Array.from({ length: 60 }, (_, index) => ({
      id: `line-${index}`,
      role: 'system' as const,
      content: `line-${String(index).padStart(2, '0')}`,
    }));

    const agent = fakeClient({ name: 'scroller', history: async () => transcript });

    try {
      root.render(<ChatApp client={agent.client} onExit={() => {}} />);
      await renderSettled(renderOnce);
      expect(captureCharFrame()).toContain('line-59');
      expect(captureCharFrame()).not.toContain('line-00');
      const bottom = topVisibleTranscriptLine(captureCharFrame());

      mockInput.pressArrow('up', { meta: true });
      await renderSettled(renderOnce);
      expect(captureCharFrame()).not.toContain('line-59');
      const lineStep = bottom - topVisibleTranscriptLine(captureCharFrame());
      expect(lineStep).toBeGreaterThan(0);

      mockInput.pressArrow('down', { meta: true });
      await renderSettled(renderOnce);
      expect(topVisibleTranscriptLine(captureCharFrame())).toBe(bottom);

      mockInput.pressKey('\u001B[5~');
      await renderSettled(renderOnce);
      const pageStep = bottom - topVisibleTranscriptLine(captureCharFrame());
      expect(pageStep).toBeGreaterThan(lineStep);

      await mockInput.typeText('first line');
      mockInput.pressEnter({ shift: true });
      await mockInput.typeText('second line');
      await renderSettled(renderOnce);
      const beforeDraftArrow = topVisibleTranscriptLine(captureCharFrame());
      mockInput.pressArrow('down');
      await renderSettled(renderOnce);
      expect(topVisibleTranscriptLine(captureCharFrame())).toBe(beforeDraftArrow);

      mockInput.pressKey('\u001B[6~');
      await renderSettled(renderOnce);
      expect(topVisibleTranscriptLine(captureCharFrame())).toBeGreaterThan(beforeDraftArrow);
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });

  test('slash command hints render as a palette without numeric hotkeys', async () => {
    const commands = commandsForClient({ localControls: null, consents: null, checkpoints: null, plans: null });
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);

    try {
      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <CommandHintOverlay commands={commands} terminal={{ width: 80, height: 24 }} />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      expect(frame).toContain('Commands');
      expect(frame).toContain('/help');
      expect(frame).toContain(`… ${String(commands.length - 5)} more commands.`);
      expect(frame).toContain('/status');
      expect(frame).toContain('more commands');
      expect(frame).not.toContain('/sessions');
      expect(frame).not.toContain('/statusShShow');
      expect(frame).not.toContain('/helptoShow');
      expect(frame).not.toContain('1 /help');
      expect(frame).not.toContain('2 /status');
      expect(frame).toContain('Type to filter · Enter runs a completed command');
      expect(frame).toContain('Keep typing to filter.');
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });

  test('command palette clips rows inside the overlay frame', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 58, height: 18, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);

    try {
      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <CommandPaletteOverlay
            commands={[{
              name: '/very-long-command-name',
              description: 'This command description is intentionally too long to fit in a narrow overlay without clipping.',
            }]}
            terminal={{ width: 58, height: 18 }}
            onSelect={() => {}}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();

      for (const line of frame.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(58);
      }

      const hintLine = lineContaining(frame, 'Type to filter');
      const commandLine = lineContaining(frame, '/very-long');

      const closingLine = frame.split('\n').findIndex((line, index) =>
        index > commandLine && line.includes('╰'));

      expect(commandLine).toBeGreaterThan(hintLine);
      expect(closingLine).toBeGreaterThan(commandLine);
      expect(frame).toContain('/very-long');
      expect(frame).not.toContain('without clipping');
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });

  test('a one-result slash hint keeps its command above the closing border', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 58,
      height: 18,
      useThread: false,
      maxFps: Number.POSITIVE_INFINITY,
    });

    const root = createRoot(renderer);

    try {
      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <CommandHintOverlay
            commands={[{ name: '/status', description: 'Show workspace status' }]}
            terminal={{ width: 58, height: 18 }}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      const commandLine = lineContaining(frame, '/status');

      const closingLine = frame.split('\n').findIndex((line, index) =>
        index > commandLine && line.includes('╰'));

      expect(closingLine).toBeGreaterThan(commandLine);
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });

  test('interactive command and settings surfaces select through one active row', async () => {
    const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 72,
      height: 24,
      useThread: false,
      maxFps: Number.POSITIVE_INFINITY,
    });

    const root = createRoot(renderer);
    const selected: string[] = [];

    try {
      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <CommandPaletteOverlay
            commands={commandsForClient({ localControls: null, consents: null, checkpoints: null, plans: null })}
            terminal={{ width: 72, height: 24 }}
            onSelect={(command) => { selected.push(command.name); }}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      await mockInput.typeText('status');
      await renderSettled(renderOnce);
      expect(captureCharFrame()).toContain('/status');
      mockInput.pressEnter();
      await renderSettled(renderOnce);
      expect(selected).toEqual(['/status']);

      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <SettingsOverlay
            settings={[
              { id: 'model', group: 'Model', label: 'Active model', value: 'GPT 5.5', command: '/model' },
              { id: 'effort', group: 'Model', label: 'Reasoning effort', value: 'high', command: '/effort high' },
            ]}
            terminal={{ width: 72, height: 24 }}
            onSelect={(setting) => { selected.push(setting.command); }}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      expect(captureCharFrame()).toContain('Reasoning effort');
      mockInput.pressArrow('down');
      mockInput.pressEnter();
      await renderSettled(renderOnce);
      expect(selected).toContain('/effort high');
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });

  test('compact command palettes reserve one selectable row', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 40,
      height: 8,
      useThread: false,
      maxFps: Number.POSITIVE_INFINITY,
    });

    const root = createRoot(renderer);

    try {
      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <CommandPaletteOverlay
            commands={[{ name: '/status', description: 'Show workspace state' }]}
            terminal={{ width: 40, height: 8 }}
            onSelect={() => {}}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      expect(captureCharFrame()).toContain('/status');

      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <ModelPickerOverlay
            models={[MODELS[0]]}
            currentSpec={MODELS[0].spec}
            failures={[{ provider: 'broken', reason: 'offline' }]}
            terminal={{ width: 40, height: 8 }}
            onSelect={() => {}}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      expect(captureCharFrame()).toContain(MODELS[0].label);
      expect(captureCharFrame()).toContain('1 unavailable');

      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <ModelPickerOverlay
            models={[]}
            currentSpec={null}
            failures={[{ provider: 'broken', reason: 'offline' }]}
            terminal={{ width: 40, height: 8 }}
            onSelect={() => {}}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      expect(captureCharFrame()).toContain('1 provider unavailable');
      expect(captureCharFrame()).not.toContain('see below');

      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <WalkbackOverlay
            candidates={[{ text: 'walk back here', occurrenceFromEnd: 1 }]}
            terminal={{ width: 40, height: 8 }}
            onSelect={() => {}}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      expect(captureCharFrame()).toContain('walk back');

      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <ChangelogOverlay
            view={{
              unseenCount: 1,
              entries: [{
                id: 'change-1',
                kind: 'tool',
                at: 1,
                summary: 'Added a parser',
                evidence: '3 accepted turns',
              }],
            }}
            terminal={{ width: 40, height: 8 }}
            onSelect={() => {}}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      expect(captureCharFrame()).toContain('Added a parser');

      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <TakesOverlay
            set={{
              id: 'takes-1',
              turnId: 'turn-1',
              sessionId: 'session-1',
              task: 'Choose an implementation',
              source: 'mcts',
              winnerNodeId: 'node-1',
              chosenNodeId: null,
              candidates: [{
                nodeId: 'node-1',
                text: 'Use the indexed path',
                score: 0.8,
                visits: 3,
                depth: 1,
              }],
              createdAt: 1,
              pickedAt: null,
            }}
            terminal={{ width: 40, height: 8 }}
            onSelect={() => {}}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      expect(captureCharFrame()).toContain('indexed path');
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });

  test('narrow settings preserve current state and stay selectable', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 40,
      height: 20,
      useThread: false,
      maxFps: Number.POSITIVE_INFINITY,
    });

    const root = createRoot(renderer);

    try {
      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <SettingsOverlay
            settings={[{
              id: 'effort',
              group: 'Model',
              label: 'A very long reasoning effort setting',
              value: 'current',
              command: '/effort medium',
            }]}
            terminal={{ width: 40, height: 20 }}
            onSelect={() => {}}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      expect(captureCharFrame()).toContain('current');

    } finally {
      flushSync(() => { root.unmount(); });
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
      flushSync(() => { root.unmount(); });
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
            prompt={{ phase: 'ask', statusLine: 'No computer is connected to your account yet.', deviceName: 'ashish@studio' }}
            terminal={{ width: 96, height: 24 }}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      const frame = captureCharFrame();
      expect(frame).toContain('Let this agent use this computer?');
      expect(frame).toContain('No computer is connected to your account yet.');
      expect(frame).toContain('C connect and stay connected');
      expect(frame).toContain('S use this session only');
      expect(frame).toContain("D don't ask again · N not now");
    } finally {
      flushSync(() => { root.unmount(); });
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
      expect(captureCharFrame()).toContain('Waiting for this computer to answer..');

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
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });

  // The arrow press afterwards proves keys arrived, so "the selection did not move" is meaningful.
  test('digit keys never select a workspace on the home screen', async () => {
    const run = await runHomeScreen({
      workspaces: WORKSPACE_NAMES,
      driver: `
        // The TITLES, because that is what the navigator renders. A row shows
        // what a workspace is called; its directory is the address behind it.
        const WORKSPACES = ${JSON.stringify(WORKSPACE_NAMES.map(workspaceTitle))};
        const selected = () => WORKSPACES.find((name) => {
          const row = frame().split('\\n').find((line) => line.includes(name));
          return row?.includes('▶') || row?.includes('›');
        }) ?? null;

        for (const name of WORKSPACES) {
          await waitFor(name + ' to render', () => frame().includes(name));
        }
        await waitFor('the sidebar to take initial focus', () => selected() !== null);
        const listed = WORKSPACES
          .map((name) => ({ name, at: frame().split('\\n').findIndex((row) => row.includes(name)) }))
          .sort((left, right) => left.at - right.at)
          .map((entry) => entry.name);
        const initial = selected();
        for (const digit of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
          mockInput.pressKey(digit);
          await settle(3);
        }
        const observed = {
          listed,
          initial,
          afterDigits: selected(),
          openedByDigits: action,
          header: rowWith('Kinu workspaces'),
        };
        mockInput.pressArrow('down');
        await settle(5);
        observed.afterArrowDown = selected();
        mockInput.pressEscape();
        observed.finalAction = await opened;
        console.log(JSON.stringify(observed));
      `,
    });

    // Unmodelled records on purpose: v.object would drop the extra field that would carry a mission into chat.
    const homeAction = v.nullable(v.record(v.string(), v.unknown()));

    const observed = v.parse(v.object({
      listed: v.array(v.string()),
      initial: v.nullable(v.string()),
      afterDigits: v.nullable(v.string()),
      openedByDigits: homeAction,
      header: v.string(),
      afterArrowDown: v.nullable(v.string()),
      finalAction: homeAction,
    }), JSON.parse(run.stdout));

    expect(observed.initial).toBe(observed.listed[0]);
    expect(observed.afterDigits).toBe(observed.listed[0]);
    expect(observed.openedByDigits).toBeNull();
    expect(observed.afterArrowDown).toBe(observed.listed[1]);
    expect(observed.finalAction).toEqual({ type: 'exit' });
    expect(observed.header).toContain(`Kinu workspaces · cli ${VERSION}`);
  });

  // The mission seeds SOUL.md and names the workspace; it must not be replayed as the opening turn.
  test('creating a workspace from a mission opens it without sending the mission', async () => {
    const mission = 'My personal assistant, Jarvis';

    const run = await runHomeScreen({
      width: 80,
      driver: `
        await waitFor('the mission field to render', () => frame().includes('What is this workspace for?'));
        await mockInput.typeText(${JSON.stringify(mission)});
        await waitFor('the mission to reach the field', () => frame().includes(${JSON.stringify(mission)}));
        mockInput.pressEnter();
        await waitFor('the new workspace to open', () => action !== null, 3000);
        console.log(JSON.stringify({ opened: await opened }));
      `,
    });

    const observed = v.parse(
      v.object({ opened: v.record(v.string(), v.unknown()) }),
      JSON.parse(run.stdout),
    );

    const created = readdirSync(run.home, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(resolve(run.home, entry.name, 'agent.db')))
      .map((entry) => entry.name);

    expect(created).toHaveLength(1);
    expect(observed.opened).toEqual({ type: 'open-agent', name: created[0] });

    const db = new Database(resolve(run.home, created[0], 'agent.db'), { readonly: true });

    try {
      expect(db.query('SELECT COUNT(*) AS messages FROM conversation_entries').get()).toEqual({ messages: 0 });
      expect(db.query('SELECT mission FROM workspace_identity').all()).toEqual([{ mission }]);
    } finally {
      db.close();
    }
  });

  // Tab queues a focus commit and Escape finishes the screen in the same tick, forcing a commit after the
  // renderer is freed; nothing may reach the native library once it is.
  test('nothing reaches the native library after the home screen frees its renderer', async () => {
    const run = await runHomeScreen({
      driver: `
        const lib = renderer.lib;
        const ptr = renderer.rendererPtr;
        let freed = false;
        const afterFree = [];
        const destroyRenderer = lib.destroyRenderer.bind(lib);
        lib.destroyRenderer = (target) => { destroyRenderer(target); if (target === ptr) freed = true; };
        for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(lib))) {
          if (name === 'constructor' || name === 'destroyRenderer' || typeof lib[name] !== 'function') continue;
          const original = lib[name].bind(lib);
          lib[name] = (...args) => {
            if (freed) afterFree.push(name);
            // A call through the freed pointer IS the segfault, so it is
            // recorded and not forwarded; everything else still runs, because
            // a stubbed allocation only moves the failure into a TypeError.
            return freed && args[0] === ptr ? undefined : original(...args);
          };
        }
        await waitFor('the mission field to render', () => frame().includes('What is this workspace for?'));
        mockInput.pressTab();
        mockInput.pressEscape();
        const finalAction = await opened;
        // Whatever React still holds runs on its own macrotask; wait it out
        // without renderOnce, which would drive the freed renderer itself.
        for (let i = 0; i < 5; i++) await Bun.sleep(10);
        console.log(JSON.stringify({ finalAction, afterFree }));
      `,
    });

    const observed = v.parse(v.object({
      finalAction: v.nullable(v.record(v.string(), v.unknown())),
      afterFree: v.array(v.string()),
    }), JSON.parse(run.stdout));

    expect(observed.finalAction).toEqual({ type: 'exit' });
    expect(observed.afterFree).toEqual([]);
  });

  test('home model and effort selections persist as global defaults', async () => {
    const kinuHome = scratchDir('home-tui');

    writeFileSync(resolve(kinuHome, 'config.json'), JSON.stringify({
      model: 'openai/gpt-5.5',
      reasoningEffort: 'medium',
      providers: { openai: { apiKey: 'sk-test' } },
    }));

    const script = `
      import { readFileSync } from 'node:fs';
      import { createElement } from 'react';
      import { createTestRenderer } from '@opentui/core/testing.js';
      import { createRoot, flushSync } from '@opentui/react';
      import { CONFIG_PATH } from './packages/cli/src/config.ts';
      import { HomeApp } from './packages/cli/src/tui/home-app.tsx';

      globalThis.fetch = async () => new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
        width: 100,
        height: 40,
        useThread: false,
        maxFps: Number.POSITIVE_INFINITY,
      });
      const root = createRoot(renderer);
      const defaultTier = () => JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).localProfile?.catalog?.tiers?.default;
      const settle = async (rounds = 10) => {
        for (let i = 0; i < rounds; i++) {
          await renderOnce();
          await Bun.sleep(10);
        }
      };
      // Counted render rounds are the wrong instrument for "has the UI caught
      // up": on a loaded machine the overlay had not opened yet, every
      // subsequent keystroke went nowhere, and the test then asserted against a
      // config file it had seeded itself — so a no-op interaction read as a
      // persistence bug. Wait for the observable state instead, and name what
      // failed to arrive.
      const waitFor = async (what, predicate, rounds = 600) => {
        for (let i = 0; i < rounds; i++) {
          await renderOnce();
          if (predicate()) return;
          await Bun.sleep(10);
        }
        throw new Error('timed out waiting for ' + what);
      };
      root.render(createElement(HomeApp, { opts: {} }));
      await settle();
      mockInput.pressTab();
      await settle();
      mockInput.pressTab();
      await settle();
      mockInput.pressEnter();
      await waitFor('the model picker to open', () => captureCharFrame().includes('Select model'));
      // Filter to ONE match and take it, rather than counting arrow presses
      // from an assumed cursor position. The picker opens with the cursor on
      // the model already in use — sensible behaviour, and it made the old
      // 'openai' + one 'down' land back on gpt-5.5 (the seeded current model,
      // and the LAST of the three openai matches), so the selection was a
      // no-op that looked like a persistence failure.
      await mockInput.typeText('gpt-5.4');
      // And wait for the CURSOR to be on that row before taking it: Enter
      // pressed a render too early takes whatever the cursor still sat on,
      // which is the current model, which is a no-op. Anchored on the cursor
      // marker rather than on the absence of gpt-5.5 anywhere in the frame —
      // the home screen renders the model in use BEHIND the overlay, so that
      // string is on screen no matter what the list is showing.
      await waitFor('the cursor to reach the gpt-5.4 row', () => {
        const cursorRow = captureCharFrame().split('\\n').find((row) => row.includes('▶'));
        return cursorRow !== undefined && cursorRow.includes('gpt-5.4');
      });
      mockInput.pressEnter();
      await waitFor('the chosen model to persist', () => defaultTier()?.model !== undefined && defaultTier().model !== 'openai/gpt-5.5');
      // The write lands while the overlay is still on screen, so persistence is
      // NOT the signal that the picker is done with the keyboard. Tab pressed
      // here goes to the overlay and focus never reaches Effort.
      await waitFor('the model picker to close', () => !captureCharFrame().includes('Select model'));
      mockInput.pressTab();
      // The row renders its key hint only while focused, so this is the
      // observable "the effort control has the keyboard" — an arrow sent before
      await waitFor('the effort control to take focus', () => {
        const row = captureCharFrame().split('\\n').find((line) => line.includes('Effort:'));
        return row?.includes('select') === true;
      });
      mockInput.pressArrow('right');
      await waitFor('the chosen effort to persist', () => defaultTier()?.reasoningEffort !== undefined && defaultTier().reasoningEffort !== 'medium');
      flushSync(() => { root.unmount(); });
      renderer.destroy();
      console.log(JSON.stringify(defaultTier()));
    `;

    const env: NodeJS.ProcessEnv = { ...process.env, KINU_HOME: kinuHome };

    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'KINU_TOKEN']) {
      delete env[name];
    }

    const proc = await runToExit([process.execPath, '-e', script], {
      cwd: repoRoot,
      env,
    });

    expect({ exitCode: proc.exitCode, stderr: proc.stderr }).toEqual({ exitCode: 0, stderr: '' });
    const tier = v.parse(v.object({ reasoningEffort: v.string(), model: v.string() }), JSON.parse(proc.stdout));
    expect(tier).toMatchObject({ reasoningEffort: 'high' });
    expect(tier.model).toStartWith('openai/');
    expect(tier.model).not.toBe('openai/gpt-5.5');
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
            currentSpec={MODELS[0].spec}
            terminal={{ width: 80, height: 24 }}
            onSelect={() => {}}
          />
        )}
      </box>,
    );
    await renderSettled(renderOnce);

    return captureCharFrame();
  } finally {
    flushSync(() => { root.unmount(); });
    renderer.destroy();
  }
}

async function renderSettled(renderOnce: () => Promise<void>) {
  for (let i = 0; i < 10; i++) {
    await renderOnce();
    await new Promise<void>((settle) => setImmediate(settle));
  }
}

function lineContaining(frame: string, text: string) {
  const line = frame.split('\n').findIndex((candidate) => candidate.includes(text));
  expect(line).toBeGreaterThanOrEqual(0);

  return line;
}

function topVisibleTranscriptLine(frame: string): number {
  const numbers = [...frame.matchAll(/line-(\d\d)/gu)].map(([, digits]) => Number(digits));
  expect(numbers.length).toBeGreaterThan(0);

  return Math.min(...numbers);
}

const WORKSPACE_NAMES = ['alpha', 'beta', 'gamma'] as const;

function workspaceTitle(name: string): string {
  return `${name[0]?.toUpperCase() ?? ''}${name.slice(1)} workspace`;
}

/** Env keys that would otherwise let the developer's shell pick cloud or local mode. */
const INHERITED_CREDENTIALS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CODEX_ACCESS_TOKEN',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'KINU_TOKEN',
];

/** Installed before mount: the cloud roster sync runs on mount, so a later swap would race it. */
const homeScreenPrelude = (width = 100, height = 40, fetchStub?: string) => `
  import { mock } from 'bun:test';
  import * as core from '@opentui/core';
  import { createTestRenderer } from '@opentui/core/testing.js';

  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
  globalThis.fetch = ${fetchStub ?? `async () => new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })`};
  const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
    width: ${width},
    height: ${height},
    useThread: false,
    maxFps: Number.POSITIVE_INFINITY,
    // Ctrl+Enter creates the workspace, and only the kitty protocol carries a
    // modifier on Return.
    kittyKeyboard: true,
  });
  // runHomeTui is the entry point the CLI calls, and the completion callback it
  // installs is module-private: rendering HomeApp on its own leaves it null, so
  // "opens a workspace" cannot be observed at all. Swap the terminal renderer
  // for the test one and drive the real thing. The import has to be dynamic —
  // the swap must be in place before home-app resolves createCliRenderer.
  await mock.module('@opentui/core', () => ({ ...core, createCliRenderer: async () => renderer }));
  const { runHomeTui } = await import('./packages/cli/src/tui/home-app.tsx');

  const frame = () => captureCharFrame();
  const rowWith = (text) => (frame().split('\\n').find((row) => row.includes(text)) ?? '').replace(/\\s+/gu, ' ').trim();
  const waitFor = async (what, predicate, rounds = 600) => {
    for (let i = 0; i < rounds; i++) {
      await renderOnce();
      if (predicate()) return;
      await Bun.sleep(10);
    }
    throw new Error('timed out waiting for ' + what);
  };
  const settle = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) {
      await renderOnce();
      await Bun.sleep(10);
    }
  };

  let action = null;
  const opened = runHomeTui({}).then((resolved) => { action = resolved; return resolved; });
  // A key pressed before the screen's own handler is attached is dropped, and a
  // painted frame does not mean it is attached: the handler subscribes on the
  // commit after the first paint. opentui's own keypress listener is the first,
  // so the screen's is the second — that, not a frame, is "keys land now".
  await waitFor('the home screen to start accepting keys', () => renderer.keyInput.listenerCount('keypress') > 1);
`;

  test('the home screen carries readiness once and reads its brief in one line', async () => {
    const full = await runHomeScreen({
      driver: `
        await waitFor('the mode segments to render', () => frame().includes('Cloud'));
        const rows = frame().split('\\n');
        console.log(JSON.stringify({
          readinessRow: rows.some((row) => row.includes('Cloud account')),
          briefOnOneLine: (rows.find((row) => row.includes('An ongoing job')) ?? '').includes('checkout service'),
        }));
      `,
    });

    const observed = v.parse(v.object({
      readinessRow: v.boolean(),
      briefOnOneLine: v.boolean(),
    }), JSON.parse(full.stdout));

    expect(observed.readinessRow).toBe(false);
    expect(observed.briefOnOneLine).toBe(true);

    const compact = await runHomeScreen({
      height: 30,
      driver: `
        await waitFor('the readiness row to render', () => frame().includes('Cloud account'));
        console.log(JSON.stringify({ readinessRow: true }));
      `,
    });

    expect(JSON.parse(compact.stdout)).toEqual({ readinessRow: true });
  });

  test('a cloud workspace whose name a local one holds is named on screen, not silently dropped', async () => {
    const project = realpathSync(scratchDir('home-project'));

    const run = await runHomeScreen({
      workspaces: ['shopbot'],
      config: {
        origin: 'https://kinu.test',
        accessToken: 'ptc_test_fixture_token_not_real',
        tokenExpiresAt: '2099-01-01T00:00:00.000Z',
        user: { id: 'acc-a', email: 'a@example.com' },
        agents: {
          shopbot: {
            name: 'shopbot',
            mode: 'local',
            displayName: 'Shop Bot',
            localName: 'shopbot',
            cwd: project,
            workspaceId: 'shop-floor',
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T00:00:00.000Z',
          },
        },
      },
      fetchStub: `async (input) => String(input).endsWith('/api/cli/workspaces')
        ? Response.json([{ name: 'shopbot', displayName: 'Cloud Shop', createdAt: 1790000000000, lastVisited: 1790000000000, archivedAt: null }])
        : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })`,
      driver: `
        // Either wording, so a sync that FAILED reports as itself rather than
        // as "the notice never rendered". The local workspace is also a roster
        // row, so anchoring on its name alone would pass on the sidebar.
        const noticeRow = () => frame().split('\\n')
          .find((row) => row.includes('holds this name') || row.includes('could not be refreshed')) ?? '';
        await waitFor('the roster notice to render', () => noticeRow() !== '', 1200);
        console.log(JSON.stringify({ notice: noticeRow().replace(/\\s+/gu, ' ').trim() }));
      `,
    });

    const observed = v.parse(v.object({ notice: v.string() }), JSON.parse(run.stdout));
    expect(observed.notice).toContain('shopbot');
    expect(observed.notice).toContain('a local workspace holds this name');
  });

/** Subprocess so one KINU_HOME and one renderer swap belong to one test; the caller owns the returned home. */
async function runHomeScreen(options: {
  driver: string;
  workspaces?: readonly string[];
  width?: number;
  height?: number;
  config?: Partial<KinuConfig>;
  fetchStub?: string;
}) {
  const home = scratchDir('home-tui');
  writeFileSync(resolve(home, 'config.json'), JSON.stringify({
    model: 'openai/gpt-5.5',
    providers: { openai: { apiKey: 'sk-test' } },
    ...options.config,
  }));

  for (const name of options.workspaces ?? []) {
    mkdirSync(resolve(home, name));
    // A real database with a title: the navigator reads its label there, and an unnamed one shows "Untitled workspace".
    const db = new Database(resolve(home, name, 'agent.db'), { create: true });

    try {
      createCLIRuntime(db, { dbPath: db.filename, llm: null, agentName: name }).actor.config.setDisplayName(workspaceTitle(name));
    } finally {
      db.close();
    }
  }

  const env: NodeJS.ProcessEnv = { ...process.env, KINU_HOME: home, KINU_SKIP_DAEMON: '1' };

  for (const name of INHERITED_CREDENTIALS) delete env[name];

  const proc = await runToExit([
    process.execPath,
    '-e',
    `${homeScreenPrelude(options.width, options.height, options.fetchStub)}${options.driver}`,
  ], { cwd: repoRoot, env });

  // Bun exits 0 for a rejected top-level await, so stderr is what fails the test.
  expect({ exitCode: proc.exitCode, stderr: proc.stderr }).toEqual({ exitCode: 0, stderr: '' });

  return { home, stdout: proc.stdout };
}

const MODELS: AgentModelEntry[] = [
  {
    provider: 'workers-ai',
    label: 'Kimi K2.6',
    spec: 'workers-ai/@cf/moonshotai/kimi-k2.6',
    capabilities: ['tools', 'streaming'],
  },
  {
    provider: 'workers-ai',
    label: 'Llama 3.3 70B',
    spec: 'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    capabilities: ['streaming'],
  },
];
