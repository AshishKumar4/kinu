// A container whose connection is lost (staging rc23, 2026-10-19; rc29, 2026-10-21): the box's request failed as an
// uncaught "Network connection lost.". workerd's fire-and-forget calls are tasks it adds and nobody awaits
// (`IoContext::addTask`): the kill, `ExecProcess.kill()` or aborting an exec's signal (`ExecProcess::sendKill`); a PTY's
// `ExecProcess.resize()`; and the end of the stdin of an exec given none (`Container::exec`). On a lost connection each
// fails, and `IoContext::taskFailed` logs it as an uncaught exception and marks the request's outcome an exception. So
// the box ends a process with an exec of its own, resizes a PTY with one, and owns every exec's stdin (`containerExec`).
import { describe, expect, test } from 'bun:test';

import { Files } from '@cloudflare/sandbox';
import { DevboxError } from '../src/errors';
import { nativeStartClock } from '../src/native-clock';
import { containerExec, seamedContainer } from '../src/processes';
import { attachTerminal } from '../src/terminal';
import { processResult } from './support/native-process';

const LOST = 'Network connection lost.';

/** What a socket end's listener is handed: a close's code and reason, or a message's data. */
interface FakeEvent {
  readonly code?: number;
  readonly reason?: string;
  readonly data?: string;
}

/** A socket end that records how it was closed. */
interface FakeEnd {
  binaryType: string;
  closedWith: { code: number; reason: string } | null;
  accept(): void;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code: number, reason: string): void;
  addEventListener(type: string, listener: (event: FakeEvent) => void): void;
  fire(type: string, event?: FakeEvent): void;
}

function fakeEnd(): FakeEnd {
  const listeners = new Map<string, ((event: FakeEvent) => void)[]>();

  return {
    binaryType: 'blob',
    closedWith: null,
    accept: () => undefined,
    send: () => undefined,
    close(code, reason) { this.closedWith ??= { code, reason }; },
    addEventListener(type, listener) { listeners.set(type, [...listeners.get(type) ?? [], listener]); },
    fire(type, event = {}) { for (const listener of listeners.get(type) ?? []) listener(event); },
  };
}

/**
 * The platform's container, as far as an exec goes: each exec answers a process whose kill, and whose signal's abort,
 * is a platform task — recorded in `platformKills`, as workerd would fail it on a lost connection. A PTY's resize, and
 * the end of the stdin of an exec given none, are platform tasks too: one that runs once the connection is lost is
 * recorded in `uncaught`, as workerd logs it. Its exit is made the first time it is read, as workerd makes it
 * (`ExecProcess::ensureExitCodePromise`). `lose()` loses the connection: every stream errors, every exit read rejects,
 * every exec after it rejects, and every stdin a box closes after it refuses, all in the platform's words. An output a
 * reader lets go is kept in `released`.
 */
function platform() {
  const platformKills: string[] = [];
  const uncaught: string[] = [];
  const execs: string[][] = [];
  const released: number[] = [];
  const outputs = new Map<number, ReadableStreamDefaultController<Uint8Array>>();
  const exits = new Map<number, ReturnType<typeof Promise.withResolvers<number>>>();
  const exitCodes = new Map<number, number>();
  let lost = false;
  let closeFault: Error | undefined;
  let held: Promise<void> | undefined;
  let clientGone = false;

  /** A command that only sets or ends something exits as it runs. A resize of a client that is gone fails: `stty` exits 1,
   *  and the box's resize script 3 (`resizePty`), each as it does on a real shell (`exec-seam.test.ts`). */
  const exitAtOnce = (argv: readonly string[]): number | undefined => {
    if (argv[0] === 'kill') return 0;

    if (argv[0] === 'stty') return clientGone ? 1 : 0;

    if (argv[3] === 'devbox-resize') return clientGone ? 3 : 0;

    return undefined;
  };

  const container = {
    async exec(argv: string[], options: ContainerExecOptions = {}): Promise<ExecProcess> {
      execs.push(argv);

      // The stdin's end is added as the exec is sent, before its answer: a lost connection fails it either way.
      if (options.stdin === undefined && lost) uncaught.push(`stdin end of ${argv.join(' ')}`);

      if (held !== undefined) await held;

      if (lost) throw new Error(LOST);
      const pid = 4000 + execs.length;
      const immediate = exitAtOnce(argv);

      // A rejection the box made and never read ends the test as an unhandled one, as workerd reports it.
      const exited = (): Promise<number> => {
        let exit = exits.get(pid);

        if (exit === undefined) {
          exit = Promise.withResolvers<number>();
          exits.set(pid, exit);
          const code = immediate ?? exitCodes.get(pid);

          if (lost) exit.reject(new Error(LOST));
          else if (code !== undefined) exit.resolve(code);
        }

        return exit.promise;
      };

      options.signal?.addEventListener('abort', () => { platformKills.push(`abort ${String(pid)}`); }, { once: true });

      const stdout = new ReadableStream<Uint8Array>({
        start: (controller) => { outputs.set(pid, controller); },
        cancel: () => { released.push(pid); },
      });

      const close = (): void => {
        const fault = closeFault;
        closeFault = undefined;

        if (fault !== undefined) throw fault;

        if (lost) throw new Error(LOST);
      };

      return {
        pid,
        isPty: options.pty !== undefined,
        stdin: new WritableStream<Uint8Array>({ close }),
        stdout,
        stderr: null,
        get exitCode() { return exited(); },
        output: async () => ({ stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0), exitCode: await exited() }),
        kill: (signo?: number) => { platformKills.push(`kill ${String(signo ?? 15)} ${String(pid)}`); },
        resize: () => { if (lost) uncaught.push(`resize ${String(pid)}`); },
      };
    },
  };

  return {
    container,
    platformKills,
    uncaught,
    execs,
    released,
    lose() {
      lost = true;

      for (const output of outputs.values()) output.error(new Error(LOST));

      for (const exit of exits.values()) exit.reject(new Error(LOST));
    },
    /** The next stdin a box closes refuses, in these words. */
    failNextClose(fault: Error) { closeFault = fault; },
    /** Holds every exec's answer until the returned release. */
    hold(): () => void {
      const release = Promise.withResolvers<void>();
      held = release.promise;

      return () => { held = undefined; release.resolve(); };
    },
    /** The terminal's client is gone: a resize finds no process. */
    goneClient() { clientGone = true; },
    /** `pid` ends: its output closes and it exits 0. */
    exit(pid: number) {
      exitCodes.set(pid, 0);
      outputs.get(pid)?.close();
      exits.get(pid)?.resolve(0);
    },
  };
}

/** A terminal socket on the fake platform: the browser's end, and the box's, its events handed to the PTY as the
 *  runtime hands a held socket's to its object (`webSocketMessage`, `webSocketClose`, `webSocketError`, D109). */
async function openTerminal(container: ReturnType<typeof platform>['container']) {
  const [browser, box]: [FakeEnd, FakeEnd] = [fakeEnd(), fakeEnd()];
  const session = { id: 'sb0cf683013', name: 'shell', cwd: '/workspace' };
  const events = await attachTerminal(container, new URLSearchParams({ cols: '45', rows: '46' }), session, box);

  box.addEventListener('message', (event) => { events.message(event.data ?? ''); });
  box.addEventListener('close', () => { events.close(); });
  box.addEventListener('error', () => { events.error(); });

  return { browser, box };
}

/** Each resize the box ran, as the pid, columns and rows it named (`resizePty`). */
function resizes(lane: ReturnType<typeof platform>): string[][] {
  return lane.execs.filter((argv) => argv[3] === 'devbox-resize').map((argv) => argv.slice(4));
}

/** Lets every queued callback, and the box's pumps, run. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
}

describe('a container whose connection is lost', () => {
  test('a terminal whose output fails as the connection goes ends its client by an exec, and hands the platform no kill', async () => {
    const lane = platform();
    const { box } = await openTerminal(lane.container);

    lane.lose();
    await settled();

    expect({ closed: box.closedWith, platformKills: lane.platformKills, uncaught: lane.uncaught, ended: lane.execs.at(-1) })
      .toEqual({ closed: { code: 1011, reason: 'terminal output failed' }, platformKills: [], uncaught: [], ended: ['kill', '-KILL', '4001'] });
  });

  // staging rc29, 2026-10-21: a pane's size, sent as it attached, reached a container whose connection was gone.
  test('a pane that resizes once the connection is lost fails its terminal as the box reads it, and leaves the platform no task', async () => {
    const lane = platform();
    const { box } = await openTerminal(lane.container);

    lane.lose();
    box.fire('message', { data: JSON.stringify({ type: 'resize', cols: 120, rows: 40 }) });
    await settled();

    expect({ uncaught: lane.uncaught, resized: resizes(lane), closed: box.closedWith?.code })
      .toEqual({ uncaught: [], resized: [['4001', '120', '40']], closed: 1011 });
  });

  test('a pane dragged through many sizes resizes its terminal to the last, never all of them at once', async () => {
    const lane = platform();
    const { box } = await openTerminal(lane.container);

    for (const cols of [90, 100, 110, 120]) box.fire('message', { data: JSON.stringify({ type: 'resize', cols, rows: 40 }) });
    await settled();

    expect(resizes(lane).map(([, cols]) => cols)).toEqual(['90', '120']);
  });

  // Review of 977bf090f: the pane sends its size as it attaches, and again whenever it is laid out.
  test('a pane that asks for the size its terminal has already runs no resize', async () => {
    const lane = platform();
    const { box } = await openTerminal(lane.container);

    box.fire('message', { data: JSON.stringify({ type: 'resize', cols: 45, rows: 46 }) });
    await settled();

    for (let asked = 0; asked < 2; asked += 1) box.fire('message', { data: JSON.stringify({ type: 'resize', cols: 90, rows: 46 }) });
    await settled();

    expect(resizes(lane)).toEqual([['4001', '90', '46']]);
  });

  // Review of 977bf090f: a person who types `exit` as the pane resizes; the client's terminal is gone before `stty` runs.
  test('a pane resized as its client exits ends its terminal as an exit does, never as a failure', async () => {
    const lane = platform();
    const { box } = await openTerminal(lane.container);

    lane.goneClient();
    box.fire('message', { data: JSON.stringify({ type: 'resize', cols: 120, rows: 40 }) });
    await settled();
    const resizing = box.closedWith;

    lane.exit(4001);
    await settled();

    expect({ resizing, closed: box.closedWith }).toEqual({ resizing: null, closed: { code: 1000, reason: 'terminal exited' } });
  });

  // Review of 977bf090f: the input's failure was caught before the listener's, which alone stops the read.
  test('a terminal whose input fails closes, and lets its output go', async () => {
    const lane = platform();
    const { box } = await openTerminal(lane.container);

    box.fire('message', { data: 'no resize' });
    await settled();

    expect({ closed: box.closedWith, released: lane.released }).toEqual({ closed: { code: 1011, reason: 'terminal input failed' }, released: [4001] });
  });

  test('a pane that closes ends its terminal client by an exec, never by the platform kill', async () => {
    const lane = platform();
    const { box } = await openTerminal(lane.container);

    box.fire('close', { code: 1001, reason: 'tab closed' });
    await settled();

    expect({ platformKills: lane.platformKills, ended: lane.execs.at(-1) }).toEqual({ platformKills: [], ended: ['kill', '-KILL', '4001'] });
  });

  test("a restore clock whose sleep loses its connection fires, and kills nothing the platform would have to", async () => {
    const lane = platform();
    const fired = Promise.withResolvers<void>();

    nativeStartClock(lane.container).after(60_000, () => { fired.resolve(); });
    await settled();
    lane.lose();
    await fired.promise;

    expect(lane.platformKills).toEqual([]);
  });

  // Review of 977bf090f: a cancel while the sleep's stdin was still closing left it running to its deadline.
  test('a restore clock cancelled while its sleep is still being answered ends that sleep by an exec once it answers', async () => {
    const lane = platform();
    const release = lane.hold();
    const cancel = nativeStartClock(lane.container).after(60_000, () => undefined);

    await settled();
    cancel();
    release();
    await settled();

    expect({ platformKills: lane.platformKills, ended: lane.execs.at(-1) }).toEqual({ platformKills: [], ended: ['kill', '-KILL', '4001'] });
  });

  test('a restore clock cancelled before its deadline ends its sleep by an exec', async () => {
    const lane = platform();
    const cancel = nativeStartClock(lane.container).after(60_000, () => undefined);

    await settled();
    cancel();
    await settled();

    expect({ platformKills: lane.platformKills, ended: lane.execs.at(-1) }).toEqual({ platformKills: [], ended: ['kill', '-KILL', '4001'] });
  });
});

// Reviews of 977bf090f: what the seam does with an exec's signal and stdin, and with a kill an SDK client makes.
describe("the seam's own exec", () => {
  test("an exec's signal, aborted once the exec has answered, reaches neither the platform nor the process its caller owns", async () => {
    const lane = platform();
    const aborting = new AbortController();

    await containerExec(lane.container, ['sleep', '9'], { signal: aborting.signal });
    aborting.abort();
    await settled();

    expect({ platformKills: lane.platformKills, execs: lane.execs }).toEqual({ platformKills: [], execs: [['sleep', '9']] });
  });

  test('an exec whose signal aborts while its stdin closes fails as cancelled, and is ended by an exec', async () => {
    const lane = platform();
    const aborting = new AbortController();

    const container = {
      exec: async (argv: string[], options?: ContainerExecOptions): Promise<ExecProcess> => {
        const process = await lane.container.exec(argv, options);
        const stdin = new WritableStream<Uint8Array>({ close: () => { aborting.abort(); } });

        return argv[0] === 'kill' ? process : { ...process, stdin };
      },
    };

    const [ran] = await Promise.allSettled([containerExec(container, ['sleep', '9'], { signal: aborting.signal })]);

    await settled();

    expect({ code: ran?.status === 'rejected' && ran.reason instanceof DevboxError ? ran.reason.code : 'ran', platformKills: lane.platformKills, ended: lane.execs.at(-1) })
      .toEqual({ code: 'cancelled', platformKills: [], ended: ['kill', '-KILL', '4001'] });
  });

  test('an exec whose signal aborts before it answers fails as cancelled, and is ended by an exec once it answers', async () => {
    const lane = platform();
    const release = lane.hold();
    const aborting = new AbortController();
    const running = Promise.allSettled([containerExec(lane.container, ['sleep', '9'], { signal: aborting.signal })]);

    await settled();
    aborting.abort();
    const [ran] = await running;

    release();
    await settled();

    expect({ code: ran?.status === 'rejected' && ran.reason instanceof DevboxError ? ran.reason.code : 'ran', platformKills: lane.platformKills, ended: lane.execs.at(-1) })
      .toEqual({ code: 'cancelled', platformKills: [], ended: ['kill', '-KILL', '4001'] });
  });

  test('an exec whose stdin will not close fails, and is ended by an exec', async () => {
    const lane = platform();

    lane.failNextClose(new Error('the stdin would not close'));
    const [ran] = await Promise.allSettled([containerExec(lane.container, ['sleep', '9'])]);

    await settled();

    expect({ failed: ran?.status === 'rejected' ? String(ran.reason) : 'ran', ended: lane.execs.at(-1), platformKills: lane.platformKills })
      .toEqual({ failed: expect.stringContaining('closing the stdin of sleep'), ended: ['kill', '-KILL', '4001'], platformKills: [] });
  });

  test('an exec the platform answers with no stdin fails, and sends nothing after it', async () => {
    const execs: string[][] = [];

    const container = {
      exec: async (argv: string[]): Promise<ExecProcess> => {
        execs.push(argv);

        return { ...processResult(Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }), 7), stdin: null };
      },
    };

    const [ran] = await Promise.allSettled([containerExec(container, ['true'])]);

    expect({ failed: ran?.status === 'rejected' ? String(ran.reason) : 'ran', execs }).toEqual({ failed: expect.stringContaining('gave true no stdin to close'), execs: [['true']] });
  });

  // The SDK's shim session kills its process with `kill(9)` when a stream fails (`ShimSession.terminate`).
  test("an SDK client's kill, as its stream fails with the connection, is an exec, never the platform's", async () => {
    const lane = platform();
    const stat = Promise.allSettled([new Files(seamedContainer(lane.container)).stat('/workspace/a')]);

    await settled();
    lane.lose();
    await stat;
    await settled();

    expect({ platformKills: lane.platformKills, uncaught: lane.uncaught, ended: lane.execs.at(-1) })
      .toEqual({ platformKills: [], uncaught: [], ended: ['kill', '-KILL', '4001'] });
  });

  test('an SDK client that hands the seam a stream for its stdin is refused before anything runs', async () => {
    const lane = platform();
    const [ran] = await Promise.allSettled([seamedContainer(lane.container).exec(['cat'], { stdin: new ReadableStream<Uint8Array>() })]);

    expect({ refused: ran?.status === 'rejected' ? String(ran.reason) : 'ran', execs: lane.execs }).toEqual({ refused: expect.stringContaining('a stream for its stdin'), execs: [] });
  });
});

