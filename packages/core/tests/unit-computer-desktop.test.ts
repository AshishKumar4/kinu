/**
 * The computer's desktop as a program calls it (D89): `computer.screenshot`, `watch` and six input members, each read
 * and checked in core before the box is asked, run whole one call at a time, and stopped with its program. The box is
 * faked at its handle; what the box itself checks is proved in the devbox's own tests.
 */
import { describe, expect, test } from 'bun:test';
import type { ShellApprovalPolicy } from '../src/index';
import { createSandboxExecutor, type SandboxHandle } from '../src/execution/sandbox';
import { DESKTOP_MEMBERS, WATCH_DEFAULT_FRAMES, type DesktopAction, type DesktopScreen, type DesktopAnswer, type DesktopRequest } from '../src/execution/desktop';
import { gateProviderExec } from '../src/execution/approval';
import { providersInWorkMode } from '../src/execution/work-mode';
import { executorNamespace } from '../src/tools/executor-operations';
import { withCodemodeProgram } from '../src/tools/outcome';
import { DeviceRequestOwnership, execContext } from '../src/jobs/device-ownership';
import { slateAddressImpact } from '../src/slates/members';
import type { CodemodeProvider } from '../src/types/codemode';
import { sandboxHandleLifecycle } from './helpers/sandbox-handle-lifecycle';
import { projectJsonValue, type JsonValue } from '../src/utils/json';

const PNG = 'iVBORw0KGgo=';

/** What a box answers when it accepts: the screen for a look, done for the rest. */
function accepted(action: DesktopAction): DesktopAnswer {
  return action.kind === 'screenshot' || action.kind === 'watch' ? { kind: 'screen', png: PNG, width: 1280, height: 768 } : { kind: 'done' };
}

const SHOWN = `data:image/png;base64,${PNG}`;

/** The box's desktop: its screen, and its watch's layout, half-size frames two then four to a row. */
const SCREEN: DesktopScreen = { width: 1280, height: 768, sheet: { percent: 50, columns: [1, 2, 2, 2, 4, 4, 4, 4] } };

/** A computer whose box records each desktop request and answers as `answer` says, given the call's stop; nothing else
 *  is reachable. */
function desktopBox(answer: (action: DesktopAction, signal: AbortSignal | undefined) => DesktopAnswer | Promise<DesktopAnswer> = accepted) {
  const sent: DesktopRequest[] = [];

  const unreachable = async (): Promise<never> => {
    throw new Error('a desktop call must not touch the computer any other way');
  };

  const box: SandboxHandle = {
    exec: unreachable, readFile: unreachable, writeFile: unreachable, listFiles: unreachable, deleteFile: unreachable,
    exposePort: unreachable, unexposePort: unreachable, getExposedPorts: unreachable,
    ...sandboxHandleLifecycle,
    desktop: async (request, opts) => {
      sent.push(request);

      return await answer(request.action, opts?.signal);
    },
  };

  return { box, sent, actions: () => sent.map((request) => request.action) };
}

/** An owner who is asked nothing: strict, and every ask recorded. */
function strictOwner() {
  const asked: string[] = [];

  const policy: ShellApprovalPolicy = {
    mode: () => 'strict',
    requestApproval: async (request) => {
      asked.push(request.command);

      return 'deny';
    },
  };

  return { policy, asked };
}

/** The computer's namespace as a program reaches it: the executor, gated at registration as the router gates it. */
function computerOf(box: SandboxHandle, policy: ShellApprovalPolicy = strictOwner().policy): CodemodeProvider {
  return executorNamespace(gateProviderExec(createSandboxExecutor(box, { desktop: { driver: 'main', screen: SCREEN } }), policy));
}

/** A program's call of `member` with positional arguments, as `computer.<member>(...)` makes it: its value, or the
 *  refusal it branches on. */
async function call(computer: CodemodeProvider, member: string, ...args: JsonValue[]): Promise<JsonValue> {
  const tool = computer.tools[member];

  if (tool === undefined) throw new Error(`computer has no ${member}`);

  return projectJsonValue({ value: await tool.execute(...args) });
}

describe('the desktop members', () => {
  test('are declared on the computer with positional call forms, each sending its one action for its agent, and no slate reaches them', async () => {
    const { box, sent } = desktopBox();
    const computer = computerOf(box);

    expect(Object.fromEntries(DESKTOP_MEMBERS.map((member) => [member, computer.declarations?.[member]?.call]))).toEqual({
      screenshot: 'screenshot()', watch: 'watch(seconds, { fps })', click: 'click(at, { button, count, keys })', type: 'type(text)',
      key: 'key(keys, { hold })', scroll: 'scroll(at, dy, { dx })', move: 'move(at)', drag: 'drag(from, to)',
    });
    expect(DESKTOP_MEMBERS.map((member) => slateAddressImpact({ namespace: 'computer', member }))).toEqual(DESKTOP_MEMBERS.map(() => null));

    // The screen is the image alone; its size is said once, where the model reads the member.
    expect(await call(computer, 'screenshot')).toBe(SHOWN);
    expect(computer.declarations?.['screenshot']?.full).toContain('1280×768');
    expect(computer.declarations?.['click']?.full).toContain('x below 1280 and y below 768');
    // A chord's keys are typed as an array where the model reads them (owner, 2026-10-19).
    expect((['key', 'click'] as const).map((member) => computer.declarations?.[member]?.full)).toEqual([
      expect.stringContaining('key(keys: string[]'), expect.stringContaining('keys?: string[]'),
    ]);
    await call(computer, 'click', [10, 20], { button: 'right', count: 2, keys: ['Ctrl', 'cmd'] });
    await call(computer, 'type', 'hi');
    await call(computer, 'key', ['Enter']);
    await call(computer, 'key', ['ctrl', '/']);
    await call(computer, 'key', ['w'], { hold: 800 });
    await call(computer, 'scroll', [5, 6], -3, { dx: 2 });
    await call(computer, 'move', [7, 8]);
    // Minecraft trials, 2026-10-22: under a captured pointer the view turns by motion alone, so a game is aimed by a
    // distance, and clicked where the pointer is.
    await call(computer, 'move', { by: [0, -150] });
    await call(computer, 'click', null);
    expect(await call(computer, 'drag', [1, 2], [3, 4])).toBeNull();

    const expected: DesktopAction[] = [
      { kind: 'screenshot' },
      { kind: 'click', at: [10, 20], button: 'right', count: 2, hold: ['ctrl', 'super'] },
      { kind: 'type', text: 'hi' },
      { kind: 'key', keys: 'Return' },
      { kind: 'key', keys: 'ctrl+slash' },
      { kind: 'key', keys: 'w', holdMs: 800 },
      { kind: 'scroll', at: [5, 6], dy: -3, dx: 2 },
      { kind: 'move', at: [7, 8] },
      { kind: 'move', by: [0, -150] },
      { kind: 'click', button: 'left', count: 1, hold: [] },
      { kind: 'drag', from: [1, 2], to: [3, 4] },
    ];

    expect(sent).toEqual(expected.map((action) => ({ driver: 'main', action })));
  });

  test('watch looks over a window and answers one image; its frames are capped, and a window past 10 s is refused', async () => {
    const { box, actions } = desktopBox();
    const computer = computerOf(box);

    expect(await call(computer, 'watch', 3)).toBe(SHOWN);
    expect(await call(computer, 'watch', 2, { fps: 1 })).toBe(SHOWN);
    expect(await call(computer, 'watch', 10, { fps: 30 })).toBe(SHOWN);
    expect(await call(computer, 'watch', 11)).toMatchObject({ success: false, reason: 'bad_input' });

    const expected: DesktopAction[] = [
      { kind: 'watch', seconds: 3, frames: WATCH_DEFAULT_FRAMES }, { kind: 'watch', seconds: 2, frames: 2 }, { kind: 'watch', seconds: 10, frames: SCREEN.sheet.columns.length },
    ];

    expect(actions()).toEqual(expected);
  });

  test('desktop input runs as the computer\'s shell does there: nothing asks the owner, whatever the mode', async () => {
    const { box, actions } = desktopBox();
    const owner = strictOwner();
    const computer = computerOf(box, owner.policy);

    expect(await call(computer, 'click', [1, 2])).toBeNull();
    expect(await call(computer, 'type', 'ok')).toBeNull();
    expect({ asked: owner.asked, sent: actions().map((action) => action.kind) }).toEqual({ asked: [], sent: ['click', 'type'] });
  });

  test('typed text reaches the box in runs it can type, with Return where a line breaks and Tab where it tabs', async () => {
    const { box, actions } = desktopBox();
    const line = 'x'.repeat(120);

    await call(computerOf(box), 'type', `${line}\r\nnext\tcell\n`);

    expect(actions()).toEqual([
      { kind: 'type', text: 'x'.repeat(50) }, { kind: 'type', text: 'x'.repeat(50) }, { kind: 'type', text: 'x'.repeat(20) },
      { kind: 'key', keys: 'Return' }, { kind: 'type', text: 'next' }, { kind: 'key', keys: 'Tab' }, { kind: 'type', text: 'cell' },
      { kind: 'key', keys: 'Return' },
    ]);
  });

  // 2026-10-14, a real box: Chromium dropped the ü that xdotool's `type` sent at 12 ms a character, and took `key U00FC`.
  test('a character past ASCII is pressed as its own Unicode key, between the runs typed around it', async () => {
    const { box, actions } = desktopBox();

    await call(computerOf(box), 'type', 'Grüße, 5 € 😀!');

    const expected: DesktopAction[] = [
      { kind: 'type', text: 'Gr' }, { kind: 'key', keys: 'U00FC' }, { kind: 'key', keys: 'U00DF' }, { kind: 'type', text: 'e, 5 ' },
      { kind: 'key', keys: 'U20AC' }, { kind: 'type', text: ' ' }, { kind: 'key', keys: 'U1F600' }, { kind: 'type', text: '!' },
    ];

    expect(actions()).toEqual(expected);
  });

  test('a key or modifier X does not know, or a chord that is not one, is refused before anything reaches the box', async () => {
    const { box, sent } = desktopBox();
    const computer = computerOf(box);

    const refused: JsonValue[] = await Promise.all([
      call(computer, 'key', ['Entr']), call(computer, 'key', ['ctrl', 'Entr']), call(computer, 'key', 'ctrl++'),
      call(computer, 'click', [1, 2], { keys: ['q'] }), call(computer, 'scroll', [1, 2], 0),
      call(computer, 'key', ['w'], { hold: 10_001 }), call(computer, 'key', ['w'], { hold: 0 }),
    ]);

    expect(refused).toEqual(refused.map(() => expect.objectContaining({ success: false, reason: 'bad_input' })));
    expect(sent).toEqual([]);
  });

  // The minecraft trials (2026-10-19): Muse sent 21 of its 54 wrong desktop calls as its keys in order, which was
  // refused; OpenAI's and Anthropic's computer tools send keys that way. An array is the documented form, and a string
  // joined by "+" is read the same, silently (owner, 2026-10-19).
  test("a chord's keys are an array, and a string joined by \"+\" is read the same; the space bar sent as \" \" is told its name", async () => {
    const { box, actions } = desktopBox();
    const computer = computerOf(box);

    const answers: JsonValue[] = await Promise.all([
      call(computer, 'key', ['Escape']), call(computer, 'key', ['ctrl', 's']), call(computer, 'key', 'ctrl+s'), call(computer, 'key', ['ctrl', '+']),
      call(computer, 'click', [1, 2], { keys: ['ctrl', 'shift'] }), call(computer, 'click', [1, 2], { keys: 'shift' }),
    ]);

    expect(answers).toEqual(answers.map(() => null));
    expect(actions()).toEqual([
      { kind: 'key', keys: 'Escape' }, { kind: 'key', keys: 'ctrl+s' }, { kind: 'key', keys: 'ctrl+s' }, { kind: 'key', keys: 'ctrl+plus' },
      { kind: 'click', at: [1, 2], button: 'left', count: 1, hold: ['ctrl', 'shift'] }, { kind: 'click', at: [1, 2], button: 'left', count: 1, hold: ['shift'] },
    ]);

    const refused: JsonValue[] = await Promise.all([call(computer, 'key', [' ']), call(computer, 'key', ['shift', ' ']), call(computer, 'key', [])]);

    expect(refused.map((answer) => /send \[[^\]]*\]|like \[[^\]]*\]/u.exec(JSON.stringify(answer).replaceAll('\\"', '"'))?.[0] ?? null)).toEqual([
      'send ["space"]', 'send ["shift","space"]', 'like ["ctrl", "s"]',
    ]);
  });

  // The rc22 release evals (minecraft, both legs): forward and jump at once, sent as "w+space" four times, was refused
  // though the box presses any keys together.
  test('keys pressed together are one chord, held as one', async () => {
    const { box, actions } = desktopBox();
    const computer = computerOf(box);

    expect(await call(computer, 'key', ['w', 'space'], { hold: 800 })).toBeNull();
    expect(await call(computer, 'key', 'w+space', { hold: 800 })).toBeNull();
    expect(actions()).toEqual([{ kind: 'key', keys: 'w+space', holdMs: 800 }, { kind: 'key', keys: 'w+space', holdMs: 800 }]);
  });

  // The rc22 release evals: `click({ at: [640, 360] })` and `click({ x: 640, y: 360 })`, each told only "Expected Array".
  test('a point sent as an object is refused with the array to send', async () => {
    const { box, sent } = desktopBox();
    const computer = computerOf(box);

    const refused: JsonValue[] = await Promise.all([
      call(computer, 'click', { at: [640, 360] }), call(computer, 'click', { x: 640, y: 360 }), call(computer, 'move', { x: 7, y: 8 }),
    ]);

    expect(refused.map((answer) => /send \[[^\]]*\]/u.exec(JSON.stringify(answer))?.[0] ?? null)).toEqual(['send [640, 360]', 'send [640, 360]', 'send [7, 8]']);
    expect(sent).toEqual([]);
  });

  // `hold` is only ever a duration (key's); a click's held modifiers had the same name, and a model sent a click 500.
  test("a click's held keys are its keys, and a hold sent to a click is told so", async () => {
    const { box, actions } = desktopBox();
    const computer = computerOf(box);

    expect(await call(computer, 'click', [650, 660], { hold: 500 })).toMatchObject({ success: false, error: expect.stringContaining('"hold" was removed: use "keys"') });
    expect(await call(computer, 'click', [650, 660], { keys: ['shift'] })).toBeNull();
    expect(actions()).toEqual([{ kind: 'click', at: [650, 660], button: 'left', count: 1, hold: ['shift'] }]);
  });

  test('a hold that names no duration is refused saying what hold is', async () => {
    const { box, sent } = desktopBox();
    const computer = computerOf(box);

    const refused: JsonValue[] = await Promise.all([call(computer, 'key', ['w'], { hold: true }), call(computer, 'key', ['w'], { hold: 0 })]);

    expect(refused).toEqual(refused.map(() => expect.objectContaining({ success: false, reason: 'bad_input' })));
    expect(refused.map((answer) => JSON.stringify(answer).includes('there is no separate key down or key up'))).toEqual([true, true]);
    expect(sent).toEqual([]);
  });

  test("the box's own refusals reach the program as refusals: a point off its screen, and another agent driving it", async () => {
    const off: DesktopAnswer = { kind: 'refused', reason: 'off_screen', detail: '[1300, 20] is off the screen, which is 1280×768.' };
    const driven: DesktopAnswer = { kind: 'refused', reason: 'driven', detail: 'another agent of this workspace drives the desktop' };
    const answers = [off, driven];
    const { box } = desktopBox(() => answers.shift() ?? { kind: 'done' });
    const computer = computerOf(box);

    expect(await call(computer, 'click', [1300, 20])).toMatchObject({ success: false, reason: 'bad_input', error: expect.stringContaining('[1300, 20] is off the screen') });
    expect(await call(computer, 'move', [1, 1])).toMatchObject({ success: false, reason: 'unavailable', error: expect.stringContaining('another agent') });
  });

  test('a Plan turn can look at the screen, and every member that acts on it is refused before the box is asked', async () => {
    const { box, actions } = desktopBox();
    const [planned] = providersInWorkMode('plan', [computerOf(box)]);

    if (planned === undefined) throw new Error('Plan dropped the computer');

    expect(await call(planned, 'screenshot')).toBe(SHOWN);
    expect(await call(planned, 'watch', 1)).toBe(SHOWN);

    const acting: Array<[string, JsonValue[]]> = [['click', [[1, 2]]], ['type', ['x']], ['key', ['Return']], ['scroll', [[1, 2], 1]], ['move', [[1, 2]]], ['drag', [[1, 2], [3, 4]]]];

    for (const [member, args] of acting) {
      expect(await call(planned, member, ...args)).toMatchObject({ success: false, reason: 'denied' });
    }

    expect(actions().map((action) => action.kind)).toEqual(['screenshot', 'watch']);
  });
});

describe('a program driving the desktop', () => {
  /** A box that holds each typed run until it is let go, so a test can act while one is on the screen. */
  function holdingBox() {
    const held: Array<() => void> = [];
    const awaited: Array<{ readonly count: number; readonly resolve: () => void }> = [];

    const desk = desktopBox(async (action) => {
      for (const waiter of awaited.filter((entry) => desk.sent.length >= entry.count)) {
        awaited.splice(awaited.indexOf(waiter), 1);
        waiter.resolve();
      }

      if (action.kind === 'type') await new Promise<void>((resolve) => { held.push(resolve); });

      return accepted(action);
    });

    /** Once the box has been asked `count` times. */
    const arrived = async (count: number): Promise<void> => {
      if (desk.sent.length >= count) return;
      await new Promise<void>((resolve) => { awaited.push({ count, resolve }); });
    };

    return { ...desk, arrived, release: () => { held.shift()?.(); } };
  }

  test('calls made together reach the screen one whole call at a time, in the order made', async () => {
    const { box, actions, arrived, release } = holdingBox();
    const computer = computerOf(box);

    const all = withCodemodeProgram(async () => ({
      result: await Promise.all([call(computer, 'type', 'a'.repeat(60)), call(computer, 'type', 'b'.repeat(60)), call(computer, 'click', [1, 2])]),
    }), { call: 'call-test' });

    // Each typed run is held on the screen until let go; whatever else was called waits behind it.
    for (let count = 1; count <= 4; count += 1) {
      await arrived(count);
      release();
    }

    await all;

    const expected: DesktopAction[] = [
      { kind: 'type', text: 'a'.repeat(50) }, { kind: 'type', text: 'a'.repeat(10) },
      { kind: 'type', text: 'b'.repeat(50) }, { kind: 'type', text: 'b'.repeat(10) },
      { kind: 'click', at: [1, 2], button: 'left', count: 1, hold: [] },
    ];

    expect(actions()).toEqual(expected);
  });

  test('a stop reaches the box: the action on the screen is ended there, and nothing waiting behind it is sent', async () => {
    const ended: string[] = [];
    const asked = Promise.withResolvers<void>();

    // As the box answers a held key: its run lasts until a stop ends it there, and the call settles once it has.
    const { box, actions } = desktopBox((action, signal) => {
      if (action.kind !== 'key') return accepted(action);
      asked.resolve();

      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => {
          ended.push(action.keys);
          reject(new DOMException('its container process tree was ended', 'AbortError'));
        }, { once: true });
      });
    });

    const computer = computerOf(box);
    const stop = new AbortController();

    const all = withCodemodeProgram(async () => ({
      result: await Promise.all([call(computer, 'key', ['w'], { hold: 10_000 }), call(computer, 'click', [1, 2])]),
    }), { call: 'call-test', signal: stop.signal });

    await asked.promise;
    stop.abort();

    const { result } = await all;

    expect({ ended, sent: actions() }).toEqual({ ended: ['w'], sent: [{ kind: 'key', keys: 'w', holdMs: 10_000 }] });
    expect(result).toEqual([expect.objectContaining({ reason: 'cancelled' }), expect.objectContaining({ reason: 'cancelled' })]);
  });

  test("a program stopped while another program's look holds the screen is answered at once, and nothing of it reaches the box", async () => {
    const looking = Promise.withResolvers<void>();
    const seen = Promise.withResolvers<void>();

    // As the box answers a look: it holds the screen until the test lets it go.
    const { box, actions } = desktopBox(async (action) => {
      if (action.kind === 'screenshot') {
        looking.resolve();
        await seen.promise;
      }

      return accepted(action);
    });

    const computer = computerOf(box);
    const look = withCodemodeProgram(async () => ({ result: [await call(computer, 'screenshot')] }), { call: 'call-test' });

    await looking.promise;
    const stop = new AbortController();
    const queued = withCodemodeProgram(async () => ({ result: [await call(computer, 'click', [1, 2])] }), { call: 'call-test', signal: stop.signal });

    stop.abort();
    // Answered while the other program's look still holds the screen, which is let go only after.
    const stopped = await queued;

    seen.resolve();

    expect({ stopped: stopped.result, look: (await look).result, sent: actions() })
      .toEqual({ stopped: [expect.objectContaining({ reason: 'cancelled' })], look: [SHOWN], sent: [{ kind: 'screenshot' }] });
  });

  test('a program moved to the background may still look, but no longer acts on the screen', async () => {
    const { box, actions } = desktopBox();
    const computer = computerOf(box);
    const job = new DeviceRequestOwnership('job-1');

    const { result } = await withCodemodeProgram(async () => {
      const before = await call(computer, 'click', [1, 2]);

      // As the background wrapper moves a program that outlived its window.
      job.drain('job-1');

      return { result: [before, await call(computer, 'click', [3, 4]), await call(computer, 'key', 'w', { hold: 500 }), await call(computer, 'screenshot'), await call(computer, 'watch', 1)] };
    }, { call: 'call-test' }, execContext({ channel: job }));

    expect(result).toEqual([null, expect.objectContaining({ success: false, reason: 'denied' }), expect.objectContaining({ success: false, reason: 'denied' }), SHOWN, SHOWN]);
    expect(actions().map((action) => action.kind)).toEqual(['click', 'screenshot', 'watch']);
  });
});
