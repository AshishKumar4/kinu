#!/usr/bin/env bun
// Kinu PC agent — reverse-WebSocket daemon.
// Runs under the Kinu CLI's bundled Bun (global fetch + global WebSocket). No external deps.
'use strict';

const fs = require('node:fs');

const path = require('node:path');

const os = require('node:os');

const crypto = require('node:crypto');

const sha256Of = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * A write frame: confined as a write and checkpointed as one, then `write` with the decoded bytes. An answer that wrote
 * nothing (`ok: false`) carries no checkpoint note.
 */
function checkpointedWrite(msg, { requested, content, options }, checkpoints, write) {
  const view = viewFromFrame(msg);
  const confined = confinedDeviceViewPath(view, requested, 'write');
  const covers = (candidate) => view.checkpointDirectory(candidate).why === null;

  const verdict = checkpoints && msg.checkpoint
    ? view.checkpointDirectory(hintedDir(msg.checkpoint) ?? checkpoints.workdirForPath(confined, covers))
    : null;

  const data = options?.encoding === 'base64' ? Buffer.from(String(content), 'base64') : Buffer.from(String(content));

  return mutation(checkpoints, { view, hint: msg.checkpoint }, coveredBy(verdict), (snapshot) => {
    const answer = write(view, confined, data);

    if (answer.ok === false) return answer;
    const skipped = whyUncheckpointed(verdict, snapshot);

    return skipped === null ? answer : { ...answer, uncheckpointed: skipped };
  });
}

/**
 * Writes `data` only if the file's bytes still hash to `expected` (null: only if no file is there), over the file in
 * place, as a plain write does: the file keeps its inode, owner, group, mode, ACLs and every other link to it, and a file
 * this user may not write is refused. The compare and the write run here in one synchronous step of this process, so no
 * other write of this daemon interleaves. Answers the new digest, or the one found (null: absent). `target` is the
 * judged path; the step runs where it still is (`atJudged`).
 */
function replaceIfDigest(view, target, data, expected) {
  return atJudged(view, target, { createParents: true }, (at) => {
    let found = null;

    try {
      found = sha256Of(readEntry(at));
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
    }

    if (found !== expected) return { ok: false, sha256: found };
    // A create only where nothing is yet; a replacement only of a file still there.
    writeEntry(at, found === null ? fs.constants.O_CREAT | fs.constants.O_EXCL : fs.constants.O_TRUNC, data);

    return { ok: true, sha256: sha256Of(data) };
  });
}

/** The bytes of the file entry `at` names. */
function readEntry(at) {
  const fd = at.open(fs.constants.O_RDONLY);

  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** `data` written to the file entry `at` names, opened for writing with `flags`. */
function writeEntry(at, flags, data) {
  const fd = at.open(fs.constants.O_WRONLY | flags, 0o666);

  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

const { atJudged, movedUnderneath } = require('./daemon/held.js');

const sandbox = require('./sandbox.js');

const pty = require('./pty.js');

const supervisor = require('./daemon/supervisor.js');

const { log, errorDetail } = require('./daemon/log.js');

const update = require('./update.js');

const machinePidfile = require('../../cli-backend/src/machine-pidfile.ts');

const { KINU_BUN_VERSION, approvedBun, bunResolutionShell } = require('../../core/src/cli/bun-runtime.ts');

const { DAEMON_PREDECESSOR_ENV } = require('../../core/src/cli/command-env.ts');

const protocol = require('./device-protocol.json');

const METHODS = Object.fromEntries(Object.keys(protocol.methods).map((name) => [name, name]));

const FRAMES = protocol.frames;

const chatgpt = require('./chatgpt.js');

const { runToExit } = update;

/** This daemon's own file, as Bun started it. Not `__filename`: a release bundles this file, and the bundler writes the
 *  source's path into it. */
const daemonPath = () => require.main.filename;

const HOME_SETTING = process.env.KINU_HOME?.trim() ?? '';

const DEVICE_HOME = path.resolve(HOME_SETTING === '' ? path.join(os.homedir(), '.kinu') : HOME_SETTING);

/** The build this process IS: the stamp beside the daemon when it started,
 *  read once. The file may change under a running daemon (an update lands
 *  it before the successor connects); what this process reports is what it
 *  loaded. */
const RUNNING_VERSION = update.readVersionStamp(DEVICE_HOME);


const CONFIG_PATH = path.join(DEVICE_HOME, 'device.json');

/** The directory this daemon owns for agent homes. The HUB computes the home
 *  for one (device, workspace) beneath it and sends it on the exec frame; the
 *  daemon owns the PATH so an uninstall has one directory to remove. */
const AGENT_ROOT = path.join(DEVICE_HOME, 'agents');

/** One daemon owns a machine. This file names the process that owns it, and
 *  the daemon claims it in its own process — the CLI is not the only thing
 *  that can start this file. */
const PID_PATH = path.join(DEVICE_HOME, 'pc-agent.pid');

/** What this daemon exits with when another daemon already owns the machine.
 *  Not a failure: the machine has its daemon and this process is the extra
 *  one. `packages/cli/tests/device-connect.test.ts` pins the number. */
const ALREADY_RUNNING_EXIT = 3;

const TOKEN_ROTATION = FRAMES.rotate;

/** This daemon's answer once the rotated token is on disk, core's
 *  DEVICE_FRAMES.rotated. The hub keeps the superseded token valid until
 *  this frame arrives and drops it then, so the grace covers exactly the
 *  failure it exists for — a rotation lost with its socket — and not the
 *  indefinite window a copy of device.json could spend. */
const TOKEN_ROTATION_ACK = FRAMES.rotated;

/** The hub's close code for a token it will not accept again, and the message
 *  the ticket exchange raises for the same refusal over HTTP. Both mean the
 *  same thing: this machine's credential is dead and no amount of retrying
 *  brings it back, so the daemon stops LOUDLY instead of dialling forever. */
const CREDENTIALS_REJECTED_CLOSE = 4401;

/** The hub's close reason when another socket took this device's slot. Its
 *  words, verbatim (`DEVICE_SOCKET_REPLACED_REASON` in core): after this
 *  daemon started its successor, that close is the successor connecting, and
 *  this daemon's cue to exit. */
const SOCKET_REPLACED_REASON = 'replaced by a new connection';

const CREDENTIALS_REJECTED = 'device credentials were rejected; re-run: kinu connect';

/** The shape the hub mints a device token in (`pdt_` and 32 url-safe characters). */
const DEVICE_TOKEN = /^pdt_[A-Za-z0-9_-]{32,}$/;

/** Hosts a development hub may serve over plain http from the owner's own
 *  machine; the token never crosses a network there. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const REJECTED_EXIT = 4;

/** The hub answers this text frame with `pong` (its socket auto-response), so
 *  a half-open socket — the case a TCP-level close never reports — is found in
 *  40 s rather than at the next command the owner is waiting for. */
const PING_FRAME = FRAMES.ping;

const PONG_FRAME = FRAMES.pong;

const PING_INTERVAL_MS = 30_000;

const PONG_DEADLINE_MS = 10_000;

const { KINU_INFLIGHT_ROOT } = process.env;

/** What the dotenv files in this daemon's launch directory put into its environment; no command inherits it. */
const LAUNCH_DOTENV = sandbox.launchDotenv(process.cwd(), process.env.NODE_ENV);

const CANCEL_METHOD = METHODS.cancel;

/** How much a range read allocates at a time, so memory follows the bytes the
 *  file actually has rather than the length a caller asked for. */
const READ_CHUNK_BYTES = 1024 * 1024;

/**
 * The terminal protocol, which is the one thing on this socket that is not a
 * correlated call.
 *
 * Opening IS a call: it is the moment consent is decided, so it carries a
 * request id, it answers once, and the hub composes the same `sandbox` block
 * onto it that it composes onto `exec`. Everything after it is a stream —
 * keystrokes in, bytes and an exit status out — and a stream has nothing to
 * correlate, so those frames carry a session name instead of an id.
 */
const PTY_OPEN_METHOD = METHODS.ptyOpen;

const PTY_INPUT_FRAME = FRAMES.ptyInput;

const PTY_RESIZE_FRAME = FRAMES.ptyResize;

const PTY_OUTPUT_FRAME = FRAMES.ptyOutput;

const PTY_EXIT_FRAME = FRAMES.ptyExit;

/** The frames the hub sends a live session. Each names a session this daemon
 *  already opened, so none of them is a way to start work. */
const PTY_FRAMES = new Set([PTY_INPUT_FRAME, PTY_RESIZE_FRAME]);

/**
 * How far behind the socket may fall before live output — a terminal's, or a
 * running command's — is dropped rather than queued.
 *
 * Live output has no end to wait for, so a program writing faster than the
 * socket drains would grow this daemon's heap without bound. Queueing does not
 * help a display — the newest bytes ARE the picture, and a command's result
 * still carries every byte — so past this backlog the newest frame is dropped
 * and counted. A full repaint of a large window is tens of kilobytes, so this
 * holds several of them and a brief stall stays invisible.
 */
const LIVE_BACKLOG_MAX_BYTES = 256 * 1024;

/**
 * The provider relay: the hub asks this machine to make a model call for the
 * owner's web session. One call is one correlated RPC that answers when the
 * body ends; the head and each body chunk go back as uncorrelated frames
 * naming the call, so an answer streams as the provider sends it. The names
 * and the allow-list mirror core's DEVICE_RELAY (execution/device-relay.ts),
 * codexEgressAllowed (providers/codex.ts) and chatgptEgressAllowed
 * (providers/chatgpt.ts); cf-backend's pc-agent test holds them equal.
 *
 * Two hosts. chatgpt.com refuses Kinu's cloud network, so a Codex call comes
 * with the owner's access token in its headers; it lives in this request's
 * memory only. api.openai.com is the ChatGPT plan, and its token is this
 * machine's own sign-in (chatgpt.js), attached here and never sent to the hub.
 * Nothing here logs a header or a body.
 */
const RELAY_METHOD = METHODS.codexRelay;

const RELAY_HEAD_FRAME = FRAMES.relayHead;

const RELAY_BODY_FRAME = FRAMES.relayBody;

const CHATGPT_HOST = 'api.openai.com';

const RELAY_ROUTES = Object.freeze({
  'chatgpt.com': Object.freeze(['GET /backend-api/codex/models', 'POST /backend-api/codex/responses', 'GET /backend-api/wham/usage']),
  [CHATGPT_HOST]: Object.freeze(['GET /v1/models', 'POST /v1/responses']),
});

/** The hub's calls on this machine's ChatGPT sign-in, core's DEVICE_CHATGPT. */
const CHATGPT_METHODS = Object.freeze({ status: METHODS.chatgptStatus, signIn: METHODS.chatgptSignIn, signOut: METHODS.chatgptSignOut });

/** The error code of the answer a relayed ChatGPT call gets when this machine holds no usable sign-in. */
const CHATGPT_SIGNED_OUT = 'chatgpt_signed_out';

/** The daemon that started this one as its successor, which may still be finishing a rotation of its own. */
const replacedDaemon = isPredecessor(process.ppid) ? process.ppid : null;

function predecessorExited() {
  return update.lifelineClosed(process.stdin).then(() => { log('device.predecessor_exited', `pid ${String(replacedDaemon)}`); });
}

const chatgptSession = chatgpt.createDeviceSession({ home: DEVICE_HOME, predecessorExited: replacedDaemon === null ? null : predecessorExited() });

let exiting = false;

/**
 * Exits once this machine's ChatGPT sign-in has written what it is writing, so a successor never reads a spent
 * refresh token: an update handoff or a first stop signal waits for the auth call in flight to end, as long as
 * that takes. A second call is a forced stop: that call ends there, unanswered, and the exit follows.
 */
function exitWhenQuiet(code) {
  if (exiting) {
    log('device.exit_forced', 'the ChatGPT auth call in flight is abandoned');
    chatgptSession.abort();

    return;
  }

  exiting = true;
  const exit = () => process.exit(code);

  log('device.exit_draining', 'the ChatGPT sign-in finishes the write in flight first');
  chatgptSession.quiesce().then(exit, exit);
}

/** Hop-by-hop headers, plus the ones a relay must not carry from the cloud side. */
const RELAY_DROPPED_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'host', 'content-length', 'x-forwarded-for',
]);

/** In-flight relays by call id, so a cancel can stop one. */
const relays = new Map();


/** The directory a checkpoint hint names, or undefined when it names none, so
 *  the caller's own fallback is what `??` reaches. */
function hintedDir(hint) {
  const dir = hint.dir ?? '';

  return dir === '' ? undefined : dir;
}

/** What `sandbox.probe()` answered at start. Read by HELLO and by the exec
 *  frame's own refusal, so it is proved once rather than per command. */
let SANDBOX_CAPABILITY = { status: sandbox.SANDBOX_STATUS.PROBE_FAILED, detail: 'the sandbox probe has not run yet' };

function rpcError(cause) {
  return { code: cause?.code ?? 'io', message: cause instanceof Error ? cause.message : String(cause) };
}

function rpc(ws, id, result, error) {
  try {
    ws.send(JSON.stringify(error === undefined ? { id, result: result ?? null } : { id, error: rpcError(error) }));
  } catch (cause) {
    log('device.frame_dropped', 'rpc_answer', errorDetail(cause));
  }
}

// ── Shadow-git checkpoints ─────────────────────────────────────────────
//
// One engine with the CLI's, core's checkpoints/format.ts and
// checkpoints/engine.ts, so a machine's checkpoints are taken by the same rules
// and read alike whichever side wrote them:
//
//   <device home>/checkpoints/<agent>/<sha256(dir)[:16]>/ — bare GIT_DIR
//     KINU_WORKDIR                                    — the target dir
//     info/exclude                                       — default excludes
//     refs/kinu/<ms13>-<seq>                          — one ref per snapshot
//
// Invisible infrastructure: mutating RPC frames (exec/writeFile) may carry a
// `checkpoint` hint — the daemon snapshots the target dir before executing,
// once per agent turn. Restore/list/plan are explicit RPC methods. Degrades
// honestly to "checkpoints unavailable: git not found" without blocking
// anything.

const { DEFAULT_CHECKPOINT_KEEP } = require('../../core/src/checkpoints/format.ts');

const { createCheckpointEngine } = require('../../core/src/checkpoints/engine.ts');

/** What a confined checkpoint git exits with when its work tree is not there inside the sandbox; git never exits so. */
const CHECKPOINT_TREE_UNSEEN = 73;

/** What a confined checkpoint git exits with when there is no git inside the sandbox: bash's own for a missing command. */
const CHECKPOINT_GIT_MISSING = 127;

/**
 * The argv, environment and directory a checkpoint git runs with: as this daemon's own process for a raw view, else
 * inside the frame's sandbox (L111 #3) with its store writable. There it enters its work tree itself, so a tree that
 * leads out of the roots is one it cannot see, and says so by its exit.
 */
function checkpointGitRun(confine, bin, args, options) {
  if (confine === null) return { file: bin, argv: [...args], cwd: options.cwd, env: options.env };
  const { view } = confine;

  // A sandboxed frame's checkpoint runs only where its commands would: never unconfined on a machine with no sandbox.
  if (SANDBOX_CAPABILITY.status !== sandbox.SANDBOX_STATUS.OK) {
    throw new Error(`checkpoints need this device's sandbox, which it does not have (${SANDBOX_CAPABILITY.status}): ${SANDBOX_CAPABILITY.detail}`);
  }

  // Made on first use, as a sandboxed command's are: the sandbox starts in the agent's home.
  for (const dir of [view.agentHome, view.agentTmp]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const env = { ...options.env };

  // The work tree as the sandbox names it, where git looks for it inside.
  if (env.GIT_WORK_TREE !== undefined) env.GIT_WORK_TREE = view.insidePath(env.GIT_WORK_TREE);
  const program = ['bash', '-c', `cd -- "$1" || exit ${CHECKPOINT_TREE_UNSEEN}; shift; exec "$@"`, 'kinu-checkpoint', view.insidePath(options.cwd), bin, ...args];
  const planned = sandbox.confined({ view, program, env, writable: [options.env.GIT_DIR ?? path.join(DEVICE_HOME, 'checkpoints')] });

  // The sandbox launcher is found on the daemon's own PATH, as a sandboxed command's is; git's environment is its own.
  return { file: planned.argv[0], argv: planned.argv.slice(1), cwd: planned.cwd, env: { PATH: process.env.PATH, ...planned.env } };
}

/** Why a confined checkpoint could not reach its work tree, naming the roots it had to stay in. */
function treeOutsideRoots(view, tree) {
  const root = view.roots.find((candidate) => tree === candidate || tree.startsWith(`${candidate}/`));
  const given = root ?? (view.roots.length === 0 ? `the agent's own home, ${view.agentHome}` : view.roots.join(', '));

  return new Error(`checkpoint directory '${tree}' is no longer inside ${given}, which this workspace was given on this device: something in its path now leads out of it, so no checkpoint reads or restores it`);
}

/** This daemon's frames over core's one checkpoint engine: a hint names the agent, its turn and the directory. */
function createCheckpoints(opts = {}) {
  const engine = createCheckpointEngine({
    fs, path, homedir: os.homedir(), tmpdir: os.tmpdir(), devNull: os.devNull, env: process.env,
    sha256: (text) => crypto.createHash('sha256').update(text).digest('hex'),
    run: async (bin, args, { cwd, env, maxBuffer, confine }) => {
      const run = checkpointGitRun(confine, bin, args, { cwd, env });
      const { error, stdout, stderr } = await runToExit(run.file, run.argv, { cwd: run.cwd, env: run.env, maxBuffer, encoding: 'utf8' });
      // A code that is not an exit status (a signal, an overfull buffer) is git never finishing.
      const finished = error === null || Number.isInteger(error.code);
      const code = finished ? (error?.code ?? 0) : null;

      if (confine !== null && code === CHECKPOINT_TREE_UNSEEN) throw treeOutsideRoots(confine.view, cwd);

      return {
        code, stdout: String(stdout), stderr: String(stderr),
        missing: error !== null && (error.code === 'ENOENT' || (confine !== null && code === CHECKPOINT_GIT_MISSING)),
      };
    },
    now: () => Date.now(),
    log: (message) => { log(message); },
  }, {
    base: opts.base ?? path.join(DEVICE_HOME, 'checkpoints'),
    keep: opts.keep ?? DEFAULT_CHECKPOINT_KEEP,
    gitBin: opts.gitBin ?? 'git',
  });

  /** The snapshot a frame's hint asks for under its `view`, or null when it asks none. */
  const requestFor = (view, hint, fallbackDir) => {
    const dir = hint ? (hintedDir(hint) ?? fallbackDir) : undefined;

    if (!hint || !dir) return null;

    const named = (field) => ((field ?? '') === '' ? null : field);

    return {
      agent: String(hint.agent ?? ''), dir, turn: { turnId: named(hint.turnId), sessionId: named(hint.sessionId) }, reason: 'pre-mutation',
      confine: confinementOf(view),
    };
  };

  return {
    status: () => engine.status(),
    /** The pre-mutation snapshot the hint asks for, in store order: its id, or null when none was taken. */
    ensure: (view, hint, fallbackDir) => engine.mutate(requestFor(view, hint, fallbackDir), (outcome) => (outcome !== null && 'id' in outcome ? outcome.id : null)),
    /** `apply`, a frame's mutation, after the snapshot its hint asks for, handed that snapshot's outcome. */
    mutate: (view, hint, fallbackDir, apply) => engine.mutate(requestFor(view, hint, fallbackDir), apply),
    list: (agent, limit, turnId) => engine.list(String(agent ?? ''), { limit, turnId }),
    plan: (view, agent, dir, id) => engine.plan(String(agent ?? ''), dir, String(id), confinementOf(view)),
    restore: (view, agent, dir, id) => engine.restore(String(agent ?? ''), dir, String(id), confinementOf(view)),
    workdirForPath: (p, covers) => engine.workdirForPath(p, covers),
  };
}

// ── PATH lookup (the toolchain probe's device half) ────────────────────
//
// `which` answers ONE closed question: which of the binary NAMES the caller
// asked about resolve on this machine's PATH. The names come from core's single
// toolchain table (packages/core/src/execution/toolchain.ts) and the hub sends
// them with the question, so this daemon holds no capability policy of its own —
// there is no second answer to "which binaries prove python" here to drift from
// the one the CLI host uses. The hub turns the names back into the `device`
// capability row, which is where the model decides to send work.
//
// Bare names only, and a bounded number of them. A name carrying a path
// separator would make this a way to test arbitrary paths on the user's machine
// for existence, and the capability row needs nothing of the sort.
//
// PATH is read per call, never cached: the agent can install a toolchain onto
// this machine through `exec`, and a cached row that outlived its measurement is
// the failure the probe exists to prevent.
const BARE_BINARY_NAME = /^[A-Za-z0-9._+-]{1,64}$/;

const WHICH_MAX_NAMES = 64;

/** The names this daemon will answer about, parsed out of the frame: bare
 *  binary names, and nothing else. */
function probeNames(raw) {
  if (!Array.isArray(raw)) throw new Error('which expects an array of binary names');
  const names = [];

  for (const value of raw.slice(0, WHICH_MAX_NAMES)) {
    const name = String(value);

    // `name === value` rejects anything that merely stringifies into a name — a
    // number, a boxed object — because only a name is a name.
    if (name === value && BARE_BINARY_NAME.test(name)) names.push(name);
  }

  return names;
}

/** The names an executable file on PATH provides, resolved as the CLI host resolves them (`Bun.which`, PATH passed so a
 *  toolchain installed since start counts). */
function whichAll(names) {
  const PATH = String(process.env.PATH ?? '');

  return probeNames(names).filter((name) => Bun.which(name, { PATH }) !== null);
}

/** Where each command's supervisor keeps its record, which outlives this daemon (daemon/supervisor.js). */
const INFLIGHT_ROOT = path.resolve(
  KINU_INFLIGHT_ROOT === undefined || KINU_INFLIGHT_ROOT === '' ? path.join(DEVICE_HOME, 'inflight') : KINU_INFLIGHT_ROOT,
);

const EXEC_ACK_METHOD = METHODS.execAck;

/**
 * A running command's output, sent only to a hub whose exec frame asked with
 * `output: true`: `{ type, request, chunks: [{ stream, data }], dropped }`,
 * each chunk's bytes in base64, `dropped` the bytes left out since the last
 * frame. A hub that never asks gets no frame and the command gets no output
 * pipe.
 */
const EXEC_OUTPUT_FRAME = FRAMES.execOutput;

/** At most one output frame per request per interval, holding at most the
 *  newest window of bytes: the rate and size core's job feed sends at. */
const EXEC_OUTPUT_FLUSH_MS = 250;

const EXEC_OUTPUT_WINDOW_BYTES = 16 * 1024;

/** Named before the command is written to disk, so the answer is one error
 *  frame that says what to do rather than a supervisor that exits 125. */
function assertCommandShellPresent() {
  if (whichAll([COMMAND_SHELL]).length === 0) {
    throw new Error(`device commands run under ${COMMAND_SHELL}, which is not on this machine's PATH; install ${COMMAND_SHELL} and reconnect`);
  }
}

function parseString(value, expectation) {
  try {
    const string = String.prototype.valueOf.call(value);

    if (string !== value) throw new Error(expectation);

    return string;
  } catch (err) {
    if (err instanceof TypeError) throw new Error(expectation, { cause: err });
    throw err;
  }
}

function parseRecord(value, expectation) {
  if (value === null || Object(value) !== value || Array.isArray(value)) throw new Error(expectation);
  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) throw new Error(expectation);

  return value;
}

/** The one shell a device command runs under, resolved on the machine's PATH
 *  rather than at a fixed path.
 *
 *  `/bin/sh` is dash on Debian and Ubuntu, so every command the model wrote
 *  with `[[ `, `set -o pipefail`, arrays or process substitution failed on
 *  those machines and succeeded on the ones where `/bin/sh` happens to be
 *  bash. One shell removes that difference. There is deliberately NO fallback:
 *  a second shell is a second behaviour, reached only on the machines nobody
 *  tests, and an exec that cannot find bash says so instead. */
const COMMAND_SHELL = 'bash';

/** Exec requests whose supervisor has not published its state yet, by request
 *  id. Each waits behind its pre-mutation snapshot in checkpoint-store order;
 *  a re-delivered frame joins it, and a cancel lets it start before stopping it. */
const starting = new Map();

/** One daemon, one set of supervisors. */
const supervision = supervisor.createSupervision({ root: INFLIGHT_ROOT, isStarting: (requestId) => starting.has(requestId), log });

// ── RPC dispatch ───────────────────────────────────────────────────────

const UNTIERED = 'this device refuses a frame that names no sandbox tier: '
  + 'the hub decides one for every call that runs a command or touches a file';

/** One workspace's segment under the agent root: the characters a workspace
 *  name may carry, and never `.` or `..`. */
const AGENT_SEGMENT = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The agent home a sandboxed frame names: exactly `<agentRoot>/<workspace>/home`
 * for ONE workspace. A name carrying `a/../b` composes a path that resolves
 * under the root and is workspace b's home.
 */
function frameAgentHome(value) {
  const spelled = parseString(value, 'device sandbox options must name an agent home');
  const segments = spelled.startsWith(`${AGENT_ROOT}/`) ? spelled.slice(AGENT_ROOT.length + 1).split('/') : [];
  const [workspace = '', home = ''] = segments;

  if (segments.length !== 2 || home !== 'home' || !AGENT_SEGMENT.test(workspace) || workspace === '.' || workspace === '..') {
    throw new Error(`device sandbox agent home must be ${AGENT_ROOT}/<workspace>/home, for one workspace`);
  }

  return spelled;
}

/**
 * The sandbox block of a frame that reaches this machine: the tier, the
 * consented roots, and a sandboxed frame's one agent home. The hub composes it
 * from the owner's Sandbox switch for every method that runs something or
 * touches a file, so a frame without a tier did not come from a hub that
 * decided one: it is refused, never read as unconfined. A consented root of
 * `/` is the whole machine, which is what the switch off means, so that frame
 * runs raw. `agentHome()` checks the agent home a sandboxed frame names.
 */
function frameSandbox(msg) {
  const block = parseRecord(msg.sandbox ?? null, UNTIERED);

  if (block.tier !== 'raw' && block.tier !== 'sandboxed') throw new Error(UNTIERED);

  const roots = Array.isArray(block.roots)
    ? block.roots.map((root) => path.resolve(parseString(root, 'device sandbox roots must be paths')))
    : [];

  return {
    tier: block.tier === 'raw' || roots.includes('/') ? 'raw' : 'sandboxed',
    roots,
    agentHome: () => frameAgentHome(block.agentHome),
  };
}

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EACCES')) return false;
    throw err;
  }
}

/**
 * Where an unsandboxed command runs when the frame names no directory: the
 * directory the owner shared, else their home. Never this daemon's own working
 * directory, which is Kinu's directory once the daemon has updated itself.
 */
function rawWorkingDirectory(msg, roots) {
  const named = msg.cwd === undefined ? null : path.resolve(parseString(msg.cwd, 'exec cwd must be a path'));

  return [named, ...roots].find((dir) => dir !== null && isDirectory(dir)) ?? os.homedir();
}

/**
 * The sandbox the hub asked for, as this daemon will enforce it.
 *
 * The hub DECIDES the tier (the owner's per-device Sandbox switch) and this
 * daemon only enforces it, with one exception that is deliberately not a
 * downgrade: a frame asking for 'sandboxed' on a machine whose own probe said
 * it cannot sandbox is REFUSED, never run raw. The hub refuses it too; this is
 * the second of the two, because the machine is the only party that knows
 * whether its kernel will cooperate.
 *
 * `source` is the environment the tier's own allow-list filters. A command
 * takes this daemon's; a terminal session takes the same with `TERM` set to
 * the terminal it was just given. `statusFd` is the descriptor the sandbox
 * reports on, which only a command's supervisor holds open: a terminal's
 * program has its pty alone, and a sandbox told to write to a descriptor it
 * does not have exits before the shell starts.
 */
async function planFromFrame(msg, command, { source = process.env, statusFd } = {}) {
  const frame = frameSandbox(msg);

  if (frame.tier === 'raw') {
    return sandbox.plan({
      tier: 'raw', deviceHome: DEVICE_HOME, command, cwd: rawWorkingDirectory(msg, frame.roots), source, dotenv: LAUNCH_DOTENV,
    });
  }

  if (SANDBOX_CAPABILITY.status !== sandbox.SANDBOX_STATUS.OK) {
    const error = new Error(`sandbox_unavailable (${SANDBOX_CAPABILITY.status}): ${SANDBOX_CAPABILITY.detail}`);
    error.code = protocol.errors.sandboxUnavailable;
    error.reason = SANDBOX_CAPABILITY.status;
    throw error;
  }

  const agentHome = frame.agentHome();
  const agentTmp = path.join(path.dirname(agentHome), 'tmp');

  // Created on first use, 0700: the hub computes the path per (device,
  // workspace) and this machine is the only one that can make the directory.
  for (const dir of [agentHome, agentTmp]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  await sandbox.ensureUvmNode();

  return sandbox.plan({
    tier: 'sandboxed',
    home: os.homedir(),
    agentHome,
    agentTmp,
    deviceHome: DEVICE_HOME,
    roots: frame.roots,
    cwd: msg.cwd === undefined ? agentHome : path.resolve(parseString(msg.cwd, 'exec cwd must be a path')),
    command,
    source,
    dotenv: LAUNCH_DOTENV,
    ...(statusFd !== undefined && { statusFd }),
  });
}

/**
 * The view this FRAME's file methods are confined to: the same block an exec
 * frame carries, so both enforcers read one policy — the kernel for the shell,
 * this view for the file methods.
 *
 * NO capability check here, deliberately. A machine that cannot sandbox is
 * `files_only`, and that state exists so its file methods keep working: this
 * enforcer is JavaScript in the daemon and needs no kernel to be correct.
 */
function viewFromFrame(msg) {
  const frame = frameSandbox(msg);

  if (frame.tier === 'raw') return sandbox.rawViewFor({ platform: os.platform(), deviceHome: DEVICE_HOME });
  const agentHome = frame.agentHome();

  return sandbox.viewFor({
    platform: os.platform(),
    home: os.homedir(),
    agentHome,
    agentTmp: path.join(path.dirname(agentHome), 'tmp'),
    deviceHome: DEVICE_HOME,
    roots: frame.roots,
  });
}

/**
 * A path's size, mtime and kind, or null when there is nothing there. `follow: false` is lstat, of the entry as
 * unlink takes it: a link is the link, so a removal walking a tree takes the name and never goes on into what it leads to.
 */
function statPathAnswer(msg) {
  const { params } = msg;
  const follow = (params[1] ?? {}).follow !== false;
  const view = viewFromFrame(msg);
  const confined = follow ? confinedDeviceViewPath(view, params[0], 'read') : view.resolveEntryPath(parseString(params[0], 'device paths must be strings'), 'read');
  const stat = follow ? statJudged(view, confined) : atJudged(view, confined, {}, (at) => at.stat());

  return stat === undefined ? null : { size: stat.size, mtimeMs: stat.mtimeMs, type: statType(stat) };
}

/**
 * What a judged path holds, read where it was judged (L111 #2): the view resolved every link in it, so a link found
 * there now is one a command put in its place since, and its target is no part of the judgment. A raw view judged
 * nothing, and follows it as the device's own commands do.
 */
function statJudged(view, judged) {
  if (view.raw === true) return fs.statSync(judged, { throwIfNoEntry: false });
  const stat = atJudged(view, judged, {}, (at) => at.stat());

  if (stat !== undefined && stat.isSymbolicLink()) throw movedUnderneath(judged);

  return stat;
}

/**
 * The entry rmdir removes, as unlink takes it, so a link is no directory here and rmdir refuses it; the directory
 * itself is judged as well as its parent, so Kinu's own directory is never one a frame removes.
 */
function rmdirEntry(view, msg) {
  const requested = parseString(msg.params[0], 'device paths must be strings');

  view.resolvePath(requested, 'write');

  return view.resolveEntryPath(requested, 'write');
}

/** A stat's kind as the device file contract names it: a link (lstat only), a directory, or a file. */
function statType(stat) {
  if (stat.isSymbolicLink()) return 'symlink';

  return stat.isDirectory() ? 'directory' : 'file';
}

/** One file method's path, through the frame's view. `mode` is what the method
 *  does to the path, and the view refuses exactly what the kernel would. */
function confinedDeviceViewPath(view, requested, mode) {
  return view.resolvePath(parseString(requested, 'device paths must be strings'), mode);
}

/**
 * Why no checkpoint covers what a mutating frame changes, as `{ dir, why }` the
 * turn is told, or null when one does or none was asked for. `verdict` is the
 * view's on the directory a checkpoint would cover; `snapshot` is what the
 * store answered when asked for one.
 */
function whyUncheckpointed(verdict, snapshot) {
  if (verdict === null) return null;

  if (verdict.why !== null) {
    log('device.checkpoint_skipped', verdict.path, verdict.why);

    return { dir: verdict.path, why: `it is ${verdict.why}` };
  }

  return snapshot?.skipped === undefined ? null : { dir: verdict.path, why: snapshot.skipped };
}

/** How a frame's checkpoint git is confined: in its sandbox, or not at all for a raw view, which judged nothing. */
function confinementOf(view) {
  return view.raw === true ? null : { view };
}

/** The directory a verdict lets a checkpoint cover, or null. */
function coveredBy(verdict) {
  return verdict !== null && verdict.why === null ? verdict.path : null;
}

/** A checkpoint RPC's directory, through the frame's view; a refusal names why. */
function checkpointDirFor(view, requested) {
  const dir = parseString(requested, 'checkpoint directories must be paths');
  const verdict = view.checkpointDirectory(dir);

  if (verdict.why !== null) throw new Error(`device path '${dir}' is ${verdict.why}`);

  return verdict.path;
}

/**
 * Up to `length` bytes of `file` from `offset`, fewer at its end. The hub asks
 * for a large file a range at a time, each answer under the socket's 32 MiB
 * receive ceiling, so the whole file crosses whatever its size.
 */
function readRangeBytes(view, file, offset, length) {
  // Opened where the view judged it, not by its name again: a directory of it swapped for a link since reads nothing
  // outside the root (L111 #2).
  const descriptor = atJudged(view, file, {}, (at) => at.open(fs.constants.O_RDONLY));

  try {
    const chunks = [];
    let total = 0;

    while (total < length) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, length - total));
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, offset + total);

      if (read === 0) break;
      chunks.push(chunk.subarray(0, read));
      total += read;
    }

    return Buffer.concat(chunks, total);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * One entry as a listing names it, with the size and modification time a `statPath` of it answers (links followed),
 * so a reader of a large directory needs no stat per entry. An entry gone since the read, a broken or looping link, or
 * one in a directory this user may list but not search carries its name alone.
 */
function listEntry(view, dir, entry) {
  const stat = entryStat(view, dir, entry);
  const named = { name: entry.name, type: (stat === undefined ? entry.isDirectory() : stat.isDirectory()) ? 'dir' : 'file' };

  return stat === undefined ? named : { ...named, size: stat.size, mtimeMs: stat.mtimeMs };
}

/** What leaves a listed entry its name alone: gone, unreadable, looping, or a link the view does not let this frame read. */
const NAME_ALONE = new Set(['EACCES', 'ELOOP', 'ENOENT', sandbox.VIEW_INVISIBLE]);

/**
 * An entry's stat as a listing shows it, links followed. Its own, read through the directory the listing holds; a link's
 * target only where the view lets this frame read it, judged and read as `statPath` reads it: a link out of the root
 * shows its name alone, as one that is broken does (L111 #2).
 */
function entryStat(view, dir, entry) {
  try {
    if (!entry.isSymbolicLink()) return entry.stat();

    return statJudged(view, view.resolvePath(path.join(dir, entry.name), 'read'));
  } catch (err) {
    if (err && NAME_ALONE.has(err.code)) return undefined;
    throw err;
  }
}

/**
 * A `listFiles` frame's answer. The home DEFAULTS to the agent's when the
 * frame carries one, which is the directory the model is told `~` is, not the
 * owner's. A hub from before paging names no page and reads every entry in
 * one answer.
 */
function listFilesAnswer(msg) {
  const { params } = msg;
  const frame = frameSandbox(msg);
  const requested = params[0] ?? (frame.tier === 'sandboxed' ? frame.agentHome() : os.homedir());
  const dir = confinedDeviceViewPath(viewFromFrame(msg), requested, 'read');
  const page = parseRecord(params[1] ?? {}, 'listFiles options must be an object');

  const view = viewFromFrame(msg);
  const offset = page.offset ?? 0;

  if (page.limit !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(page.limit) || page.limit <= 0)) {
    throw new Error('listFiles pages by a non-negative offset and a positive limit');
  }

  // Read where the view judged it, through its descriptor: a link swapped in for it lists nothing (L111 #2).
  return atJudged(view, dir, {}, (at) => at.list((entries) => (page.limit === undefined
    ? entries.map((entry) => listEntry(view, dir, entry))
    : listPage(entries, offset, page.limit, (entry) => listEntry(view, dir, entry)))));
}

/**
 * One page of a directory, in the order the filesystem yields it: `next` is
 * the offset of the page after, or null past the last entry. The hub pages a
 * large directory so each answer stays under the socket's receive ceiling.
 */
/** One page of a listing: `limit` entries from `offset`, each as `show` shows it, and where the next page starts. */
function listPage(listed, offset, limit, show) {
  const entries = listed.slice(offset, offset + limit).map(show);

  return { entries, next: offset + limit < listed.length ? offset + limit : null };
}

/**
 * The program a terminal session runs.
 *
 * `plan()` builds `bash -c <command>` for every tier, and this is that command:
 * become an interactive shell. The `exec` makes it one process rather than a
 * shell inside a shell, and going through `plan` unchanged is the point — a
 * session is confined by exactly the argv, environment and mounts a command
 * on this device is confined by, computed by the same function, with no second
 * policy for terminals to drift from.
 */
const SESSION_COMMAND = `exec ${COMMAND_SHELL} -i`;

/**
 * The environment the session's plan is built from.
 *
 * One name is added to this daemon's own: the terminal it is about to be given.
 * `TERM` is already on the sandbox environment's allow-list, so both tiers
 * carry it through the same filter, and a full-screen program is told the
 * truth about what it is drawing on. A daemon started by a launcher has no
 * `TERM` of its own to inherit.
 */
function sessionSource() {
  return { ...process.env, TERM: pty.TERMINAL_NAME };
}

/**
 * The environment the session LEADER runs with.
 *
 * The leader becomes the planned program, and finding it means resolving a
 * bare name — `bwrap`, or the shell — on a PATH. A sandboxed plan deliberately
 * hands the command no environment at all, because bwrap re-establishes it
 * with `--setenv`, so PATH here reaches the leader and never the command. A
 * raw plan already carries its own allow-listed PATH, which wins.
 */
function leaderEnvironment(plan) {
  return { PATH: process.env.PATH, ...plan.env };
}

/**
 * One frame of live output — a terminal's, or a running command's — to the
 * hub, and whether the socket took it.
 *
 * `false` is not a failure: it means this socket is too far behind to be
 * caught up by queueing, and the sender counts what it dropped.
 *
 * The backlog rule covers OUTPUT alone. A terminal's newest bytes are its
 * picture, and a dropped repaint is repaired by the next one — but the frame
 * saying the shell ended repairs nothing and repeats never. Dropping that one
 * leaves the hub holding a terminal that no longer exists, so it goes out even
 * when the socket is behind: it is one small frame, once per session.
 */
function sendLiveFrame(ws, frame) {
  const droppable = frame.type === PTY_OUTPUT_FRAME || frame.type === EXEC_OUTPUT_FRAME;

  if (droppable && Number.isFinite(ws.bufferedAmount) && ws.bufferedAmount > LIVE_BACKLOG_MAX_BYTES) {
    log('device.frame_dropped', frame.type, 'socket_backlog');

    return false;
  }

  try {
    ws.send(JSON.stringify(frame));
  } catch (err) {
    // The socket closed between the read and this write. Its own close handler
    // ends every session and command; this frame has nowhere left to go.
    log('device.live_frame_unsent', frame.type, frame.session ?? frame.request, errorDetail(err));

    return false;
  }

  return true;
}

/**
 * A frame for a session already open.
 *
 * There is no request id to answer on, so a frame naming a terminal this
 * machine no longer holds is recorded and dropped. That is the ordinary race
 * and not an error: the program exited, and its exit frame is already on its
 * way to the hub that sent this.
 */
function handlePtyFrame(msg, ctx) {
  const sessions = ctx && ctx.sessions;

  if (!sessions) return log('device.terminal_frame_dropped', msg.type, 'this daemon holds no terminals');

  try {
    if (msg.type === PTY_INPUT_FRAME) sessions.write(msg.session, msg.data);
    else if (msg.type === PTY_RESIZE_FRAME) sessions.resize(msg.session, msg.cols, msg.rows);
  } catch (err) {
    log('device.terminal_frame_dropped', msg.type, msg.session, errorDetail(err));
  }
}

/** Open one terminal session: the SAME plan derivation `exec` uses, from the
 *  same frame. The tier the owner set, the agent home the hub computed, the
 *  roots they consented to, and a refusal when the machine cannot honour a
 *  sandboxed frame. A terminal is device access, so it is confined exactly as
 *  a command is. */
async function openTerminalSession(msg, ws, ctx) {
  const { id, params } = msg;

  supervisor.assertSupervisionSupported();
  assertCommandShellPresent();

  if (!ctx || !ctx.sessions) throw new Error('this daemon was started without terminal support');
  const plan = await planFromFrame(msg, SESSION_COMMAND, { source: sessionSource() });

  const opened = ctx.sessions.open({
    session: id,
    cols: params[0],
    rows: params[1],
    argv: plan.argv,
    env: leaderEnvironment(plan),
    send: (frame) => sendLiveFrame(ws, frame),
  });

  return { session: id, pid: opened.pid, cols: opened.cols, rows: opened.rows };
}

/** Answers `id` once `pending` settles: with its value, or with its error's message. */
function rpcWhenSettled(ws, id, pending) {
  /** @param {unknown} error */
  function replyWithFailure(error) {
    rpc(ws, id, null, error);
  }

  pending.then((result) => rpc(ws, id, result), replyWithFailure);
}

/** A mutating frame's work: after the pre-mutation snapshot of `covered` its
 *  checkpoint hint asks for, in checkpoint-store order, or at once where this
 *  daemon keeps no store. */
function mutation(checkpoints, { view, hint }, covered, apply) {
  if (!checkpoints) return new Promise((resolve) => { resolve(apply()); });

  return checkpoints.mutate(view, hint && covered !== null ? { ...hint, dir: covered } : null, covered ?? undefined, apply);
}

/** A socket the hub closed: nothing it sent can be answered any more. */
function socketClosed(ws) {
  return ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED;
}

/** Commands whose output a hub is watching, by request id, while their supervisor's pipe is open. */
const outputWatches = new Map();

/**
 * One watched command: its supervisor's records, coalesced into frames for
 * the socket that asked, at most one per EXEC_OUTPUT_FLUSH_MS holding the
 * newest EXEC_OUTPUT_WINDOW_BYTES. Every byte left out is counted where it
 * was: a chunk's `omitted` is what was lost just before it, and a loss with
 * no chunk after it ends the frame as an empty one. `dropped` is their sum. A
 * re-delivered exec binds it to the socket that sent it. `ended` resolves once
 * the pipe has closed and its last frame went out, so the command's result
 * follows its output.
 */
function watchOutput(requestId, pipe, ws) {
  let socket = ws;
  let chunks = [];
  let held = 0;
  let lost = 0;
  let timer = null;

  function flush() {
    clearTimeout(timer);
    timer = null;

    if (chunks.length === 0 && lost === 0) return;
    const sent = chunks.map(({ stream, bytes, omitted }) => ({ stream, data: bytes.toString('base64'), ...(omitted > 0 && { omitted }) }));

    if (lost > 0) sent.push({ stream: chunks.at(-1)?.stream ?? 'stdout', data: '', omitted: lost });
    const dropped = sent.reduce((sum, chunk) => sum + (chunk.omitted ?? 0), 0);
    const frame = { type: EXEC_OUTPUT_FRAME, request: requestId, chunks: sent, dropped };

    // A frame the socket refused is lost whole, before whatever comes next.
    lost = !socketClosed(socket) && sendLiveFrame(socket, frame) ? 0 : dropped + held;
    chunks = [];
    held = 0;
  }

  function arm() {
    timer ??= setTimeout(flush, EXEC_OUTPUT_FLUSH_MS);
  }

  function keep(stream, bytes) {
    const kept = bytes.subarray(Math.max(0, bytes.length - EXEC_OUTPUT_WINDOW_BYTES));
    const omitted = lost + bytes.length - kept.length;
    const last = chunks.at(-1);

    if (omitted === 0 && last !== undefined && last.stream === stream) last.bytes = Buffer.concat([last.bytes, kept]);
    else chunks.push({ stream, bytes: Buffer.from(kept), omitted });
    lost = 0;
    held += kept.length;

    // Past the window the oldest bytes go, lost before the first chunk kept; the newest chunk always stays.
    while (held > EXEC_OUTPUT_WINDOW_BYTES) {
      const first = chunks[0];
      const cut = Math.min(first.bytes.length, held - EXEC_OUTPUT_WINDOW_BYTES);
      first.bytes = first.bytes.subarray(cut);
      first.omitted += cut;
      held -= cut;

      if (first.bytes.length === 0) {
        chunks.shift();
        chunks[0].omitted += first.omitted;
      }
    }

    arm();
  }

  supervisor.readOutputRecords(pipe, {
    bytes: keep,
    lost: (size) => {
      lost += size;
      arm();
    },
  });

  pipe.on('error', (err) => { log('device.exec_output_unread', requestId, errorDetail(err)); });

  const ended = new Promise((resolve) => {
    pipe.once('close', () => {
      flush();
      outputWatches.delete(requestId);
      resolve();
    });
  });

  return { ended, bind: (next) => { socket = next; } };
}

/** Starts `id`'s supervisor after the pre-mutation snapshot its frame asks for
 *  and publishes the start in `starting` until the supervisor's state is on
 *  disk. A command whose socket closed while it waited is never started: its
 *  caller is gone, as `terminateUnanswered` has it for one already running. */
function startCommand(msg, cmd, ws, ctx) {
  const { id } = msg;

  const published = (async () => {
    const plan = await planFromFrame(msg, cmd, { statusFd: supervisor.STATUS_FD });
    const checkpoints = ctx && ctx.checkpoints;
    // A command's checkpoint covers its working tree.
    const tree = checkpoints && msg.checkpoint ? plan.view.workingTree(hintedDir(msg.checkpoint) ?? plan.cwd) : null;

    const started = await mutation(checkpoints, { view: plan.view, hint: msg.checkpoint }, coveredBy(tree), (snapshot) => {
      if (socketClosed(ws)) throw new Error(`the socket that sent ${id} closed before it could start`);

      return supervision.start(id, cmd, plan, {
        uncheckpointed: whyUncheckpointed(tree, snapshot), outputWindow: msg.output === true ? EXEC_OUTPUT_WINDOW_BYTES : 0,
      });
    });

    if (msg.output === true) outputWatches.set(id, watchOutput(id, started.child.stdio[3], ws));
    await supervision.adopt(id, started);

    /** @param {unknown} error */
    function reportStopFailure(error) {
      log('Could not terminate abandoned command', id, error);
    }

    // Its socket dropped while it started: stopped as the drop's sweep stopped the rest, now it has a supervisor.
    if (socketClosed(ws)) await supervision.cancel(id).catch(reportStopFailure);
  })();

  const forget = () => { starting.delete(id); };

  starting.set(id, published);
  published.then(forget, forget);

  return published;
}

/** Run one command, joining a re-delivered request to its existing supervisor.
 *  The plan is computed once, HERE: a re-delivered exec must not re-plan, or
 *  the same request could run under two policies. */
function execCommand(msg, ws, ctx) {
  const { id, params } = msg;
  const cmd = parseString(params[0], 'exec expects a command string');
  supervisor.assertSupervisionSupported();
  assertCommandShellPresent();

  const started = starting.get(id) ?? supervision.joining(id) ?? startCommand(msg, cmd, ws, ctx);

  if (msg.output === true) outputWatches.get(id)?.bind(ws);

  /** @param {unknown} error */
  function reportExecReplyFailure(error) {
    log('Could not report exec command result', id, error);
  }

  (async () => {
    try {
      await started;
      const completed = await supervision.result(id);

      if (!completed) throw new Error(`missing in-flight command ${id}`);
      await outputWatches.get(id)?.ended;
      rpc(ws, id, completed.result);
    } catch (err) {
      rpc(ws, id, null, err);
    }
  })().catch(reportExecReplyFailure);
}

/** Why `method url` is not relayed, or null when it is. */
function relayRefusal(method, url) {
  const target = URL.parse(String(url ?? ''));

  if (target === null || !Object.hasOwn(RELAY_ROUTES, target.hostname)) return `the provider relay does not reach ${String(url)}`;
  const routes = RELAY_ROUTES[target.hostname];

  if (target.protocol !== 'https:' || target.port !== '' || target.username !== '' || target.password !== '') {
    return `the provider relay does not reach ${String(url)}`;
  }

  return routes.includes(`${method} ${target.pathname}`) ? null : `the provider relay does not carry ${method} ${target.pathname}`;
}

function relayHeaders(pairs) {
  const headers = new Headers();

  for (const [name, value] of pairs) {
    const lower = String(name).toLowerCase();

    if (RELAY_DROPPED_HEADERS.has(lower) || lower.startsWith('cf-') || lower.startsWith('x-kinu-')) continue;
    headers.set(lower, String(value));
  }

  return headers;
}

/** The answer a relayed ChatGPT call gets when this machine holds no usable sign-in, shaped as the
 *  provider's own refusals are, so the hub reads one kind of answer. */
function chatgptSignedOut() {
  const body = JSON.stringify({ error: { code: CHATGPT_SIGNED_OUT, message: `${os.hostname()} holds no ChatGPT sign-in with plan usage` } });

  return new Response(body, { status: 401, headers: { 'content-type': 'application/json' } });
}

/** One upstream call. A ChatGPT call carries this machine's token, and a 401 gets one rotation and
 *  one resend: the token is this machine's, so its refresh is too. */
async function fetchRelayed(request, target, signal) {
  const headers = relayHeaders(Array.isArray(request.headers) ? request.headers : []);

  const send = () => fetch(request.url, {
    method: request.method, headers, body: request.method === 'POST' ? request.body : undefined, redirect: 'manual', signal,
  });

  if (target.hostname !== CHATGPT_HOST) return send();

  const token = await chatgptSession.bearer();

  if (token === null) return chatgptSignedOut();
  headers.set('authorization', `Bearer ${token}`);
  const first = await send();

  if (first.status !== 401) return first;
  await first.body?.cancel();
  const rotated = await chatgptSession.bearer(token);

  if (rotated === null) return chatgptSignedOut();
  headers.set('authorization', `Bearer ${rotated}`);

  return send();
}

/** Fetch one allow-listed call and stream its answer back as frames; resolves with the byte count. */
async function relayCall(ws, id, request) {
  const refused = relayRefusal(request?.method, request?.url);

  if (refused !== null) throw new Error(refused);

  if (relays.has(id)) throw new Error(`relay ${id} is already in flight`);
  const target = new URL(request.url);
  const abort = new AbortController();
  const ended = Promise.withResolvers();
  relays.set(id, { abort: () => abort.abort(), ended: ended.promise });

  try {
    const upstream = await fetchRelayed(request, target, abort.signal);

    // The runtime already decoded the body, so its encoding no longer describes the bytes sent on.
    const headers = [...upstream.headers].filter(([name]) => !RELAY_DROPPED_HEADERS.has(name) && name !== 'content-encoding');
    ws.send(JSON.stringify({ type: RELAY_HEAD_FRAME, relay: id, status: upstream.status, headers }));
    let bytes = 0;

    if (upstream.body !== null) {
      for await (const chunk of upstream.body) {
        if (socketClosed(ws)) throw new Error(`the socket that asked for relay ${id} closed`);
        bytes += chunk.byteLength;
        ws.send(JSON.stringify({ type: RELAY_BODY_FRAME, relay: id, data: Buffer.from(chunk).toString('base64') }));
      }
    }

    return { bytes };
  } catch (err) {
    if (abort.signal.aborted) throw new Error(`relay ${id} was stopped by the caller`, { cause: err });
    throw new Error(`${target.hostname} could not be reached from this machine: ${errorDetail(err)}`, { cause: err });
  } finally {
    relays.delete(id);
    ended.resolve();
  }
}

/** Methods past the file and command set: the provider relay and this machine's ChatGPT sign-in, else
 *  the answer an older hub's newer frame gets. */
function answerLaterMethod(msg, ws) {
  const { id, method, params } = msg;

  if (method === RELAY_METHOD) rpcWhenSettled(ws, id, relayCall(ws, id, params[0]));
  else if (method === CHATGPT_METHODS.status) rpc(ws, id, chatgptSession.status());
  else if (method === CHATGPT_METHODS.signIn) rpcWhenSettled(ws, id, chatgptSession.signIn());
  else if (method === CHATGPT_METHODS.signOut) rpcWhenSettled(ws, id, chatgptSession.signOut({ revoke: params?.[0]?.revoke === true }));
  else rpc(ws, id, null, Object.assign(new Error('unknown method: ' + method), { code: protocol.errors.unknownMethod }));
}

async function cancelWork(requestId, ctx) {
  await Promise.allSettled([starting.get(requestId)]);
  const relay = relays.get(requestId);

  if (relay) {
    relay.abort();
    await relay.ended;

    return { requestId, cancelled: 'terminated' };
  }

  if (ctx?.sessions?.has(requestId)) {
    await ctx.sessions.close(requestId).ended;

    return { requestId, cancelled: 'terminated' };
  }

  return supervision.cancel(requestId);
}

function rpcRequest(msg) {
  const { id, method, params } = msg;

  if (String(id) !== id || String(method) !== method || !Array.isArray(params)) {
    log('device.frame_dropped', 'invalid_request');

    return null;
  }

  return { id, method, params };
}

function handle(msg, ws, ctx) {
  if (PTY_FRAMES.has(msg.type)) return handlePtyFrame(msg, ctx);
  const request = rpcRequest(msg);

  if (request === null) return;
  const { id, method, params } = request;
  const checkpoints = ctx && ctx.checkpoints;

  try {
    if (method === METHODS.ping) {
      rpc(ws, id, PONG_FRAME);
    } else if (method === PTY_OPEN_METHOD) {
      const opened = openTerminalSession(msg, ws, ctx);
      starting.set(id, opened);
      const forget = () => starting.delete(id);
      opened.then(forget, forget);
      rpcWhenSettled(ws, id, opened);
    } else if (method === METHODS.exec) {
      execCommand(msg, ws, ctx);

    } else if (method === CANCEL_METHOD || method === EXEC_ACK_METHOD) {
      const requested = params[0];
      const target = String(requested);

      if (target !== requested) return rpc(ws, id, null, `${method} expects the request id to target`);
      rpcWhenSettled(ws, id, method === CANCEL_METHOD
        ? cancelWork(target, ctx)
        : supervision.acknowledge(target));
    } else if (method === METHODS.readRange) {
      const offset = params[1], length = params[2];

      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
        return rpc(ws, id, null, 'readRange expects a positive safe offset and length');
      }

      const view = viewFromFrame(msg);
      const bytes = readRangeBytes(view, confinedDeviceViewPath(view, params[0], 'read'), offset, length);
      rpc(ws, id, { encoding: 'base64', content: bytes.toString('base64') });
    } else if (method === METHODS.writeFile) {
      rpcWhenSettled(ws, id, checkpointedWrite(msg, { requested: params[0], content: params[1], options: params[2] }, checkpoints, (view, confined, data) => {
        atJudged(view, confined, { createParents: true }, (at) => { writeEntry(at, fs.constants.O_CREAT | fs.constants.O_TRUNC, data); });

        return { success: true };
      }));
    } else if (method === METHODS.writeFileIfDigest) {
      rpcWhenSettled(ws, id, checkpointedWrite(msg, { requested: params[0], content: params[1], options: params[3] }, checkpoints,
        (view, confined, data) => replaceIfDigest(view, confined, data, params[2] ?? null)));
    } else if (method === METHODS.listFiles) {
      rpc(ws, id, listFilesAnswer(msg));
    } else if (method === METHODS.statPath) {
      rpc(ws, id, statPathAnswer(msg));
    } else if (method === METHODS.unlinkPath) {
      // The ENTRY, not its target: unlink removes the name the caller gave,
      // and following the link would delete a path they never named.
      const view = viewFromFrame(msg);
      const entry = view.resolveEntryPath(parseString(params[0], 'device paths must be strings'), 'write');

      rpcWhenSettled(ws, id, mutation(checkpoints, { view: viewFromFrame(msg), hint: null }, null, () => {
        atJudged(view, entry, {}, (at) => { at.unlink(); });

        return { success: true };
      }));
    } else if (method === METHODS.rmdirPath) {
      const view = viewFromFrame(msg);
      const entry = rmdirEntry(view, msg);

      rpcWhenSettled(ws, id, mutation(checkpoints, { view: viewFromFrame(msg), hint: null }, null, () => {
        atJudged(view, entry, {}, (at) => { at.rmdir(); });

        return { success: true };
      }));
    } else if (method === METHODS.mkdirPath) {
      const recursive = (params[1] ?? {}).recursive === true;
      const view = viewFromFrame(msg);
      const confined = confinedDeviceViewPath(view, params[0], 'write');

      rpcWhenSettled(ws, id, mutation(checkpoints, { view: viewFromFrame(msg), hint: null }, null, () => {
        atJudged(view, confined, { createParents: recursive }, (at) => { at.mkdir(recursive); });

        return { success: true };
      }));
    } else if (method === METHODS.which) {
      rpc(ws, id, { present: whichAll(params[0]) });
    } else if (method === METHODS.checkpointStatus) {
      rpcWhenSettled(ws, id, checkpoints.status());
    } else if (method === METHODS.checkpointList) {
      rpcWhenSettled(ws, id, checkpoints.list(params[0], params[1], params[2]));
    } else if (method === METHODS.checkpointPlan) {
      const view = viewFromFrame(msg);
      rpcWhenSettled(ws, id, checkpoints.plan(view, params[0], checkpointDirFor(view, params[1]), params[2]));
    } else if (method === METHODS.checkpointRestore) {
      const view = viewFromFrame(msg);
      rpcWhenSettled(ws, id, checkpoints.restore(view, params[0], checkpointDirFor(view, params[1]), params[2]));
    } else {
      answerLaterMethod(msg, ws);
    }
  } catch (err) {
    rpc(ws, id, null, err);
  }
}

// ── Daemon startup ─────────────────────────────────────────────────────

function readDeviceConfig(configPath = CONFIG_PATH) {
  let text;

  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`device config not found at ${configPath}; run: kinu connect`, { cause: err });
    }

    if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
      throw new Error(`device config at ${configPath} is not readable by this user; check its owner and permissions`, { cause: err });
    }

    throw new Error(`could not read device config at ${configPath}`, { cause: err });
  }

  return parseDeviceConfig(text, configPath);
}

/**
 * The one schema of device.json, which the CLI reads it by too: JSON naming
 * the user, token, origin and root this daemon runs on, each a nonempty
 * string; `origin` one this daemon will send its token to; `root`, the
 * directory the owner linked (their home, or one the command named),
 * absolute. `device`, the registration the hub issued, is the CLI's and
 * never read here: a nonempty string where
 * `kinu connect` wrote one, absent where the previous release linked the
 * machine, which an update leaves as it is. Fields beyond these are kept, so
 * a rotated token is written back with them. `text` is the file's contents;
 * a parse error never echoes them.
 */
function parseDeviceConfig(text, configPath) {
  let value;

  try {
    value = JSON.parse(text);
  } catch (cause) {
    const safeCause = cause instanceof SyntaxError
      ? new Error('device config is not valid JSON')
      : new Error('device config could not be parsed');

    throw new Error(`device config at ${configPath} is corrupt; re-run: kinu connect`, { cause: safeCause });
  }

  const expectation = `device config at ${configPath} is missing its user, token, origin or directory; re-run: kinu connect`;
  const cfg = parseRecord(value, expectation);

  const nonempty = (field, refusal) => {
    const named = parseString(cfg[field], refusal);

    if (named.length === 0) throw new Error(refusal);

    return named;
  };

  const [user, token, origin, root] = ['user', 'token', 'origin', 'root'].map((field) => nonempty(field, expectation));

  if (!path.isAbsolute(root)) throw new Error(`device config at ${configPath} names a directory that is not absolute; re-run: kinu connect`);

  if (cfg.device !== undefined) nonempty('device', `device config at ${configPath} names a device that is not a nonempty string; re-run: kinu connect`);

  return { ...cfg, user, token, origin: trustedOrigin(origin, configPath), root };
}

/**
 * The origin this daemon POSTs its long-lived token to: https, or plain http to
 * this machine. Any other scheme hands the token to whatever the network path
 * is, so the daemon refuses to start rather than send it.
 */
function trustedOrigin(text, configPath) {
  let url;

  try {
    url = new URL(text);
  } catch (cause) {
    throw new Error(`device config at ${configPath} names an origin that is not a URL; it must be an https origin`, { cause });
  }

  if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) return text;

  throw new Error(`device config at ${configPath} names ${url.protocol}//${url.host}; this daemon sends its token `
    + 'only to an https origin, or over plain http to this machine');
}

function redactConnectSecrets(value, secrets) {
  let redacted = String(value);

  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join('[redacted]');
  }

  return redacted;
}

function connectFailureMessage(err, secrets) {
  const raw = err instanceof Error ? err.message : String(err?.message ?? err);
  const status = /Unexpected server response:\s*(\d{3})/.exec(raw);
  let message = raw;

  if (status && (status[1] === '401' || status[1] === '403')) {
    message = 'refused by the server (invalid, used, or expired connect ticket); retrying with a fresh ticket';
  } else if (status && status[1] === '404') {
    message = 'the configured server has no device connect endpoint';
  } else if (status && status[1] === '426') {
    message = 'the server refused the WebSocket upgrade';
  }

  return redactConnectSecrets(message, secrets);
}

async function getConnectTicket(cfg, httpOrigin, fetchFn = fetch) {
  let res;

  try {
    res = await fetchFn(httpOrigin + '/pc/connect-ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: cfg.user, token: cfg.token }),
    });
  } catch (err) {
    throw new Error('ticket exchange could not reach the server', {
      cause: new Error(redactConnectSecrets(err instanceof Error ? err.message : err, [cfg.token])),
    });
  }

  let body = {};

  try { body = await res.json(); }
  catch (cause) {
    // A gateway's non-JSON error page is diagnosed by the status check below;
    // an unreadable body behind HTTP 200 is a real protocol failure.
    if (res.ok) {
      const safeCause = cause instanceof SyntaxError
        ? new Error('ticket response is not valid JSON')
        : new Error('ticket response could not be read');

      throw new Error(`ticket exchange returned an unreadable body: HTTP ${res.status}`, { cause: safeCause });
    }
  }

  let record;

  try {
    record = parseRecord(body, 'ticket exchange returned an invalid body');
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'ticket response is invalid';
    throw new Error('ticket exchange returned an invalid body', {
      cause: new Error(redactConnectSecrets(detail, [cfg.token])),
    });
  }

  let ticket = '';
  let serviceError = '';

  try {
    if (record.ticket !== undefined) {
      ticket = parseString(record.ticket, 'ticket exchange returned an invalid connect ticket');
    }

    if (record.error !== undefined) {
      serviceError = redactConnectSecrets(
        parseString(record.error, 'ticket exchange returned an invalid body'),
        [cfg.token],
      );
    }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'ticket response fields are invalid';
    throw new Error('ticket exchange returned an invalid body', {
      cause: new Error(redactConnectSecrets(detail, [cfg.token])),
    });
  }

  if (!res.ok || ticket.length === 0) {
    const detail = serviceError || `HTTP ${res.status}`;

    if (res.status === 401 || res.status === 403) {
      throw new Error(CREDENTIALS_REJECTED, { cause: new Error(detail) });
    }

    throw new Error(`ticket exchange failed: HTTP ${res.status}`, { cause: new Error(detail) });
  }

  if (!/^pct_[A-Za-z0-9_-]{32,}$/.test(ticket)) {
    throw new Error('ticket exchange returned an invalid connect ticket', { cause: new Error('ticket format is invalid') });
  }

  return ticket;
}

function startConnectLoop(opts) {
  const {
    getTicket, dial, logger = log, secret = () => '', schedule = setTimeout, onClose,
    onRejected = () => {}, cancel = clearTimeout,
  } = opts;

  let backoff = 1000;
  let stopped = false;
  let currentTicket = '';

  /**
   * The one outcome retrying cannot fix. A rejected credential means the hub
   * has this machine's token superseded or revoked, so the loop stops and says
   * which command relinks it — a daemon that kept dialling would fill the log
   * with a failure the owner never reads and never act on it.
   */
  function stopRejected(detail) {
    stopped = true;
    logger(`${CREDENTIALS_REJECTED} (${detail})`);
    onRejected();
  }

  function retry() {
    if (stopped) return;
    schedule(startConnectAttempt, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  }

  async function connect() {
    if (stopped) return;
    let ticket;

    try {
      ticket = await getTicket();
    } catch (err) {
      if (err instanceof Error && err.message === CREDENTIALS_REJECTED) {
        return stopRejected('the ticket exchange refused this device token');
      }

      logger('Ticket exchange failed:', connectFailureMessage(err, [secret()]));
      retry();

      return;
    }

    if (stopped) return;
    currentTicket = ticket;
    let ws;

    try {
      ws = dial(ticket);
    } catch (err) {
      logger('Connect attempt failed:', connectFailureMessage(err, [secret(), currentTicket]));
      retry();

      return;
    }

    // A half-open socket answers no close event, so the daemon asks. The hub
    // replies from its socket auto-response, which costs it no wake.
    let pingTimer;
    let pongTimer;

    const stopKeepalive = () => {
      if (pingTimer !== undefined) cancel(pingTimer);

      if (pongTimer !== undefined) cancel(pongTimer);
      pingTimer = undefined;
      pongTimer = undefined;
    };

    const beat = () => {
      if (stopped) return;

      try {
        ws.send(PING_FRAME);
      } catch (err) {
        logger('Keepalive could not be sent:', connectFailureMessage(err, [secret(), currentTicket]));

        return;
      }

      pongTimer = schedule(() => {
        logger('No keepalive answer within', PONG_DEADLINE_MS, 'ms; closing this socket and redialling');
        stopKeepalive();
        ws.close();
      }, PONG_DEADLINE_MS);
      pingTimer = schedule(beat, PING_INTERVAL_MS);
    };

    ws.addEventListener('message', (ev) => {
      if (String(ev.data) !== PONG_FRAME) return;

      if (pongTimer !== undefined) cancel(pongTimer);
      pongTimer = undefined;
    });
    ws.addEventListener('open', () => {
      backoff = 1000;
      pingTimer = schedule(beat, PING_INTERVAL_MS);
    });
    ws.addEventListener('close', (event) => {
      stopKeepalive();

      if (stopped) return;

      if (event?.code === protocol.versionRefusalClose) {
        stopped = true;
        logger('device.protocol_refused', protocol.updateRequired);

        if (onClose) onClose(event);
        onRejected();

        return;
      }

      if (event && event.code === CREDENTIALS_REJECTED_CLOSE) {
        if (onClose) onClose(event);

        return stopRejected(`the hub closed this socket with ${CREDENTIALS_REJECTED_CLOSE}`);
      }

      if (onClose) onClose(event);

      if (stopped) return;
      logger('Disconnected, reconnecting in', backoff, 'ms');
      retry();
    });
    ws.addEventListener('error', (err) => {
      logger('Connect attempt failed:', connectFailureMessage(err, [secret(), currentTicket]));
    });
  }

  /** @param {unknown} error */
  function reportConnectFailure(error) {
    logger('Connect attempt failed:', connectFailureMessage(error, [secret(), currentTicket]));
    retry();
  }

  function startConnectAttempt() {
    connect().catch(reportConnectFailure);
  }

  startConnectAttempt();

  return {
    stop() {
      stopped = true;
    },
  };
}

function persistRotatedToken(cfg, token, configPath = CONFIG_PATH) {
  const temporary = `${configPath}.rotate-${process.pid}-${Date.now()}`;
  const next = { ...cfg, token };
  let fileDescriptor;

  try {
    fileDescriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fileDescriptor, JSON.stringify(next, null, 2) + '\n');
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fs.renameSync(temporary, configPath);
    cfg.token = token;

    if (os.platform() !== 'win32') {
      const directoryDescriptor = fs.openSync(path.dirname(configPath), 'r');

      try { fs.fsyncSync(directoryDescriptor); }
      finally { fs.closeSync(directoryDescriptor); }
    }
  } catch (err) {
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
    fs.rmSync(temporary, { force: true });
    throw new Error('persist rotated device token', { cause: err });
  }
}

function handleTokenRotation(
  cfg,
  msg,
  configPath = CONFIG_PATH,
  logger = log,
) {
  if (!msg || msg.type !== TOKEN_ROTATION) return false;

  // The daemon acknowledges only when the token it holds equals the frame's,
  // so a token it refuses to store is also one it never acknowledges, and the
  // hub keeps honouring the one on disk.
  if (!(Object(msg.token) instanceof String) || !DEVICE_TOKEN.test(String(msg.token))) {
    logger('Device token rotation refused:', 'the frame carries no device token; the one on disk stays');

    return true;
  }

  try {
    persistRotatedToken(cfg, msg.token, configPath);
    logger('Device token rotated');
  } catch (err) {
    logger('Device token rotation failed:', err);
  }

  return true;
}

// ── Machine lock ───────────────────────────────────────────────────────
//
// Two daemons on one machine share one device.json, so both connect with the
// same credentials, both answer the hub, and each rotation invalidates the
// other's token. The pidfile is the lock, and this daemon takes it in its own
// process: the CLI is one starter of this file, never the only one.

/**
 * Whether `pid` is the daemon that started this process as its successor: the
 * one holder whose claim this process takes over. Named by the environment the
 * predecessor set AND this process's own parent — a stray variable names
 * nobody.
 */
function isPredecessor(pid) {
  const named = Number(process.env[DAEMON_PREDECESSOR_ENV]);

  return Number.isInteger(named) && named > 0 && named === pid && pid === process.ppid;
}

/**
 * Take the machine for this process, or report the daemon that already holds it (`claimMachine`, the one protocol
 * `kinu connect` uses too). A pidfile naming this process's predecessor is a claim handed over: the predecessor keeps
 * serving until the hub replaces its socket, and exits without touching a pidfile that no longer names it.
 */
function claimThisMachine(pidPath = PID_PATH) {
  return machinePidfile.claimMachine(pidPath, process.pid, daemonPath(), isPredecessor);
}

/** Give the machine back, and only while this process still holds it. */
function releaseMachine(pidPath = PID_PATH) {
  let holder;

  try {
    holder = machinePidfile.readMachinePid(pidPath);
  } catch (err) {
    // Shutdown path: an unreadable pidfile is left for the next daemon's stale
    // check, which is what recovers it, rather than thrown out of an exit hook.
    log('Could not read the device pidfile while exiting:', errorDetail(err));

    return;
  }

  if (holder !== process.pid) return;

  try {
    machinePidfile.removeMachinePid(pidPath, process.pid);
  } catch (err) {
    log('Could not remove the device pidfile while exiting:', errorDetail(err));
  }
}

async function main() {
  const claim = await claimThisMachine();

  if (!claim.held) {
    log(`Another Kinu device daemon is already running on this machine (pid ${claim.holder}); this one is exiting.`);
    process.exitCode = ALREADY_RUNNING_EXIT;

    return;
  }

  process.on('exit', () => { releaseMachine(); });
  // The terminals this daemon holds. Live state, never durable: a terminal
  // is something a person is watching, so one whose socket is gone has
  // nobody to draw for.
  const sessions = pty.createSessions({ log });

  // A signalled daemon terminates without running exit hooks, so the machine
  // would stay claimed by a dead pid until the next daemon reaped it. The
  // terminals go first: a signal never reaches the socket's close handler,
  // and the kernel's own hangup on the closing pty reaches the shell and the
  // jobs it still owns, not a job it disowned into a group of its own. The
  // commands stay: a supervisor outlives this daemon by design and the next
  // one reconciles it.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => {
      const ended = sessions.closeAll();

      if (ended.length > 0) log('device.terminals_closed_with_daemon', ended.join(' '));
      exitWhenQuiet(0);
    });
  }

  const cfg = readDeviceConfig(CONFIG_PATH);
  const USER = cfg.user;
  const HTTP_ORIGIN = hubOrigin(cfg);
  const WS_ORIGIN = HTTP_ORIGIN.replace(/^http/, 'ws');

  const ctx = {
    checkpoints: createCheckpoints({ keep: cfg.checkpointKeep }),
    sessions,
  };

  const updater = update.createUpdater({
    layout: {
      deviceHome: DEVICE_HOME,
      daemonPath: daemonPath(),
      runtime: process.execPath,
    },
    origin: HTTP_ORIGIN,
    log,
    // A successor that died before connecting left the pidfile naming it;
    // this daemon takes the machine back, which claimThisMachine grants because
    // the holder it finds is dead.
    reclaim: () => claimThisMachine(),
  });

  // The daemon's one WebSocket: the global of the approved Bun
  // `startOnApprovedBun` put this process on, the implementation the whole
  // connect protocol is exercised against. There is no `ws` fallback: a fallback is a second
  // implementation that never runs in CI and failed first in the field.
  const mkWs = (url) => new globalThis.WebSocket(url);

  // Probed once, by RUNNING the real sandbox shape: a check that only looked
  // for the binary would report success on every machine whose AppArmor policy
  // forbids the namespace. A machine that cannot sandbox still CONNECTS — its
  // file methods work and the owner needs to read the reason — so a probe that
  // cannot even run is recorded as a status, never raised.
  try {
    SANDBOX_CAPABILITY = await sandbox.probe({ deviceHome: DEVICE_HOME });
    fs.mkdirSync(AGENT_ROOT, { recursive: true, mode: 0o700 });
  } catch (err) {
    SANDBOX_CAPABILITY = {
      status: sandbox.SANDBOX_STATUS.PROBE_FAILED,
      detail: `the sandbox probe could not run: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (SANDBOX_CAPABILITY.status !== sandbox.SANDBOX_STATUS.OK) {
    log('Commands cannot be sandboxed on this machine:', SANDBOX_CAPABILITY.detail);
  }

  await supervision.ready;

  const loop = startConnectLoop({
    getTicket: () => getConnectTicket(cfg, HTTP_ORIGIN),
    // A dead credential is not a transient failure, so the process exits
    // non-zero and the log says which command relinks the machine.
    onRejected: () => { process.exitCode = REJECTED_EXIT; },
    secret: () => cfg.token,
    onClose: (event) => {
      // The successor this daemon started has connected: the hub gave it this
      // device's slot and closed this socket for it. This daemon's work is
      // done, and exiting releases nothing — the pidfile already names the
      // successor.
      if (updater.pending() && event && event.reason === SOCKET_REPLACED_REASON) {
        const ended = ctx.sessions.closeAll();

        if (ended.length > 0) log('device.terminals_closed_with_socket', ended.join(' '));
        log('device.update_handed_over', `successor connected; pid ${process.pid} exiting`);
        loop.stop();
        exitWhenQuiet(0);

        return;
      }

      /** @param {unknown} error */
      function reportSweepFailure(error) {
        log('Could not sweep the commands this socket left unanswered', error);
      }

      // The commands still waiting to answer can no longer report to anyone,
      // and their ids died with the caller that minted them. Terminating them
      // here is what keeps a dropped socket from leaving work running that
      // nothing can name, stop or observe.
      supervision.terminateUnanswered().catch(reportSweepFailure);
      // A terminal outlives nothing: the socket that carried its bytes is the
      // socket that carried its keystrokes, so the shell is hung up here
      // rather than left running with no way to reach it.
      const ended = ctx.sessions.closeAll();

      if (ended.length > 0) log('device.terminals_closed_with_socket', ended.join(' '));
    },
    dial(ticket) {
      const wsUrl = `${WS_ORIGIN}/pc/connect?user=${encodeURIComponent(USER)}&ticket=${encodeURIComponent(ticket)}`;
      log('Connecting to', WS_ORIGIN + '/pc/connect');
      const ws = mkWs(wsUrl);
      ws.addEventListener('open', () => {
        log('Connected');

        // The hub accepted this socket, so its row reads connected: an update
        // that was pending on this machine has landed or been rolled back,
        // either way into a daemon that connects. A daemon still waiting on
        // its own successor leaves the marker for that successor to clear.
        if (!updater.pending()) update.clearPendingMarker(DEVICE_HOME);
        // `root` is the directory the owner linked, recorded in
        // device.json at link time: the hub scopes every base-tier file call
        // to it, so the tier is one directory the owner named rather than a
        // default the hub computed. `home` is what the file view opens at
        // under the full tier, sent so the hub never runs a command on this
        // machine to learn a path.
        ws.send(JSON.stringify({
          type: FRAMES.hello, protocolVersion: protocol.version, features: Object.keys(protocol.methods),
          user: USER, os: os.platform(), arch: os.arch(), hostname: os.hostname(), pid: process.pid,
          root: cfg.root,
          home: os.homedir(),
          // The build this daemon IS: the stamp beside it when this process
          // started, read once — the daemon is the build it loaded, not the
          // file beside it now (an update that landed and whose successor
          // died would otherwise report the new stamp from old code, and the
          // hub would never push that version again). Absent when no stamp
          // existed at start: the hub then pushes nothing, as it does for
          // every daemon before this field.
          version: RUNNING_VERSION ?? undefined,
          updateCheck: !update.updateOptedOut(DEVICE_HOME),
          // A build this daemon refused is not pushed again while it runs here.
          runtime: runtimeName(),
          // What this machine PROVED at startup, in the hub's words: the hub
          // decides the tier and needs one term for what the machine can
          // honour, so a machine that cannot sandbox is never silently given a
          // raw shell. GPU nodes are enumerated per HELLO, because a driver
          // loaded after this daemon started is still this machine's GPU.
          sandbox: {
            platform: os.platform(),
            ...sandbox.helloCapability(SANDBOX_CAPABILITY),
            gpu: sandbox.gpuNodes(),
          },
          agentRoot: AGENT_ROOT,
        }));
      });
      ws.addEventListener('message', (ev) => {
        const payload = ev.data instanceof ArrayBuffer
          ? new TextDecoder().decode(ev.data)
          : String(ev.data);

        // Before the parse: the keepalive answer is a bare word, not JSON, so
        // reading it afterwards would log a parse failure every 30 seconds.
        if (payload === PONG_FRAME) return;
        let msg;

        try {
          msg = JSON.parse(payload);
        } catch (err) {
          log('device.frame_dropped', 'malformed', errorDetail(err));

          return;
        }

        // The hub's UPDATE frame: the updater owns everything that follows,
        // on its own promise, and the socket keeps serving meanwhile.
        if (updater.handle(msg)) return;

        // The hub rotates this machine's long-lived token on every accepted
        // connect. Rename a complete same-directory file before changing memory:
        // a crash leaves either the old valid JSON or the complete new JSON.
        if (handleTokenRotation(cfg, msg)) {
          // `persistRotatedToken` assigns cfg.token only after the rename
          // lands, so this comparison is "the new secret is on disk" and
          // nothing weaker. The hub mints a fresh secret per rotation, so it
          // can never equal the one already held. Acknowledging is what ends
          // the grace on the superseded token: a rotation this daemon failed
          // to persist must keep it, or the machine is locked out.
          if (cfg.token === msg.token) ws.send(JSON.stringify({ type: TOKEN_ROTATION_ACK }));

          return;
        }

        try {
          handle(msg, ws, ctx);
        } catch (err) {
          log('Device message failed:', err);
        }
      });

      return ws;
    },
  });
}

/** The HTTP origin the device credentials trust. */
function hubOrigin(cfg) {
  return cfg.origin.replace(/\/+$/, '');
}

// The runtime. An updater starts its successor on the Bun it runs on, so a build can wake on a Bun older than the one
// it was tested on; it leaves that Bun the way the launcher does, before it claims anything.

/** Whether this process runs on the approved Bun or a newer one; any other runtime does not. */
function onApprovedBun() {
  const running = process.versions.bun;

  return running !== undefined && approvedBun(running);
}

/**
 * The approved Bun's absolute path, provided by the launcher's own `provide_bun`: a compatible Bun this machine
 * already has, or the approved one installed under `$KINU_HOME/runtime`. Rejects with what the provisioning said
 * last; everything it said goes to the log.
 */
async function provideApprovedBun(deviceHome) {
  const script = ['set -euo pipefail', 'die() { echo "$*" >&2; exit 1; }', bunResolutionShell(), 'provide_bun', 'printf \'%s\' "$KINU_BUN"'];

  const { error, stdout, stderr } = await update.runToExit('bash', ['-c', script.join('\n')], {
    env: { ...process.env, KINU_HOME: deviceHome },
    encoding: 'utf8',
  });

  const said = String(stderr).trim();

  if (said !== '') log('device.runtime_provisioning', said);

  if (error === null) return String(stdout);

  if (!Number.isInteger(error.code)) throw new Error(`Bun ${KINU_BUN_VERSION} could not be provided: ${error.message}`);

  const lines = said.split('\n');

  throw new Error(`Bun ${KINU_BUN_VERSION} could not be provided: ${said === '' ? `bash exited ${String(error.code)}` : lines[lines.length - 1]}`);
}

/**
 * The daemon, on the Bun it was tested on. One woken on an older runtime (an
 * older daemon's updater starts its successor on the runtime it had) first
 * provides the approved Bun the launcher's way, then goes on as this same
 * process on it: same pid, arguments and descriptors, a successor's lifeline
 * among them. Nothing is claimed or served before that.
 */
async function startOnApprovedBun() {
  if (!onApprovedBun()) await moveToApprovedBun();
  await main();
}

/** The runtime this process runs on, as HELLO and a refusal name it. */
function runtimeName() {
  return process.versions.bun === undefined ? `${process.release.name} ${process.version}` : `Bun ${process.versions.bun}`;
}

async function moveToApprovedBun() {
  const running = runtimeName();
  let bun;

  try {
    // Bun 1.3.12 has no process.execve: it cannot go on as this process on another runtime.
    if (!(process.execve instanceof Function)) throw new Error(`${running} cannot restart this daemon on another runtime`);
    bun = await provideApprovedBun(DEVICE_HOME);
  } catch (err) {
    await refuse(running, `this machine runs ${running}, and ${errorDetail(err)}`);

    return;
  }

  log('device.runtime_provided', `${running}; going on as Bun ${KINU_BUN_VERSION} or newer at ${bun}`);
  process.execve(bun, [bun, ...process.execArgv, ...process.argv.slice(1)], process.env);
}

/**
 * This build cannot run here. The hub is told why, so it stops pushing the
 * build and the owner's device row says why the machine is behind; then the
 * process ends, and an updater that started it rolls back and keeps serving.
 */
async function refuse(runtime, reason) {
  log('device.runtime_refused', reason);

  try {
    if (RUNNING_VERSION === null) {
      log('device.runtime_refusal_unsent', 'no build stamp: the hub pushes nothing to an unstamped daemon');
    } else {
      const cfg = readDeviceConfig(CONFIG_PATH);
      const status = await update.reportRefusal({ origin: hubOrigin(cfg), cfg, version: RUNNING_VERSION, runtime, reason });
      log(status === 200 ? 'device.runtime_refusal_sent' : 'device.runtime_refusal_unsent', `HTTP ${String(status)}`);
    }
  } catch (err) {
    log('device.runtime_refusal_unsent', errorDetail(err));
  }

  console.error('Kinu PC agent:', reason);
  exitWhenQuiet(1);
}

/**
 * A start that failed ends the process, not just its exit code: a successor's
 * lifeline (`predecessorExited`) would hold it open, and the updater that
 * started it rolls back only when it exits.
 * @param {unknown} err
 */
function reportFatal(err) {
  console.error('Kinu PC agent:', err instanceof Error ? err.message : String(err));
  exitWhenQuiet(1);
}

if (require.main === module) {
  try {
    // `--selftest`: the landed daemon run once by the one it replaces. The
    // requires above have loaded every sibling by now; the stamp beside this
    // file is what its HELLO would report. No pidfile is claimed and nothing
    // connects.
    if (process.argv.includes('--selftest')) {
      const stamp = RUNNING_VERSION;

      if (stamp === null) throw new Error(`no version stamp beside ${daemonPath()}`);
      console.log(stamp);
    } else {
      startOnApprovedBun().catch(reportFatal);
    }
  } catch (err) {
    reportFatal(err);
  }
}

module.exports = {
  handle,
  supervision,
  CANCEL_METHOD,
  EXEC_ACK_METHOD,
  EXEC_OUTPUT_FRAME,
  PTY_OPEN_METHOD,
  PTY_INPUT_FRAME,
  PTY_RESIZE_FRAME,
  PTY_OUTPUT_FRAME,
  PTY_EXIT_FRAME,
  RELAY_METHOD,
  RELAY_HEAD_FRAME,
  RELAY_BODY_FRAME,
  RELAY_ROUTES,
  relayRefusal,
  CHATGPT_METHODS,
  CHATGPT_SIGNED_OUT,
  SESSION_COMMAND,
  INFLIGHT_ROOT,
  watchOutput,
  createCheckpoints,
  CONFIG_PATH,
  readDeviceConfig,
  parseDeviceConfig,
  startConnectLoop,
  getConnectTicket,
  persistRotatedToken,
  handleTokenRotation,
};
