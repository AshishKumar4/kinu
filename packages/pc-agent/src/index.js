#!/usr/bin/env node
// Proteus PC agent — reverse-WebSocket daemon.
// Node 18+. No external deps (uses global fetch + WebSocket polyfill via ws fallback).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const CONFIG_PATH = path.join(os.homedir(), '.proteus', 'config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const AGENT = cfg.agent, TOKEN = cfg.token;
const ORIGIN = (cfg.origin || 'https://proteus.ashishkumarsingh.com').replace(/^http/, 'ws');
const WS_URL = `${ORIGIN}/pc/connect?agent=${encodeURIComponent(AGENT)}&token=${encodeURIComponent(TOKEN)}`;

let WS;
try { WS = require('ws'); } catch { /* Node 22+ has global WebSocket */ }
const mkWs = (url) => WS ? new WS(url) : new WebSocket(url);

function log(...a) { console.log(new Date().toISOString(), ...a); }

function rpc(ws, id, result, error) {
  ws.send(JSON.stringify(error ? { id, error } : { id, result }));
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
      rpc(ws, id, 'ok');
    } else if (method === 'listFiles') {
      const p = params[0] || os.homedir();
      const entries = fs.readdirSync(p, { withFileTypes: true });
      rpc(ws, id, entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })));
    } else if (method === 'listPorts') {
      rpc(ws, id, []); // PC-local port listing not implemented in v1
    } else {
      rpc(ws, id, null, 'unknown method: ' + method);
    }
  } catch (err) {
    rpc(ws, id, null, err instanceof Error ? err.message : String(err));
  }
}

let backoff = 1000;
function connect() {
  log('Connecting to', WS_URL);
  const ws = mkWs(WS_URL);
  ws.addEventListener('open', () => {
    log('Connected');
    backoff = 1000;
    ws.send(JSON.stringify({ type: 'HELLO', agent: AGENT, os: os.platform(), hostname: os.hostname(), pid: process.pid }));
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
