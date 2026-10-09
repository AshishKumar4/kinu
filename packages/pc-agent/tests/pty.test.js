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

const { AwaitedList, awaitExit, runToExit } = require('@kinu.run/test-utils');

const { shellQuote } = require('@kinu.run/core');

const { createSessions, MAX_AXIS, TERMINAL_NAME, parseSessionName } = require('../src/pty.js');


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
  const recorded = new AwaitedList();
  const frames = recorded.items;
  const logged = [];
  const sessions = createSessions({ log: (...args) => logged.push(args), ...options });
  opened.push(sessions);

  const send = (frame) => {
    recorded.push(frame);

    return options.congested === true ? false : true;
  };

  const output = () => Buffer.concat(
    frames.filter((f) => f.type === 'PTY_OUT').map((f) => Buffer.from(f.data, 'base64')),
  ).toString('utf8');

  return { sessions, frames, logged, send, output, until: async (predicate) => {
    let found;
    await recorded.until(() => {
      found = predicate();

      return Boolean(found);
    });

    return found;
  } };
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
  await h.until(() => /(^|[^)*\s])42\b/m.test(h.output()));
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
    const painted = await h.until(() => /load average|%Cpu|Tasks:/.test(h.output()));
    expect(painted).toBe(true);
    expect(h.output()).toContain('\u001b[');
    process.stderr.write('PTY contract: top painted; sending Ctrl-C and awaiting PTY_EXIT\n');
    h.sessions.write('pane-1', Buffer.from('\u0003').toString('base64'));

    const exited = await h.until(() => h.frames.find((frame) => frame.type === 'PTY_EXIT' && frame.session === 'pane-1'));
    expect(exited.session).toBe('pane-1');
    expect(h.sessions.size()).toBe(0);

    // The other half of the claim, on the same machine, this second: the
    // daemon's one-shot path gives this program a pipe and it refuses.
    const withoutTerminal = await runToExit(['bash', '-c', 'exec top'], {
      env: shellEnv(),
    });

    expect(withoutTerminal.exitCode).toBe(1);
    expect(withoutTerminal.stderr).toContain('failed tty get');
  });

  test('the terminal is the shell\'s controlling terminal, so it has job control', async () => {
    const h = harness();
    h.sessions.open({ session: 'pane-jobs', cols: 80, rows: 24, argv: shellArgv(), env: { ...shellEnv(), LC_ALL: 'C' }, send: h.send });
    h.sessions.write('pane-jobs', Buffer.from('groups=$(ps -o pgid=,tpgid= -p $$); printf "\nJOB_CONTROL flags=%s groups=%s\n" "$-" "$groups"\r').toString('base64'));

    const answer = await h.until(() => /(?:^|\n)JOB_CONTROL flags=([a-zA-Z]+) groups=\s*(\d+)\s+(-?\d+)\r?(?:\n|$)/.exec(h.output())
      ?? h.frames.find((frame) => frame.type === 'PTY_EXIT'));

    if (!Array.isArray(answer)) throw new Error('the shell exited before answering its terminal-ownership query: ' + h.output());

    const [, flags, group, foreground] = answer;
    const facts = 'flags=' + flags + ', pgid=' + group + ', foreground=' + foreground;

    if (!flags.includes('m') || group !== foreground) throw new Error('Bun terminal spawn did not give bash job control and its controlling foreground group: ' + facts);
    process.stderr.write('PTY contract: bash owns the foreground; ' + facts + '\n');

    // A pending SIGCONT must survive the interval between READY and the blocking wait.
    const program = [
      'import signal',
      'signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGCONT})',
      'print(f"READY:{313 * 17}", flush=True)',
      'signal.sigwait({signal.SIGCONT})',
      'print(f"RESUMED:{313 * 17}", flush=True)',
    ].join('\n');

    h.sessions.write('pane-jobs', Buffer.from('python3 -c ' + shellQuote(program) + '\r').toString('base64'));
    await h.until(() => /(?:^|[\r\n])READY:5321(?=[\r\n]|$)/.test(Bun.stripANSI(h.output())));
    process.stderr.write('PTY contract: foreground program reported READY; sending Ctrl-Z\n');
    h.sessions.write('pane-jobs', Buffer.from('\u001a').toString('base64'));
    await h.until(() => /Stopped/.test(h.output()));
    process.stderr.write('PTY contract: bash reported Stopped; sending fg and awaiting the program\'s SIGCONT response\n');
    h.sessions.write('pane-jobs', Buffer.from('fg\r').toString('base64'));
    await h.until(() => /(?:^|[\r\n])RESUMED:5321(?=[\r\n]|$)/.test(Bun.stripANSI(h.output())));
  });

  test('a resize reaches the program on the terminal', async () => {
    const h = harness();
    h.sessions.open({ session: 'pane-size', cols: 80, rows: 24, argv: shellArgv(), env: shellEnv(), send: h.send });
    await ready(h, 'pane-size');

    h.sessions.write('pane-size', Buffer.from('stty size\r').toString('base64'));
    await h.until(() => /\b24 80\b/.test(h.output()));

    const resized = h.sessions.resize('pane-size', 133, 44);
    expect(resized).toEqual({ cols: 133, rows: 44 });
    h.sessions.write('pane-size', Buffer.from('stty size\r').toString('base64'));
    await h.until(() => /\b44 133\b/.test(h.output()));
  });

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
    await h.until(() => h.output().includes('waiting'));
    h.sessions.resize('pane-winch', 120, 40);
    await h.until(() => /\b40 120\b/.test(h.output()));
  });

  test('the program exits and the session reports its status once', async () => {
    const h = harness();
    h.sessions.open({
      session: 'pane-exit', cols: 80, rows: 24, argv: ['bash', '-c', 'exit 7'], env: shellEnv(), send: h.send,
    });
    await h.until(() => h.frames.some((f) => f.type === 'PTY_EXIT'));
    const exits = h.frames.filter((f) => f.type === 'PTY_EXIT');
    expect(exits).toHaveLength(1);
    expect(exits[0]).toEqual({ type: 'PTY_EXIT', session: 'pane-exit', exitCode: 7 });
    expect(h.sessions.has('pane-exit')).toBe(false);
    expect(h.sessions.size()).toBe(0);
  });

  test('closing a terminal hangs up the shell and everything it started', async () => {
    const h = harness();
    h.sessions.open({ session: 'pane-close', cols: 80, rows: 24, argv: shellArgv(), env: shellEnv(), send: h.send });
    await ready(h, 'pane-close');
    // A descendant that outlives its shell is what a group signal is for.
    h.sessions.write('pane-close', Buffer.from('sleep 600 & echo started $!\r').toString('base64'));
    const started = await h.until(() => /started (\d+)/.exec(h.output()));
    const descendant = Number(started[1]);

    const pid = h.sessions.pidOf('pane-close');
    h.sessions.close('pane-close');
    await h.until(() => h.frames.some((f) => f.type === 'PTY_EXIT'));
    expect(h.sessions.has('pane-close')).toBe(false);


    await awaitExit(pid);
    await awaitExit(descendant);
  });
});

describe('the session registry answers for what it holds', () => {
  const secondOpenRefusals = [
    { name: 'a second terminal cannot take a name that is in use', options: {}, second: 'pane-1', refusal: 'already open' },
    { name: 'the machine refuses more terminals than it holds', options: { maxSessions: 1 }, second: 'pane-2', refusal: 'holds 1 terminals already' },
  ];

  for (const refusal of secondOpenRefusals) {
    test(refusal.name, () => {
      const h = harness(refusal.options);
      h.sessions.open({ session: 'pane-1', cols: 80, rows: 24, argv: shellArgv(), env: shellEnv(), send: h.send });
      expect(() => h.sessions.open({
        session: refusal.second, cols: 80, rows: 24, argv: shellArgv(), env: shellEnv(), send: h.send,
      })).toThrow(refusal.refusal);
    });
  }

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

  test('the daemon and the hub bound the window at the same number', () => {
    // Two ends of one wire protocol, and the daemon cannot import the hub: it
    // ships standalone. So the agreement is asserted here rather than assumed,
    // and a change to either side that forgets the other fails this.
    const { DEVICE_PTY_MAX_AXIS } = require('@kinu.run/core');
    expect(MAX_AXIS).toBe(DEVICE_PTY_MAX_AXIS);
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
    await h.until(() => h.frames.some((f) => f.type === 'PTY_EXIT'));
    const discarded = h.logged.find((entry) => entry[0] === 'device.terminal_output_discarded');
    expect(discarded).toBeDefined();
    expect(discarded[1]).toBe('pane-loud');
    expect(discarded[2]).toBeGreaterThan(0);
  });

  test('closing every terminal is what a dropped socket does', async () => {
    const h = harness();
    h.sessions.open({ session: 'pane-1', cols: 80, rows: 24, argv: shellArgv(), env: shellEnv(), send: h.send });
    h.sessions.open({ session: 'pane-2', cols: 80, rows: 24, argv: shellArgv(), env: shellEnv(), send: h.send });
    expect(h.sessions.size()).toBe(2);
    expect(h.sessions.closeAll().sort()).toEqual(['pane-1', 'pane-2']);
    await h.until(() => h.frames.filter((frame) => frame.type === 'PTY_EXIT').length === 2);
    expect(h.sessions.size()).toBe(0);
  });
});

describe('an unsupported terminal runtime is refused', () => {

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
