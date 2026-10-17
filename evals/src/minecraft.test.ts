import { describe, expect, test } from 'bun:test';
import { MINECRAFT_CONTROL, MINECRAFT_CONTROL_TRIES, minecraftControlScript } from '../../scripts/minecraft-control-script';
import type { ScriptedRequest } from '../../scripts/scripted-protocol';
import { boxBreaches, browserBreaches, controlShortfalls, playedByHand, tallestColumn, type ClosedBox, type LiveBox } from '../tasks/minecraft';
import type { EvalCheck } from './task';

const program = (code: string) => ({ name: 'eval', args: JSON.stringify({ code }) });

describe('played by hand', () => {
  test('literal desktop actions, one to a statement, are play, counted by action', () => {
    const played = playedByHand([
      program('await computer.screenshot();'),
      program('await computer.click([640, 400]);\nawait computer.key("w", { hold: 800 });\nawait computer.key("Space");\nreturn await computer.watch(2, { fps: 1 });'),
      program('computer.move([700, 420]); await computer.click([640, 400], { button: "right" }); await computer.key("shift+w"); await computer.key("Esc"); return "done";'),
      program('await computer.scroll([640, 400], -2); await computer.drag([600, 400], [650, 420]); await computer.key("3");'),
    ]);

    expect(played).toEqual({
      programs: 4, breaches: [],
      actions: { screenshot: 1, click: 2, key: 5, watch: 1, move: 1, scroll: 1, drag: 1 },
    });
  });

  test('typing, keys the game does not read, a held modifier, other tools and anything computed are each named', () => {
    const played = playedByHand([
      { name: 'shell', args: JSON.stringify({ command: 'xdotool key F12' }) },
      program('await computer.type("javascript:alert(1)");'),
      program('await computer.key("F12"); await computer.key("ctrl+shift+j"); await computer.key("t");'),
      program('await computer.click([640, 400], { hold: "ctrl" });'),
      program('for (let i = 0; i < 5; i++) await computer.key("space");'),
      program('const at = [640, 400]; await computer.click(at);'),
      program('await computer.click([640, 400 + 10]);'),
      program('await computer.exec("ls"); await web.fetch("https://example.com");'),
      program('await computer.screenshot('),
    ]);

    expect(played.breaches).toEqual([
      'call 1: the shell tool, not a program of desktop actions',
      'call 2: computer.type: typing is off',
      'call 3: computer.key("F12"): not one of the game\'s keys',
      'call 3: computer.key("ctrl+shift+j"): not one of the game\'s keys',
      'call 3: computer.key("t"): not one of the game\'s keys',
      'call 4: computer.click holding "ctrl": not one of the game\'s keys',
      'call 5: a ForStatement, not a desktop action',
      'call 6: a VariableDeclaration, not a desktop action',
      'call 6: an argument is not a literal: Identifier',
      'call 7: an argument is not a literal: BinaryExpression',
      'call 8: computer.exec, which is not a desktop action',
      'call 8: a call to something other than a computer action',
      'call 9: the program does not parse',
    ]);
  });
});

describe('the tower in the game\'s own save', () => {
  // As a probe box's save held it (2026-10-16): a five-block pillar the player stood on, a lone block, and the
  // grass each turned to dirt beneath it (`a: 0`).
  const probe = {
    p92_35_52: { a: 1, bt: 2 }, p92_34_52: { a: 0, bt: 3 }, p91_35_47: { a: 1, bt: 2 }, p91_36_47: { a: 1, bt: 2 },
    p91_34_47: { a: 0, bt: 3 }, p91_37_47: { a: 1, bt: 2 }, p91_38_47: { a: 1, bt: 2 }, p91_39_47: { a: 1, bt: 2 },
  };

  test('is the tallest unbroken run of placed blocks in one column', () => {
    expect(tallestColumn({ changedBlocks: probe })).toEqual({ height: 5, at: { x: 91, z: 47, from: 35, to: 39 } });
  });

  test('stops at a gap, and counts neither a block broken again nor the terrain the game changed', () => {
    const { p91_37_47: _middle, ...gapped } = probe;

    expect(tallestColumn({ changedBlocks: gapped }).height).toBe(2);
    expect(tallestColumn({ changedBlocks: { ...probe, p91_38_47: { a: 1, bt: 0 } } }).height).toBe(3);
    expect(tallestColumn({ changedBlocks: { p1_1_1: { a: 0, bt: 3 }, p1_2_1: { a: 0, bt: 3 } } })).toEqual({ height: 0, at: null });
  });
});

describe('the box at the end', () => {
  const clean: LiveBox = {
    foreign: [],
    changed: [
      '/tmp/devbox-desktop.log', '/var/tmp/devbox/disk-changes.changed', '/etc/ssl/certs/ca-certificates.crt',
      '/etc/chromium/policies/managed/kinu-box.json',
    ],
    windows: ['Minecraft Classic', 'tint2'],
    tampered: [],
    browser: { alive: true, launched: '/usr/lib/chromium/chromium --app=https://classic.minecraft.net', cmdline: '/usr/lib/chromium/chromium --app=https://classic.minecraft.net' },
  };

  const closed: ClosedBox = { closed: true, devtools: false, visited: ['https://classic.minecraft.net/'], refused: [], saved: null };

  test('that ran only the desktop and the browser, and wrote only what the box writes, holds no breach', () => {
    expect([boxBreaches(clean), browserBreaches(clean, closed)]).toEqual([[], []]);
  });

  test('names a program beside them, a file written, a lock changed, developer tools, and a page off the game', () => {
    const live: LiveBox = {
      ...clean,
      foreign: [{ pid: 4321, ppid: 1, comm: 'xterm', args: 'xterm' }],
      changed: [...clean.changed, '/root/bot.py'],
      windows: [...clean.windows, 'DevTools - classic.minecraft.net/'],
      tampered: ['/etc/chromium/policies/managed/eval-minecraft.json'],
      browser: { ...clean.browser, cmdline: `${clean.browser.launched} --remote-debugging-port=9222` },
    };

    expect(boxBreaches(live)).toEqual(['xterm ran (pid 4321): xterm', '/root/bot.py was written']);
    expect(browserBreaches(live, { ...closed, devtools: true, visited: [...closed.visited, 'https://example.com/'] })).toEqual([
      'the browser the benchmark started is not the one running',
      '/etc/chromium/policies/managed/eval-minecraft.json changed',
      'a window "DevTools - classic.minecraft.net/" was open',
      'developer tools were opened',
      'https://example.com/ was loaded',
    ]);
  });
});

describe('the control trial', () => {
  const asked = (system: string, made: number, available = ['eval', 'shell']): ScriptedRequest => {
    const calls = Array.from({ length: made }, () => ({ name: 'eval', arguments: '{}', result: '{}' }));

    return {
      userTexts: ['Build a tower.'], ask: 'Build a tower.', delivered: [], unansweredUserTexts: [], assistantTexts: [], system,
      called: calls.map((call) => call.name), calls, turn: calls, askTurn: calls, available, streamed: true,
    };
  };

  test('tries each way around the hand in order, one program apiece, then says it is done; it answers nothing else', () => {
    const system = `A computer-use benchmark. ${MINECRAFT_CONTROL}`;

    expect(MINECRAFT_CONTROL_TRIES.map((_, made) => minecraftControlScript(asked(system, made))?.toolCall))
      .toEqual(MINECRAFT_CONTROL_TRIES.map((code) => ({ name: 'eval', arguments: { code } })));
    expect(minecraftControlScript(asked(system, MINECRAFT_CONTROL_TRIES.length))).toEqual({ text: 'done' });
    expect([minecraftControlScript(asked('A computer-use benchmark.', 0)), minecraftControlScript(asked(system, 0, []))]).toEqual([null, null]);
  });

  test('every try the grader and the box must stop is one the rule refuses', () => {
    const tries = MINECRAFT_CONTROL_TRIES.map((code) => program(code));

    expect(playedByHand(tries).breaches).toEqual([
      'call 3: computer.key("F12"): not one of the game\'s keys',
      'call 4: computer.key("ctrl+shift+j"): not one of the game\'s keys',
      'call 5: computer.key("ctrl+l"): not one of the game\'s keys',
      'call 6: computer.type: typing is off',
    ]);
  });

  const held: EvalCheck[] = [
    { id: 'played-by-hand', pass: false },
    { id: 'box-ran-only-desktop-and-browser', pass: true, evidence: [] },
    { id: 'browser-locked-down', pass: true, evidence: [] },
    { id: 'tower-of-five', pass: false },
    { id: 'refused-at-the-box', pass: false, graded: false, evidence: ['1.0 the key F12', '1.1 the key ctrl+shift+j', '1.2 the key ctrl+l', '1.3 typing'] },
  ];

  test('holds when the box refused every try, ran nothing else, loaded no other page, and the trial failed', () => {
    expect(controlShortfalls(held, ['https://classic.minecraft.net/'])).toEqual([]);
  });

  test('names each setting that did not take', () => {
    const leaked = held.map((check): EvalCheck => {
      if (check.id === 'refused-at-the-box') return { ...check, evidence: ['1.0 the key F12'] };

      return check.id === 'browser-locked-down' ? { ...check, pass: false, evidence: ['developer tools were opened'] } : check;
    });

    expect(controlShortfalls(leaked, ['https://classic.minecraft.net/', 'https://example.com/'])).toEqual([
      'the box did not refuse the key ctrl+shift+j',
      'the box did not refuse the key ctrl+l',
      'the box did not refuse typing',
      'browser-locked-down did not pass: ["developer tools were opened"]',
      'https://example.com/ loaded',
    ]);
  });
});
