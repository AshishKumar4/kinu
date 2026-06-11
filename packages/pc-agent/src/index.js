#!/usr/bin/env node
// Proteus PC agent — reverse-WebSocket daemon.
// Node 18+. No external deps (uses global fetch + WebSocket polyfill via ws fallback).
//
// Every exec runs under an OS sandbox policy (the canonical model lives in
// packages/core/src/safety/sandbox-policy.ts — this file mirrors it in plain
// JS because the daemon must stay a single dependency-free script; keep them
// in sync). Policy comes from ~/.proteus/device.json:
//   "sandbox": { "mode": "read-only"|"workspace-write"|"full",
//                "writableRoots": ["/abs/path"], "network": true|false }
// Default: workspace-write rooted at $HOME + tmp, network OFF. Per-call
// protocol overrides (exec params[1].mode) clamp DOWNWARD only — raising the
// mode requires the user to edit the device config.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

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

// ── Sandbox (mirrors core/src/safety/{sandbox-policy,sandbox-spawn}.ts) ────

const SANDBOX_MODE_RANK = { 'read-only': 0, 'workspace-write': 1, full: 2 };

function isSandboxMode(v) { return v === 'read-only' || v === 'workspace-write' || v === 'full'; }

/** Downward-only: a per-call request can never loosen the configured mode. */
function clampSandboxMode(granted, requested) {
  if (!isSandboxMode(requested)) return granted;
  return SANDBOX_MODE_RANK[requested] < SANDBOX_MODE_RANK[granted] ? requested : granted;
}

function normalizePosixPath(p) {
  const absolute = p.startsWith('/');
  const out = [];
  for (const seg of String(p).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const joined = out.join('/');
  return absolute ? '/' + joined : joined || '.';
}

/** Resolve the device sandbox policy from the config's `sandbox` value. */
function buildSandboxPolicy(raw, env) {
  const home = (env && env.home) || os.homedir();
  const tmp = (env && env.tmp) || os.tmpdir();
  const mode = raw && isSandboxMode(raw.mode) ? raw.mode : 'workspace-write';
  if (mode === 'full') return { mode, writableRoots: [], network: true };
  if (mode === 'read-only') return { mode, writableRoots: [], network: false };
  const extra = raw && Array.isArray(raw.writableRoots)
    ? raw.writableRoots.filter((r) => typeof r === 'string' && r.startsWith('/'))
    : [];
  const roots = [...new Set([home, tmp, ...extra].map(normalizePosixPath))];
  return { mode, writableRoots: roots, network: !!(raw && raw.network === true) };
}

function isPathWritable(policy, p) {
  if (policy.mode === 'full') return true;
  if (policy.mode === 'read-only') return false;
  const norm = normalizePosixPath(p);
  return policy.writableRoots.some((root) => norm === root || norm.startsWith(root === '/' ? '/' : root + '/'));
}

/** Probe the strongest working sandbox backend on this machine (once). */
function detectSandboxBackend() {
  const ok = (cmd, args) => {
    try { return spawnSync(cmd, args, { stdio: 'ignore', timeout: 5000 }).status === 0; }
    catch { return false; }
  };
  if (os.platform() === 'darwin') {
    return ok('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']) ? 'sandbox-exec' : 'none';
  }
  if (ok('bwrap', ['--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-net', '--', '/bin/true'])) return 'bwrap';
  if (ok('unshare', ['-Ucn', '/bin/true'])) return 'unshare';
  return 'none';
}

function seatbeltProfile(policy) {
  const esc = (p) => p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines = [
    '(version 1)', '(deny default)',
    '(allow process-fork)', '(allow process-exec)',
    '(allow sysctl-read)', '(allow mach-lookup)',
    '(allow signal (target same-sandbox))',
    '(allow file-read*)',
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper"))',
    '(allow file-ioctl (literal "/dev/dtracehelper"))',
  ];
  if (policy.mode === 'workspace-write' && policy.writableRoots.length > 0) {
    lines.push('(allow file-write* ' + policy.writableRoots.map((r) => '(subpath "' + esc(r) + '")').join(' ') + ')');
  }
  if (policy.network) lines.push('(allow network*)', '(allow system-socket)');
  return lines.join('\n');
}

/** Build the spawn argv enforcing `policy` via `backend` around a shell command. */
function buildSandboxedArgv(policy, backend, cmd) {
  const inner = ['/bin/sh', '-c', cmd];
  if (policy.mode === 'full') return { argv: inner, enforced: { filesystem: false, network: false } };
  if (backend === 'bwrap') {
    const argv = ['bwrap', '--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'];
    if (policy.mode === 'read-only') argv.push('--tmpfs', '/tmp');
    else for (const root of policy.writableRoots) argv.push('--bind', root, root);
    if (!policy.network) argv.push('--unshare-net');
    argv.push('--', ...inner);
    return { argv, enforced: { filesystem: true, network: !policy.network } };
  }
  if (backend === 'sandbox-exec') {
    return { argv: ['sandbox-exec', '-p', seatbeltProfile(policy), ...inner], enforced: { filesystem: true, network: !policy.network } };
  }
  if (backend === 'unshare') {
    const fsWarning = "bwrap not found — filesystem restrictions of sandbox mode '" + policy.mode + "' are NOT enforced. Install bubblewrap.";
    if (policy.network) return { argv: inner, enforced: { filesystem: false, network: false }, warning: fsWarning };
    return { argv: ['unshare', '-Ucn', '--', ...inner], enforced: { filesystem: false, network: true }, warning: fsWarning + " Network isolation IS enforced via 'unshare -Ucn'." };
  }
  return {
    argv: inner,
    enforced: { filesystem: false, network: false },
    warning: "sandbox mode '" + policy.mode + "' is NOT enforced: no OS sandbox available (Linux: install bubblewrap [bwrap] or util-linux unshare; macOS: sandbox-exec). Commands run UNSANDBOXED.",
  };
}

const FS_DENIAL = [/read-only file system/i, /\bEROFS\b/];
const NET_DENIAL = [
  /network is unreachable/i, /\bENETUNREACH\b/, /could not resolve host/i,
  /temporary failure in name resolution/i, /\bEAI_AGAIN\b/i, /getaddrinfo/i,
  /failed to connect to .+ port \d+/i, /\bECONNREFUSED\b/,
];

function escalation(policy, blocked, detail) {
  const remedy = blocked === 'filesystem'
    ? 'edit the "sandbox" section of ~/.proteus/device.json on the device (raise mode or add writableRoots) and restart the daemon'
    : 'enable "network": true (or mode "full") in the "sandbox" section of ~/.proteus/device.json on the device and restart the daemon';
  const esc = { kind: 'sandbox_escalation', mode: policy.mode, blocked, detail, remedy };
  return 'Sandbox blocked this operation (mode=' + esc.mode + ', blocked=' + blocked + '). ' + detail +
    '. This is the OS sandbox on the device, not a command bug. To proceed: ' + remedy + '.\n' + JSON.stringify(esc);
}

/** Append a structured escalation note when a failed exec matches an
 *  enforced sandbox denial — blocked operations are never silent. */
function annotateDenial(policy, enforced, exitCode, stderr) {
  if (exitCode === 0) return stderr;
  const lines = String(stderr).split('\n').map((l) => l.trim()).filter(Boolean);
  if (enforced.filesystem && policy.mode !== 'full') {
    const hit = lines.find((l) => FS_DENIAL.some((p) => p.test(l)));
    if (hit) return stderr + (stderr && !stderr.endsWith('\n') ? '\n' : '') + escalation(policy, 'filesystem', hit.slice(0, 300));
  }
  if (enforced.network && !policy.network) {
    const hit = lines.find((l) => NET_DENIAL.some((p) => p.test(l)));
    if (hit) return stderr + (stderr && !stderr.endsWith('\n') ? '\n' : '') + escalation(policy, 'network', 'likely caused by the sandbox (network disabled): ' + hit.slice(0, 300));
  }
  return stderr;
}

/** The HELLO `sandbox` field: active policy + what this host really enforces. */
function sandboxReport(policy, backend) {
  const probe = buildSandboxedArgv(policy, backend, 'true');
  return {
    mode: policy.mode,
    writableRoots: policy.writableRoots,
    network: policy.network,
    backend,
    enforced: probe.enforced,
  };
}

// ── RPC surface ─────────────────────────────────────────────────────────────

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

/** Build the per-message dispatcher bound to this device's sandbox. */
function createHandler(sandbox) {
  const { rawConfig, backend } = sandbox;
  const basePolicy = buildSandboxPolicy(rawConfig, sandbox.env);

  return function handle(msg, ws) {
    const { id, method, params } = msg;
    try {
      if (method === 'exec') {
        const cmd = params[0];
        // params[1].mode is the per-invocation override — DOWNWARD only.
        const requested = params[1] && typeof params[1] === 'object' ? params[1].mode : undefined;
        const policy = buildSandboxPolicy(
          Object.assign({}, rawConfig, { mode: clampSandboxMode(basePolicy.mode, requested) }),
          sandbox.env,
        );
        const launch = buildSandboxedArgv(policy, backend, String(cmd));
        if (launch.warning) log('[sandbox]', launch.warning);
        const child = spawn(launch.argv[0], launch.argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('close', (code) => {
          const exitCode = code ?? 0;
          rpc(ws, id, { stdout, stderr: annotateDenial(policy, launch.enforced, exitCode, stderr), exitCode });
        });
        child.on('error', (e) => rpc(ws, id, null, e.message));
      } else if (method === 'readFile') {
        rpc(ws, id, fs.readFileSync(params[0], 'utf8'));
      } else if (method === 'writeFile') {
        // Same policy the OS enforces on exec, applied at the direct-write seam.
        if (!isPathWritable(basePolicy, path.resolve(String(params[0])))) {
          rpc(ws, id, null, escalation(basePolicy, 'filesystem',
            'write to ' + params[0] + ' blocked: ' +
            (basePolicy.mode === 'read-only' ? "mode 'read-only' permits no writes" : 'outside writable roots [' + basePolicy.writableRoots.join(', ') + ']')));
          return;
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
      } else {
        rpc(ws, id, null, 'unknown method: ' + method);
      }
    } catch (err) {
      rpc(ws, id, null, err instanceof Error ? err.message : String(err));
    }
  };
}

// ── Connection lifecycle ────────────────────────────────────────────────────

function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const USER = cfg.user, TOKEN = cfg.token;
  const HTTP_ORIGIN = (cfg.origin || 'https://proteus.ashishkumarsingh.com').replace(/\/+$/, '');
  const WS_ORIGIN = HTTP_ORIGIN.replace(/^http/, 'ws');

  let WS;
  try { WS = require('ws'); } catch { /* Node 22+ has global WebSocket */ }
  const mkWs = (url) => WS ? new WS(url) : new WebSocket(url);

  const backend = detectSandboxBackend();
  const basePolicy = buildSandboxPolicy(cfg.sandbox, undefined);
  const report = sandboxReport(basePolicy, backend);
  log('Sandbox policy:', JSON.stringify(report));
  const probe = buildSandboxedArgv(basePolicy, backend, 'true');
  if (probe.warning) log('[sandbox] WARNING:', probe.warning);
  const handle = createHandler({ rawConfig: cfg.sandbox, backend, env: undefined });

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
      ws.send(JSON.stringify({ type: 'HELLO', user: USER, os: os.platform(), hostname: os.hostname(), pid: process.pid, sandbox: report }));
    });
    ws.addEventListener('message', (ev) => {
      try { handle(JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)), ws); }
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

// Exported for unit tests (the daemon itself only runs main() above).
module.exports = {
  buildSandboxPolicy,
  clampSandboxMode,
  isPathWritable,
  buildSandboxedArgv,
  detectSandboxBackend,
  annotateDenial,
  sandboxReport,
  createHandler,
};
