// Kinu device terminal — one pseudo-terminal per session, on the daemon.
//
// Every other method this daemon answers is one request and one reply. A
// terminal is neither: bytes arrive from a program nobody asked, at a time
// nobody chose. So a session is state the daemon holds, and the socket carries
// four frames each way (open, input, resize, close) rather than a call.
//
// WHY the runtime's own terminal, and not `posix_openpt` through `bun:ffi`.
// The daemon runs on Kinu's approved Bun, and the launcher will not start it on
// anything older (`KINU_BUN_VERSION` is 1.4.0 and `kinu_bun_compatible` refuses
// a lower version — packages/cf-backend/src/cli/bun-runtime.ts). That Bun
// allocates the pty, gives the child its slave as stdin, stdout and stderr,
// hands bytes back through a callback, puts a new window size on the kernel,
// AND makes the pty the child's controlling terminal. Four raw libc calls would
// be more code to reach the same place, so the runtime does it.
//
// ONE DETAIL DECIDES ALL OF THAT, and it is not documented: the terminal must
// be passed to `spawn` as OPTIONS, never as a terminal built beforehand. Bun
// calls `setsid()` and `ioctl(TIOCSCTTY)` in the child only for a terminal it
// created as part of that spawn (`js_bun_spawn_bindings.rs` passes
// `pty_slave_fd` for a new terminal and -1 for an existing one; `bun-spawn.cpp`
// does both calls only when that fd is present). The created terminal comes
// back on the subprocess as `.terminal`.
//
// Measured on this machine, 2026-09-03, Bun 1.4.0, both ways:
//
//   passed as options            passed as an instance
//   tcgetpgrp answers            tcgetpgrp fails ENOTTY
//   /dev/tty opens               /dev/tty fails ENXIO
//   SIGWINCH arrives on resize   no SIGWINCH ever
//   ^C interrupts the program     ^C echoes and reaches nothing
//   ^Z, jobs, bg, fg all work    "bash: no job control in this shell"
//
// Both ways give a pty that carries bytes, so a test that only reads output
// passes on either. The tests that separate them are the ones about signals:
// tests/pty.test.js goes red on the instance form. `@cloudflare/sandbox` 0.12.8
// builds the terminal first and spawns against the instance
// (`sandbox-container/src/pty.ts`), which is why the container terminal has no
// job control and this one does.
//
// `name: 'xterm-256color'` names the terminal to the kernel and does NOT put
// `TERM` in the child's environment — measured, a child there reads
// `TERM=dumb`. The daemon carries `TERM` through the tier's own environment
// allow-list instead, so a full-screen program is told the truth.
'use strict';

/** What the child is looking at, and the terminal the browser half renders
 *  with. One name on both sides, or a full-screen program draws for a terminal
 *  nobody has. */
const TERMINAL_NAME = 'xterm-256color';

/**
 * How many terminals one machine holds at once.
 *
 * A terminal is something a person watches, and nobody watches eight. The cap
 * is not a demand model: it bounds what repeated `open` frames can do to the
 * machine, because each one is a shell.
 */
const MAX_SESSIONS = 8;

/**
 * The window, bounded. The kernel carries each axis as an `unsigned short`, and
 * a thousand cells on a side is past any real display, so anything larger is a
 * malformed frame rather than a window.
 */
const MAX_AXIS = 1000;

/** A session name is a map key and a word in this daemon's log lines. Bounded
 *  for both reasons; it never becomes a path. */
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function parseAxis(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_AXIS) {
    throw new Error(`terminal ${name} must be a whole number from 1 to ${MAX_AXIS}`);
  }
  return value;
}

/** A string, or the named expectation. The same shape as index.js's
 *  `parseString`, kept here because index.js requires this file. */
function parseText(value, expectation) {
  let text;
  try {
    text = String.prototype.valueOf.call(value);
  } catch (err) {
    if (err instanceof TypeError) throw new Error(expectation, { cause: err });
    throw err;
  }
  if (text !== value) throw new Error(expectation);
  return text;
}

const SESSION_NAME_RULE = 'terminal session names are up to 64 letters, digits, dashes or underscores';

function parseSessionName(value) {
  const name = parseText(value, SESSION_NAME_RULE);
  if (!SESSION_NAME.test(name)) throw new Error(SESSION_NAME_RULE);
  return name;
}

/**
 * Every process group in the session `leader` leads, the leader's own first.
 *
 * A terminal's shell is a session leader, and each job it starts becomes its
 * own process group inside that session. Signalling the session is how a close
 * reaches all of them; there is no one syscall for it, so the process table
 * answers.
 *
 * Linux reads `/proc`, where field 4 after the command name is the session id
 * (`proc(5)`) — the same file and the same offset arithmetic the command
 * supervisor already uses for a process group. macOS has no `/proc` and its
 * `ps` reports a session POINTER rather than a session id, which is not
 * comparable to a pid, so there the shell's own group is signalled and a
 * background job started from that terminal can outlive it. Stated rather than
 * hidden: this is measured on Linux and unmeasured on a Mac.
 */
function sessionGroups(leader, platform = process.platform) {
  const groups = [leader];
  if (platform !== 'linux') return groups;
  const fs = require('node:fs');
  for (const entry of fs.readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${entry.name}/stat`, 'utf8');
    } catch (err) {
      // A process that exited between the listing and this read is not in the
      // session any more, which is the answer this function wanted.
      if (!err || (err.code !== 'ENOENT' && err.code !== 'ESRCH')) throw err;
      continue;
    }
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (Number(fields[3]) !== leader) continue;
    const group = Number(fields[2]);
    if (group > 0 && !groups.includes(group)) groups.push(group);
  }
  return groups;
}


/**
 * The terminals this daemon holds.
 *
 * `spawn` is an argument so a test can read what was asked for without a
 * machine, and defaults to the runtime's own so production has one path.
 * `send` belongs to the SOCKET that opened the session: a terminal whose socket
 * is gone has nobody to draw for, which is why `closeAll` exists.
 */
function createSessions(options = {}) {
  const {
    spawn = (argv, spawnOptions) => Bun.spawn(argv, spawnOptions),
    log = () => {},
    maxSessions = MAX_SESSIONS,
  } = options;
  const sessions = new Map();

  /**
   * Open a terminal and run `argv` on it.
   *
   * `argv` is a plan this daemon already computed — the sandbox's argv for a
   * sandboxed device, a plain shell for a raw one — and this function decides
   * no part of it. `send` reports the session's own frames to the socket, and
   * answers false when the socket is too far behind to take more.
   */
  function open(request) {
    const name = parseSessionName(request.session);
    if (sessions.has(name)) throw new Error(`terminal ${name} is already open on this machine`);
    if (sessions.size >= maxSessions) {
      throw new Error(`this machine holds ${maxSessions} terminals already; close one before opening another`);
    }
    const cols = parseAxis(request.cols, 'width');
    const rows = parseAxis(request.rows, 'height');
    if (!Array.isArray(request.argv) || request.argv.length === 0) throw new Error('a terminal needs a program to run');
    const send = request.send;
    if (!(send instanceof Function)) throw new Error('a terminal needs a socket to report to');

    const record = { name, pid: 0, discardedBytes: 0, exited: false, terminal: undefined };

    let child;
    try {
      child = spawn(request.argv, {
        // OPTIONS, never a terminal built first: this is what makes the pty
        // the shell's controlling terminal. See the note at the top of this
        // file — the instance form silently costs every signal.
        terminal: {
          cols,
          rows,
          name: TERMINAL_NAME,
          data(_terminal, bytes) {
            // A terminal's newest bytes ARE its picture, so a congested socket
            // discards rather than queues: the count is logged when the
            // session ends, and the next full repaint restores the display.
            if (!send({ type: 'PTY_OUT', session: name, data: Buffer.from(bytes).toString('base64') })) {
              record.discardedBytes += bytes.length;
            }
          },
          exit(_terminal, code) {
            // The pty's own end of stream, not the program's exit status. The
            // program's status arrives on `child.exited` below, which is the
            // one this daemon reports.
            log('device.terminal_stream_closed', name, code);
          },
        },
        env: request.env,
        // No cwd: the plan puts the command where it belongs — `--chdir`
        // inside the sandbox, the shell's own default outside it — and a cwd
        // here would be a second answer to that question.
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
    } catch (err) {
      throw new Error('could not open a terminal on this machine', { cause: err });
    }
    const terminal = child.terminal;
    if (!terminal) {
      child.kill('SIGKILL');
      throw new Error('this runtime spawned no terminal for the session; Kinu needs a newer Bun');
    }
    record.terminal = terminal;
    record.pid = child.pid;
    sessions.set(name, record);

    /** @param {number} status */
    function reportExit(status) {
      if (record.exited) return;
      record.exited = true;
      sessions.delete(name);
      terminal.close();
      if (record.discardedBytes > 0) log('device.terminal_output_discarded', name, record.discardedBytes);
      send({ type: 'PTY_EXIT', session: name, exitCode: status });
    }
    /** @param {unknown} error */
    function reportExitFailure(error) {
      log('device.terminal_exit_unreadable', name, error);
    }
    child.exited.then(reportExit, reportExitFailure);

    return { pid: child.pid, cols, rows };
  }

  function held(name) {
    const record = sessions.get(parseSessionName(name));
    if (!record) throw new Error(`this machine holds no terminal called ${name}`);
    return record;
  }

  /** Keystrokes, as the browser sent them. Base64 because this socket carries
   *  JSON, and a keystroke is bytes rather than text — an arrow key is three
   *  bytes that are not a character. */
  function write(name, data) {
    const record = held(name);
    const bytes = Buffer.from(parseText(data, 'terminal input must be base64 text'), 'base64');
    record.terminal.write(bytes);
    return bytes.length;
  }

  /** A new window. The kernel signals the foreground program itself, which is
   *  what makes a full-screen program redraw. */
  function resize(name, cols, rows) {
    const record = held(name);
    const width = parseAxis(cols, 'width');
    const height = parseAxis(rows, 'height');
    record.terminal.resize(width, height);
    return { cols: width, rows: height };
  }

  /**
   * Close one terminal, and leave nothing running behind it.
   *
   * Closing the pty is what a person closing a terminal does, and the kernel
   * hangs up the terminal's FOREGROUND process group for us. That is not the
   * whole shell, and the difference is exactly what job control bought: a
   * background job gets a process group of its OWN, so one group signal
   * reaches the shell and not the `sleep` it started. A shell that hangs up
   * its own jobs is a shell option (`huponexit`) that is off by default, so it
   * cannot be relied on either.
   *
   * What every one of them shares is the SESSION, and the shell leads it. So
   * the close signals each process group in that session. A terminal on the
   * owner's machine must not leave work nothing can reach, which is the same
   * position `execCancel` takes for a command.
   */
  function close(name) {
    const record = held(name);
    record.terminal.close();
    for (const group of sessionGroups(record.pid)) {
      try {
        process.kill(-group, 'SIGHUP');
      } catch (err) {
        // Gone between the sweep and this signal: this function's own goal,
        // reached without it. Anything else is a fault to surface.
        if (!err || err.code !== 'ESRCH') throw new Error(`could not close terminal ${name}`, { cause: err });
      }
    }
    return { session: record.name };
  }

  /** Every terminal, because the socket that was watching them is gone. */
  function closeAll() {
    const closed = [];
    for (const name of sessions.keys()) {
      closed.push(name);
      try {
        close(name);
      } catch (err) {
        log('device.terminal_close_failed', name, err);
      }
    }
    return closed;
  }

  return {
    open,
    write,
    resize,
    close,
    closeAll,
    has(name) { return sessions.has(name); },
    pidOf(name) { return sessions.get(name)?.pid ?? 0; },
    size() { return sessions.size; },
  };
}

module.exports = {
  createSessions,
  MAX_SESSIONS,
  MAX_AXIS,
  TERMINAL_NAME,
  parseSessionName,
  parseAxis,
};
