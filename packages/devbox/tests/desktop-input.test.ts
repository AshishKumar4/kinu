// D89: the box's end of an agent's desktop action. The desktop check, X's input and the capture are the container's,
// faked at its exec: what is proved here is what the box sends, in what order, what it refuses before sending anything,
// and how a stop ends it. A real container's desktop is held to the same actions by gate:devbox-e2e's desktop contracts.
import { TestDevbox } from './support/test-devbox';
import { describe, expect, test } from 'bun:test';

import { harness } from './support/devbox-harness';
import type { DesktopRequest } from '../src/desktop-input';

class DesktopBox extends TestDevbox<unknown> {

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}

/** A PNG header for a 1280×768 image, and a byte that is not valid UTF-8, so a text decode would show. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0, 0, 0, 3, 0, 0xff]);

let pids = 100;

/** A process that ends with these bytes once `exited` settles; ended at once by default. */
function ended(stdout: Uint8Array, exitCode = 0, stderr = '', exited: Promise<number> = Promise.resolve(exitCode)): ExecProcess {
  const bytes = (data: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close(); } });
  const err = new TextEncoder().encode(stderr);

  return {
    pid: pids += 1, isPty: false, stdin: null, stdout: bytes(stdout), stderr: bytes(err), exitCode: exited,
    kill() { /* its group's kill ends it */ }, resize() { throw new Error('this process has no PTY'); },
    output: async () => ({ stdout: stdout.slice().buffer, stderr: err.slice().buffer, exitCode: await exited }),
  };
}

/** One run as the box launched it: what ran, and whether in its own group, which `killExec` ends (D69). */
interface Run {
  readonly argv: readonly string[];
  readonly grouped: boolean;
  readonly locale: string | undefined;
}

/**
 * A box whose container answers the desktop check, X's input and the capture, each run recorded. `answer` may hold a
 * run: `held(run)` keeps it running until its group is killed, as a real `xdotool ... sleep` or a wedged check is.
 */
async function desktopBox(answer: (run: readonly string[], held: () => ExecProcess) => ExecProcess | undefined = () => undefined) {
  const runs: Run[] = [];
  const killed: string[] = [];
  // What ended a run and what let up after it, in the order the box asked.
  const order: string[] = [];
  const holding = new Map<number, (exitCode: number) => void>();
  // The next check finds X gone and starts it: the screen is a new one.
  let restarted = false;

  const held = (): ExecProcess => {
    const { promise, resolve } = Promise.withResolvers<number>();
    const process = ended(new Uint8Array(), 0, '', promise);

    holding.set(process.pid, resolve);

    return process;
  };

  const { box } = harness(DesktopBox, undefined, async (argv, options) => {
    if (argv[3] === 'kill-tree') {
      const pid = Number(argv[4]);
      const end = holding.get(pid);

      killed.push(String(pid));
      order.push('kill');
      holding.delete(pid);
      end?.(137);

      return ended(new Uint8Array(), end === undefined ? 3 : 0);
    }

    const grouped = argv[0] === 'setsid' && argv[1] === '-w';
    const run = grouped ? argv.slice(2) : argv;
    runs.push({ argv: run, grouped, locale: options?.env?.['LC_ALL'] });

    if (run[3] === 'devbox-let-up') order.push('let up');
    const answered = answer(run, held);

    if (answered !== undefined) return answered;

    if (run[3] === 'devbox-desktop') {
      const fresh = restarted;
      restarted = false;

      return ended(new TextEncoder().encode(fresh ? '1280 768\nfresh\n' : '1280 768\n'));
    }

    return run[3] === 'devbox-screenshot' || run[3] === 'devbox-watch' ? ended(PNG) : ended(new Uint8Array());
  });

  await box.devboxStartup();
  runs.length = 0;

  /** Once a run that `is` picks has started. */
  const started = async (is: (run: Run) => boolean): Promise<void> => {
    while (!runs.some(is)) await new Promise((resolve) => { setImmediate(resolve); });
  };

  return {
    box, runs, killed, started, order,
    /** The let-up's runs: what the box asked X to let up after a run that did not end cleanly. */
    letUps: () => runs.filter((run) => run.argv[3] === 'devbox-let-up').length,
    restartX: () => { restarted = true; },
    input: () => runs.filter((run) => run.argv[0] === 'xdotool').map((run) => run.argv.join(' ')),
  };
}

const look = (driver: string): DesktopRequest => ({ driver, action: { kind: 'screenshot' } });

const click = (driver: string, at: readonly [number, number] = [10, 20]): DesktopRequest => ({ driver, action: { kind: 'click', at, button: 'left', count: 1, hold: [] } });

describe("an agent's desktop action on the box", () => {
  test('runs after the desktop check, as one xdotool run in its own group on the screen, with nothing held after it', async () => {
    const { box, runs } = await desktopBox();

    await box.desktop(look('main'));

    expect(await box.desktop({ driver: 'main', action: { kind: 'click', at: [640, 92], button: 'right', count: 2, hold: ['ctrl', 'shift'] } })).toEqual({ kind: 'done' });
    expect(await box.desktop({ driver: 'main', action: { kind: 'scroll', at: [5, 6], dy: -3, dx: 2 } })).toEqual({ kind: 'done' });
    expect(await box.desktop({ driver: 'main', action: { kind: 'drag', from: [0, 0], to: [100, 50] } })).toEqual({ kind: 'done' });

    expect(runs.map((run) => (run.argv[3] === 'devbox-desktop' ? 'check' : run.argv.join(' ').replace(/^\/bin\/bash -c .* devbox-screenshot$/su, 'capture')))).toEqual([
      'check', 'capture',
      'check', 'xdotool keydown ctrl keydown shift mousemove 640 92 click --repeat 2 --delay 80 3 keyup ctrl keyup shift',
      'check', 'xdotool mousemove 5 6 click --repeat 3 --delay 20 4 click --repeat 2 --delay 20 7',
      'check', 'xdotool mousemove 0 0 mousedown 1 sleep 0.05 mousemove 50 25 sleep 0.05 mousemove 100 50 sleep 0.05 mouseup 1',
    ]);
    // Every run is in its own group, which its stop ends; a run that ended cleanly let up all it pressed itself.
    expect(runs.filter((run) => !run.grouped)).toEqual([]);
  });

  // 2026-10-14, a real box: under the C locale `xdotool type -- "aüb"` typed "a", then "Invalid multi-byte sequence".
  test('text is typed under a UTF-8 locale, so a character past ASCII reaches the screen', async () => {
    const { box, runs } = await desktopBox();

    await box.desktop(look('main'));
    await box.desktop({ driver: 'main', action: { kind: 'type', text: 'aüb' } });

    expect(runs.filter((run) => run.argv[1] === 'type').map((run) => [run.argv.at(-1), run.locale])).toEqual([['aüb', 'C.UTF-8']]);
  });

  test('a watch is one run that looks over its window, its sheet laid out by its frames, and it takes the screen as a look does', async () => {
    const { box, runs } = await desktopBox();

    expect(await box.desktop({ driver: 'main', action: { kind: 'watch', seconds: 3, frames: 4 } })).toMatchObject({ kind: 'screen', width: 1280, height: 768 });
    await box.desktop({ driver: 'main', action: { kind: 'watch', seconds: 2, frames: 8 } });
    expect(await box.desktop(click('main'))).toEqual({ kind: 'done' });

    expect(runs.filter((run) => run.argv[3] === 'devbox-watch').map((run) => [...run.argv.slice(4), run.grouped])).toEqual([
      ['3', '4', '50', '2', true], ['2', '8', '50', '4', true],
    ]);
  });

  test('a held key is pressed, held and let go in one run, and what X holds is let up when the run fails', async () => {
    const { box, input, letUps } = await desktopBox((run) => (run.includes('keydown') ? ended(new Uint8Array(), 1, 'killed') : undefined));

    await box.desktop(look('main'));

    await expect(box.desktop({ driver: 'main', action: { kind: 'key', keys: 'w', holdMs: 800 } })).rejects.toThrow('killed');
    expect([input(), letUps()]).toEqual([['xdotool keydown w sleep 0.8 keyup w'], 1]);
  });

  // scrot rings X's bell on every capture unless told not to, and the owner's desktop client plays each ring: an agent
  // looking at the screen was a chime per look in the owner's tab (staging, 2026-10-15).
  test('a look and every frame of a watch are captured silently, ringing no bell on the desktop', async () => {
    const { box, runs } = await desktopBox();

    await box.desktop(look('main'));
    await box.desktop({ driver: 'main', action: { kind: 'watch', seconds: 1, frames: 2 } });

    const captures = runs.filter((run) => run.argv[3] === 'devbox-screenshot' || run.argv[3] === 'devbox-watch').map((run) => run.argv[2] ?? '');

    expect(captures).toHaveLength(2);
    expect(captures.filter((program) => /scrot['", ]+-z/u.test(program))).toEqual(captures);
  });

  test('a screenshot is the PNG the box captured, byte for byte, with the size its header names', async () => {
    const { box } = await desktopBox();

    expect(await box.desktop(look('main'))).toEqual({ kind: 'screen', png: Buffer.from(PNG).toString('base64'), width: 1280, height: 768 });
  });

  test('a capture that is no PNG is a failure, never a screen', async () => {
    const { box } = await desktopBox((run) => (run[3] === 'devbox-screenshot' ? ended(new TextEncoder().encode('giblib error: Saving to file failed\n'.repeat(3))) : undefined));

    await expect(box.desktop(look('main'))).rejects.toThrow('the screenshot failed');
  });

  test('a point off the screen is refused before any input reaches it', async () => {
    const { box, input } = await desktopBox();

    await box.desktop(look('main'));

    expect(await box.desktop(click('main', [1280, 10]))).toEqual({ kind: 'refused', reason: 'off_screen', detail: '[1280, 10] is off the screen, which is 1280×768.' });
    expect(await box.desktop({ driver: 'main', action: { kind: 'drag', from: [1, 1], to: [5, 768] } })).toMatchObject({ kind: 'refused', reason: 'off_screen' });
    expect(input()).toEqual([]);
  });

  test('what a click holds is let up even when its run fails, and the failure is the answer', async () => {
    const { box, input, letUps } = await desktopBox((run) => (run.includes('click') ? ended(new Uint8Array(), 1, "Can't open display") : undefined));

    await box.desktop(look('main'));

    await expect(box.desktop({ driver: 'main', action: { kind: 'click', at: [1, 1], button: 'left', count: 1, hold: ['super'] } })).rejects.toThrow("Can't open display");
    expect([input(), letUps()]).toEqual([['xdotool keydown super mousemove 1 1 click --repeat 1 --delay 80 1 keyup super'], 1]);
  });

  test('a request the box cannot type or name is refused whole', async () => {
    const { box, input } = await desktopBox();

    await box.desktop(look('main'));

    await expect(box.desktop({ driver: 'main', action: { kind: 'type', text: 'line\nbreak' } })).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(box.desktop({ driver: 'main', action: { kind: 'key', keys: 'ctrl+-' } })).rejects.toMatchObject({ code: 'invalid-input' });
    expect(input()).toEqual([]);
  });
});

describe('a stopped desktop call', () => {
  // Any action that presses something can be cut between its press and its release: a chord, one click of three, one
  // character of a long text, a drag's button, a wheel's turn. Each, stopped mid-run, is let up after its run has gone.
  test.each<[string, DesktopRequest['action']]>([
    ['a held key', { kind: 'key', keys: 'w', holdMs: 10_000 }],
    ['a chord', { kind: 'key', keys: 'ctrl+shift+t' }],
    ['a triple click holding a modifier', { kind: 'click', at: [5, 5], button: 'left', count: 3, hold: ['shift'] }],
    ['a long text', { kind: 'type', text: 'a'.repeat(50) }],
    ['a drag', { kind: 'drag', from: [0, 0], to: [9, 9] }],
    ['a scroll', { kind: 'scroll', at: [5, 5], dy: 50, dx: 0 }],
  ])('%s, stopped mid-run, is ended, then what X holds is let up, and the call answers that it was stopped', async (_, action) => {
    const { box, killed, started, order, letUps } = await desktopBox((run, held) => (run[0] === 'xdotool' ? held() : undefined));

    await box.desktop(look('main'));
    const pressing = box.desktop({ driver: 'main', execId: 'press-1', action });

    await started((run) => run.argv[0] === 'xdotool');
    expect(await box.killExec('press-1')).toBe(true);
    await expect(pressing).rejects.toMatchObject({ code: 'cancelled' });

    // Its run was ended, and no other: a check that had ended is not ended again. Then, once it had gone, the let-up.
    expect([killed.length, order, letUps()]).toEqual([1, ['kill', 'let up'], 1]);
    // The desktop is the agent's again at once: its next look is answered.
    expect(await box.desktop(look('main'))).toMatchObject({ kind: 'screen' });
  });

  // 2026-10-14, a real box: a look stopped as it began left its desktop check owned by nobody, and the next look waited on
  // it for good (270 s, until the edge cancelled it).
  test('a call stopped at any point of its start leaves the desktop to the next call', async () => {
    const { box } = await desktopBox();

    for (let ticks = 0; ticks < 24; ticks += 1) {
      const execId = `early-${String(ticks)}`;
      const looking = box.desktop({ driver: 'main', execId, action: { kind: 'screenshot' } });

      for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
      await box.killExec(execId);

      // Stopped, or answered before the stop reached it.
      const [outcome] = await Promise.allSettled([looking]);

      expect(outcome?.status === 'fulfilled' ? outcome.value : outcome?.reason).toMatchObject(outcome?.status === 'fulfilled' ? { kind: 'screen' } : { code: 'cancelled' });

      // Answered at once, or this test's own bound fails it.
      expect(await box.desktop(look('main'))).toMatchObject({ kind: 'screen' });
    }
  });

  test('the call that started the desktop check, stopped, ends the check and answers once it has gone', async () => {
    const { box, input, killed, started } = await desktopBox((run, held) => (run[3] === 'devbox-desktop' ? held() : undefined));
    const waiting = box.desktop({ driver: 'main', execId: 'look-1', action: { kind: 'screenshot' } });

    await started((run) => run.argv[3] === 'devbox-desktop');
    expect(await box.killExec('look-1')).toBe(true);
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });

    // The check's own run was ended: the only process killed, since the call's own never started.
    expect([killed.length, input()]).toEqual([1, []]);
  });

  test('one waiting its turn behind another agent\'s action waits no longer, and sends nothing', async () => {
    const { box, input, started } = await desktopBox((run, held) => (run[3] === 'devbox-watch' ? held() : undefined));
    const watching = box.desktop({ driver: 'main', execId: 'watch-1', action: { kind: 'watch', seconds: 10, frames: 4 } });

    await started((run) => run.argv[3] === 'devbox-watch');
    const queued = box.desktop({ driver: 'main', execId: 'look-2', action: { kind: 'screenshot' } });

    expect(await box.killExec('look-2')).toBe(true);
    await expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    expect(await box.killExec('watch-1')).toBe(true);
    await expect(watching).rejects.toMatchObject({ code: 'cancelled' });
    expect(input()).toEqual([]);
  });
});

describe('one agent drives the desktop at a time', () => {
  test('input is taken only from the agent that looked; another may look, and takes the screen by looking once it is let go', async () => {
    const { box, input } = await desktopBox();

    await box.desktop(look('main'));
    expect(await box.desktop(click('main'))).toEqual({ kind: 'done' });

    expect(await box.desktop(look('helper'))).toMatchObject({ kind: 'screen' });
    expect(await box.desktop(click('helper'))).toMatchObject({ kind: 'refused', reason: 'driven' });

    // Its driver's turns ended: the screen is free, and the helper must look before it acts.
    await box.releaseDesktop('main');
    expect(await box.desktop(click('helper'))).toMatchObject({ kind: 'refused', reason: 'look_first' });
    await box.desktop(look('helper'));
    expect(await box.desktop(click('helper'))).toEqual({ kind: 'done' });

    // The first driver's next input would land on a screen another agent changed; letting go of a screen it does not
    // hold frees nothing.
    await box.releaseDesktop('main');
    expect(await box.desktop(click('main'))).toMatchObject({ kind: 'refused', reason: 'driven' });

    expect(input()).toHaveLength(2);
  });

  test('a screen X started afresh is nobody\'s: the agent that drove the old one looks again before it acts', async () => {
    const { box, restartX } = await desktopBox();

    await box.desktop(look('main'));
    restartX();

    expect(await box.desktop(click('main'))).toMatchObject({ kind: 'refused', reason: 'look_first' });
    await box.desktop(look('main'));
    expect(await box.desktop(click('main'))).toEqual({ kind: 'done' });
  });
});
