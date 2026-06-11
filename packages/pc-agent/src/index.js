#!/usr/bin/env node
// Proteus PC agent — reverse-WebSocket daemon.
// Node 18+. No external deps (uses global fetch + WebSocket polyfill via ws fallback).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const CONFIG_PATH = path.join(os.homedir(), '.proteus', 'device.json');

function log(...a) { console.log(new Date().toISOString(), ...a); }

function rpc(ws, id, result, error) {
  ws.send(JSON.stringify(error ? { id, error } : { id, result }));
}

function runCommand(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

// ── Shadow-git checkpoints ─────────────────────────────────────────────
//
// Mirrors cli-backend/src/checkpoints.ts byte-for-byte (same store layout,
// ref scheme, and commit-subject encoding) so a machine's checkpoints are one
// format regardless of which side wrote them:
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
        throw new Error(CHECKPOINTS_UNAVAILABLE_NO_GIT);
      }
      gitAvailable = true;
      throw new Error((err.stderr ? String(err.stderr).trim() : '') || err.message);
    }
  };

  const probe = () => {
    if (gitAvailable !== null) return gitAvailable;
    try { git(['--version'], os.homedir(), isolatedEnv()); } catch { /* sets gitAvailable */ }
    if (gitAvailable === null) gitAvailable = false;
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
    if (abs === path.parse(abs).root || abs === path.resolve(os.homedir())) return true;
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

  const stageCurrent = (gitDir, workdir) => {
    const env = storeEnv(gitDir, workdir);
    git(['add', '-A'], workdir, env);
    return git(['write-tree'], workdir, env).trim();
  };

  const snapshot = (agent, dir, turn, reason) => {
    if (snapshotSkipped(dir)) return null;
    const abs = path.resolve(dir);
    const gitDir = storeDirFor(agent, abs);
    initStore(gitDir, abs);
    const env = storeEnv(gitDir, abs);
    const tree = stageCurrent(gitDir, abs);

    const refs = storeRefs(gitDir, abs);
    const latest = refs[0];
    if (latest) {
      try {
        if (git(['rev-parse', `${latest.id}^{tree}`], abs, env).trim() === tree) return latest.id;
      } catch { /* unreadable ref — take a fresh snapshot */ }
    }

    const sha = git(['commit-tree', tree, '-m', subjectFor(turn, reason)], abs, env).trim();
    const refName = `${REF_PREFIX}/${String(Date.now()).padStart(13, '0')}-${(refSeq++).toString(36).padStart(3, '0')}`;
    git(['update-ref', refName, sha], abs, env);

    if (refs.length + 1 > keep) {
      for (const stale of storeRefs(gitDir, abs).slice(keep)) {
        git(['update-ref', '-d', stale.ref], abs, env);
      }
      try { git(['prune', '--expire=now'], abs, env); } catch { /* reclamation is best-effort */ }
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
      throw new Error(`checkpoint not found: ${id}`);
    }
    return { gitDir, abs, env };
  };

  /** diff current staged state → checkpoint tree, in restore direction. */
  const diffToCheckpoint = (gitDir, abs, id) => {
    const env = storeEnv(gitDir, abs);
    const currentTree = stageCurrent(gitDir, abs);
    const out = git(['diff-tree', '-r', '--name-status', currentTree, `${id}^{tree}`], abs, env);
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
        if (!hint || typeof hint !== 'object' || !probe()) return null;
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

    list(agent, limit) {
      if (!probe()) return [];
      const agentBase = path.join(base, sanitizeAgent(agent));
      let stores;
      try { stores = fs.readdirSync(agentBase); } catch { return []; }
      const entries = [];
      for (const name of stores) {
        const gitDir = path.join(agentBase, name);
        const marker = path.join(gitDir, WORKDIR_MARKER);
        if (!fs.existsSync(path.join(gitDir, 'HEAD')) || !fs.existsSync(marker)) continue;
        const workdir = fs.readFileSync(marker, 'utf8').trim();
        for (const ref of storeRefs(gitDir, workdir)) {
          const meta = parseSubject(ref.subject);
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
        try { fs.unlinkSync(target); } catch { /* already gone */ }
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
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => rpc(ws, id, { stdout, stderr, exitCode: code ?? 0 }));
      child.on('error', (e) => rpc(ws, id, null, e.message));
    } else if (method === 'readFile') {
      rpc(ws, id, fs.readFileSync(params[0], 'utf8'));
    } else if (method === 'writeFile') {
      if (checkpoints && msg.checkpoint) {
        const hint = msg.checkpoint;
        checkpoints.ensure(hint, hint.dir || checkpoints.workdirForPath(params[0]));
      }
      fs.mkdirSync(path.dirname(params[0]), { recursive: true });
      fs.writeFileSync(params[0], params[1]);
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
      rpc(ws, id, checkpoints.list(params[0], params[1]));
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
  try { WS = require('ws'); } catch { /* Node 22+ has global WebSocket */ }
  const mkWs = (url) => WS ? new WS(url) : new WebSocket(url);

  let backoff = 1000;
  async function getTicket() {
    const res = await fetch(HTTP_ORIGIN + '/pc/connect-ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: USER, token: TOKEN }),
    });
    let body = {};
    try { body = await res.json(); } catch { /* nop */ }
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
      try { handle(JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)), ws, ctx); }
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
