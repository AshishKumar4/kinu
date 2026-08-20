/** @jsxImportSource @opentui/react */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import { SLASH_COMMANDS } from '../src/slash-commands';
import { CommandHintOverlay, DeviceConnectOverlay, ModelPickerOverlay, WalkbackOverlay } from '../src/tui/overlays';
import type { AgentModelEntry } from '../src/model-catalog';
import { MessageList } from '../src/tui/messages';
import { tuiColors } from '../src/tui/theme';
import { StatusBar } from '../src/tui/status-bar';
import { handleHistoryScrollKey } from '../src/tui/chat-app';
import { VERSION } from '../src/display';

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
    const packageJson = v.parse(
      v.object({ version: v.string() }),
      JSON.parse(readFileSync(resolve(repoRoot, 'packages/cli/package.json'), 'utf8')),
    );

    expect(VERSION).toBe(packageJson.version);
    // What the CLI reports is the contract. The greps this replaced named the
    // wiring instead — display.ts's package.json import, program.ts's
    // `.version(VERSION)` call, home-app.tsx's header literal — and passed for
    // any spelling of it while a `-v` that printed nothing would too. The home
    // header is asserted where it renders, on the frame, by 'digit keys never
    // select a workspace on the home screen'.
    const reported = Bun.spawnSync({
      cmd: [process.execPath, resolve(repoRoot, 'packages/cli/bin/cli.ts'), '-v'],
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect({ exitCode: reported.exitCode, stdout: reported.stdout.toString().trim() })
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
            currentSpec={MODELS[0]!.spec}
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
      expect(selected[0]?.spec).toBe(MODELS[1]!.spec);
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

  // Digits belong to the mission, never to the workspace list. The grep this
  // replaced ("home-app.tsx does not contain Number(key.name)") locked a
  // spelling: renaming the local broke it with no behaviour change, and a
  // numeric handler written any other way passed it. So drive the real screen
  // and press the keys — with an arrow press afterwards, so "the selection did
  // not move" cannot be "no key arrived".
  test('digit keys never select a workspace on the home screen', () => {
    const run = runHomeScreen({
      workspaces: WORKSPACE_NAMES,
      driver: `
        const WORKSPACES = ${JSON.stringify(WORKSPACE_NAMES)};
        const selected = () => WORKSPACES.find((name) => frame().includes('› ' + name)) ?? null;

        await waitFor('the workspace list to render', () => frame().includes('Workspaces'));
        const listed = WORKSPACES
          .map((name) => ({ name, at: frame().split('\\n').findIndex((row) => row.includes(name + '  local')) }))
          .sort((a, b) => a.at - b.at)
          .map((entry) => entry.name);
        mockInput.pressTab();
        await waitFor('the workspace list to take the keyboard', () => rowWith('Workspaces').includes('↑/↓ select'));

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
        await waitFor('the down arrow to move the selection', () => selected() !== initial, 200);
        observed.afterArrowDown = selected();
        mockInput.pressEscape();
        observed.finalAction = await opened;
        console.log(JSON.stringify(observed));
      `,
    });
    try {
      // The actions stay unmodelled records: v.object would quietly drop a field
      // the screen has no business sending, which is exactly the field that
      // would carry a mission into chat.
      const homeAction = v.nullable(v.record(v.string(), v.unknown()));
      const observed = v.parse(v.object({
        listed: v.array(v.string()),
        initial: v.string(),
        afterDigits: v.string(),
        openedByDigits: homeAction,
        header: v.string(),
        afterArrowDown: v.string(),
        finalAction: homeAction,
      }), JSON.parse(run.stdout));

      expect(observed.initial).toBe(observed.listed[0]);
      expect(observed.afterDigits).toBe(observed.listed[0]);
      expect(observed.openedByDigits).toBeNull();
      expect(observed.afterArrowDown).toBe(observed.listed[1]);
      expect(observed.finalAction).toEqual({ type: 'exit' });
      // The home header renders the one VERSION, which is why the version test
      // no longer greps home-app.tsx for the literal.
      expect(observed.header).toBe(`Kinu workspaces · cli ${VERSION}`);
    } finally {
      rmSync(run.home, { recursive: true, force: true });
    }
  });

  // The mission is what the workspace IS — it seeds SOUL.md and names the
  // workspace. Replaying it as the opening turn hands a standing brief over as
  // a task, which is what "My personal assistant, Jarvis" being answered as a
  // request came from. The CLI opens the new workspace with an empty
  // conversation, exactly as the web app does. Asserted on the created
  // workspace itself and on the action the home screen hands to chat — the only
  // channel a prompt could ride in on — rather than on the absence of the
  // string 'initialPrompt' from three files.
  test('creating a workspace from a mission opens it without sending the mission', () => {
    const mission = 'My personal assistant, Jarvis';
    const run = runHomeScreen({
      driver: `
        await waitFor('the mission field to render', () => frame().includes('What is this workspace for?'));
        await mockInput.typeText(${JSON.stringify(mission)});
        await waitFor('the mission to reach the field', () => frame().includes(${JSON.stringify(mission)}));
        mockInput.pressEnter({ ctrl: true });
        await waitFor('the new workspace to open', () => action !== null, 3000);
        console.log(JSON.stringify({ opened: await opened }));
      `,
    });
    try {
      const observed = v.parse(
        v.object({ opened: v.record(v.string(), v.unknown()) }),
        JSON.parse(run.stdout),
      );
      const created = readdirSync(run.home, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(resolve(run.home, entry.name, 'agent.db')))
        .map((entry) => entry.name);
      expect(created).toHaveLength(1);
      // Exactly this payload: an extra field is how a mission would reach chat
      // as a first turn, and chat opens whatever `name` says.
      expect(observed.opened).toEqual({ type: 'open-agent', name: created[0] });

      const db = new Database(resolve(run.home, created[0]!, 'agent.db'), { readonly: true });
      try {
        expect(db.query('SELECT COUNT(*) AS messages FROM messages').get()).toEqual({ messages: 0 });
        expect(db.query('SELECT mission FROM workspace_identity').all()).toEqual([{ mission }]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(run.home, { recursive: true, force: true });
    }
  });

  test('home model and effort selections persist as global defaults', () => {
    const kinuHome = mkdtempSync(resolve(tmpdir(), 'kinu-home-tui-'));
    try {
      writeFileSync(resolve(kinuHome, 'config.json'), JSON.stringify({
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
        const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
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
        await waitFor('the chosen model to persist', () => JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).model !== 'openai/gpt-5.5');
        // The write lands while the overlay is still on screen, so persistence is
        // NOT the signal that the picker is done with the keyboard. Tab pressed
        // here goes to the overlay and focus never reaches Effort.
        await waitFor('the model picker to close', () => !captureCharFrame().includes('Select model'));
        mockInput.pressTab();
        // The row renders its key hint only while focused, so this is the
        // observable "the effort control has the keyboard" — an arrow sent before
        // it does goes to the previous field.
        await waitFor('the effort control to take focus', () => captureCharFrame().includes('↑/↓ select'));
        mockInput.pressArrow('down');
        await waitFor('the chosen effort to persist', () => JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).reasoningEffort !== 'medium');
        root.render(createElement('box'));
        renderer.destroy();
        console.log(readFileSync(CONFIG_PATH, 'utf8'));
      `;
      const env: NodeJS.ProcessEnv = { ...process.env, KINU_HOME: kinuHome };
      for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'KINU_TOKEN']) {
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
      const config = v.parse(v.object({ reasoningEffort: v.string(), model: v.string() }), JSON.parse(proc.stdout.toString()));
      expect(config).toMatchObject({ reasoningEffort: 'high' });
      expect(config.model).toStartWith('openai/');
      expect(config.model).not.toBe('openai/gpt-5.5');
    } finally {
      rmSync(kinuHome, { recursive: true, force: true });
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

const WORKSPACE_NAMES = ['alpha', 'beta', 'gamma'] as const;

/** Keys and tokens that would otherwise decide, from the developer's own shell,
 *  whether the home screen comes up in cloud or local mode. */
const INHERITED_CREDENTIALS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CODEX_ACCESS_TOKEN',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'KINU_TOKEN',
];

const HOME_SCREEN_PRELUDE = `
  import { mock } from 'bun:test';
  import * as core from '@opentui/core';
  import { createTestRenderer } from '@opentui/core/testing.js';

  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
  globalThis.fetch = async () => new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 100,
    height: 40,
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

/** Drives the home screen the CLI actually runs, in a subprocess so that one
 *  KINU_HOME and one renderer swap belong to one test. `driver` runs with
 *  `frame`, `rowWith`, `waitFor`, `settle`, `mockInput`, `action` (whatever the
 *  screen has finished with, or null) and `opened` in scope, and prints the one
 *  JSON line the caller asserts on. The caller owns the returned home. */
function runHomeScreen(options: { driver: string; workspaces?: readonly string[] }) {
  const home = mkdtempSync(resolve(tmpdir(), 'kinu-home-tui-'));
  writeFileSync(resolve(home, 'config.json'), JSON.stringify({
    model: 'openai/gpt-5.5',
    providers: { openai: { apiKey: 'sk-test' } },
  }));
  for (const name of options.workspaces ?? []) {
    mkdirSync(resolve(home, name));
    writeFileSync(resolve(home, name, 'agent.db'), '');
  }
  const env: NodeJS.ProcessEnv = { ...process.env, KINU_HOME: home, KINU_SKIP_DAEMON: '1' };
  for (const name of INHERITED_CREDENTIALS) delete env[name];

  const proc = Bun.spawnSync({
    cmd: [process.execPath, '-e', `${HOME_SCREEN_PRELUDE}${options.driver}`],
    cwd: repoRoot,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // A driver that timed out reports what never arrived on stderr, and Bun still
  // exits 0 for a rejected top-level await, so stderr is what fails the test.
  expect({ exitCode: proc.exitCode, stderr: proc.stderr.toString() }).toEqual({ exitCode: 0, stderr: '' });
  return { home, stdout: proc.stdout.toString() };
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
