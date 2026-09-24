#!/usr/bin/env bun
// Kinu PC agent — reverse-WebSocket daemon.
// Runs under the Kinu CLI's bundled Bun (global fetch + global WebSocket). No external deps.
'use strict';

const fs = require('node:fs');

const path = require('node:path');

const os = require('node:os');

const crypto = require('node:crypto');

const { spawn, spawnSync, execFileSync } = require('node:child_process');

const sandbox = require('./sandbox.js');

const pty = require('./pty.js');

const update = require('./update.js');

/** The names this daemon requires beside itself — the three requires above
 *  — for the updater to land a newer set of. */
const DAEMON_SIBLINGS = ['sandbox.js', 'pty.js', 'update.js'];

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

/** The hub's token-rotation frame type, core's DEVICE_TOKEN_ROTATION: this
 *  daemon ships as one dependency-free file and cannot import the constant, so
 *  packages/cli/tests/daemon-update.test.ts drives it with core's frames. */
const TOKEN_ROTATION = 'ROTATE';

/** This daemon's answer once the rotated token is on disk, core's
 *  DEVICE_TOKEN_ROTATION_ACK. The hub keeps the superseded token valid until
 *  this frame arrives and drops it then, so the grace covers exactly the
 *  failure it exists for — a rotation lost with its socket — and not the
 *  indefinite window a copy of device.json could spend. */
const TOKEN_ROTATION_ACK = 'ROTATE_ACK';

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
const PING_FRAME = 'ping';

const PONG_FRAME = 'pong';

const PING_INTERVAL_MS = 30_000;

const PONG_DEADLINE_MS = 10_000;

const { KINU_INFLIGHT_ROOT } = process.env;

/** The supervisor's own environment: the sandboxed tier's allow-list, so no
 *  NODE_OPTIONS or BUN_INSPECT loads code into it. The command it starts runs
 *  with its plan's environment (sandbox.js), never this one. */
const COMMAND_ENV = sandbox.sandboxEnvironment(process.env, {});

/** What the dotenv files in this daemon's launch directory put into its environment; no command inherits it. */
const LAUNCH_DOTENV = sandbox.launchDotenv(process.cwd(), process.env.NODE_ENV);

/** The method that terminates one in-flight command's process group, and the
 *  cancellation protocol this daemon speaks. Both mirror core's
 *  DEVICE_CANCEL_METHOD / DEVICE_CANCEL_PROTOCOL (execution/device-tunnel.ts);
 *  cf-backend's pc-agent test pins the pair, since this file cannot import
 *  them. A frame carrying any other version is REFUSED, never guessed at: a
 *  cancellation the daemon misread would report a stopped command that is
 *  still running. */
const CANCEL_METHOD = 'execCancel';

const CANCEL_PROTOCOL = 1;

/** Each exec stream stays far below the Worker WebSocket's documented 32 MiB
 * receive ceiling even after worst-case JSON escaping. The daemon drains bytes
 * past the cap without retaining them, so a noisy process cannot grow its heap. */
const EXEC_STREAM_MAX_BYTES = 512 * 1024;

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
 *
 * The names are pinned against core's own constants by cf-backend's pc-agent
 * test, as `execCancel` is: this daemon ships as three dependency-free files
 * and cannot import them.
 */
const PTY_OPEN_METHOD = 'ptyOpen';

const PTY_INPUT_FRAME = 'PTY_IN';

const PTY_RESIZE_FRAME = 'PTY_RESIZE';

const PTY_CLOSE_FRAME = 'PTY_CLOSE';

const PTY_OUTPUT_FRAME = 'PTY_OUT';

const PTY_EXIT_FRAME = 'PTY_EXIT';

/** The frames the hub sends a live session. Each names a session this daemon
 *  already opened, so none of them is a way to start work. */
const PTY_FRAMES = new Set([PTY_INPUT_FRAME, PTY_RESIZE_FRAME, PTY_CLOSE_FRAME]);

/**
 * How far behind the socket may fall before a terminal's output is dropped
 * rather than queued.
 *
 * A terminal is unlike a command: its output has no end to wait for, so a
 * program writing faster than the socket drains would grow this daemon's heap
 * without bound. Queueing does not help a display — the newest bytes ARE the
 * picture, and the pane repaints — so past this backlog the newest frame is
 * dropped and counted. A full repaint of a large window is tens of kilobytes,
 * so this holds several of them and a brief stall stays invisible.
 */
const PTY_BACKLOG_MAX_BYTES = 256 * 1024;


function log(...a) { console.log(new Date().toISOString(), ...a); }

/** What a caught value says: its message, or the value itself when it carries
 *  none — a `throw 'text'` and an `Error('')` both reach these logs. */
function errorDetail(err) {
  const message = err?.message;

  return message === undefined || message === '' ? err : message;
}

/** The directory a checkpoint hint names, or undefined when it names none, so
 *  the caller's own fallback is what `??` reaches. */
function hintedDir(hint) {
  const dir = hint.dir ?? '';

  return dir === '' ? undefined : dir;
}

/** What `sandbox.probe()` answered at start. Read by HELLO and by the exec
 *  frame's own refusal, so it is proved once rather than per command. */
let SANDBOX_CAPABILITY = { status: sandbox.SANDBOX_STATUS.PROBE_FAILED, detail: 'the sandbox probe has not run yet' };

function rpc(ws, id, result, error) {
  ws.send(JSON.stringify(error ? { id, error } : { id, result }));
}

function runCommand(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    // Probing for an optional tool accepts two outcomes: the binary is not
    // installed (ENOENT), or it ran and exited non-zero (a numeric status).
    // Anything else — EACCES, ETIMEDOUT, EMFILE — is this daemon's own
    // breakage and must surface instead of reading as "no such tool".
    if (!err || (err.code !== 'ENOENT' && !Number.isInteger(err.status))) throw err;

    return null;
  }
}

// ── Shadow-git checkpoints ─────────────────────────────────────────────
//
// Zero-dep mirror of the store format in core/src/checkpoints/format.ts
// (same layout, ref scheme, and commit-subject encoding — the constants below
// pin it; cli-backend/tests/checkpoint-parity.test.ts round-trips one store
// through both engines) so a machine's checkpoints are one format regardless
// of which side wrote them:
//
//   ~/.kinu/checkpoints/<agent>/<sha256(dir)[:16]>/   — bare GIT_DIR
//     KINU_WORKDIR                                    — the target dir
//     info/exclude                                       — default excludes
//     refs/kinu/<ms13>-<seq>                          — one ref per snapshot
//
// Invisible infrastructure: mutating RPC frames (exec/writeFile) may carry a
// `checkpoint` hint — the daemon snapshots the target dir before executing,
// once per agent turn. Restore/list/plan are explicit RPC methods. Degrades
// honestly to "checkpoints unavailable: git not found" without blocking
// anything.

const CHECKPOINTS_UNAVAILABLE_NO_GIT = 'checkpoints unavailable: git not found';

const REF_PREFIX = 'refs/kinu';

const WORKDIR_MARKER = 'KINU_WORKDIR';

const SHA_RE = /^[0-9a-f]{4,64}$/i;

/** `git diff-tree --name-status` letters this daemon reports by name; every
 *  other letter (M, R, T, …) restores as a modification. */
const DIFF_KIND = { A: 'create', D: 'delete' };

const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Makefile', '.hg'];

const CHECKPOINT_EXCLUDES = [
  '.git/', '.hg/', '.svn/',
  'node_modules/', '.venv/', 'venv/', '__pycache__/', '*.pyc',
  'dist/', 'build/', 'target/', 'out/', '.next/', '.nuxt/',
  '.cache/', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', 'coverage/',
  '.DS_Store', 'Thumbs.db', '*.log',
];

// Shared temp roots, pinned alongside the TS engine's copy
// (cli-backend/src/checkpoints.ts): a bare `/tmp/x.js` resolves to `/tmp` for
// want of a project marker, and that is not a work tree.
const UNSNAPSHOTTABLE = new Set([os.tmpdir(), '/tmp', '/var/tmp'].map((dir) => path.resolve(dir)));

// What `git add` says about a path it could not READ, pinned as literals —
// core/src/checkpoints/format.ts holds the same four patterns and the same
// reason encoding. A path this process may not read (a private temp directory,
// another user's tree) is not a failed checkpoint: it is a path the snapshot
// does not cover, recorded in the reason so an incomplete restore is
// explainable. `--ignore-errors` is what keeps the rest of the tree staged;
// without it git aborts at the first refusal and everything after it is
// silently missing. `LC_ALL=C` below is what makes these strings the ones git
// emits.
const UNREADABLE_DIR = /^warning: could not open directory '(.+?)\/?': Permission denied$/;

const UNREADABLE_FILE = /^error: open\("(.+)"\): Permission denied$/;

const UNINDEXED_FILE = /^error: unable to index file '(.+?)'$/;

const ADD_FAILED = /^fatal: adding files failed$/;

const REASON_UNREADABLE_LIMIT = 3;

function diagnoseStaging(stderr) {
  const lines = String(stderr ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const unreadable = new Set();

  for (const line of lines) {
    const denied = UNREADABLE_DIR.exec(line) ?? UNREADABLE_FILE.exec(line);

    if (denied) unreadable.add(denied[1]);
  }

  const explained = (line) => {
    if (UNREADABLE_DIR.test(line) || UNREADABLE_FILE.test(line)) return true;
    const unindexed = UNINDEXED_FILE.exec(line);

    if (unindexed) return unreadable.has(unindexed[1]);

    return ADD_FAILED.test(line) && unreadable.size > 0;
  };

  return {
    unreadable: [...unreadable].sort((a, b) => (a < b ? -1 : 1)),
    unexplained: lines.filter((line) => !explained(line)),
  };
}

function reasonWithSkips(reason, unreadable) {
  if (unreadable.length === 0) return reason;
  const shown = unreadable.slice(0, REASON_UNREADABLE_LIMIT);
  const rest = unreadable.length - shown.length;
  const more = rest > 0 ? ` +${rest} more` : '';

  return `${reason} [skipped ${unreadable.length} unreadable: ${shown.join(' ')}${more}]`;
}

function createCheckpoints(opts = {}) {
  const base = opts.base ?? path.join(os.homedir(), '.kinu', 'checkpoints');
  const keep = Math.max(1, opts.keep ?? 50);
  const gitBin = opts.gitBin ?? 'git';
  let gitAvailable = null;
  let refSeq = 0;
  /** `${agent}|${dir}` → last turn key; one snapshot per turn per dir. */
  const turnDone = new Map();

  const isolatedEnv = () => {
    const env = {};

    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith('GIT_')) env[k] = v;
    }

    env.GIT_CONFIG_GLOBAL = os.devNull;
    env.GIT_CONFIG_SYSTEM = os.devNull;
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_AUTHOR_NAME = 'Kinu Checkpoint';
    env.GIT_AUTHOR_EMAIL = 'checkpoints@kinu.local';
    env.GIT_COMMITTER_NAME = 'Kinu Checkpoint';
    env.GIT_COMMITTER_EMAIL = 'checkpoints@kinu.local';
    // So `diagnoseStaging` parses git's own words rather than a translation of
    // them: a localized warning would read as an unexplained staging failure.
    env.LC_ALL = 'C';

    return env;
  };

  const storeEnv = (gitDir, workdir) => ({ ...isolatedEnv(), GIT_DIR: gitDir, GIT_WORK_TREE: workdir });

  /** Run git; returns stdout. Throws on non-zero exit or missing binary. */
  const git = (args, cwd, env) => {
    // A missing cwd would fail spawn with the same ENOENT a missing binary
    // produces — never let a vanished workdir flip the degraded-mode probe.
    if (!fs.existsSync(cwd)) throw new Error(`working directory not found: ${cwd}`);

    try {
      const out = execFileSync(gitBin, args, {
        cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
      });

      gitAvailable = true;

      return out;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        gitAvailable = false;
        throw new Error(CHECKPOINTS_UNAVAILABLE_NO_GIT, { cause: err });
      }

      gitAvailable = true;
      throw new Error((err.stderr ? String(err.stderr).trim() : '') || err.message, { cause: err });
    }
  };

  const probe = () => {
    if (gitAvailable !== null) return gitAvailable;

    try {
      git(['--version'], os.homedir(), isolatedEnv());
    } catch (err) {
      // git() records availability from the spawn outcome, so a git that ran
      // and failed is still a git that exists. Only a failure that never
      // reached the binary leaves availability unknown, and that must not be
      // reported as "git not found".
      if (gitAvailable === null) throw err;
    }

    return gitAvailable;
  };

  const sanitizeAgent = (agent) => {
    const name = String(agent ?? '');

    return (name === '' ? 'agent' : name).replace(/[^A-Za-z0-9_-]/g, '_');
  };

  const dirHash = (dir) => crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 16);
  const storeDirFor = (agent, dir) => path.join(base, sanitizeAgent(agent), dirHash(dir));
  const workdirOrBase = (workdir) => (fs.existsSync(workdir) ? workdir : base);

  const initStore = (gitDir, workdir) => {
    if (fs.existsSync(path.join(gitDir, 'HEAD'))) return;
    fs.mkdirSync(gitDir, { recursive: true });
    git(['init', '--bare', '--quiet', gitDir], path.dirname(gitDir), isolatedEnv());
    fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), CHECKPOINT_EXCLUDES.join('\n') + '\n');
    fs.writeFileSync(path.join(gitDir, WORKDIR_MARKER), path.resolve(workdir) + '\n');
  };

  const cleanField = (s) => String(s ?? '-').replace(/[\n|]/g, ' ').trim() || '-';

  const subjectFor = (turn, reason) =>
    `turn=${cleanField(turn && turn.turnId)} session=${cleanField(turn && turn.sessionId)} ${cleanField(reason)}`;

  const parseSubject = (subject) => {
    const m = /^turn=(\S+) session=(\S+) (.*)$/.exec(subject);

    if (!m) return { turnId: null, sessionId: null, reason: subject };

    return { turnId: m[1] === '-' ? null : m[1], sessionId: m[2] === '-' ? null : m[2], reason: m[3] };
  };

  const snapshotSkipped = (dir) => {
    const abs = path.resolve(dir);

    // Not a work tree, so a whole-tree snapshot of one is never what the caller
    // meant: the filesystem root, the user's home, and the SHARED temp roots —
    // `workdirForPath` resolves a bare `/tmp/x.js` to `/tmp`, which holds every
    // process's and user's scratch, none of it this agent's to copy.
    if (abs === path.parse(abs).root || abs === path.resolve(os.homedir())) return true;

    if (UNSNAPSHOTTABLE.has(abs)) return true;

    // Dependency-free spelling of the closed set: a vanished path is the one
    // expected statSync failure here; anything else must surface.
    try { return !fs.statSync(abs).isDirectory(); }
    catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;

      return true;
    }
  };

  const storeRefs = (gitDir, workdir) => {
    let out;

    try {
      out = git(['for-each-ref', '--sort=-refname', '--format=%(refname)|%(objectname)|%(subject)', REF_PREFIX],
        workdirOrBase(workdir), storeEnv(gitDir, workdir));
    } catch (err) {
      if (err.message === CHECKPOINTS_UNAVAILABLE_NO_GIT) throw err;

      return [];
    }

    return out.split('\n').filter(Boolean).map((line) => {
      const [ref, id, ...rest] = line.split('|');

      return { ref, id, subject: rest.join('|') };
    });
  };

  const refTimestampMs = (ref) => {
    const m = /(\d{13})-[0-9a-z]+$/.exec(ref);

    return m ? Number(m[1]) : 0;
  };

  /** `git add -A`, keeping what it could not read instead of failing over it.
   *  spawnSync rather than the `git` helper above because stderr is the answer
   *  here, and it arrives on a clean exit too (an unreadable DIRECTORY is only
   *  a warning). */
  const stageAll = (workdir, env) => {
    if (!fs.existsSync(workdir)) throw new Error(`working directory not found: ${workdir}`);

    const run = spawnSync(gitBin, ['add', '-A', '--ignore-errors'], {
      cwd: workdir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
    });

    if (run.error && run.error.code === 'ENOENT') {
      gitAvailable = false;
      throw new Error(CHECKPOINTS_UNAVAILABLE_NO_GIT, { cause: run.error });
    }

    gitAvailable = true;

    if (run.error) throw new Error(`checkpoint staging failed: ${run.error.message}`, { cause: run.error });
    const stderr = String(run.stderr ?? '');
    const diagnosis = diagnoseStaging(stderr);

    // Non-zero explained entirely by paths it may not read is not a failure;
    // anything else is, and a truncated tree must not be called a checkpoint.
    if (diagnosis.unexplained.length > 0 || (run.status !== 0 && diagnosis.unreadable.length === 0)) {
      throw new Error(`checkpoint staging failed: ${stderr.trim()}`);
    }

    return diagnosis.unreadable;
  };

  const stageCurrent = (gitDir, workdir) => {
    const env = storeEnv(gitDir, workdir);
    const unreadable = stageAll(workdir, env);

    return { tree: git(['write-tree'], workdir, env).trim(), unreadable };
  };

  const snapshot = (agent, dir, turn, reason) => {
    if (snapshotSkipped(dir)) return null;
    const abs = path.resolve(dir);
    const gitDir = storeDirFor(agent, abs);
    initStore(gitDir, abs);
    const env = storeEnv(gitDir, abs);
    const staged = stageCurrent(gitDir, abs);
    const tree = staged.tree;

    const refs = storeRefs(gitDir, abs);
    const latest = refs[0];

    if (latest && git(['rev-parse', `${latest.id}^{tree}`], abs, env).trim() === tree) return latest.id;

    const subject = subjectFor(turn, reasonWithSkips(reason, staged.unreadable));
    const sha = git(['commit-tree', tree, '-m', subject], abs, env).trim();
    const refName = `${REF_PREFIX}/${String(Date.now()).padStart(13, '0')}-${(refSeq++).toString(36).padStart(3, '0')}`;
    git(['update-ref', refName, sha], abs, env);

    if (refs.length + 1 > keep) {
      for (const stale of storeRefs(gitDir, abs).slice(keep)) {
        git(['update-ref', '-d', stale.ref], abs, env);
      }

      git(['prune', '--expire=now'], abs, env);
    }

    return sha;
  };

  const requireCheckpoint = (agent, dir, id) => {
    if (!SHA_RE.test(String(id))) throw new Error(`invalid checkpoint id: ${id}`);
    const abs = path.resolve(dir);
    const gitDir = storeDirFor(agent, abs);

    if (!fs.existsSync(path.join(gitDir, 'HEAD'))) throw new Error(`no checkpoints exist for ${abs}`);
    const env = storeEnv(gitDir, abs);

    try { git(['rev-parse', '--verify', `${id}^{commit}`], workdirOrBase(abs), env); }
    catch (err) {
      if (err.message === CHECKPOINTS_UNAVAILABLE_NO_GIT) throw err;
      throw new Error(`checkpoint not found: ${id}`, { cause: err });
    }

    return { gitDir, abs, env };
  };

  /** diff current staged state → checkpoint tree, in restore direction. */
  const diffToCheckpoint = (gitDir, abs, id) => {
    const env = storeEnv(gitDir, abs);
    // An unreadable path is in neither tree, so no change names it.
    const current = stageCurrent(gitDir, abs);
    const out = git(['diff-tree', '-r', '--name-status', current.tree, `${id}^{tree}`], abs, env);
    const files = [];

    for (const line of out.split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');

      if (tab < 0) continue;
      const status = line.slice(0, tab);
      files.push({
        path: line.slice(tab + 1),
        kind: DIFF_KIND[status] ?? 'modify',
      });
    }

    return files;
  };

  return {
    status() {
      return probe() ? { available: true } : { available: false, reason: CHECKPOINTS_UNAVAILABLE_NO_GIT };
    },

    /** Pre-mutation snapshot driven by the frame's checkpoint hint. Never
     *  throws — a snapshot failure must not block the operation it precedes. */
    ensure(hint, fallbackDir) {
      try {
        if (!hint || !probe()) return null;
        const dir = hintedDir(hint) ?? fallbackDir;

        if (!dir) return null;
        const abs = path.resolve(dir);
        const dedupeKey = `${sanitizeAgent(hint.agent)}|${abs}`;
        const turnId = hint.turnId ?? '';
        const turnKey = turnId === '' ? 'no-turn' : turnId;

        if (turnDone.get(dedupeKey) === turnKey) return null;
        turnDone.set(dedupeKey, turnKey);

        return snapshot(hint.agent, abs, { turnId: hint.turnId, sessionId: hint.sessionId }, 'pre-mutation');
      } catch (err) {
        log('checkpoint snapshot failed (non-blocking):', err.message);

        return null;
      }
    },

    // `turnId` filters HERE, before the limit truncates, because retention is
    // per working directory while the limit is global across them: a caller that
    // reads a window and filters by turn itself loses turns whose checkpoint
    // still exists. See FileCheckpoints.list in @kinu.run/core.
    list(agent, limit, turnId) {
      if (!probe()) return [];
      const agentBase = path.join(base, sanitizeAgent(agent));
      let stores;

      try { stores = fs.readdirSync(agentBase); }
      catch (err) {
        // No store directory means this agent has taken no checkpoints; any
        // other readdir failure is a real fault and must not read as "none".
        if (!err || err.code !== 'ENOENT') throw err;

        return [];
      }

      const entries = [];

      for (const name of stores) {
        const gitDir = path.join(agentBase, name);
        const marker = path.join(gitDir, WORKDIR_MARKER);

        if (!fs.existsSync(path.join(gitDir, 'HEAD')) || !fs.existsSync(marker)) continue;
        const workdir = fs.readFileSync(marker, 'utf8').trim();

        for (const ref of storeRefs(gitDir, workdir)) {
          const meta = parseSubject(ref.subject);

          if (turnId !== undefined && turnId !== null && meta.turnId !== turnId) continue;
          entries.push({ id: ref.id, dir: workdir, at: refTimestampMs(ref.ref), ...meta });
        }
      }

      entries.sort((a, b) => b.at - a.at);

      return entries.slice(0, Math.max(1, limit ?? 50));
    },

    plan(agent, dir, id) {
      if (!probe()) throw new Error(CHECKPOINTS_UNAVAILABLE_NO_GIT);
      const { gitDir, abs } = requireCheckpoint(agent, dir, id);

      return { dir: abs, id, files: diffToCheckpoint(gitDir, abs, id) };
    },

    restore(agent, dir, id) {
      if (!probe()) throw new Error(CHECKPOINTS_UNAVAILABLE_NO_GIT);
      const { gitDir, abs, env } = requireCheckpoint(agent, dir, id);

      if (!fs.existsSync(abs)) throw new Error(`working directory no longer exists: ${abs}`);
      const files = diffToCheckpoint(gitDir, abs, id);

      // Safety snapshot first, so the restore itself is undoable.
      const preRestoreId = snapshot(agent, abs, null, 'pre-restore');

      // Remove files created since the checkpoint, then materialize the
      // checkpoint tree (content + recreated deletions) from the store index.
      for (const change of files) {
        if (change.kind !== 'delete') continue;
        const target = path.resolve(abs, change.path);

        if (!target.startsWith(abs)) continue;

        try { fs.unlinkSync(target); }
        catch (err) { if (!err || err.code !== 'ENOENT') throw err; }
      }

      git(['read-tree', id], abs, env);
      git(['checkout-index', '-a', '-f'], abs, env);

      return { dir: abs, id, files, preRestoreId };
    },

    /** The project directory holding `p`, climbing only through directories
     *  `covers` admits, so a marker above what the frame may write never widens
     *  a checkpoint past it. */
    workdirForPath(p, covers = () => true) {
      const abs = path.resolve(p);
      let candidate = abs;

      try { if (!fs.statSync(abs).isDirectory()) candidate = path.dirname(abs); }
      catch (err) { if (!err || err.code !== 'ENOENT') throw err; candidate = path.dirname(abs); }

      const home = path.resolve(os.homedir());
      let probeDir = candidate;

      while (probeDir !== path.dirname(probeDir) && probeDir !== home && covers(probeDir)) {
        if (PROJECT_MARKERS.some((m) => fs.existsSync(path.join(probeDir, m)))) return probeDir;
        probeDir = path.dirname(probeDir);
      }

      return candidate;
    },
  };
}

// ── Listening-port discovery ───────────────────────────────────────────

function listListeningPorts() {
  const rows = [];
  const seen = new Set();

  const add = (port, host, command, pid) => {
    const n = Number(port);

    if (!Number.isInteger(n) || n <= 0 || n > 65535) return;
    const bind = host ?? '';
    const program = command ?? '';
    const key = `${bind}:${n}:${pid ?? ''}:${program}`;

    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ port: n, host: bind === '' ? '0.0.0.0' : bind, protocol: 'tcp', command: program === '' ? null : program, pid: pid ? Number(pid) : null });
  };

  const lsof = runCommand('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);

  if (lsof) {
    for (const line of lsof.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      const name = parts.slice(8).join(' ');
      const m = name.match(/(.+):(\d+)\s+\(LISTEN\)$/);

      if (m) add(m[2], m[1].replace(/^\[|\]$/g, ''), parts[0], parts[1]);
    }

    if (rows.length) return rows;
  }

  const ss = runCommand('ss', ['-ltnp']);

  if (ss) {
    for (const line of ss.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      const local = parts[3] ?? '';
      const m = local.match(/^(.*):(\d+)$/);
      const proc = line.match(/users:\(\("([^"]+)",pid=(\d+)/);

      if (m) add(m[2], m[1].replace(/^\[|\]$/g, ''), proc?.[1], proc?.[2]);
    }

    if (rows.length) return rows;
  }

  const netstat = runCommand('netstat', ['-anv']);

  if (netstat) {
    for (const line of netstat.split('\n')) {
      if (!/\bLISTEN\b/i.test(line) || !/^tcp/i.test(line.trim())) continue;
      const parts = line.trim().split(/\s+/);
      const local = parts[3] ?? parts[1] ?? '';
      const m = local.match(/^(.*)\.(\d+)$/) ?? local.match(/^(.*):(\d+)$/);

      if (m) add(m[2], m[1].replace(/^\[|\]$/g, ''), null, null);
    }
  }

  return rows;
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

/**
 * Whether any PATH entry provides an executable `name`.
 *
 * Must agree with `Bun.which` on the CLI host, which resolves the same names on
 * the machine the CLI runs on — one row, two resolvers, and a disagreement is a
 * capability the model routes work by. `cli-backend/tests/path-resolver-parity.test.ts`
 * holds them to it.
 *
 * `isFile` is the load-bearing half: a DIRECTORY can carry a binary's name and
 * carry the execute bit (they nearly all do), and `accessSync(X_OK)` alone said
 * yes to it. A directory named `bun` on PATH claimed `javascript` and
 * `typescript` for a machine that could run neither.
 */
function onPath(dirs, name) {
  for (const dir of dirs) {
    const candidate = path.join(dir, name);

    try {
      // stat, not lstat: a symlink to a real executable IS the normal shape of
      // a binary on PATH, and resolving it is what `which` does.
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);

      return true;
    } catch (err) {
      // Absent, not executable by this user, an entry that is not a directory
      // at all, or a symlink that goes nowhere: each means this entry does not
      // provide the binary. Anything else is a real fault and must not pass as
      // a clean "absent".
      if (!['ENOENT', 'EACCES', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG'].includes(err.code)) throw err;
    }
  }

  return false;
}

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

function whichAll(names) {
  const dirs = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean);

  return probeNames(names).filter((name) => onPath(dirs, name));
}

// ── In-flight commands ─────────────────────────────────────────────────
//
// A request survives daemon restart in one direct child of this root. This is
// a same-principal coordination protocol, not an OS isolation boundary: the
// command runs as this user's uid and can interfere with any same-user process
// or file it can discover. State validation prevents malformed or stale records
// from being selected accidentally; it cannot defend against a malicious
// same-user command that already has equivalent local authority.
const INFLIGHT_ROOT = path.resolve(
  KINU_INFLIGHT_ROOT === undefined || KINU_INFLIGHT_ROOT === '' ? path.join(os.homedir(), '.kinu', 'inflight') : KINU_INFLIGHT_ROOT,
);

const REQUEST_ID = /^rpc-[A-Za-z0-9_-]{10}-[1-9]\d*$/;

const EXEC_ACK_METHOD = 'execAck';

/** Room for what the supervisor writes around the kept bytes: the seam, and the closing line that names
 *  the spill path or why it was not saved. */
const EXEC_CAPTURE_MAX_BYTES = EXEC_STREAM_MAX_BYTES + 16 * 1024;

function supervisionSupported(platform = process.platform) {
  return platform === 'linux' || platform === 'darwin';
}

/** Named before the command is written to disk, so the answer is one error
 *  frame that says what to do rather than a supervisor that exits 125. */
function assertCommandShellPresent() {
  if (whichAll([COMMAND_SHELL]).length === 0) {
    throw new Error(`device commands run under ${COMMAND_SHELL}, which is not on this machine's PATH; install ${COMMAND_SHELL} and reconnect`);
  }
}

function assertSupervisionSupported() {
  if (!supervisionSupported()) throw new Error('pc-agent command supervision requires POSIX Linux or macOS');
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

function requestDirectory(root, requestId) {
  const parsedRequestId = parseString(requestId, 'exec request id must match rpc-<epoch>-<sequence>');

  if (!REQUEST_ID.test(parsedRequestId)) {
    throw new Error('exec request id must match rpc-<epoch>-<sequence>');
  }

  const resolvedRoot = path.resolve(root);
  const dir = path.resolve(resolvedRoot, parsedRequestId);

  if (path.dirname(dir) !== resolvedRoot) throw new Error('exec request directory must be a direct child of the in-flight root');

  return dir;
}

function processStartIdentity(pid) {
  if (process.platform === 'linux') {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const start = tail[19];

    if (!start) throw new Error(`cannot read start identity for supervisor ${pid}`);

    return start;
  }

  if (process.platform === 'darwin') {
    const start = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();

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
function startedAs(pid, start) {
  try {
    return processStartIdentity(pid) === start;
  } catch (err) {
    if (err && (err.code === 'ENOENT' || (process.platform === 'darwin' && err.status === 1))) {
      return false;
    }

    throw err;
  }
}

function supervisorStartMatches(entry) {
  return startedAs(entry.pid, entry.start) && startedAs(entry.group, entry.groupStart);
}

function processGroupHasLiveProcess(group) {
  if (process.platform === 'linux') {
    for (const entry of fs.readdirSync('/proc', { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;

      try {
        const stat = fs.readFileSync(`/proc/${entry.name}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);

        if (Number(fields[2]) === group && fields[0] !== 'Z') return true;
      } catch (err) {
        if (err && err.code === 'ENOENT') continue;
        throw err;
      }
    }

    return false;
  }

  const rows = execFileSync('ps', ['-ax', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' }).trim().split('\n');

  return rows.some((row) => {
    const [pid, pgid, stat] = row.trim().split(/\s+/, 3);

    return Number(pid) > 0 && Number(pgid) === group && stat && !stat.startsWith('Z');
  });
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

/** A command a signal ended says so, in the words the CLI's own shell uses (cli-backend runtime.ts exitStatus). */
function readExecResult(dir) {
  const terminal = readTerminalResult(dir);
  const stderr = readCapturedOutput(path.join(dir, 'stderr'));
  const note = terminal.signal === null ? '' : `Command terminated by ${terminal.signal}.`;

  return {
    terminal,
    result: {
      stdout: readCapturedOutput(path.join(dir, 'stdout')),
      stderr: note === '' ? stderr : `${stderr}${stderr === '' || stderr.endsWith('\n') ? '' : '\n'}${note}`,
      exitCode: terminal.exitCode,
    },
  };
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

const SUPERVISOR_SCRIPT = `
'use strict';
const fs = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');

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

function startIdentity(pid) {
  if (process.platform === 'linux') {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/);
    if (!tail[19]) throw new Error('cannot read process start identity');
    return tail[19];
  }
  const start = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
  if (!start) throw new Error('cannot read process start identity');
  return start;
}

function writeTerminalResult(kind, exitCode, signal) {
  const temporary = resultFile + '.tmp.' + process.pid;
  const named = signal ? 'signal=' + signal + '\\n' : '';
  fs.writeFileSync(temporary, 'kind=' + kind + '\\nexitCode=' + exitCode + '\\n' + named, { mode: 0o600 });
  fs.renameSync(temporary, resultFile);
}

function processGroupHasLiveProcess(group) {
  if (process.platform === 'linux') {
    for (const entry of fs.readdirSync('/proc', { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\\d+$/.test(entry.name)) continue;
      try {
        const stat = fs.readFileSync('/proc/' + entry.name + '/stat', 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/);
        if (Number(fields[2]) === group && fields[0] !== 'Z') return true;
      } catch {}
    }
    return false;
  }
  const rows = execFileSync('ps', ['-ax', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' }).trim().split('\\n');
  return rows.some((row) => {
    const [pid, pgid, stat] = row.trim().split(/\\s+/, 3);
    return Number(pid) > 0 && Number(pgid) === group && stat && !stat.startsWith('Z');
  });
}

/** One stream: the first HEAD bytes go to its file as they arrive, the last TAIL stay in a ring, every
 *  byte is counted, and once the stream outgrows both the whole of it goes to the spill file. close()
 *  writes what core's BoundedOutput.finish writes, byte for byte, so every executor reads the same.
 *  The spill is written at its host path and named by the path the command's own view gives it. */
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
      fs.mkdirSync(require('node:path').dirname(this.spillTarget.file), { recursive: true, mode: 0o700 });
      this.spill = fs.openSync(this.spillTarget.file, 'w', 0o600);
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
    // A character cut at either seam is dropped whole rather than decoded as a replacement.
    const last = Buffer.alloc(Math.min(4, this.head));
    fs.readSync(this.fd, last, 0, last.length, this.head - last.length);
    let headEnd = this.head;
    for (let lead = last.length - 1; lead >= 0; lead--) {
      const byte = last[lead];
      if ((byte & 0xC0) === 0x80) continue;
      const size = byte >= 0xF0 ? 4 : byte >= 0xE0 ? 3 : byte >= 0xC0 ? 2 : 1;
      if (lead + size > last.length) headEnd = this.head - last.length + lead;
      break;
    }
    let tailStart = 0;
    while (tailStart < Math.min(3, tail.length) && (tail[tailStart] & 0xC0) === 0x80) tailStart++;
    const omitted = this.total - headEnd - (tail.length - tailStart);
    if (this.spill !== null) fs.closeSync(this.spill);
    let where = 'the full ' + this.stream + ' was not saved: ' + this.spillFailure;
    if (this.spill !== null) where = 'the full ' + this.stream + ' is at ' + this.spillTarget.shown;
    const closing = Buffer.concat([
      Buffer.from('\\n[\\u2026 ' + omitted + ' bytes omitted \\u2026]\\n'),
      tail.subarray(tailStart),
      Buffer.from('\\n[' + this.stream + ': ' + this.total + ' bytes, ' + omitted + ' omitted from the middle; ' + where + ']\\n'),
    ]);
    fs.writeSync(this.fd, closing, 0, closing.length, headEnd);
    fs.ftruncateSync(this.fd, headEnd + closing.length);
    fs.closeSync(this.fd);
  }
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
  if (kind === 'cancelled') {
    writeTerminalResult(kind, exitCode);
    process.exit(0);
    return;
  }
  // The cloud may ACK as soon as result appears. Publish an open FIFO before
  // that result, otherwise its writer can create a regular file in the race.
  execFileSync('mkfifo', [ackFile]);
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
  child = spawn(argv[0], argv.slice(1), {
    detached: true,
    env: plan.env,
    cwd: plan.cwd,
    // A fourth pipe when the plan asked for one: bwrap writes its
    // --json-status-fd there, and the first line carries the host pid of the
    // sandbox's pid 1. Killing THAT is deterministic — the kernel reaps every
    // process in the namespace before pid 1's exit completes — where a group
    // kill returns before the namespace has finished dying.
    stdio: plan.statusFd === 3 ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });
  if (plan.statusFd === 3 && child.stdio[3]) {
    let statusText = '';
    child.stdio[3].on('data', (chunk) => {
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
  child.stdout.on('data', (chunk) => { if (!completed) stdout.write(chunk); });
  child.stderr.on('data', (chunk) => { if (!completed) stderr.write(chunk); });
  const stateTemporary = stateFile + '.tmp.' + process.pid;
  fs.writeFileSync(
    stateTemporary,
    'pid=' + process.pid + '\\nstart=' + startIdentity(process.pid) +
      '\\ngroup=' + child.pid + '\\ngroupStart=' + startIdentity(child.pid) + '\\n',
    { mode: 0o600 },
  );
  fs.renameSync(stateTemporary, stateFile);
} catch (err) {
  // Startup either publishes an authoritative group or leaves no group at all.
  // A detached child exists only after spawn, so every post-spawn failure kills
  // and reaps that exact group rather than abandoning an unnameable command.
  if (child && child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (killError) {
      if (!killError || killError.code !== 'ESRCH') throw new Error('supervisor startup group cleanup', { cause: killError });
    }
  }
  process.exit(125);
}



child.once('exit', (code, signal) => {
  const finishAfterDrain = () => {
    if (cancellationRequested && cancellationSignalDelivered) {
      try {
        // This confirms only the owned process group. A command can use setsid
        // to escape that group; same-uid supervision cannot honestly claim it
        // terminated such a detached descendant.
        const groupAlive = processGroupHasLiveProcess(child.pid);
        finish(groupAlive ? 'exited' : 'cancelled', groupAlive ? 125 : 137);
      } catch {
        finish('exited', 125);
      }
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

function waitForDirectoryRemoval(dir) {
  return waitForPath(dir, false);
}

function writeAcknowledgement(dir) {
  const ack = path.join(dir, 'ack');

  return new Promise((resolve, reject) => {
    const writer = spawn('/bin/sh', ['-c', 'printf 1 > "$1"', 'kinu-ack', ack], { stdio: 'ignore' });
    writer.once('error', reject);
    writer.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`supervisor acknowledgement writer exited with ${signal ?? code}`));
    });
  });
}

function removeRequestDirectory(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function createInFlight(root = INFLIGHT_ROOT) {
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

  function reconcile() {
    if (!fs.existsSync(root)) return [];
    const recovered = [];

    for (const directory of fs.readdirSync(root, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const dir = path.join(root, directory.name);

      try {
        requestDirectory(root, directory.name);
        const state = readSupervisorState(dir);
        const terminal = fs.existsSync(path.join(dir, 'result'));

        if (!terminal && !supervisorStartMatches(state)) {
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
    let entry;

    try {
      entry = await loadEntry(requestId);
    } catch (err) {
      throw new Error(`cannot validate supervisor for ${requestId}: ${errorDetail(err)}`, { cause: err });
    }

    if (!entry || fs.existsSync(path.join(entry.dir, 'result'))) {
      return { requestId, cancelled: 'unknown' };
    }

    if (!supervisorStartMatches(entry)) {
      throw new Error(`cannot terminate ${requestId}: supervisor identity no longer matches`);
    }

    process.kill(entry.pid, 'SIGUSR1');
    await waitForFile(path.join(entry.dir, 'result'));
    const terminal = readTerminalResult(entry.dir);

    if (terminal.kind !== 'cancelled') {
      throw new Error(`cannot terminate ${requestId}: supervisor exited without a confirmed group termination`);
    }

    if (processGroupHasLiveProcess(entry.group)) {
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
    await waitForFile(path.join(entry.dir, 'result'));

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
    // of the identity never matches here.
    if (terminal.kind === 'exited' && startedAs(entry.pid, entry.start)) {
      await writeAcknowledgement(entry.dir);
      await waitForDirectoryRemoval(entry.dir);
    } else {
      removeRequestDirectory(entry.dir);
    }

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
  function terminateUnanswered() {
    // Reconciled FIRST, because the in-memory registry is not the whole truth:
    // a command whose supervisor has published its state but which
    // `register` has not reached yet is absent from `entries`, so a socket
    // that dropped in that window left the command running with nothing left
    // to name or stop it. `reconcile` reads the request directories, which is
    // where the durable truth is, and is idempotent.
    reconcile();
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

  reconcile();

  return {
    register,
    cancel,
    result,
    acknowledge,
    reconcile,
    terminateUnanswered,
    size() { return entries.size; },
  };
}

/** One daemon, one registry. Reconciliation makes a restarted daemon the
 * durable request owner without creating another supervisor. */
const inFlight = createInFlight();

function startSupervisor(requestId, command, plan) {
  assertSupervisionSupported();
  const dir = requestDirectory(INFLIGHT_ROOT, requestId);
  fs.mkdirSync(INFLIGHT_ROOT, { recursive: true, mode: 0o700 });
  fs.chmodSync(INFLIGHT_ROOT, 0o700);
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
    }),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );

  const child = spawn(process.execPath, [
    '-e', SUPERVISOR_SCRIPT,
    commandFile, path.join(dir, 'state'), path.join(dir, 'result'),
    path.join(dir, 'stdout'), path.join(dir, 'stderr'), path.join(dir, 'ack'),
    String(EXEC_STREAM_MAX_BYTES), planFile,
  ], { detached: true, env: COMMAND_ENV, stdio: 'ignore' });

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

    return { file, shown: plan.view.raw ? file : plan.view.insidePath(file) };
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
 * the terminal it was just given, which is the only difference between them.
 */
function planFromFrame(msg, command, source = process.env) {
  const frame = frameSandbox(msg);

  if (frame.tier === 'raw') {
    return sandbox.plan({
      tier: 'raw', deviceHome: DEVICE_HOME, command, cwd: rawWorkingDirectory(msg, frame.roots), source, dotenv: LAUNCH_DOTENV,
    });
  }

  if (SANDBOX_CAPABILITY.status !== sandbox.SANDBOX_STATUS.OK) {
    const error = new Error(`sandbox_unavailable (${SANDBOX_CAPABILITY.status}): ${SANDBOX_CAPABILITY.detail}`);
    error.code = 'sandbox_unavailable';
    error.reason = SANDBOX_CAPABILITY.status;
    throw error;
  }

  const agentHome = frame.agentHome();
  const agentTmp = path.join(path.dirname(agentHome), 'tmp');

  // Created on first use, 0700: the hub computes the path per (device,
  // workspace) and this machine is the only one that can make the directory.
  for (const dir of [agentHome, agentTmp]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  sandbox.ensureUvmNode();

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
    statusFd: 3,
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

/** One file method's path, through the frame's view. `mode` is what the method
 *  does to the path, and the view refuses exactly what the kernel would. */
function confinedDeviceViewPath(view, requested, mode) {
  return view.resolvePath(parseString(requested, 'device paths must be strings'), mode);
}

/**
 * The directory a checkpoint hint covers through this frame's view, or null
 * when the frame may not write it; the mutation it precedes still runs.
 */
function checkpointDirOf(view, dir) {
  const verdict = view.checkpointDirectory(dir);

  if (verdict.why === null) return verdict.path;
  log('device.checkpoint_skipped', dir, verdict.why);

  return null;
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
function readRangeBytes(file, offset, length) {
  const descriptor = fs.openSync(file, 'r');

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

function listEntry(entry) {
  return { name: entry.name, type: entry.isDirectory() ? 'dir' : 'file' };
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

  if (page.limit === undefined) return fs.readdirSync(dir, { withFileTypes: true }).map(listEntry);
  const offset = page.offset ?? 0;

  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(page.limit) || page.limit <= 0) {
    throw new Error('listFiles pages by a non-negative offset and a positive limit');
  }

  return listPage(dir, offset, page.limit);
}

/**
 * One page of a directory, in the order the filesystem yields it: `next` is
 * the offset of the page after, or null past the last entry. The hub pages a
 * large directory so each answer stays under the socket's receive ceiling.
 */
function listPage(dir, offset, limit) {
  const opened = fs.opendirSync(dir);
  const entries = [];

  try {
    let index = 0;

    for (let entry = opened.readSync(); entry !== null; entry = opened.readSync(), index += 1) {
      if (index < offset) continue;

      if (entries.length === limit) return { entries, next: index };
      entries.push(listEntry(entry));
    }
  } finally {
    opened.closeSync();
  }

  return { entries, next: null };
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
 * One frame from a live terminal to the hub, and whether the socket took it.
 *
 * `false` is not a failure: it means this socket is too far behind to be
 * caught up by queueing, and the session counts what it dropped.
 *
 * The backlog rule covers OUTPUT alone. A terminal's newest bytes are its
 * picture, and a dropped repaint is repaired by the next one — but the frame
 * saying the shell ended repairs nothing and repeats never. Dropping that one
 * leaves the hub holding a terminal that no longer exists, so it goes out even
 * when the socket is behind: it is one small frame, once per session.
 */
function sendPtyFrame(ws, frame) {
  const droppable = frame.type === PTY_OUTPUT_FRAME;

  if (droppable && Number.isFinite(ws.bufferedAmount) && ws.bufferedAmount > PTY_BACKLOG_MAX_BYTES) return false;

  try {
    ws.send(JSON.stringify(frame));
  } catch (err) {
    // The socket closed between this terminal's read and this write. Its own
    // close handler ends every session; this frame has nowhere left to go.
    log('device.terminal_frame_unsent', frame.type, frame.session, errorDetail(err));

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
    else sessions.close(msg.session);
  } catch (err) {
    log('device.terminal_frame_dropped', msg.type, msg.session, errorDetail(err));
  }
}

/** Open one terminal session: the SAME plan derivation `exec` uses, from the
 *  same frame. The tier the owner set, the agent home the hub computed, the
 *  roots they consented to, and a refusal when the machine cannot honour a
 *  sandboxed frame. A terminal is device access, so it is confined exactly as
 *  a command is. */
function openTerminalSession(msg, ws, ctx) {
  const { id, params } = msg;

  assertSupervisionSupported();
  assertCommandShellPresent();

  if (!ctx || !ctx.sessions) throw new Error('this daemon was started without terminal support');
  const plan = planFromFrame(msg, SESSION_COMMAND, sessionSource());

  const opened = ctx.sessions.open({
    session: params[0],
    cols: params[1],
    rows: params[2],
    argv: plan.argv,
    env: leaderEnvironment(plan),
    send: (frame) => sendPtyFrame(ws, frame),
  });

  rpc(ws, id, { session: params[0], pid: opened.pid, cols: opened.cols, rows: opened.rows });
}

/** Run one command, joining a re-delivered request to its existing supervisor.
 *  The plan is computed once, HERE: a re-delivered exec must not re-plan, or
 *  the same request could run under two policies. */
function execCommand(msg, ws, ctx) {
  const { id, params } = msg;
  const cmd = parseString(params[0], 'exec expects a command string');
  const checkpoints = ctx && ctx.checkpoints;
  assertSupervisionSupported();
  assertCommandShellPresent();
  const dir = requestDirectory(INFLIGHT_ROOT, id);
  const plan = fs.existsSync(dir) ? null : planFromFrame(msg, cmd);

  if (plan !== null && checkpoints && msg.checkpoint) {
    const covered = checkpointDirOf(plan.view, hintedDir(msg.checkpoint) ?? plan.cwd);

    if (covered !== null) checkpoints.ensure({ ...msg.checkpoint, dir: covered }, covered);
  }

  /** @param {unknown} error */
  function reportExecReplyFailure(error) {
    log('Could not report exec command result', id, error);
  }

  (async () => {
    try {
      if (plan === null) {
        await waitForFile(path.join(dir, 'state'));
      } else {
        const supervisor = startSupervisor(id, cmd, plan);
        await waitForSupervisorState(supervisor.dir, supervisor.child);
        inFlight.register(id, supervisor.dir);
      }

      const completed = await inFlight.result(id);

      if (!completed) throw new Error(`missing in-flight command ${id}`);
      rpc(ws, id, completed.result);
    } catch (err) {
      rpc(ws, id, null, err instanceof Error ? err.message : String(err));
    }
  })().catch(reportExecReplyFailure);
}

function handle(msg, ws, ctx) {
  const { id, method, params } = msg;
  const checkpoints = ctx && ctx.checkpoints;

  // A session frame first: it carries a terminal's name rather than a request
  // id, so the method dispatch below has nothing to match it on.
  if (PTY_FRAMES.has(msg.type)) return handlePtyFrame(msg, ctx);

  try {
    if (method === PTY_OPEN_METHOD) {
      openTerminalSession(msg, ws, ctx);
    } else if (method === 'exec') {
      execCommand(msg, ws, ctx);
    } else if (method === CANCEL_METHOD || method === EXEC_ACK_METHOD) {
      const requested = params[0];
      const target = String(requested);
      const protocol = params[1];

      if (protocol !== CANCEL_PROTOCOL) return rpc(ws, id, null,
        `unsupported cancellation protocol ${JSON.stringify(protocol)}: this daemon speaks ${CANCEL_PROTOCOL}`);

      if (target !== requested) return rpc(ws, id, null, `${method} expects the request id to target`);
      requestDirectory(INFLIGHT_ROOT, target);
      const operation = method === CANCEL_METHOD ? inFlight.cancel(target) : inFlight.acknowledge(target);

      /** @param {unknown} error */
      function replyWithOperationFailure(error) {
        rpc(ws, id, null, error instanceof Error ? error.message : String(error));
      }

      operation.then(
        (result) => rpc(ws, id, result),
        replyWithOperationFailure,
      );
    } else if (method === 'readFile') {
      const options = params[1] ?? {};
      const confined = confinedDeviceViewPath(viewFromFrame(msg), params[0], 'read');

      if (options.encoding === 'base64') rpc(ws, id, { content: fs.readFileSync(confined).toString('base64'), encoding: 'base64' });
      else rpc(ws, id, fs.readFileSync(confined, 'utf8'));
    } else if (method === 'readRange') {
      const offset = params[1], length = params[2];

      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
        return rpc(ws, id, null, 'readRange expects a positive safe offset and length');
      }

      const bytes = readRangeBytes(confinedDeviceViewPath(viewFromFrame(msg), params[0], 'read'), offset, length);
      rpc(ws, id, { encoding: 'base64', content: bytes.toString('base64') });
    } else if (method === 'writeFile') {
      const options = params[2] ?? {};
      const view = viewFromFrame(msg);
      const confined = confinedDeviceViewPath(view, params[0], 'write');

      if (checkpoints && msg.checkpoint) {
        const hint = msg.checkpoint;
        const covers = (candidate) => view.checkpointDirectory(candidate).why === null;
        const covered = checkpointDirOf(view, hintedDir(hint) ?? checkpoints.workdirForPath(confined, covers));

        if (covered !== null) checkpoints.ensure({ ...hint, dir: covered }, covered);
      }

      fs.mkdirSync(path.dirname(confined), { recursive: true });
      fs.writeFileSync(confined, options.encoding === 'base64' ? Buffer.from(String(params[1]), 'base64') : params[1]);
      rpc(ws, id, { success: true });
    } else if (method === 'listFiles') {
      rpc(ws, id, listFilesAnswer(msg));
    } else if (method === 'statPath') {
      const confined = confinedDeviceViewPath(viewFromFrame(msg), params[0], 'read');

      if (!fs.existsSync(confined)) return rpc(ws, id, null);
      const stat = fs.statSync(confined);
      rpc(ws, id, { size: stat.size, mtimeMs: stat.mtimeMs, isDir: stat.isDirectory() });
    } else if (method === 'unlinkPath') {
      // The ENTRY, not its target: unlink removes the name the caller gave,
      // and following the link would delete a path they never named.
      fs.unlinkSync(viewFromFrame(msg).resolveEntryPath(
        parseString(params[0], 'device paths must be strings'), 'write',
      ));
      rpc(ws, id, { success: true });
    } else if (method === 'mkdirPath') {
      const options = params[1] ?? {};
      fs.mkdirSync(confinedDeviceViewPath(viewFromFrame(msg), params[0], 'write'), {
        recursive: options.recursive === true,
      });
      rpc(ws, id, { success: true });
    } else if (method === 'exists') {
      const confined = confinedDeviceViewPath(viewFromFrame(msg), params[0], 'read');
      rpc(ws, id, fs.existsSync(confined));
    } else if (method === 'listPorts') {
      rpc(ws, id, listListeningPorts());
    } else if (method === 'which') {
      rpc(ws, id, { present: whichAll(params[0]) });
    } else if (method === 'checkpointStatus') {
      rpc(ws, id, checkpoints ? checkpoints.status() : { available: false, reason: 'checkpoints are not configured' });
    } else if (method === 'checkpointList') {
      if (!checkpoints) return rpc(ws, id, []);
      rpc(ws, id, checkpoints.list(params[0], params[1], params[2]));
    } else if (method === 'checkpointPlan') {
      if (!checkpoints) return rpc(ws, id, null, 'checkpoints are not configured');
      rpc(ws, id, checkpoints.plan(params[0], checkpointDirFor(viewFromFrame(msg), params[1]), params[2]));
    } else if (method === 'checkpointRestore') {
      if (!checkpoints) return rpc(ws, id, null, 'checkpoints are not configured');
      rpc(ws, id, checkpoints.restore(params[0], checkpointDirFor(viewFromFrame(msg), params[1]), params[2]));
    } else {
      rpc(ws, id, null, 'unknown method: ' + method);
    }
  } catch (err) {
    rpc(ws, id, null, err instanceof Error ? err.message : String(err));
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

  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    const safeCause = cause instanceof SyntaxError
      ? new Error('device config is not valid JSON')
      : new Error('device config could not be parsed');

    throw new Error(`device config at ${configPath} is corrupt; re-run: kinu connect`, { cause: safeCause });
  }

  const expectation = `device config at ${configPath} is missing its user or token; re-run: kinu connect`;
  const cfg = parseRecord(parsed, expectation);
  const user = parseString(cfg.user, expectation);
  const token = parseString(cfg.token, expectation);
  const origin = cfg.origin === undefined ? undefined : trustedOrigin(parseString(cfg.origin, expectation), configPath);
  // The directory `kinu connect` ran in, parsed HERE with everything else so
  // the dial site sends a domain value rather than branching on a
  // representation. Absent on a config written before it existed, and absent
  // is what the hub reads as "this device named no directory".
  const root = cfg.root === undefined ? undefined : parseString(cfg.root, expectation);

  if (user.length === 0 || token.length === 0) throw new Error(expectation);
  const config = { ...cfg, user, token };

  if (origin !== undefined) config.origin = origin;

  if (root !== undefined) config.root = root;

  return config;
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

/** The pid the pidfile names, or null when it holds nothing usable. */
function readPidfile(pidPath = PID_PATH) {
  let text;

  try {
    text = fs.readFileSync(pidPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw new Error(`read the device daemon pidfile at ${pidPath}`, { cause: err });
  }

  const pid = Number(text.trim());

  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Whether `pid` is a live process. `kill(pid, 0)` reports absence as ESRCH
 *  and presence under another user as EPERM, so only ESRCH is death. */
function processAlive(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;

    if (err && err.code === 'EPERM') return true;
    throw new Error(`check whether pid ${pid} is running`, { cause: err });
  }
}

/**
 * Whether `pid` runs this daemon file. A pid the operating system recycled for
 * an unrelated program does not own this machine.
 *
 * The command line names this file by whatever spelling its starter used, so a
 * bare `pc-agent.js` argument counts. That treats another home's daemon, if it
 * ever inherited this pid, as the owner: refusing to start is recoverable with
 * one `kinu connect`, while a second daemon beside the first is the defect this
 * lock exists for.
 */
function processRunsThisDaemon(pid) {
  const named = (args) => args.some((arg) => arg === __filename || path.basename(arg) === path.basename(__filename));

  try {
    if (process.platform === 'linux') {
      return named(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'));
    }

    if (process.platform === 'darwin') {
      return named(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim().split(/\s+/));
    }

    return false;
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM')) return false;

    if (process.platform === 'darwin' && err && err.status === 1) return false;
    throw new Error(`check whether pid ${pid} runs this daemon`, { cause: err });
  }
}

/**
 * Whether `pid` is the daemon that started this process as its successor: the
 * one holder whose claim this process takes over. Named by the environment the
 * predecessor set AND this process's own parent — a stray variable names
 * nobody.
 */
function isPredecessor(pid) {
  const named = Number(process.env[update.PREDECESSOR_ENV]);

  return Number.isInteger(named) && named > 0 && named === pid && pid === process.ppid;
}

/**
 * Take the machine for this process, or report the daemon that already holds
 * it. A pidfile naming this process is this process's own claim: the CLI
 * writes it for the daemon it just started, and that is the same claim. A
 * pidfile naming this process's predecessor is a claim handed over: the
 * predecessor keeps serving until the hub replaces its socket, and exits
 * without touching a pidfile that no longer names it.
 */
function claimMachine(pidPath = PID_PATH) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;

    try {
      descriptor = fs.openSync(pidPath, 'wx', 0o600);
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        throw new Error(`claim the device daemon pidfile at ${pidPath}`, { cause: err });
      }

      const holder = readPidfile(pidPath);

      if (holder === process.pid) return { held: true, holder: process.pid };

      if (holder !== null && processAlive(holder) && processRunsThisDaemon(holder) && !isPredecessor(holder)) {
        return { held: false, holder };
      }

      fs.rmSync(pidPath, { force: true });
      continue;
    }

    try {
      fs.writeFileSync(descriptor, `${process.pid}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }

    fs.chmodSync(pidPath, 0o600);

    return { held: true, holder: process.pid };
  }

  return { held: false, holder: readPidfile(pidPath) };
}

/** Give the machine back, and only while this process still holds it. */
function releaseMachine(pidPath = PID_PATH) {
  let holder;

  try {
    holder = readPidfile(pidPath);
  } catch (err) {
    // Shutdown path: an unreadable pidfile is left for the next daemon's stale
    // check, which is what recovers it, rather than thrown out of an exit hook.
    log('Could not read the device pidfile while exiting:', errorDetail(err));

    return;
  }

  if (holder !== process.pid) return;

  try {
    fs.rmSync(pidPath, { force: true });
  } catch (err) {
    log('Could not remove the device pidfile while exiting:', errorDetail(err));
  }
}

function main() {
  const claim = claimMachine();

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
      process.exit(0);
    });
  }

  const cfg = readDeviceConfig(CONFIG_PATH);
  const USER = cfg.user;
  const origin = cfg.origin ?? '';
  const HTTP_ORIGIN = (origin === '' ? 'https://kinu.run' : origin).replace(/\/+$/, '');
  const WS_ORIGIN = HTTP_ORIGIN.replace(/^http/, 'ws');

  const ctx = {
    checkpoints: createCheckpoints({ keep: cfg.checkpointKeep }),
    sessions,
  };

  const updater = update.createUpdater({
    layout: {
      deviceHome: DEVICE_HOME,
      daemonPath: __filename,
      siblings: DAEMON_SIBLINGS,
      runtime: process.execPath,
    },
    origin: HTTP_ORIGIN,
    log,
    // A successor that died before connecting left the pidfile naming it;
    // this daemon takes the machine back, which claimMachine grants because
    // the holder it finds is dead.
    reclaim: () => { claimMachine(); },
  });

  // The daemon's one WebSocket: the runtime's global. Kinu launches this
  // daemon only under its own Bun, whose WebSocket is the implementation the
  // whole connect protocol is exercised against — there is no `ws` fallback,
  // because a fallback is a second implementation that never runs in CI and
  // failed first in the field. A runtime without the global cannot run the
  // daemon, and says so.
  if (!(globalThis.WebSocket instanceof Function)) {
    throw new Error('this daemon requires a runtime with a global WebSocket; run it with the Kinu CLI (its bundled Bun)');
  }

  const mkWs = (url) => new globalThis.WebSocket(url);

  // Probed once, by RUNNING the real sandbox shape: a check that only looked
  // for the binary would report success on every machine whose AppArmor policy
  // forbids the namespace. A machine that cannot sandbox still CONNECTS — its
  // file methods work and the owner needs to read the reason — so a probe that
  // cannot even run is recorded as a status, never raised.
  try {
    SANDBOX_CAPABILITY = sandbox.probe({ deviceHome: DEVICE_HOME });
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
        process.exit(0);
      }

      // The commands still waiting to answer can no longer report to anyone,
      // and their ids died with the caller that minted them. Terminating them
      // here is what keeps a dropped socket from leaving work running that
      // nothing can name, stop or observe.
      inFlight.terminateUnanswered();
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
        // `root` is the directory `kinu connect` ran in, recorded in
        // device.json at link time: the hub scopes every base-tier file call
        // to it, so the tier is one directory the owner named rather than a
        // default the hub computed. `home` is what the file view opens at
        // under the full tier, sent so the hub never runs a command on this
        // machine to learn a path.
        ws.send(JSON.stringify({
          type: 'HELLO', user: USER, os: os.platform(), arch: os.arch(), hostname: os.hostname(), pid: process.pid,
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
          // Terminals are deliberately NOT advertised here. A hub that asks a
          // daemon too old to hold them gets `unknown method: ptyOpen`, which
          // is the same answer and cannot go stale — where a recorded
          // capability outlives the build that proved it.
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
          log('Device message parse failed:', err);

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

if (require.main === module) {
  try {
    // `--selftest`: the landed daemon run once by the one it replaces. The
    // requires above have loaded every sibling by now; the stamp beside this
    // file is what its HELLO would report. No pidfile is claimed and nothing
    // connects.
    if (process.argv.includes('--selftest')) {
      const stamp = RUNNING_VERSION;

      if (stamp === null) throw new Error(`no version stamp beside ${__filename}`);
      console.log(stamp);
    } else {
      main();
    }
  } catch (err) {
    console.error('Kinu PC agent:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

module.exports = {
  handle,
  inFlight,
  CANCEL_METHOD,
  CANCEL_PROTOCOL,
  EXEC_ACK_METHOD,
  PTY_OPEN_METHOD,
  PTY_INPUT_FRAME,
  PTY_RESIZE_FRAME,
  PTY_CLOSE_FRAME,
  PTY_OUTPUT_FRAME,
  PTY_EXIT_FRAME,
  SESSION_COMMAND,
  createInFlight,
  INFLIGHT_ROOT,
  requestDirectory,
  supervisionSupported,
  waitForFile,
  waitForSupervisorState,
  createCheckpoints,
  listListeningPorts,
  CONFIG_PATH,
  readDeviceConfig,
  startConnectLoop,
  getConnectTicket,
  persistRotatedToken,
  handleTokenRotation,
};
