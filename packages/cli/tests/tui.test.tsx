/** @jsxImportSource @opentui/react */
import { runToExit, workspaceDatabase } from '@kinu.run/test-utils';
import { scratchDir } from '../../test-utils/src/scratch';
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';

import { resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot, flushSync } from '@opentui/react';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import { createCLIRuntime, soulOf } from '@kinu.run/cli-backend';
import { commandsForClient } from '../src/slash-commands';
import {
  ChangelogOverlay,
  CommandPaletteOverlay,
  ModelPickerOverlay,
  SettingsOverlay,
  WalkbackOverlay,
  TakesOverlay,
} from '../src/tui/overlays';

import type { AgentModelEntry } from '@kinu.run/core';
import { missionOf } from '@kinu.run/core';
import type { KinuConfig } from '../src/config';

import { StatusBar } from '../src/tui/status-bar';
import { ChatApp } from '../src/tui/chat-app';

import { fakeClient } from './helpers/chat-app-fixture';
import { VERSION } from '../src/display';

const repoRoot = resolve(__dirname, '../../..');

describe('CLI TUI layout', () => {
  test('status bar names a model served through a gateway on a wide terminal', async () => {
    // A gateway's provider path took the whole budget, so the header showed no model at all.
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 160, height: 6, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);

    try {
      root.render(<StatusBar name="jarvis" mode="local" model="my-gateway/anthropic/claude-opus-5-5" reasoningEffort="max" connected={true} />);
      await renderSettled(renderOnce);
      expect(captureCharFrame()).toContain('Claude Opus 5 5');
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


  test('model picker is an absolute overlay and does not move the input area', async () => {
    const withoutOverlay = await renderOverlayFrame(false);
    const withOverlay = await renderOverlayFrame(true);

    expect(lineContaining(withoutOverlay, 'INPUT-SENTINEL')).toBe(lineContaining(withOverlay, 'INPUT-SENTINEL'));
    expect(withOverlay).toContain('Select model');
    expect(withOverlay).toContain('Type to filter');
    expect(withOverlay).toContain('Filter models');
    expect(withOverlay).toContain('Kimi K2.6');
  });

  test('a model of a provider with several accounts asks which, and the answer names the account', async () => {
    const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    const selected: string[] = [];
    const claude: AgentModelEntry = { provider: 'anthropic', label: 'Claude X', spec: 'anthropic/claude-x' };

    try {
      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <ModelPickerOverlay
            models={[claude, ...MODELS]}
            accounts={{ anthropic: ['main', 'work'] }}
            currentSpec="anthropic@work/claude-x"
            terminal={{ width: 80, height: 24 }}
            onSelect={(spec) => { selected.push(spec); }}
          />
        </box>,
      );
      await renderSettled(renderOnce);
      expect(captureCharFrame()).toContain('✓ Claude X');

      mockInput.pressEnter();
      await renderSettled(renderOnce);
      const step = captureCharFrame();
      expect(step).toContain('Run Claude X on');
      expect(step).toContain('the default account');
      expect(selected).toEqual([]);

      mockInput.pressArrow('down');
      mockInput.pressArrow('down');
      mockInput.pressEnter();
      await renderSettled(renderOnce);
      expect(selected).toEqual(['anthropic@work/claude-x']);
    } finally {
      flushSync(() => { root.unmount(); });
      renderer.destroy();
    }
  });

  test('model picker forwards arrow and enter keys from its filter input', async () => {
    const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 24, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    const root = createRoot(renderer);
    const selected: string[] = [];

    try {
      root.render(
        <box style={{ width: '100%', height: '100%' }}>
          <ModelPickerOverlay
            models={MODELS}
            currentSpec={MODELS[0].spec}
            terminal={{ width: 80, height: 24 }}
            onSelect={(spec) => { selected.push(spec); }}
          />
        </box>,
      );
      await renderSettled(renderOnce);

      mockInput.pressArrow('down');
      await renderSettled(renderOnce);
      expect(captureCharFrame()).toContain('Llama 3.3 70B');

      mockInput.pressEnter();
      await renderSettled(renderOnce);
      expect(selected[0]).toBe(MODELS[1].spec);
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
              winnerNodeId: 'node-1',
              chosenNodeId: null,
              candidates: [{
                nodeId: 'node-1',
                text: 'Use the indexed path',
                origin: 'live',
              }],
              createdAt: 1,
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
      expect(missionOf(soulOf(db))).toBe(mission);
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
      import { installTurnDiagnostics } from './packages/cli/src/turn-log.ts';

      // As bin/cli.ts does: the TUI's stderr is the screen.
      installTurnDiagnostics();
      // models.dev, the OpenAI key's only model list: a failed read lists nothing to pick.
      const openai = (id, name) => ({
        id, name, tool_call: true, reasoning: true, limit: { context: 1050000 },
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] }],
      });
      // Each read takes five seconds, so the listing is always slow, as it was under load.
      const now = Date.now;
      let held = 0;
      Date.now = () => now() + held;
      globalThis.fetch = async () => {
        held += 5_000;
        return Response.json({
          openai: { models: { 'gpt-5.5': openai('gpt-5.5', 'GPT-5.5'), 'gpt-5.4': openai('gpt-5.4', 'GPT-5.4') } },
        });
      };
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

    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'KINU_TOKEN']) {
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
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'KINU_TOKEN',
];

/** Installed before mount: the cloud roster sync runs on mount, so a later swap would race it. */
const homeScreenPrelude = (project: string, width = 100, height = 40, fetchStub?: string) => `
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
  // As bin/cli.ts does: the TUI's stderr is the screen.
  (await import('./packages/cli/src/turn-log.ts')).installTurnDiagnostics();

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
  // The screen runs in the folder its workspaces are placed in, as \`kinu\` run there does.
  process.chdir(${JSON.stringify(project)});
  const opened = runHomeTui({}).then((resolved) => { action = resolved; return resolved; });
  // A key pressed before the screen's own handler is attached is dropped, and a
  // painted frame does not mean it is attached: the handler subscribes on the
  // commit after the first paint. opentui's own keypress listener is the first,
  // so the screen's is the second — that, not a frame, is "keys land now".
  await waitFor('the home screen to start accepting keys', () => renderer.keyInput.listenerCount('keypress') > 1);
`;

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
        ? Response.json([{ name: 'shopbot', displayName: 'Cloud Shop', createdAt: 1790000000000, lastVisited: 1790000000000 }])
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
  const project = realpathSync(scratchDir('home-tui-project'));
  const stamp = new Date(0).toISOString();

  const placed = Object.fromEntries((options.workspaces ?? []).map((name) => [name, {
    name, mode: 'local', localName: name, cwd: project, workspaceId: 'proj', createdAt: stamp, updatedAt: stamp,
  }]));

  writeFileSync(resolve(home, 'config.json'), JSON.stringify({
    model: 'openai/gpt-5.5',
    providers: { openai: { apiKey: 'sk-test' } },
    ...options.config,
    agents: { ...placed, ...options.config?.agents },
  }));

  for (const name of options.workspaces ?? []) {
    mkdirSync(resolve(home, name));
    // A real database with a title: the navigator reads its label there, and an unnamed one shows "Untitled workspace".
    const db = workspaceDatabase(resolve(home, name, 'agent.db'), { create: true });

    try {
      createCLIRuntime(db, { llm: null, agentName: name, cwd: project }).actor.config.setDisplayName(workspaceTitle(name));
    } finally {
      db.close();
    }
  }

  const env: NodeJS.ProcessEnv = { ...process.env, KINU_HOME: home, KINU_SKIP_DAEMON: '1' };

  for (const name of INHERITED_CREDENTIALS) delete env[name];

  const proc = await runToExit([
    process.execPath,
    '-e',
    `${homeScreenPrelude(project, options.width, options.height, options.fetchStub)}${options.driver}`,
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
