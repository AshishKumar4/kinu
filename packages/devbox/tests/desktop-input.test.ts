// D89: the box's end of an agent's desktop action. The desktop check, X's input and the capture are the container's,
// faked at its exec: what is proved here is what the box sends, in what order, and what it refuses before sending
// anything. A real container's desktop is held to the same actions by gate:devbox-e2e's desktop contracts.
import { TestDevbox } from './support/test-devbox';
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';

import { harness } from './support/devbox-harness';
import type { DesktopRequest } from '../src/desktop-input';

/** The lease the box keeps a driver's screen for (D89): 30 s after its last call. */
const DESKTOP_LEASE_MS = 30_000;

class DesktopBox extends TestDevbox<unknown> {

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}

/** A PNG header for a 1280×768 image, and a byte that is not valid UTF-8, so a text decode would show. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0, 0, 0, 3, 0, 0xff]);

/** One process that has ended with these bytes. */
function ended(stdout: Uint8Array, exitCode = 0, stderr = ''): ExecProcess {
  const bytes = (data: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close(); } });
  const err = new TextEncoder().encode(stderr);

  return {
    pid: 1, isPty: false, stdin: null, stdout: bytes(stdout), stderr: bytes(err), exitCode: Promise.resolve(exitCode),
    kill() { /* already ended */ }, resize() { throw new Error('this process has no PTY'); },
    output: async () => ({ stdout: stdout.slice().buffer, stderr: err.slice().buffer, exitCode }),
  };
}

/** A box whose container answers the desktop check, X's input and the capture; each run is recorded with its options. */
async function desktopBox(answer: (argv: readonly string[]) => ExecProcess | undefined = () => undefined) {
  const runs: Array<{ readonly argv: readonly string[]; readonly bounded: boolean; readonly locale: string | undefined }> = [];
  // The next check finds X gone and starts it: the screen is a new one.
  let restarted = false;

  const { box } = harness(DesktopBox, undefined, async (argv, options) => {
    runs.push({ argv, bounded: options?.signal !== undefined, locale: options?.env?.['LC_ALL'] });

    if (argv[3] === 'devbox-desktop') {
      const fresh = restarted;
      restarted = false;

      return ended(new TextEncoder().encode(fresh ? '1280 768\nfresh\n' : '1280 768\n'));
    }

    return answer(argv) ?? (argv[3] === 'devbox-screenshot' ? ended(PNG) : ended(new Uint8Array()));
  });

  await box.devboxStartup();
  runs.length = 0;

  return {
    box, runs,
    restartX: () => { restarted = true; },
    input: () => runs.filter((run) => run.argv[0] === 'xdotool').map((run) => run.argv.join(' ')),
  };
}

const look = (driver: string): DesktopRequest => ({ driver, action: { kind: 'screenshot' } });

const click = (driver: string, at: readonly [number, number] = [10, 20]): DesktopRequest => ({ driver, action: { kind: 'click', at, button: 'left', count: 1, hold: [] } });

afterEach(() => { setSystemTime(); });

describe("an agent's desktop action on the box", () => {
  test('runs after the desktop check, as one bounded xdotool run on the screen, with nothing held after it', async () => {
    const { box, runs } = await desktopBox();

    await box.desktop(look('main'));

    expect(await box.desktop({ driver: 'main', action: { kind: 'click', at: [640, 92], button: 'right', count: 2, hold: ['ctrl', 'shift'] } })).toEqual({ kind: 'done' });
    expect(await box.desktop({ driver: 'main', action: { kind: 'scroll', at: [5, 6], dy: -3, dx: 2 } })).toEqual({ kind: 'done' });
    expect(await box.desktop({ driver: 'main', action: { kind: 'drag', from: [0, 0], to: [100, 50] } })).toEqual({ kind: 'done' });

    expect(runs.map((run) => (run.argv[3] === 'devbox-desktop' ? 'check' : run.argv.join(' ').replace(/^\/bin\/bash -c .* devbox-screenshot$/su, 'capture')))).toEqual([
      'check', 'capture',
      'check', 'xdotool keydown ctrl keydown shift mousemove 640 92 click --repeat 2 --delay 80 3 keyup ctrl keyup shift',
      'xdotool keyup ctrl keyup shift',
      'check', 'xdotool mousemove 5 6 click --repeat 3 --delay 20 4 click --repeat 2 --delay 20 7',
      'check', 'xdotool mousemove 0 0 mousedown 1 sleep 0.05 mousemove 50 25 sleep 0.05 mousemove 100 50 sleep 0.05 mouseup 1',
      'xdotool mouseup 1',
    ]);
    // Every run is bounded: none can hold the calls behind it, or the box's rest.
    expect(runs.filter((run) => !run.bounded)).toEqual([]);
  });

  // 2026-10-14, a real box: under the C locale `xdotool type -- "aüb"` typed "a", then "Invalid multi-byte sequence".
  test('text is typed under a UTF-8 locale, so a character past ASCII reaches the screen', async () => {
    const { box, runs } = await desktopBox();

    await box.desktop(look('main'));
    await box.desktop({ driver: 'main', action: { kind: 'type', text: 'aüb' } });

    expect(runs.filter((run) => run.argv[1] === 'type').map((run) => [run.argv.at(-1), run.locale])).toEqual([['aüb', 'C.UTF-8']]);
  });

  test('a screenshot is the PNG the box captured, byte for byte, with the size its header names', async () => {
    const { box } = await desktopBox();

    expect(await box.desktop(look('main'))).toEqual({ kind: 'screen', png: Buffer.from(PNG).toString('base64'), width: 1280, height: 768 });
  });

  test('a capture that is no PNG is a failure, never a screen', async () => {
    const { box } = await desktopBox((argv) => (argv[3] === 'devbox-screenshot' ? ended(new TextEncoder().encode('giblib error: Saving to file failed\n'.repeat(3))) : undefined));

    await expect(box.desktop(look('main'))).rejects.toThrow('the screenshot failed');
  });

  test('a point off the screen is refused before any input reaches it', async () => {
    const { box, input } = await desktopBox();

    await box.desktop(look('main'));

    expect(await box.desktop(click('main', [1280, 10]))).toEqual({ kind: 'refused', reason: 'off_screen', detail: '[1280, 10] is off the screen, which is 1280×768.' });
    expect(await box.desktop({ driver: 'main', action: { kind: 'drag', from: [1, 1], to: [5, 768] } })).toMatchObject({ kind: 'refused', reason: 'off_screen' });
    expect(input()).toEqual([]);
  });

  test('what a click holds is released even when its run fails, and the failure is the answer', async () => {
    const { box, input } = await desktopBox((argv) => (argv.includes('click') ? ended(new Uint8Array(), 1, "Can't open display") : undefined));

    await box.desktop(look('main'));

    await expect(box.desktop({ driver: 'main', action: { kind: 'click', at: [1, 1], button: 'left', count: 1, hold: ['super'] } })).rejects.toThrow("Can't open display");
    expect(input()).toEqual(['xdotool keydown super mousemove 1 1 click --repeat 1 --delay 80 1 keyup super', 'xdotool keyup super']);
  });

  test('a request the box cannot type or name is refused whole', async () => {
    const { box, input } = await desktopBox();

    await box.desktop(look('main'));

    await expect(box.desktop({ driver: 'main', action: { kind: 'type', text: 'line\nbreak' } })).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(box.desktop({ driver: 'main', action: { kind: 'key', keys: 'ctrl+-' } })).rejects.toMatchObject({ code: 'invalid-input' });
    expect(input()).toEqual([]);
  });
});

describe('one agent drives the desktop at a time', () => {
  test('input is taken only from the agent that looked; another may look, and takes the screen by looking once it is free', async () => {
    const { box, input } = await desktopBox();

    setSystemTime(new Date('2026-10-14T00:00:00Z'));
    await box.desktop(look('main'));
    expect(await box.desktop(click('main'))).toEqual({ kind: 'done' });

    expect(await box.desktop(look('helper'))).toMatchObject({ kind: 'screen' });
    expect(await box.desktop(click('helper'))).toMatchObject({ kind: 'refused', reason: 'driven' });

    // The driver idle past its lease: the screen is free, and the helper must look before it acts.
    setSystemTime(new Date(Date.parse('2026-10-14T00:00:00Z') + DESKTOP_LEASE_MS + 1));
    expect(await box.desktop(click('helper'))).toMatchObject({ kind: 'refused', reason: 'look_first' });
    await box.desktop(look('helper'));
    expect(await box.desktop(click('helper'))).toEqual({ kind: 'done' });

    // The first driver's next input lands on a screen another agent changed: refused until it looks again.
    expect(await box.desktop(click('main'))).toMatchObject({ kind: 'refused', reason: 'driven' });
    setSystemTime(new Date(Date.parse('2026-10-14T00:00:00Z') + 2 * DESKTOP_LEASE_MS + 2));
    expect(await box.desktop(click('main'))).toMatchObject({ kind: 'refused', reason: 'look_first' });

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

  test('a driver keeps the screen while it thinks: its own input after a long pause is taken when nobody else looked', async () => {
    const { box } = await desktopBox();

    setSystemTime(new Date('2026-10-14T00:00:00Z'));
    await box.desktop(look('main'));
    setSystemTime(new Date(Date.parse('2026-10-14T00:00:00Z') + 5 * DESKTOP_LEASE_MS));

    expect(await box.desktop(click('main'))).toEqual({ kind: 'done' });
  });
});
