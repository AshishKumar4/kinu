// A container whose connection is lost (staging rc23, 2026-10-19; rc29, 2026-10-21): the box's request failed as an
// uncaught "Network connection lost.". workerd's fire-and-forget calls are tasks it adds and nobody awaits
// (`IoContext::addTask`): the kill, `ExecProcess.kill()` or aborting an exec's signal (`ExecProcess::sendKill`); a PTY's
// `ExecProcess.resize()`; and the end of the stdin of an exec given none (`Container::exec`). On a lost connection each
// fails, and `IoContext::taskFailed` logs it as an uncaught exception and marks the request's outcome an exception. So
// the box ends a process with an exec of its own, resizes a PTY with one, and owns every exec's stdin (`containerExec`).
import { afterEach, describe, expect, test } from 'bun:test';

import { nativeStartClock } from '../src/native-clock';
import { terminalSocket } from '../src/terminal';

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
 * every exec after it rejects, and every stdin a box closes after it refuses, all in the platform's words.
 */
function platform() {
  const platformKills: string[] = [];
  const uncaught: string[] = [];
  const execs: string[][] = [];
  const outputs: ReadableStreamDefaultController<Uint8Array>[] = [];
  const exits: ReturnType<typeof Promise.withResolvers<number>>[] = [];
  let lost = false;

  const container = {
    async exec(argv: string[], options: ContainerExecOptions = {}): Promise<ExecProcess> {
      execs.push(argv);

      // The stdin's end is added as the exec is sent, before its answer: a lost connection fails it either way.
      if (options.stdin === undefined && lost) uncaught.push(`stdin end of ${argv.join(' ')}`);

      if (lost) throw new Error(LOST);
      const pid = 4000 + execs.length;
      let exit: ReturnType<typeof Promise.withResolvers<number>> | undefined;

      // A rejection the box made and never read ends the test as an unhandled one, as workerd reports it.
      const exited = (): Promise<number> => {
        if (exit === undefined) {
          exit = Promise.withResolvers<number>();
          exits.push(exit);

          if (lost) exit.reject(new Error(LOST));
          // A command that only sets something, or ends something, exits as it runs.
          else if (argv[0] === 'stty' || argv[0] === 'kill') exit.resolve(0);
        }

        return exit.promise;
      };

      options.signal?.addEventListener('abort', () => { platformKills.push(`abort ${String(pid)}`); }, { once: true });
      const stdout = new ReadableStream<Uint8Array>({ start: (controller) => { outputs.push(controller); } });

      return {
        pid,
        isPty: options.pty !== undefined,
        stdin: new WritableStream<Uint8Array>({ close: () => { if (lost) throw new Error(LOST); } }),
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
    lose() {
      lost = true;

      for (const output of outputs) output.error(new Error(LOST));

      for (const exit of exits) exit.reject(new Error(LOST));
    },
  };
}

// Bun has no WebSocketPair: each terminal here is handed the fake ends, as the preview socket's test does.
afterEach(() => {
  Reflect.deleteProperty(globalThis, 'WebSocketPair');
});

/** A terminal socket on the fake platform: the browser's end, and the box's. */
async function openTerminal(container: ReturnType<typeof platform>['container']) {
  const ends: [FakeEnd, FakeEnd] = [fakeEnd(), fakeEnd()];

  Object.assign(globalThis, { WebSocketPair: function WebSocketPair() { return ends; } });
  const session = { id: 'sb0cf683013', name: 'shell', cwd: '/workspace' };

  await terminalSocket(container, new URLSearchParams({ cols: '45', rows: '46' }), session);

  return { browser: ends[0], box: ends[1] };
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

    expect({ uncaught: lane.uncaught, resized: lane.execs.find((argv) => argv[0] === 'stty'), closed: box.closedWith?.code })
      .toEqual({ uncaught: [], resized: ['stty', '-F', '/proc/4001/fd/0', 'cols', '120', 'rows', '40'], closed: 1011 });
  });

  test('a pane dragged through many sizes resizes its terminal to the last, never all of them at once', async () => {
    const lane = platform();
    const { box } = await openTerminal(lane.container);

    for (const cols of [90, 100, 110, 120]) box.fire('message', { data: JSON.stringify({ type: 'resize', cols, rows: 40 }) });
    await settled();

    expect(lane.execs.filter((argv) => argv[0] === 'stty').map((argv) => argv[4])).toEqual(['90', '120']);
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

  test('a restore clock cancelled before its deadline ends its sleep by an exec', async () => {
    const lane = platform();
    const cancel = nativeStartClock(lane.container).after(60_000, () => undefined);

    await settled();
    cancel();
    await settled();

    expect({ platformKills: lane.platformKills, ended: lane.execs.at(-1) }).toEqual({ platformKills: [], ended: ['kill', '-KILL', '4001'] });
  });
});
