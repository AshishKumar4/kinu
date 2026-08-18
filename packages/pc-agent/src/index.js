#!/usr/bin/env node
// Proteus PC agent — reverse-WebSocket daemon.
// Node 18+. No external deps (uses global fetch + WebSocket polyfill via ws fallback).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const CONFIG_PATH = path.join(os.homedir(), '.proteus', 'device.json');

/** Drain window after an exec'd command's own exit, before we stop reading the
 *  pipes an orphaned grandchild may still hold. Mirrors EXITED_COMMAND_DRAIN_MS
 *  in cli-backend/src/runtime.ts — this daemon ships as one dependency-free
 *  file, so it carries its own copy rather than importing one. */
const EXITED_COMMAND_DRAIN_MS = 250;

function log(...a) { console.log(new Date().toISOString(), ...a); }

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
//   ~/.proteus/checkpoints/<agent>/<sha256(dir)[:16]>/   — bare GIT_DIR
//     PROTEUS_WORKDIR                                    — the target dir
//     info/exclude                                       — default excludes
//     refs/proteus/<ms13>-<seq>                          — one ref per snapshot
//
// Invisible infrastructure: mutating RPC frames (exec/writeFile) may carry a
// `checkpoint` hint — the daemon snapshots the target dir before executing,
// once per agent turn. Restore/list/plan are explicit RPC methods. Degrades
// honestly to "checkpoints unavailable: git not found" without blocking
// anything.

const CHECKPOINTS_UNAVAILABLE_NO_GIT = 'checkpoints unavailable: git not found';
const REF_PREFIX = 'refs/proteus';
const WORKDIR_MARKER = 'PROTEUS_WORKDIR';
const SHA_RE = /^[0-9a-f]{4,64}$/i;
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
  const lines = String(stderr || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const unreadable = new Set();
  for (const line of lines) {
    const denied = UNREADABLE_DIR.exec(line) || UNREADABLE_FILE.exec(line);
    if (denied) unreadable.add(denied[1]);
  }
  const explained = (line) => {
    if (UNREADABLE_DIR.test(line) || UNREADABLE_FILE.test(line)) return true;
    const unindexed = UNINDEXED_FILE.exec(line);
    if (unindexed) return unreadable.has(unindexed[1]);
    return ADD_FAILED.test(line) && unreadable.size > 0;
  };
  return {
    unreadable: [...unreadable].sort(),
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
  const base = opts.base || path.join(os.homedir(), '.proteus', 'checkpoints');
  const keep = Math.max(1, opts.keep || 50);
  const gitBin = opts.gitBin || 'git';
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
    env.GIT_AUTHOR_NAME = 'Proteus Checkpoint';
    env.GIT_AUTHOR_EMAIL = 'checkpoints@proteus.local';
    env.GIT_COMMITTER_NAME = 'Proteus Checkpoint';
    env.GIT_COMMITTER_EMAIL = 'checkpoints@proteus.local';
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

  const sanitizeAgent = (agent) => String(agent || 'agent').replace(/[^A-Za-z0-9_-]/g, '_');
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

  const cleanField = (s) => String(s == null ? '-' : s).replace(/[\n|]/g, ' ').trim() || '-';
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
    try { return !fs.statSync(abs).isDirectory(); } catch { return true; }
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
    const stderr = String(run.stderr || '');
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
    if (latest) {
      if (git(['rev-parse', `${latest.id}^{tree}`], abs, env).trim() === tree) return latest.id;
    }

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
        kind: status === 'A' ? 'create' : status === 'D' ? 'delete' : 'modify',
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
        const dir = hint.dir || fallbackDir;
        if (!dir) return null;
        const abs = path.resolve(dir);
        const dedupeKey = `${sanitizeAgent(hint.agent)}|${abs}`;
        const turnKey = hint.turnId || 'no-turn';
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
    // still exists. See FileCheckpoints.list in @proteus/core.
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
      return entries.slice(0, Math.max(1, limit || 50));
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

    workdirForPath(p) {
      const abs = path.resolve(p);
      let candidate = abs;
      try { if (!fs.statSync(abs).isDirectory()) candidate = path.dirname(abs); }
      catch { candidate = path.dirname(abs); }
      const home = path.resolve(os.homedir());
      let probeDir = candidate;
      while (probeDir !== path.dirname(probeDir) && probeDir !== home) {
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
    const key = `${host || ''}:${n}:${pid || ''}:${command || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ port: n, host: host || '0.0.0.0', protocol: 'tcp', command: command || null, pid: pid ? Number(pid) : null });
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
      const local = parts[3] || '';
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
      const local = parts[3] || parts[1] || '';
      const m = local.match(/^(.*)\.(\d+)$/) || local.match(/^(.*):(\d+)$/);
      if (m) add(m[2], m[1].replace(/^\[|\]$/g, ''), null, null);
    }
  }
  return rows;
}

// ── RPC dispatch ───────────────────────────────────────────────────────

function handle(msg, ws, ctx) {
  const { id, method, params } = msg;
  const checkpoints = ctx && ctx.checkpoints;
  try {
    if (method === 'exec') {
      const cmd = params[0];
      // Pre-mutation snapshot (invisible; deduped per agent turn).
      if (checkpoints && msg.checkpoint) checkpoints.ensure(msg.checkpoint, process.cwd());
      const child = spawn('/bin/sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', answered = false;
      const answer = (code) => {
        if (answered) return;
        answered = true;
        rpc(ws, id, { stdout, stderr, exitCode: code ?? 0 });
      };
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      // `close` waits for every inherited pipe to shut, so a command that
      // backgrounds a server (`./server &`) would not answer until the SERVER
      // exited. `exit` means the command itself is done; drain briefly for the
      // output still in the pipe, then answer and let the orphan keep running.
      child.on('close', answer);
      child.on('exit', (code) => {
        setTimeout(() => {
          if (answered) return;
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          answer(code);
        }, EXITED_COMMAND_DRAIN_MS).unref();
      });
      child.on('error', (e) => { if (!answered) { answered = true; rpc(ws, id, null, e.message); } });
    } else if (method === 'readFile') {
      // { encoding: 'base64' } → binary-safe read, answered in a shape the
      // caller can distinguish from the plain-text default.
      if (params[1] && params[1].encoding === 'base64') {
        rpc(ws, id, { content: fs.readFileSync(params[0]).toString('base64'), encoding: 'base64' });
      } else {
        rpc(ws, id, fs.readFileSync(params[0], 'utf8'));
      }
    } else if (method === 'writeFile') {
      if (checkpoints && msg.checkpoint) {
        const hint = msg.checkpoint;
        checkpoints.ensure(hint, hint.dir || checkpoints.workdirForPath(params[0]));
      }
      fs.mkdirSync(path.dirname(params[0]), { recursive: true });
      // { encoding: 'base64' } (3rd param) → binary-safe write.
      const body = params[2] && params[2].encoding === 'base64'
        ? Buffer.from(String(params[1]), 'base64')
        : params[1];
      fs.writeFileSync(params[0], body);
      rpc(ws, id, { success: true });
    } else if (method === 'listFiles') {
      const p = params[0] || os.homedir();
      const entries = fs.readdirSync(p, { withFileTypes: true });
      rpc(ws, id, entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })));
    } else if (method === 'exists') {
      rpc(ws, id, fs.existsSync(params[0]));
    } else if (method === 'listPorts') {
      rpc(ws, id, listListeningPorts());
    } else if (method === 'checkpointStatus') {
      rpc(ws, id, checkpoints ? checkpoints.status() : { available: false, reason: 'checkpoints are not configured' });
    } else if (method === 'checkpointList') {
      if (!checkpoints) return rpc(ws, id, []);
      rpc(ws, id, checkpoints.list(params[0], params[1], params[2]));
    } else if (method === 'checkpointPlan') {
      if (!checkpoints) return rpc(ws, id, null, 'checkpoints are not configured');
      rpc(ws, id, checkpoints.plan(params[0], params[1], params[2]));
    } else if (method === 'checkpointRestore') {
      if (!checkpoints) return rpc(ws, id, null, 'checkpoints are not configured');
      rpc(ws, id, checkpoints.restore(params[0], params[1], params[2]));
    } else {
      rpc(ws, id, null, 'unknown method: ' + method);
    }
  } catch (err) {
    rpc(ws, id, null, err instanceof Error ? err.message : String(err));
  }
}

// ── Daemon startup ─────────────────────────────────────────────────────

function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const USER = cfg.user, TOKEN = cfg.token;
  const HTTP_ORIGIN = (cfg.origin || 'https://proteus.ashishkumarsingh.com').replace(/\/+$/, '');
  const WS_ORIGIN = HTTP_ORIGIN.replace(/^http/, 'ws');
  const ctx = { checkpoints: createCheckpoints({ keep: cfg.checkpointKeep }) };

  let WS;
  // `ws` is optional — Node 22+ has a global WebSocket. A `ws` that is present
  // but fails to load is not that case and must not pass as absent.
  try { WS = require('ws'); }
  catch (err) { if (!err || err.code !== 'MODULE_NOT_FOUND') throw err; }
  const mkWs = (url) => WS ? new WS(url) : new WebSocket(url);

  let backoff = 1000;
  async function getTicket() {
    const res = await fetch(HTTP_ORIGIN + '/pc/connect-ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: USER, token: TOKEN }),
    });
    let body = {};
    try { body = await res.json(); }
    catch (err) {
      // A gateway's non-JSON error page is diagnosed by the status check
      // below; an unreadable body behind HTTP 200 is a real protocol failure.
      if (res.ok) throw new Error(`ticket exchange returned an unreadable body: HTTP ${res.status}`, { cause: err });
    }
    if (!res.ok || !body.ticket) throw new Error(body.error || ('ticket exchange failed: HTTP ' + res.status));
    return body.ticket;
  }

  async function connect() {
    let ticket;
    try { ticket = await getTicket(); }
    catch (err) {
      log('Ticket exchange failed:', err.message || err);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 60_000);
      return;
    }
    const WS_URL = `${WS_ORIGIN}/pc/connect?user=${encodeURIComponent(USER)}&ticket=${encodeURIComponent(ticket)}`;
    log('Connecting to', WS_ORIGIN + '/pc/connect');
    const ws = mkWs(WS_URL);
    ws.addEventListener('open', () => {
      log('Connected');
      backoff = 1000;
      ws.send(JSON.stringify({ type: 'HELLO', user: USER, os: os.platform(), hostname: os.hostname(), pid: process.pid }));
    });
    ws.addEventListener('message', (ev) => {
      try {
        const payload = ev.data instanceof ArrayBuffer
          ? new TextDecoder().decode(ev.data)
          : String(ev.data);
        handle(JSON.parse(payload), ws, ctx);
      }
      catch (err) { log('parse error:', err); }
    });
    ws.addEventListener('close', () => {
      log('Disconnected, reconnecting in', backoff, 'ms');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 60_000);
    });
    ws.addEventListener('error', (err) => log('WS error:', err.message || err));
  }
  connect();
}

if (require.main === module) main();

module.exports = { handle, createCheckpoints, listListeningPorts };
