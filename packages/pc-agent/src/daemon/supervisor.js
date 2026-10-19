// Kinu PC agent — the command supervisor: one detached process per device command, which outlives the daemon that
// started it, and the record beside it that a restarted daemon adopts.
//
//
// A request survives daemon restart in one direct child of this root. This is
// a same-principal coordination protocol, not an OS isolation boundary: the
// command runs as this user's uid and can interfere with any same-user process
// or file it can discover. State validation prevents malformed or stale records
// from being selected accidentally; it cannot defend against a malicious
// same-user command that already has equivalent local authority.
'use strict';

const fs = require('node:fs');

const path = require('node:path');

const os = require('node:os');

const { spawn } = require('node:child_process');

const sandbox = require('../sandbox.js');

const { createProcReader, procStat, procEntryGone, groupHasLiveProcess } = require('../pty.js');

const { runToExit } = require('../update.js');

const { errorDetail } = require('./log.js');

const { heldModule } = require('./held.js');

const { elidedOutput } = require('../../../core/src/execution/bounded-output.ts');

/** Each exec stream stays far below the Worker WebSocket's documented 32 MiB
 * receive ceiling even after worst-case JSON escaping. The daemon drains bytes
 * past the cap without retaining them, so a noisy process cannot grow its heap. */
const EXEC_STREAM_MAX_BYTES = 512 * 1024;

const REQUEST_ID = /^rpc-[A-Za-z0-9_-]{10}-[1-9]\d*$/;

/** The descriptor a supervised command's sandbox reports its status on (bwrap's `--json-status-fd`): the supervisor
 *  holds it open as a pipe. No other process the daemon starts has it, so no other plan may name it. */
const STATUS_FD = 3;

/** Whether `value` is an exec request's id, the only names a record directory takes. */
function isRequestId(value) {
  return typeof value === 'string' && REQUEST_ID.test(value);
}

/** A supervisor's record on the output pipe: the descriptor the bytes came
 *  from (1 or 2), or 0 for a count of bytes it dropped; then a 48-bit length;
 *  then that many bytes, none after a count. */
const OUTPUT_RECORD_HEADER_BYTES = 7;

/** Room for what the supervisor writes around the kept bytes: the seam, and the closing line that names
 *  the spill path or why it was not saved. */
const EXEC_CAPTURE_MAX_BYTES = EXEC_STREAM_MAX_BYTES + 16 * 1024;

function supervisionSupported(platform = process.platform) {
  return platform === 'linux' || platform === 'darwin';
}

function assertSupervisionSupported() {
  if (!supervisionSupported()) throw new Error('pc-agent command supervision requires POSIX Linux or macOS');
}

function requestDirectory(root, requestId) {
  if (!isRequestId(requestId)) throw new Error('exec request id must match rpc-<epoch>-<sequence>');

  const resolvedRoot = path.resolve(root);
  const dir = path.resolve(resolvedRoot, requestId);

  if (path.dirname(dir) !== resolvedRoot) throw new Error('exec request directory must be a direct child of the in-flight root');

  return dir;
}

/** `ps` on darwin, run to its exit: its stdout, or its error thrown. */
async function psOutput(args) {
  const { error, stdout } = await runToExit('ps', args, { encoding: 'utf8' });

  if (error !== null) throw error;

  return stdout;
}

async function processStartIdentity(pid) {
  if (process.platform === 'linux') {
    const start = procStat(pid, 'stat', true).startTicks;

    if (!start) throw new Error(`cannot read start identity for supervisor ${pid}`);

    return start;
  }

  if (process.platform === 'darwin') {
    const start = (await psOutput(['-p', String(pid), '-o', 'lstart='])).trim();

    if (!start) throw new Error(`cannot read start identity for supervisor ${pid}`);

    return start;
  }

  throw new Error('pc-agent command supervision requires POSIX Linux or macOS');
}

/** A supervisor record: one `key=value` per line, split at the FIRST `=` so a
 *  value may hold one. */
function readFieldFile(file) {
  const text = fs.readFileSync(file, 'utf8');

  return new Map(text.trimEnd().split('\n').map((line) => {
    const separator = line.indexOf('=');

    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

function readSupervisorState(dir) {
  const fields = readFieldFile(path.join(dir, 'state'));
  const pid = Number(fields.get('pid'));
  const start = fields.get('start');
  const group = Number(fields.get('group'));
  const groupStart = fields.get('groupStart');

  if (!Number.isSafeInteger(pid) || pid <= 0 || !start ||
      !Number.isSafeInteger(group) || group <= 0 || !groupStart) {
    throw new Error(`invalid supervisor state in ${dir}`);
  }

  return { pid, start, group, groupStart };
}

/** Whether `pid` still runs as the process that started at `start`; false once it is gone. */
async function startedAs(pid, start) {
  try {
    return (await processStartIdentity(pid)) === start;
  } catch (err) {
    // Linux: no /proc entry. Darwin: `ps -p` found no such process and exited 1.
    if (procEntryGone(err) || (process.platform === 'darwin' && err && err.code === 1)) {
      return false;
    }

    throw err;
  }
}

async function supervisorStartMatches(entry) {
  return (await startedAs(entry.pid, entry.start)) && (await startedAs(entry.group, entry.groupStart));
}

/** A signal name the supervisor recorded: `SIG` and the platform's name for it. */
const SIGNAL_NAME = /^SIG[A-Z0-9]+$/;

function readTerminalResult(dir) {
  const fields = readFieldFile(path.join(dir, 'result'));
  const kind = fields.get('kind');
  const exitCode = Number(fields.get('exitCode'));
  const signal = fields.get('signal') ?? null;

  if ((kind !== 'exited' && kind !== 'cancelled') || !Number.isSafeInteger(exitCode)
    || (signal !== null && !SIGNAL_NAME.test(signal))) {
    throw new Error(`invalid terminal result in ${dir}`);
  }

  return { kind, exitCode, signal };
}

/** The supervisor bounds the file as it writes it; the read bound only keeps a damaged file off the heap. */
function readCapturedOutput(file) {
  const descriptor = fs.openSync(file, 'r');

  try {
    const bytes = Buffer.allocUnsafe(Math.min(fs.fstatSync(descriptor).size, EXEC_CAPTURE_MAX_BYTES));
    const read = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    const output = bytes.subarray(0, read).toString();

    return fs.existsSync(file + '.after-exit') ? output + '\n[background output after command exit is not captured]\n' : output;
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Beside a command's supervisor files: why no checkpoint covers what it changes, when none does. */
const UNCHECKPOINTED_FILE = 'uncheckpointed';

/** A command a signal ended says so, in the words the CLI's own shell uses (cli-backend runtime.ts exitStatus). */
function readExecResult(dir) {
  const terminal = readTerminalResult(dir);
  const stderr = readCapturedOutput(path.join(dir, 'stderr'));
  const note = terminal.signal === null ? '' : `Command terminated by ${terminal.signal}.`;
  const uncheckpointed = readUncheckpointed(dir);

  const result = {
    stdout: readCapturedOutput(path.join(dir, 'stdout')),
    stderr: note === '' ? stderr : `${stderr}${stderr === '' || stderr.endsWith('\n') ? '' : '\n'}${note}`,
    exitCode: terminal.exitCode,
  };

  if (uncheckpointed !== null) result.uncheckpointed = uncheckpointed;

  return { terminal, result };
}

/** Why no checkpoint covers what the command in `dir` changed, as its start recorded it, or null. */
function readUncheckpointed(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, UNCHECKPOINTED_FILE), 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

const SUPERVISOR_SCRIPT = `
'use strict';
const fs = require('node:fs');
const { procStat, groupHasLiveProcess } = (${createProcReader.toString()})(fs);
const elidedOutput = (${elidedOutput.toString()});
const { execFile, spawn } = require('node:child_process');
// A spill opens where it was judged, without following a link a sandboxed command put in its path (held.js).
const { atJudged } = (${heldModule.toString()})(require);

// fd 4 is the record's \`life\`, handed over at this process's spawn: the kernel closes it however this process exits,
// and the daemon reads that close as this supervisor gone.
const [commandFile, stateFile, resultFile, stdoutFile, stderrFile, ackFile, maxText, planFile] = process.argv.slice(1);
const maxOutput = Number(maxText);
// Half kept from the start, half from the end, as core's BoundedOutput keeps them (COMMAND_OUTPUT_LIMITS).
const HEAD = Math.floor(maxOutput / 2);
const TAIL = maxOutput - HEAD;

/** The daemon that started this supervisor, by IDENTITY rather than liveness:
 * the kernel reparents an orphan, so a changed ppid is exactly "the parent is
 * gone" and carries no pid-reuse hazard. Read before anything can fail. */
const parentPid = process.ppid;
const ORPHAN_POLL_MS = 1000;

/** A child run to its exit: its stdout, or its error thrown. Never synchronous; the daemon's runToExit says why. */
function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin.end();
  });
}

function linuxStartIdentity(pid) {
  const stat = procStat(pid, 'stat', true);
  if (!stat.startTicks) throw new Error('cannot read process start identity');
  return stat.startTicks;
}

/** What the daemon reads back with the same ps; empty once the process is gone (ps exits 1). */
async function psStartIdentity(pid) {
  try {
    return (await run('ps', ['-p', String(pid), '-o', 'lstart='])).trim();
  } catch (err) {
    if (err && err.code === 1) return '';
    throw err;
  }
}

/** A start no process has: the daemon then finds the group gone, as it is once its leader is reaped. */
const REAPED_BEFORE_READ = 'reaped before its start was read';

/** This supervisor's start and its command's. The kernel answers on Linux before the event loop can reap the
 *  command; elsewhere both ps runs start in this tick, and a command reaped before its row was read has ended. */
async function startIdentities() {
  if (process.platform === 'linux') return [linuxStartIdentity(process.pid), linuxStartIdentity(child.pid)];
  const [own, group] = await Promise.all([psStartIdentity(process.pid), psStartIdentity(child.pid)]);
  if (!own) throw new Error('cannot read process start identity');
  return [own, group || REAPED_BEFORE_READ];
}

/** Startup either publishes an authoritative group or leaves no group at all. A detached child exists only
 *  after spawn, so every post-spawn failure kills and reaps that exact group rather than abandoning an
 *  unnameable command. */
function abandonStartup() {
  if (child && child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (killError) {
      if (!killError || killError.code !== 'ESRCH') throw new Error('supervisor startup group cleanup', { cause: killError });
    }
  }
  process.exit(125);
}

async function publishState() {
  // First, before anything yields: on Linux the command's identity is read before the event loop can reap it.
  const [start, groupStart] = await startIdentities();
  const stateTemporary = stateFile + '.tmp.' + process.pid;
  fs.writeFileSync(
    stateTemporary,
    'pid=' + process.pid + '\\nstart=' + start + '\\ngroup=' + child.pid + '\\ngroupStart=' + groupStart + '\\n',
    { mode: 0o600 },
  );
  fs.renameSync(stateTemporary, stateFile);
}

function writeTerminalResult(kind, exitCode, signal) {
  const temporary = resultFile + '.tmp.' + process.pid;
  const named = signal ? 'signal=' + signal + '\\n' : '';
  fs.writeFileSync(temporary, 'kind=' + kind + '\\nexitCode=' + exitCode + '\\n' + named, { mode: 0o600 });
  fs.renameSync(temporary, resultFile);
}

/** One stream: the first HEAD bytes go to its file as they arrive, the last TAIL stay in a ring, every
 *  byte is counted, and once the stream outgrows both the whole of it goes to the spill file. close()
 *  writes core's elidedOutput, as BoundedOutput.finish does, so every executor reads the same.
 *  The spill is written at its host path and named by the path the command's own view gives it. That
 *  path is in the agent's own tmp, which its commands write: it is opened where it was judged, without
 *  following a link one of them put at its name or in its directory (L111 #1), and written through the
 *  descriptor it opened. */
class Capture {
  constructor(file, spill, stream) {
    this.fd = fs.openSync(file, 'w+', 0o600);
    this.spillTarget = spill || null;
    this.stream = stream;
    this.head = 0;
    this.ring = null;
    this.ringEnd = 0;
    this.ringLength = 0;
    this.total = 0;
    this.spill = null;
    this.spillFailure = null;
  }

  write(chunk) {
    this.total += chunk.length;
    // Nothing is dropped before this chunk, so the head and ring hold everything seen so far.
    if (this.spill === null && this.spillFailure === null && this.total > HEAD + TAIL) this.openSpill();
    if (this.spill !== null) this.spillWrite(chunk);
    let rest = chunk;
    if (this.head < HEAD) {
      const taken = rest.subarray(0, HEAD - this.head);
      fs.writeSync(this.fd, taken, 0, taken.length, this.head);
      this.head += taken.length;
      rest = rest.subarray(taken.length);
    }
    if (rest.length > 0 && TAIL > 0) this.keep(rest);
  }

  openSpill() {
    if (this.spillTarget === null) {
      this.spillFailure = 'no directory to save it in';
      return;
    }
    try {
      const { O_WRONLY, O_CREAT, O_TRUNC } = fs.constants;

      this.spill = atJudged({ raw: this.spillTarget.raw }, this.spillTarget.file, { createParents: true },
        (at) => at.open(O_WRONLY | O_CREAT | O_TRUNC, 0o600));
      const head = Buffer.alloc(this.head);
      fs.readSync(this.fd, head, 0, this.head, 0);
      this.spillWrite(head);
      this.spillWrite(this.keptTail());
    } catch (err) {
      this.fail(err);
    }
  }

  spillWrite(bytes) {
    if (this.spill === null) return;
    try {
      for (let offset = 0; offset < bytes.length;) offset += fs.writeSync(this.spill, bytes, offset);
    } catch (err) {
      this.fail(err);
    }
  }

  fail(err) {
    this.spillFailure = 'saving ' + this.spillTarget.shown + ' failed: ' + (err && err.message ? err.message : String(err));
    if (this.spill !== null) fs.closeSync(this.spill);
    this.spill = null;
  }

  keep(rest) {
    this.ring = this.ring || Buffer.alloc(TAIL);
    if (rest.length >= TAIL) {
      rest.copy(this.ring, 0, rest.length - TAIL);
      this.ringEnd = 0;
      this.ringLength = TAIL;
      return;
    }
    const first = Math.min(rest.length, TAIL - this.ringEnd);
    rest.copy(this.ring, this.ringEnd, 0, first);
    rest.copy(this.ring, 0, first);
    this.ringEnd = (this.ringEnd + rest.length) % TAIL;
    this.ringLength = Math.min(TAIL, this.ringLength + rest.length);
  }

  keptTail() {
    if (this.ring === null) return Buffer.alloc(0);
    if (this.ringLength < TAIL) return this.ring.subarray(0, this.ringLength);
    return Buffer.concat([this.ring.subarray(this.ringEnd), this.ring.subarray(0, this.ringEnd)]);
  }

  close() {
    const tail = this.keptTail();
    if (this.total === this.head + tail.length) {
      fs.writeSync(this.fd, tail, 0, tail.length, this.head);
      fs.closeSync(this.fd);
      return;
    }
    const head = Buffer.alloc(this.head);
    fs.readSync(this.fd, head, 0, this.head, 0);
    if (this.spill !== null) fs.closeSync(this.spill);
    let where = 'the full ' + this.stream + ' was not saved: ' + this.spillFailure;
    if (this.spill !== null) where = 'the full ' + this.stream + ' is at ' + this.spillTarget.shown;
    const text = Buffer.from(elidedOutput({ head, tail, total: this.total, stream: this.stream, where }));
    fs.writeSync(this.fd, text, 0, text.length, 0);
    fs.ftruncateSync(this.fd, text.length);
    fs.closeSync(this.fd);
  }
}

// The daemon's output pipe on fd 3, when its hub asked to watch: each chunk goes on as a record. A
// backlog past the plan's bound drops the chunk and counts it, and a daemon that went away (EPIPE)
// ends the forwarding, so the command never waits on the daemon and the capture never sees any of it.
let live = null;
let liveBacklog = 0;
let liveDropped = 0;

function liveRecord(kind, size) {
  const header = Buffer.alloc(7);
  header[0] = kind;
  header.writeUIntBE(size, 1, 6);
  return header;
}

function forward(kind, chunk) {
  if (live === null) return;
  if (live.writableLength > liveBacklog) {
    liveDropped += chunk.length;
    return;
  }
  if (liveDropped > 0) live.write(liveRecord(0, liveDropped));
  liveDropped = 0;
  live.write(Buffer.concat([liveRecord(kind, chunk.length), chunk]));
}

// Before the result exists: the daemon answers once this pipe has closed, so the output it forwards
// reaches the hub before the result does.
function endLive() {
  if (live === null) return;
  if (liveDropped > 0) live.write(liveRecord(0, liveDropped));
  live.end();
  live = null;
}

let child;
let stdout;
let stderr;
let sandboxPid = 0;
let cancellationRequested = false;
let cancellationSignalDelivered = false;
let completed = false;

function finish(kind, exitCode, signal) {
  if (completed) return;
  completed = true;
  stdout.close();
  stderr.close();
  endLive();
  if (kind === 'cancelled') {
    writeTerminalResult(kind, exitCode);
    process.exit(0);
    return;
  }
  // The cloud may ACK as soon as result appears. Publish an open FIFO before
  // that result, otherwise its writer can create a regular file in the race.
  run('mkfifo', [ackFile]).then(() => awaitAcknowledgement(kind, exitCode, signal), () => process.exit(125));
}

function awaitAcknowledgement(kind, exitCode, signal) {
  writeTerminalResult(kind, exitCode, signal);
  const acknowledgement = fs.createReadStream(ackFile);
  // The daemon is the only writer of this FIFO, so once it is gone the wait can
  // never end and this process would hold the request directory on the machine
  // forever. Watched only HERE, not while the command runs: a running command
  // must survive a daemon restart, and the restarted daemon adopts its live
  // supervisor by start identity. Past the result there is nothing to adopt —
  // the result file stays on disk, and whichever daemon reconciles it next
  // removes the directory itself.
  const orphaned = setInterval(() => {
    if (process.ppid !== parentPid) process.exit(0);
  }, ORPHAN_POLL_MS);
  acknowledgement.once('data', () => {
    clearInterval(orphaned);
    acknowledgement.destroy();
    fs.rmSync(require('node:path').dirname(stateFile), { recursive: true, force: true });
    process.exit(0);
  });
  acknowledgement.once('error', () => process.exit(125));
}

try {
  const command = fs.readFileSync(commandFile, 'utf8');
  fs.unlinkSync(commandFile);
  // The DAEMON decides how the command runs — sandbox argv, environment, cwd —
  // and this process only carries it out. That keeps the policy testable
  // without spawning anything and keeps this script dumb, which matters
  // because it outlives the daemon.
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  fs.unlinkSync(planFile);
  // The plan carries everything BUT the command, which this process appends
  // from the file it just unlinked: the command text then lives in one place
  // on disk rather than two, and a sentinel the daemon would have to
  // interpolate into this script is not needed.
  const argv = [...plan.argv, command];
  const spill = plan.spill || {};
  stdout = new Capture(stdoutFile, spill.stdout, 'stdout');
  stderr = new Capture(stderrFile, spill.stderr, 'stderr');
  if (plan.liveBacklog > 0) {
    liveBacklog = plan.liveBacklog;
    live = fs.createWriteStream(null, { fd: 3 });
    live.on('error', () => { live = null; });
  }
  child = spawn(argv[0], argv.slice(1), {
    detached: true,
    env: plan.env,
    cwd: plan.cwd,
    // A fourth pipe when the plan asked for one: bwrap writes its
    // --json-status-fd there, and the first line carries the host pid of the
    // sandbox's pid 1. Killing THAT is deterministic — the kernel reaps every
    // process in the namespace before pid 1's exit completes — where a group
    // kill returns before the namespace has finished dying.
    stdio: plan.statusFd === ${STATUS_FD} ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });
  if (plan.statusFd === ${STATUS_FD} && child.stdio[${STATUS_FD}]) {
    let statusText = '';
    child.stdio[${STATUS_FD}].on('data', (chunk) => {
      // Scanned whole rather than split by line: this script is a template in
      // the daemon's own source, so a newline escape here lands as a REAL
      // newline inside a string literal and the supervisor stops parsing —
      // which is exactly how it failed, silently, with exit 1.
      statusText += chunk.toString();
      const match = /"child-pid"\\s*:\\s*(\\d+)/.exec(statusText);
      if (match) sandboxPid = Number(match[1]);
    });
  }
  process.on('SIGUSR1', () => {
    if (!child || completed || cancellationRequested) return;
    cancellationRequested = true;
    try {
      // The namespace's pid 1 when there is one, its process group otherwise.
      // Both reach every descendant; only the first is synchronous.
      if (sandboxPid > 0) process.kill(sandboxPid, 'SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
      cancellationSignalDelivered = true;
    } catch (err) {
      if (!err || err.code !== 'ESRCH') finish('exited', 125);
    }
  });
  child.stdout.on('data', (chunk) => {
    if (completed) return;
    stdout.write(chunk);
    forward(1, chunk);
  });
  child.stderr.on('data', (chunk) => {
    if (completed) return;
    stderr.write(chunk);
    forward(2, chunk);
  });
} catch (err) {
  abandonStartup();
}

publishState().catch(abandonStartup);



child.once('exit', (code, signal) => {
  // A cancellation is only an end the kill caused. A command can exit on its own after the cancel arrives and before
  // this supervisor reaps it, and a signal to that exited, unreaped group still reports delivered; a sandbox's
  // launcher reports its killed namespace as 128 + SIGKILL.
  const killed = signal === 'SIGKILL' || (sandboxPid > 0 && code === 137);
  const finishAfterDrain = () => {
    if (cancellationRequested && cancellationSignalDelivered && killed) {
      // This confirms only the owned process group. A command can use setsid
      // to escape that group; same-uid supervision cannot honestly claim it
      // terminated such a detached descendant.
      groupHasLiveProcess(child.pid, (args) => run('ps', args)).then(
        (groupAlive) => finish(groupAlive ? 'exited' : 'cancelled', groupAlive ? 125 : 137),
        () => finish('exited', 125),
      );
      return;
    }
    // A signal death is 128 plus that signal's number on this platform (SIGBUS
    // is 7 on Linux and 10 on macOS). Node reports exactly one of code and
    // signal; an end with neither is this supervisor's own failure.
    if (typeof code === 'number') finish('exited', code);
    else if (signal) finish('exited', 128 + (require('node:os').constants.signals[signal] || 0), signal);
    else finish('exited', 125);
  };
  setTimeout(() => {
    // A background descendant can retain the inherited pipes forever. At this
    // established drain boundary, closing them makes the command terminal; mark
    if (child.stdout.readable) { fs.writeFileSync(stdoutFile + '.after-exit', '1'); child.stdout.destroy(); }
    if (child.stderr.readable) { fs.writeFileSync(stderrFile + '.after-exit', '1'); child.stderr.destroy(); }
    finishAfterDrain();
  }, 250);
});
`;

function waitForPath(file, exists, signal) {
  if (fs.existsSync(file) === exists) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const directory = path.dirname(file);
    const name = path.basename(file);
    let watcher;
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;

      if (watcher) watcher.close();
      signal?.removeEventListener('abort', onAbort);

      if (error) reject(error);
      else resolve();
    };

    const check = (_event, changed) => {
      if (changed !== null && String(changed) !== name) return;

      if (fs.existsSync(file) === exists) finish();
    };

    const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error('file watch aborted'));

    try {
      watcher = fs.watch(directory, check);
      watcher.once('error', finish);
      signal?.addEventListener('abort', onAbort, { once: true });
    } catch (err) {
      finish(err);

      return;
    }

    if (fs.existsSync(file) === exists) finish();
  });
}

function waitForFile(file, signal) {
  return waitForPath(file, true, signal);
}

/**
 * Resolves once the supervisor of `dir` is gone, or `signal` aborts. It holds `life` open for writing from its spawn,
 * so a reader opened while that end is held is hung up when the supervisor exits, and one opened after finds no
 * writer at all. A directory with no `life` has no supervisor: it was never spawned, or has removed it.
 */
async function supervisorExit(dir, signal) {
  let fd;

  try {
    fd = fs.openSync(path.join(dir, 'life'), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }

  try {
    if (!lifeHeld(fd)) return;
    // Bun alone sees a FIFO's hang-up here (its net.Socket over the fd never ends); it leaves the fd to us.
    const reader = Bun.file(fd).stream().getReader();
    let cancelled = Promise.resolve();
    const cancel = () => { cancelled = reader.cancel(); };

    signal.addEventListener('abort', cancel, { once: true });

    try {
      // Nothing is ever written: the read ends at the writer's close, or at the cancel.
      while (!(await reader.read()).done);
    } finally {
      signal.removeEventListener('abort', cancel);
      await cancelled;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether a writer holds the FIFO `fd` reads: with none left a non-blocking read ends (0); with one, it would wait. */
function lifeHeld(fd) {
  try {
    return fs.readSync(fd, Buffer.alloc(1)) !== 0;
  } catch (err) {
    if (err && err.code === 'EAGAIN') return true;
    throw err;
  }
}

/**
 * Resolves once the supervisor of `entry` has written its result. One that exits first never will, and that is
 * the answer: what became of its command is unknown.
 */
async function resultWritten(entry, requestId) {
  const resultFile = path.join(entry.dir, 'result');
  const settled = new AbortController();
  const written = waitForFile(resultFile, settled.signal);
  const exited = supervisorExit(entry.dir, settled.signal);

  try {
    await Promise.race([written, exited]);
  } finally {
    settled.abort();
    await Promise.allSettled([written, exited]);
  }

  resultRecorded(entry, requestId);
}

/**
 * Resolves once the supervisor of `dir` has published its state. It holds `life` from its spawn, so a record nothing
 * holds has no supervisor coming, and one whose supervisor exits first never will: both reject.
 */
async function supervisorStateWritten(dir) {
  const stateFile = path.join(dir, 'state');

  if (!fs.existsSync(path.join(dir, 'life'))) throw new Error(`no supervisor holds ${dir}`);
  const settled = new AbortController();
  const written = waitForFile(stateFile, settled.signal);
  const exited = supervisorExit(dir, settled.signal);

  try {
    await Promise.race([written, exited]);
  } finally {
    settled.abort();
    await Promise.allSettled([written, exited]);
  }

  if (!fs.existsSync(stateFile)) throw new Error(`the supervisor of ${dir} exited before publishing its state`);
}

/** The supervisor writes its result before it can exit, so one gone without a result never wrote one. */
function resultRecorded(entry, requestId) {
  if (!fs.existsSync(path.join(entry.dir, 'result'))) {
    throw new Error(`the supervisor of ${requestId} (pid ${entry.pid}) exited without recording the command's result, `
      + `so its outcome is unknown; the command may still be running in process group ${entry.group}`);
  }
}

/**
 * Tells the supervisor of `entry` to stop, and waits for its result. One gone since its identity was checked
 * cannot be told (ESRCH): it is answered for from what it left, as one that exits mid-wait is.
 */
async function stopSupervisor(entry, requestId) {
  try {
    process.kill(entry.pid, 'SIGUSR1');
  } catch (err) {
    if (!err || err.code !== 'ESRCH') throw err;
    resultRecorded(entry, requestId);

    return;
  }

  await resultWritten(entry, requestId);
}

/** The ACK to a live supervisor, settled once it has removed its directory or once it is gone, whichever is first. */
async function handOver(dir) {
  const settled = new AbortController();
  // Watched before the ACK goes: the supervisor that reads it removes `life` with the directory.
  const exited = supervisorExit(dir, settled.signal);
  const removed = writeAcknowledgement(dir, settled.signal).then(() => waitForDirectoryRemoval(dir, settled.signal));

  try {
    await Promise.race([removed, exited]);
  } finally {
    settled.abort();
    await Promise.allSettled([removed, exited]);
  }
}

function waitForDirectoryRemoval(dir, signal) {
  return waitForPath(dir, false, signal);
}

/** `signal` ends a writer still waiting for its reader, which a supervisor gone before it opened the FIFO never is. */
function writeAcknowledgement(dir, signal) {
  const ack = path.join(dir, 'ack');

  return new Promise((resolve, reject) => {
    const writer = spawn('/bin/sh', ['-c', 'printf 1 > "$1"', 'kinu-ack', ack], { stdio: 'ignore', signal });
    writer.once('error', reject);
    writer.once('exit', (code, killedBy) => {
      if (code === 0) resolve();
      else reject(new Error(`supervisor acknowledgement writer exited with ${killedBy ?? code}`));
    });
  });
}

function removeRequestDirectory(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** `isStarting(requestId)`: a start in this daemon is still building that record, which its start registers. */
function createInFlight(root, isStarting, log) {
  const entries = new Map();

  function entryFor(requestId) {
    const existing = entries.get(requestId);

    if (existing) return existing;
    const dir = requestDirectory(root, requestId);

    if (!fs.existsSync(dir)) return undefined;
    const state = readSupervisorState(dir);
    const entry = { dir, ...state };
    entries.set(requestId, entry);

    return entry;
  }

  async function loadEntry(requestId) {
    const known = entries.get(requestId);

    if (known) return known;
    const dir = requestDirectory(root, requestId);

    if (!fs.existsSync(dir)) return undefined;
    await waitForFile(path.join(dir, 'state'));

    return entryFor(requestId);
  }

  async function reconcile() {
    if (!fs.existsSync(root)) return [];
    const recovered = [];

    for (const directory of fs.readdirSync(root, { withFileTypes: true })) {
      if (!directory.isDirectory() || isStarting(directory.name)) continue;
      const dir = path.join(root, directory.name);

      try {
        requestDirectory(root, directory.name);

        if (!fs.existsSync(path.join(dir, 'state'))) await supervisorStateWritten(dir);
        const state = readSupervisorState(dir);
        // The supervisor alone, as the ACK asks: a command that has ended is its supervisor's until the result is
        // written. Asked first, because a supervisor writes its result before it exits: a result read after
        // finding it gone is final.
        const supervising = await startedAs(state.pid, state.start);
        const terminal = fs.existsSync(path.join(dir, 'result'));

        if (!terminal && !supervising) {
          removeRequestDirectory(dir);
          continue;
        }

        entries.set(directory.name, { dir, ...state });
        recovered.push({ requestId: directory.name, terminal });
      } catch (err) {
        log('Removing unusable in-flight command record', dir, errorDetail(err));
        removeRequestDirectory(dir);
      }
    }

    return recovered;
  }

  function register(requestId, dir) {
    entries.set(requestId, { dir, ...readSupervisorState(dir) });
  }

  async function cancel(requestId) {
    // No record is named so: no supervisor holds it.
    if (!isRequestId(requestId)) return { requestId, cancelled: 'unknown' };
    let entry;

    try {
      entry = await loadEntry(requestId);
    } catch (err) {
      throw new Error(`cannot validate supervisor for ${requestId}: ${errorDetail(err)}`, { cause: err });
    }

    if (!entry || fs.existsSync(path.join(entry.dir, 'result'))) {
      return { requestId, cancelled: 'unknown' };
    }

    if (!(await supervisorStartMatches(entry))) {
      throw new Error(`cannot terminate ${requestId}: supervisor identity no longer matches`);
    }

    await stopSupervisor(entry, requestId);
    const terminal = readTerminalResult(entry.dir);

    if (terminal.kind !== 'cancelled') {
      throw new Error(`cannot terminate ${requestId}: supervisor exited without a confirmed group termination`);
    }

    if (await groupHasLiveProcess(entry.group, psOutput)) {
      throw new Error(`cannot terminate ${requestId}: owned process group death is unconfirmed`);
    }

    // This scope is the process group created for the command. A command that
    // calls setsid can leave it; the cancellation protocol does not claim that
    // such a descendant was terminated.
    return { requestId, cancelled: 'terminated' };
  }

  async function result(requestId) {
    const entry = await loadEntry(requestId);

    if (!entry) return undefined;
    await resultWritten(entry, requestId);

    return { entry, ...readExecResult(entry.dir) };
  }

  async function acknowledge(requestId) {
    const entry = await loadEntry(requestId);

    // The ACK reply itself can be lost after this daemon already removed the
    // normal-result directory. Retrying must converge to accepted rather than
    // stranding UserDO's durable row on a now-unknown local request.
    if (!entry) return { requestId, acknowledged: true };
    const terminal = readTerminalResult(entry.dir);

    // The FIFO is a handshake with a LIVE supervisor: it is the only reader,
    // so writing to it when it has exited blocks that writer forever — the
    // same leak, moved into this daemon. A supervisor whose start identity no
    // longer matches is gone (its daemon died and it left the result behind),
    // and this daemon owns the directory instead. The supervisor alone is
    // asked: a finished command's group leader has exited, so the group half
    // of the identity never matches here. One that dies after this check is
    // heard of through its `life` FIFO.
    if (terminal.kind === 'exited' && (await startedAs(entry.pid, entry.start))) await handOver(entry.dir);

    // Gone already when a supervisor removed it on reading the ACK.
    removeRequestDirectory(entry.dir);

    entries.delete(requestId);

    return { requestId, acknowledged: true };
  }

  /**
   * Terminate every command that can no longer report to anyone, and RETURN
   * the terminations, each NAMING its request.
   *
   * The daemon itself does not await them — a dropped socket is not a request
   * anyone is waiting on — but the outcome has to be observable by something
   * other than a log line. Each promise resolves only once `cancel` has the
   * supervisor's terminal result AND has confirmed the owned process group
   * holds no live process, so that resolution is the exact moment the kill has
   * landed. Without it the only way to ask was to poll the process table on a
   * deadline, which answers "not yet" and "never" with the same value.
   */
  async function terminateUnanswered() {
    // Reconciled FIRST, because the in-memory registry is not the whole truth:
    // a command whose supervisor has published its state but which
    // `register` has not reached yet is absent from `entries`, so a socket
    // that dropped in that window left the command running with nothing left
    // to name or stop it. `reconcile` reads the request directories, which is
    // where the durable truth is, and is idempotent.
    await reconcile();
    const terminations = [];

    for (const [requestId, entry] of entries) {
      if (fs.existsSync(path.join(entry.dir, 'result'))) continue;

      /** @param {unknown} error */
      function reportTerminationFailure(error) {
        log('Could not terminate abandoned command', requestId, error);
      }

      const terminated = cancel(requestId);
      // The daemon's own report, so an ignored return value still surfaces.
      terminated.catch(reportTerminationFailure);
      // Named, because a sweep terminates every abandoned command at once and
      // a caller asking about one of them must not have to guess which
      // position it took.
      terminations.push({ requestId, terminated });
    }

    return terminations;
  }

  /** @param {unknown} error */
  function reportReconcileFailure(error) {
    log('Could not reconcile in-flight commands under', root, errorDetail(error));
  }

  // Startup awaits it only after claiming the machine and probing the sandbox,
  // and a module a test only requires never does: until then a rejection with
  // no handler ends the process in Bun. Handled here, it stays startup's refusal.
  const ready = reconcile();
  ready.catch(reportReconcileFailure);

  return {
    /** The first reconciliation, which makes a restarted daemon the owner of
     *  what its predecessor left running; the daemon serves nothing before it. */
    ready,
    register,
    cancel,
    result,
    acknowledge,
    reconcile,
    terminateUnanswered,
    size() { return entries.size; },
  };
}

/** `uncheckpointed`: why no checkpoint covers the command, or null. `outputWindow`: the bytes of live output the hub
 *  watching it keeps, 0 when none watches; a watched supervisor gets a pipe for it on fd 3, and `child.stdio[3]` is
 *  this daemon's end. */
async function startSupervisor({ root, env, requestId }, command, plan, { uncheckpointed, outputWindow }) {
  assertSupervisionSupported();
  const dir = requestDirectory(root, requestId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const commandFile = path.join(dir, 'command');
  fs.writeFileSync(commandFile, command, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const planFile = path.join(dir, 'plan.json');
  // Without the command: `plan.argv` ends with it, and the supervisor appends
  // it from `command`, which it unlinks before the command runs.
  fs.writeFileSync(
    planFile,
    JSON.stringify({
      argv: plan.argv.slice(0, -1), env: plan.env, statusFd: plan.statusFd, cwd: plan.spawnCwd,
      spill: outputSpill(plan, requestId),
      // A window's worth: past it, this daemon would drop the bytes from its window anyway.
      liveBacklog: outputWindow,
    }),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );

  if (uncheckpointed !== null) {
    fs.writeFileSync(path.join(dir, UNCHECKPOINTED_FILE), JSON.stringify(uncheckpointed), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }

  // The record's liveness, held here before its supervisor exists and handed to it at its spawn: a daemon that
  // finds this directory with no state yet can tell a supervisor still starting from one that never came.
  const lifeFile = path.join(dir, 'life');
  const made = await runToExit('mkfifo', [lifeFile]);

  if (made.error) throw new Error(`could not create ${lifeFile}: ${errorDetail(made.error)}`, { cause: made.error });
  const life = fs.openSync(lifeFile, 'r+');
  let child;

  try {
    child = spawn(process.execPath, [
      '-e', SUPERVISOR_SCRIPT,
      commandFile, path.join(dir, 'state'), path.join(dir, 'result'),
      path.join(dir, 'stdout'), path.join(dir, 'stderr'), path.join(dir, 'ack'),
      String(EXEC_STREAM_MAX_BYTES), planFile,
    ], { detached: true, env, stdio: ['ignore', 'ignore', 'ignore', outputWindow > 0 ? 'pipe' : 'ignore', life] });
  } finally {
    fs.closeSync(life);
  }

  child.unref();

  return { child, dir };
}

/**
 * Where a command's whole output goes once it outgrows the bound, as `{ file, shown }`: the host path,
 * and the path the command's own view names it by. A sandboxed command spills into the agent's own
 * tmp, which its shell reaches as /tmp and the file methods serve; an unsandboxed one into this
 * machine's tmp. Never Kinu's own directory, which neither serves.
 */
function outputSpill(plan, requestId) {
  const dir = path.join(plan.view.raw ? os.tmpdir() : plan.view.agentTmp, 'kinu-tool-output');

  const at = (stream) => {
    const file = path.join(dir, `device-${requestId}.${stream}.log`);

    return { file, shown: plan.view.raw ? file : plan.view.insidePath(file), raw: plan.view.raw === true };
  };

  return { stdout: at('stdout'), stderr: at('stderr') };
}

function waitForSupervisorState(dir, child) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      child.off('error', onError);
      child.off('exit', onExit);
      controller.abort(error);

      if (error) reject(error);
      else resolve();
    };

    const onError = (err) => finish(err);

    // The exit and the state watch are two event sources with no order between them: a supervisor that
    // renamed its state into place and then died can have its exit dispatched first. The file decides.
    const onExit = (code, signal) => {
      if (fs.existsSync(path.join(dir, 'state'))) finish();
      else finish(new Error(`supervisor exited before publishing state (${signal ?? code ?? 0})`));
    };

    child.once('error', onError);
    child.once('exit', onExit);

    /** @param {unknown} error */
    function finishWithError(error) {
      if (!settled) finish(error);
    }

    waitForFile(path.join(dir, 'state'), controller.signal).then(
      () => finish(),
      finishWithError,
    );
  });
}

/**
 * The records a supervisor writes on its output pipe, as they arrive: `bytes(stream, chunk)` for what the command
 * wrote on `stdout` or `stderr`, and `lost(count)` for what the supervisor dropped before it.
 */
function readOutputRecords(pipe, { bytes, lost }) {
  let header = Buffer.alloc(0);
  let source = 0;
  let remaining = 0;

  pipe.on('data', (data) => {
    for (let at = 0; at < data.length;) {
      if (remaining > 0) {
        const end = Math.min(data.length, at + remaining);
        bytes(source === 1 ? 'stdout' : 'stderr', data.subarray(at, end));
        remaining -= end - at;
        at = end;
        continue;
      }

      const end = Math.min(data.length, at + OUTPUT_RECORD_HEADER_BYTES - header.length);
      header = Buffer.concat([header, data.subarray(at, end)]);
      at = end;

      if (header.length < OUTPUT_RECORD_HEADER_BYTES) continue;
      source = header[0];
      const size = header.readUIntBE(1, 6);
      header = Buffer.alloc(0);

      if (source === 0) lost(size);
      else remaining = size;
    }
  });
}

/**
 * One daemon's supervisors under `root`: it starts them, adopts what a predecessor left running, and answers for each
 * request until the hub acknowledges its result. `isStarting(requestId)`: a start in this daemon is still building that
 * record. Reconciliation makes a restarted daemon the durable request owner without creating another supervisor.
 */
function createSupervision({ root, isStarting = () => false, log = () => {} }) {
  const { register, ...registry } = createInFlight(root, isStarting, log);
  // The supervisor's own environment: the sandboxed tier's allow-list, so no NODE_OPTIONS or BUN_INSPECT loads code
  // into it. The command it starts runs with its plan's environment (sandbox.js), never this one.
  const env = sandbox.sandboxEnvironment(process.env, {});

  return {
    ...registry,
    start: (requestId, command, plan, options) => startSupervisor({ root, env, requestId }, command, plan, options),
    /** Resolves once a started supervisor has published its state, and holds it as `requestId`'s. */
    async adopt(requestId, { dir, child }) {
      await waitForSupervisorState(dir, child);
      register(requestId, dir);
    },
    /** A record a start already made for `requestId` (a re-delivered exec), settled once its state is published; null
     *  with none. */
    joining(requestId) {
      const dir = requestDirectory(root, requestId);

      return fs.existsSync(dir) ? waitForFile(path.join(dir, 'state')) : null;
    },
  };
}

module.exports = {
  STATUS_FD,
  createSupervision,
  readOutputRecords,
  supervisionSupported,
  assertSupervisionSupported,
  requestDirectory,
  processStartIdentity,
  waitForFile,
  waitForSupervisorState,
  stopSupervisor,
};
