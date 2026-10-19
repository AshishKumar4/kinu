// Kinu device terminal — one pseudo-terminal per session, on the daemon.
//
// Every other method this daemon answers is one request and one reply. A
// terminal is neither: bytes arrive from a program nobody asked, at a time
// nobody chose. So a session is state the daemon holds, and the socket carries
// frames each way (open, input, resize, detach, output, exit) rather than a call.
// A session outlives the pane showing it (1014-t): detached, it keeps running
// and keeps its newest output, which the next pane to attach is shown first.
//
// WHY the runtime's own terminal, and not `posix_openpt` through `bun:ffi`.
// The daemon runs on Kinu's approved Bun: one started on anything older moves
// itself onto it before it serves (`startOnApprovedBun` in index.js, `KINU_BUN_VERSION` in
// packages/core/src/cli/bun-runtime.ts). That Bun
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

const FRAMES = require('./device-protocol.json').frames;

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

/** The window, bounded per axis: the protocol's `ptyMaxAxis`, the hub's bound too. */
const MAX_AXIS = require('./device-protocol.json').ptyMaxAxis;

/** The newest output a session keeps for the next pane to attach: the hub holds as much before a pane attaches, so
 *  what it is shown arrives whole. */
const RETAINED_BYTES = 64 * 1024;

/** What holds a terminal's foreground while nothing the person started runs: the shell at its prompt, or the
 *  sandbox's launcher before it. */
const IDLE_FOREGROUND = new Set(['bash', 'zsh', 'sh', 'dash', 'fish', 'ksh', 'bwrap', 'sandbox-exec']);

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
 * One /proc reader for the daemon, its standalone command supervisor (which embeds this function's source) and the
 * repository's runners. It lives here, in a module every installed updater already lands, so a successor daemon never
 * requires a file an older updater does not copy.
 * @param {typeof import('node:fs')} fs
 */
function createProcReader(fs) {
  /** @param {Error} error */
  function procEntryGone(error) {
    return 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH');
  }

  /** @param {number | string} pid @param {string} name @param {boolean} required */
  function procFile(pid, name, required = false) {
    try {
      return fs.readFileSync(`/proc/${pid}/${name}`, 'utf8');
    } catch (error) {
      if (!required && error instanceof Error && procEntryGone(error)) return undefined;
      throw error;
    }
  }

  /** The command name can contain spaces, parentheses and newlines; only its final closing parenthesis separates fields.
   * @param {string} text
   */
  function parseProcStat(text) {
    const end = text.lastIndexOf(')');
    const fields = text.slice(end + 2).trim().split(/\s+/);

    return {
      comm: text.slice(text.indexOf('(') + 1, end),
      state: fields[0] ?? '',
      ppid: Number(fields[1]),
      group: Number(fields[2]),
      session: Number(fields[3]),
      cpuTicks: Number(fields[11]) + Number(fields[12]) + Number(fields[13]) + Number(fields[14]),
      tasks: Number(fields[17]),
      startTicks: fields[19] ?? '',
      foreground: Number(fields[5]),
    };
  }

  /** @param {number | string} pid @param {string} name @param {boolean} required */
  function procStat(pid, name = 'stat', required = false) {
    const text = procFile(pid, name, required);

    return text === undefined ? undefined : parseProcStat(text);
  }

  /** Whether a process of `group` still runs, a zombie not counting; off Linux, `ps` is asked through `listProcesses`.
   * @param {number} group @param {(args: string[]) => Promise<string>} listProcesses
   */
  async function groupHasLiveProcess(group, listProcesses) {
    if (process.platform === 'linux') {
      for (const entry of fs.readdirSync('/proc', { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;

        // An entry gone since the listing reads as undefined; any other failure is the reader's.
        const stat = procStat(entry.name);

        if (stat !== undefined && stat.group === group && stat.state !== 'Z') return true;
      }

      return false;
    }

    const rows = (await listProcesses(['-ax', '-o', 'pid=,pgid=,stat='])).trim().split('\n');

    return rows.some((row) => {
      const [pid, pgid, stat] = row.trim().split(/\s+/, 3);

      return Number(pid) > 0 && Number(pgid) === group && stat !== undefined && !stat.startsWith('Z');
    });
  }

  return { procEntryGone, procFile, procStat, parseProcStat, groupHasLiveProcess };
}

const { procEntryGone, procFile, procStat, parseProcStat, groupHasLiveProcess } = createProcReader(require('node:fs'));

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
    const stat = procStat(entry.name);

    if (stat === undefined || stat.session !== leader) continue;
    const group = stat.group;

    if (group > 0 && !groups.includes(group)) groups.push(group);
  }

  return groups;
}


/**
 * The terminals this daemon holds.
 *
 * `spawn` is an argument so a test can read what was asked for without a
 * machine, and defaults to the runtime's own so production has one path.
 * `send` belongs to the pane watching the session: a session with no pane keeps
 * running, keeps its newest output, and sends nothing until one attaches.
 * `closeAll` ends them all, for a daemon that is itself ending.
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

    const record = {
      name, pid: 0, discardedBytes: 0, exited: false, terminal: undefined, ended: null, send, retained: [], retainedBytes: 0, plan: request.plan,
    };

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
            retain(record, Buffer.from(bytes));

            // A terminal's newest bytes ARE its picture, so a congested socket
            // discards rather than queues: the count is logged when the
            // session ends, and the next full repaint restores the display.
            if (record.send !== null && !record.send({ type: FRAMES.ptyOutput, session: name, data: Buffer.from(bytes).toString('base64') })) {
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
        // The plan's own answer (`spawnCwd`), as a command's supervisor takes
        // it: the raw tier's folder, and the sandbox launcher's, which then
        // `--chdir`s the shell inside.
        cwd: request.cwd,
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
    record.ended = child.exited;
    sessions.set(name, record);

    /** @param {number} status */
    function reportExit(status) {
      if (record.exited) return;
      record.exited = true;
      sessions.delete(name);
      terminal.close();

      if (record.discardedBytes > 0) log('device.terminal_output_discarded', name, record.discardedBytes);
      record.send?.({ type: FRAMES.ptyExit, session: name, exitCode: status });
    }

    /** @param {unknown} error */
    function reportExitFailure(error) {
      log('device.terminal_exit_unreadable', name, error);
    }

    child.exited.then(reportExit, reportExitFailure);

    return { pid: child.pid, cols, rows };
  }

  /** The newest output, oldest first, a whole chunk at a time. */
  function retain(record, bytes) {
    record.retained.push(bytes);
    record.retainedBytes += bytes.length;

    while (record.retainedBytes > RETAINED_BYTES && record.retained.length > 1) record.retainedBytes -= record.retained.shift().length;
  }

  /** A pane attaches: the session reports to it from now on, and it is shown what the session kept. */
  function attach(name, send) {
    if (!(send instanceof Function)) throw new Error('a terminal needs a socket to report to');
    const record = held(name);

    record.send = send;

    return { pid: record.pid, plan: record.plan, retained: Buffer.concat(record.retained) };
  }

  /** The program in the session's foreground, by its name, where /proc says: null while the shell waits at its
   *  prompt, and off Linux. */
  function running(name) {
    const record = sessions.get(name);

    if (!record || process.platform !== 'linux') return null;
    const group = procStat(record.pid)?.foreground ?? 0;
    const comm = group > 0 ? procStat(group)?.comm : undefined;

    return comm === undefined || IDLE_FOREGROUND.has(comm) ? null : comm;
  }

  /** The pane went away: the session keeps running and keeps its output for the next one. */
  function detach(name) {
    const record = sessions.get(parseSessionName(name));

    if (record) record.send = null;
  }

  /** Every pane went away with the socket that carried them. */
  function detachAll() {
    for (const record of sessions.values()) record.send = null;

    return [...sessions.keys()];
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

  /** Job control gives each job its own group, so a stop must end the whole session. */
  function close(name) {
    const record = held(name);
    record.terminal.close();

    for (const group of sessionGroups(record.pid)) {
      try {
        process.kill(-group, 'SIGKILL');
      } catch (err) {
        // Gone between the sweep and this signal: this function's own goal,
        // reached without it. Anything else is a fault to surface.
        if (!err || err.code !== 'ESRCH') throw new Error(`could not close terminal ${name}`, { cause: err });
      }
    }

    return { session: record.name, ended: record.ended };
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
    attach,
    detach,
    detachAll,
    running,
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
  TERMINAL_NAME,
  parseSessionName,
  parseAxis,
  createProcReader,
  procEntryGone,
  procFile,
  procStat,
  parseProcStat,
  groupHasLiveProcess,
};
