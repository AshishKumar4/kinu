import { describe, expect, test } from 'bun:test';
import { MINECRAFT_CONTROL, MINECRAFT_CONTROL_TRIES, minecraftControlScript } from '../../scripts/minecraft-control-script';
import { readScriptedRequest, type ScriptedRequest } from '../../scripts/scripted-protocol';
import { TOOL_IMAGES_OPENING } from '../../packages/core/src/utils/prompt-sections';
import { boxBreaches, browserBreaches, controlShortfalls, judged, playedByHand, rungsClimbed, tallestColumn, type ClosedBox, type LiveBox } from '../tasks/minecraft';
import type { EvalCheck } from './task';

const program = (code: string) => ({ name: 'eval', args: JSON.stringify({ code }) });

describe('played by hand', () => {
  test('literal desktop actions, one to a statement, are play, counted by action', () => {
    const played = playedByHand([
      program('await computer.screenshot();'),
      program('await computer.click([640, 400]);\nawait computer.key("w", { hold: 800 });\nawait computer.key("Space");\nreturn await computer.watch(2, { fps: 1 });'),
      program('computer.move([700, 420]); await computer.click([640, 400], { button: "right" }); await computer.key("shift+w"); await computer.key("Esc"); return "done";'),
      program('await computer.scroll([640, 400], -2); await computer.drag([600, 400], [650, 420]); await computer.key("3");'),
      // As a staging trial wrote them (2026-10-17): the product refuses both and presses nothing.
      program('await computer.key(["Escape"]); await computer.key(" ");'),
    ]);

    expect(played).toEqual({
      programs: 5, breaches: [],
      actions: { screenshot: 1, click: 2, key: 7, watch: 1, move: 1, scroll: 1, drag: 1 },
    });
  });

  test('typing, other tools and anything computed are each named; which keys reach the game is the box\'s to say', () => {
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

  test('counts its tries across the screenshots the product attaches as their own user message', () => {
    // On staging (2026-10-17) every screenshot's image came back as a user message after its tool result, read as a
    // new ask, and the control took its first screenshot 56 times until the request passed the model's 8 MB.
    const call = (id: string, code: string) => [
      { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'eval', arguments: JSON.stringify({ code }) } }] },
      { role: 'tool', tool_call_id: id, content: '(image attached in the next message)' },
      { role: 'user', content: [{ type: 'text', text: TOOL_IMAGES_OPENING }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] },
    ];

    const read = readScriptedRequest(JSON.stringify({
      messages: [
        { role: 'system', content: `A benchmark. ${MINECRAFT_CONTROL}` },
        { role: 'user', content: 'Build a tower.' },
        ...call('c1', MINECRAFT_CONTROL_TRIES[0]),
        ...call('c2', MINECRAFT_CONTROL_TRIES[1]),
      ],
      tools: [{ type: 'function', function: { name: 'eval' } }],
      stream: true,
    }));

    if ('refusal' in read) throw new Error(read.refusal.body);
    expect([read.request.ask, minecraftControlScript(read.request)?.toolCall])
      .toEqual(['Build a tower.', { name: 'eval', arguments: { code: MINECRAFT_CONTROL_TRIES[2] } }]);
  });

  test('of the tries the trial must fail for, typing is the rule\'s; the keys are the box\'s', () => {
    const tries = MINECRAFT_CONTROL_TRIES.map((code) => program(code));

    expect(playedByHand(tries).breaches).toEqual([
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

// Main, 2026-10-22: a task no build passes moves no pass rate, so the gate reads its rungs, from the game's own save.
describe('the rungs a Minecraft trial climbed', () => {
  const save = (blocks: Readonly<Record<string, { a: number; bt: number }>>) => ({ worldSeed: 4242, changedBlocks: blocks, worldSize: 128, version: 1 });

  test('a world, then a block, then a column of 2 and of 3, as high as its tallest placed column', () => {
    const column = save({ 'p10_40_10': { a: 1, bt: 1 }, 'p10_41_10': { a: 1, bt: 1 }, 'p3_40_3': { a: 1, bt: 4 } });

    expect([rungsClimbed(null), rungsClimbed(save({})), rungsClimbed(column)]).toEqual([
      { 'in-a-world': false, 'placed-a-block': false, 'column-of-2': false, 'column-of-3': false },
      { 'in-a-world': true, 'placed-a-block': false, 'column-of-2': false, 'column-of-3': false },
      { 'in-a-world': true, 'placed-a-block': true, 'column-of-2': true, 'column-of-3': false },
    ]);
  });
});

// 2026-10-21: every judge call failed on the reviewer login's usage limit and was recorded as a no.
describe("the vision judge's answer", () => {
  const frame = async () => new Uint8Array([1]);

  test('a yes passes, a no fails, and a failed call or an answer neither yes nor no is unjudged', async () => {
    const asking = (answer: () => Promise<{ verdict: boolean | null; reply: string }>) => judged({ judgement: answer }, frame, 'Is it a tower?');

    expect(await Promise.all([
      asking(async () => ({ verdict: true, reply: 'yes' })),
      asking(async () => ({ verdict: false, reply: 'no' })),
      asking(async () => { throw new Error('429 usage limit'); }),
      asking(async () => ({ verdict: null, reply: 'maybe' })),
    ])).toEqual([
      { pass: true, evidence: { verdict: true, reply: 'yes' } },
      { pass: false, evidence: { verdict: false, reply: 'no' } },
      { pass: false, unjudged: true, evidence: { unjudged: '429 usage limit' } },
      { pass: false, unjudged: true, evidence: { unjudged: 'the judge said neither yes nor no', reply: 'maybe' } },
    ]);
  });
});
