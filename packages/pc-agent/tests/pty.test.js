/**
 * Device terminal — a REAL pseudo-terminal, driven end to end.
 *
 * Nothing here is a double. Each test opens a terminal on this machine, runs a
 * program on it, and reads the bytes that came back, because the property under
 * test is one no fake can hold: a program that refuses to run without a
 * terminal runs, `^C` reaches it, and a resize makes the kernel tell it.
 *
 * `top` is the witness. It exits 1 with `failed tty get` when its input is a
 * pipe, which is what the daemon's one-shot `exec` gives it, so the same
 * program passing here and failing there IS the capability this adds.
 */
'use strict';
const { afterEach, describe, expect, test } = require('bun:test');
const { createSessions, MAX_AXIS, TERMINAL_NAME, parseSessionName } = require('../src/pty.js');

/** Long enough for a shell to start, read a command and answer it on a loaded
 *  machine; short enough that a broken session fails a test rather than
 *  hanging it. Every wait below is for a CONDITION, never a fixed sleep, so a
 *  fast machine spends milliseconds here. */
const SETTLE_MS = 15_000;

/** The budget one test gets. Driving a shell is several round trips through a
 *  real terminal, and bun's own default is 5 s for a whole test. */
const TEST_MS = 60_000;

const opened = [];

afterEach(() => {
  while (opened.length > 0) {
    const sessions = opened.pop();
    // Every terminal this suite opened is a shell on the developer's machine.
    // Leaving one running would outlive the suite.
    sessions.closeAll();
  }
});

/**
 * A live session registry plus the frames it produced. `send` is the socket:
 * it records, and answers true, exactly as an uncongested socket does.
 */
function harness(options = {}) {
  const frames = [];
  const logged = [];
  const sessions = createSessions({ log: (...args) => logged.push(args), ...options });
  opened.push(sessions);
  const send = (frame) => {
    frames.push(frame);
    return options.congested === true ? false : true;
  };
  const output = () => Buffer.concat(
    frames.filter((f) => f.type === 'PTY_OUT').map((f) => Buffer.from(f.data, 'base64')),
  ).toString('utf8');
  return { sessions, frames, logged, send, output };
}

/** Wait until `predicate` holds, checking on the event loop rather than on a
 *  clock: the assertion that follows is then about a state that was reached. */
async function until(predicate, what, budgetMs = SETTLE_MS) {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - started > budgetMs) throw new Error(`${what} did not happen within ${budgetMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A shell on a terminal, as the daemon starts one for a device with no
 *  sandbox: the plan's own argv, and the terminal named in the environment. */
function shellArgv() {
  return ['bash', '-c', 'exec bash -i'];
}

function shellEnv() {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TERM: TERMINAL_NAME,
  };
}

/**
 * Wait until the shell is reading commands.
 *
 * The prompt cannot be the signal: this is the developer's own machine and
 * their `.bashrc` owns `PS1`. So the shell is asked to COMPUTE something — the
 * echo of the typed line contains the sum, and the shell's answer contains
 * only the total, which is a string the request itself never carries.
 */
async function ready(h, session) {
  h.sessions.write(session, Buffer.from('echo $((6 * 7))\r').toString('base64'));
  await until(() => /(^|[^)*\s])42\b/m.test(h.output()), 'the shell answered a command');
}

describe('a device terminal is a real one', () => {
  test('a full-screen program runs, and the same program cannot run without a terminal', async () => {
    const h = harness();
    const session = h.sessions.open({
      session: 'pane-1', cols: 100, rows: 30, argv: ['bash', '-c', 'exec top'], env: shellEnv(), send: h.send,
    });
    expect(session.pid).toBeGreaterThan(0);

    // top's own header. It draws this only after asking the terminal for its
    // size and putting the cursor somewhere, neither of which a pipe answers.
    const painted = await until(() => /load average|%Cpu|Tasks:/.test(h.output()), 'top painted its screen');
    expect(painted).toBe(true);
    expect(h.output()).toContain('\u001b[');

    // The other half of the claim, on the same machine, this second: the
    // daemon's one-shot path gives this program a pipe and it refuses.
    const withoutTerminal = Bun.spawnSync(['bash', '-c', 'exec top'], {
      env: shellEnv(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    expect(withoutTerminal.exitCode).toBe(1);
    expect(withoutTerminal.stderr.toString()).toContain('failed tty get');
  }, TEST_MS);

  test('the terminal is the shell\'s controlling terminal, so it has job control', async () => {
    const h = harness();
    h.sessions.open({ session: 'pane-jobs', cols: 80, rows: 24, argv: shellArgv(), env: shellEnv(), send: h.send });
    await ready(h, 'pane-jobs');

    h.sessions.write('pane-jobs', Buffer.from('sleep 300\r').toString('base64'));
    await until(() => h.output().includes('sleep 300'), 'the shell read the command');
    // ^Z. The kernel sends SIGTSTP to the terminal's foreground group, which
    // exists only because the leader claimed the terminal.
    h.sessions.write('pane-jobs', Buffer.from('\u001a').toString('base64'));
    await until(() => /Stopped|suspended/.test(h.output()), 'the job stopped');

    h.sessions.write('pane-jobs', Buffer.from('bg\r').toString('base64'));
    await until(() => /Running|\[1\]\+? sleep/.test(h.output()), 'the job resumed in the background');

    // ^C on the foreground shell leaves it alive and prompting, which is what
    // makes it a terminal rather than a pipe that dies.
    h.sessions.write('pane-jobs', Buffer.from('\u0003').toString('base64'));
    h.sessions.write('pane-jobs', Buffer.from('echo alive\r').toString('base64'));
    await until(() => h.output().includes('alive'), 'the shell survived the interrupt');

    // The negative direction, so this test cannot pass on a terminal that has
    // no controlling terminal: such a shell says so on the way up.
    expect(h.output()).not.toContain('no job control in this shell');
  }, TEST_MS);

  test('a resize reaches the program on the terminal', async () => {
    const h = harness();
    h.sessions.open({ session: 'pane-size', cols: 80, rows: 24, argv: shellArgv(), env: shellEnv(), send: h.send });
    await ready(h, 'pane-size');

    h.sessions.write('pane-size', Buffer.from('stty size\r').toString('base64'));
    await until(() => /\b24 80\b/.test(h.output()), 'the shell reported the opening window');

    const resized = h.sessions.resize('pane-size', 133, 44);
    expect(resized).toEqual({ cols: 133, rows: 44 });
    h.sessions.write('pane-size', Buffer.from('stty size\r').toString('base64'));
    await until(() => /\b44 133\b/.test(h.output()), 'the shell reported the new window');
  }, TEST_MS);

  test('a resize signals the running program, not only the next command', async () => {
    const h = harness();
    // A program waiting in the foreground. The trap proves the SIGNAL arrived:
    // a window the kernel recorded but never announced would leave a
    // full-screen program drawing at the old size. `wait` is the idiom that
    // shows it — bash defers a trap until the running builtin returns, and a
    // blocking `read` never returns, which says nothing about the signal.
    h.sessions.open({
      session: 'pane-winch',
      cols: 80,
      rows: 24,
      argv: ['bash', '-c', 'trap "stty size" WINCH; echo waiting; sleep 30 & wait'],
      env: shellEnv(),
      send: h.send,
    });
    await until(() => h.output().includes('waiting'), 'the program started waiting');
    h.sessions.resize('pane-winch', 120, 40);
    await until(() => /\b40 120\b/.test(h.output()), 'the program was told the window changed');
  }, TEST_MS);

  test('the program exits and the session reports its status once', async () => {
    const h = harness();
    h.sessions.open({
      session: 'pane-exit', cols: 80, rows: 24, argv: ['bash', '-c', 'exit 7'], env: shellEnv(), send: h.send,
    });
    await until(() => h.frames.some((f) => f.type === 'PTY_EXIT'), 'the session reported the exit');
    const exits = h.frames.filter((f) => f.type === 'PTY_EXIT');
    expect(exits).toHaveLength(1);
    expect(exits[0]).toEqual({ type: 'PTY_EXIT', session: 'pane-exit', exitCode: 7 });
    expect(h.sessions.has('pane-exit')).toBe(false);
    expect(h.sessions.size()).toBe(0);
  }, TEST_MS);

  test('closing a terminal hangs up the shell and everything it started', async () => {
    const h = harness();
    h.sessions.open({ session: 'pane-close', cols: 80, rows: 24, argv: shellArgv(), env: shellEnv(), send: h.send });
    await ready(h, 'pane-close');
    // A descendant that outlives its shell is what a group signal is for.
    h.sessions.write('pane-close', Buffer.from('sleep 600 & echo started $!\r').toString('base64'));
    const started = await until(() => /started (\d+)/.exec(h.output()), 'the shell started a background job');
    const descendant = Number(started[1]);

    const pid = h.sessions.pidOf('pane-close');
    h.sessions.close('pane-close');
    await until(() => h.frames.some((f) => f.type === 'PTY_EXIT'), 'the session reported the exit');
    expect(h.sessions.has('pane-close')).toBe(false);

    const gone = (candidate) => {
      try {
        process.kill(candidate, 0);
        return false;
      } catch (err) {
        if (err && err.code === 'ESRCH') return true;
        throw err;
      }
    };
    await until(() => gone(pid), 'the shell is gone');
    await until(() => gone(descendant), 'the background job is gone');
  }, TEST_MS);
});

describe('the session registry answers for what it holds', () => {
  test('a second terminal cannot take a name that is in use', async () => {
    const h = harness();
    h.sessions.open({ session: 'pane-1', cols: 80, rows: 24, argv: shellArgv(), env: shellEnv(), send: h.send });
    expect(() => h.sessions.open({
      session: 'pane-1', cols: 80, rows: 24, argv: shellArgv(), env: shellEnv(), send: h.send,
    })).toThrow('already open');
  });

  test('the machine refuses more terminals than it holds', async () => {
    const h = harness({ maxSessions: 1 });
    h.sessions.open({ session: 'pane-1', cols: 80, rows: 24, argv: shellArgv(), env: shellEnv(), send: h.send });
    expect(() => h.sessions.open({
      session: 'pane-2', cols: 80, rows: 24, argv: shellArgv(), env: shellEnv(), send: h.send,
    })).toThrow('holds 1 terminals already');
  });

  test('input, resize and close name the session they cannot find', () => {
    const h = harness();
    expect(() => h.sessions.write('pane-absent', '')).toThrow('holds no terminal called pane-absent');
    expect(() => h.sessions.resize('pane-absent', 80, 24)).toThrow('holds no terminal called pane-absent');
    expect(() => h.sessions.close('pane-absent')).toThrow('holds no terminal called pane-absent');
  });

  test('a window outside what the kernel carries is a malformed frame', () => {
    const h = harness();
    const open = (cols, rows) => () => h.sessions.open({
      session: 'pane-bad', cols, rows, argv: shellArgv(), env: shellEnv(), send: h.send,
    });
    expect(open(0, 24)).toThrow('width must be a whole number from 1 to 1000');
    expect(open(80, 0)).toThrow('height must be a whole number from 1 to 1000');
    expect(open(MAX_AXIS + 1, 24)).toThrow('width must be a whole number');
    expect(open(80.5, 24)).toThrow('width must be a whole number');
    expect(open('80', 24)).toThrow('width must be a whole number');
  });

  test('a session name is bounded, and never a path', () => {
    expect(parseSessionName('pane-1')).toBe('pane-1');
    expect(() => parseSessionName('../escape')).toThrow('terminal session names are up to 64');
    expect(() => parseSessionName('pane/1')).toThrow('terminal session names are up to 64');
    expect(() => parseSessionName('')).toThrow('terminal session names are up to 64');
    expect(() => parseSessionName('-leading')).toThrow('terminal session names are up to 64');
    expect(() => parseSessionName('x'.repeat(65))).toThrow('terminal session names are up to 64');
    expect(() => parseSessionName(undefined)).toThrow('terminal session names are up to 64');
  });

  test('a terminal with no socket to report to is refused', () => {
    const h = harness();
    expect(() => h.sessions.open({ session: 'pane-1', cols: 80, rows: 24, argv: shellArgv(), env: shellEnv() }))
      .toThrow('needs a socket to report to');
    expect(() => h.sessions.open({ session: 'pane-1', cols: 80, rows: 24, argv: [], env: shellEnv(), send: h.send }))
      .toThrow('needs a program to run');
  });

  test('a congested socket discards output and the daemon says how much', async () => {
    const h = harness({ congested: true });
    h.sessions.open({
      session: 'pane-loud',
      cols: 80,
      rows: 24,
      argv: ['bash', '-c', 'printf "x%.0s" $(seq 1 4096); exit 0'],
      env: shellEnv(),
      send: h.send,
    });
    await until(() => h.frames.some((f) => f.type === 'PTY_EXIT'), 'the program exited');
    const discarded = h.logged.find((entry) => entry[0] === 'device.terminal_output_discarded');
    expect(discarded).toBeDefined();
    expect(discarded[1]).toBe('pane-loud');
    expect(discarded[2]).toBeGreaterThan(0);
  }, TEST_MS);

  test('closing every terminal is what a dropped socket does', async () => {
    const h = harness();
    h.sessions.open({ session: 'pane-1', cols: 80, rows: 24, argv: shellArgv(), env: shellEnv(), send: h.send });
    h.sessions.open({ session: 'pane-2', cols: 80, rows: 24, argv: shellArgv(), env: shellEnv(), send: h.send });
    expect(h.sessions.size()).toBe(2);
    expect(h.sessions.closeAll().sort()).toEqual(['pane-1', 'pane-2']);
    await until(() => h.sessions.size() === 0, 'both terminals ended');
  }, TEST_MS);
});

describe('the terminal is asked for the way that gives it signals', () => {
  // The one detail this whole capability rests on, and the one a refactor can
  // undo without breaking a single output assertion: Bun claims the pty as the
  // shell's controlling terminal only for a terminal it creates during the
  // spawn. Handing it one built beforehand costs ^C, ^Z, fg, bg and SIGWINCH,
  // and costs them silently. The job-control test above goes red then; this
  // one names the reason, so a reader knows why the shape matters.
  test('the spawn creates the terminal, rather than receiving one', () => {
    const asked = [];
    const sessions = createSessions({
      spawn(argv, options) {
        asked.push({ argv, options });
        return { pid: 4242, terminal: { write() {}, resize() {}, close() {} }, exited: new Promise(() => {}), kill() {} };
      },
    });
    sessions.open({ session: 'pane-shape', cols: 80, rows: 24, argv: shellArgv(), env: shellEnv(), send: () => true });
    const { terminal } = asked[0].options;
    expect(terminal).not.toBeInstanceOf(Bun.Terminal);
    expect(terminal.cols).toBe(80);
    expect(terminal.rows).toBe(24);
    expect(terminal.name).toBe(TERMINAL_NAME);
    expect(terminal.data).toBeInstanceOf(Function);
  });

  test('a runtime that spawns no terminal is refused, not half-run', () => {
    const sessions = createSessions({
      spawn: () => ({ pid: 4242, exited: new Promise(() => {}), kill() {} }),
    });
    expect(() => sessions.open({
      session: 'pane-none', cols: 80, rows: 24, argv: shellArgv(), env: shellEnv(), send: () => true,
    })).toThrow('spawned no terminal');
    expect(sessions.size()).toBe(0);
  });
});
