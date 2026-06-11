#!/usr/bin/env node
// Proteus PC agent — reverse-WebSocket daemon.
// Node 18+. No external deps (uses global fetch + WebSocket polyfill via ws fallback).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');

const CONFIG_PATH = path.join(os.homedir(), '.proteus', 'device.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const USER = cfg.user, TOKEN = cfg.token;
const HTTP_ORIGIN = (cfg.origin || 'https://proteus.ashishkumarsingh.com').replace(/\/+$/, '');
const WS_ORIGIN = HTTP_ORIGIN.replace(/^http/, 'ws');

let WS;
try { WS = require('ws'); } catch { /* Node 22+ has global WebSocket */ }
const mkWs = (url) => WS ? new WS(url) : new WebSocket(url);

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

function handle(msg, ws) {
  const { id, method, params } = msg;
  try {
    if (method === 'exec') {
      const cmd = params[0];
      const child = spawn('/bin/sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => rpc(ws, id, { stdout, stderr, exitCode: code ?? 0 }));
      child.on('error', (e) => rpc(ws, id, null, e.message));
    } else if (method === 'readFile') {
      rpc(ws, id, fs.readFileSync(params[0], 'utf8'));
    } else if (method === 'writeFile') {
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
}

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
