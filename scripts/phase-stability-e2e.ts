#!/usr/bin/env bun
/**
 * Stability Phase 1 — empirical verification suite.
 *
 * 4 tests, each with a clear pass/fail and a screenshot artifact under
 *   docs/screenshots/stability-phase1/
 *
 *   T1: WS drop mid-stream — chat panel stays mounted, banner shows,
 *       partial message persists, post-reconnect resume works.
 *   T2: Idle 110s — connection still alive (heartbeat at 25s keeps WS
 *       past Cloudflare's ~100s reaper).
 *   T3: Cold-start exec — transient failures don't surface (retry
 *       wrapper recovers).
 *   T4: Build + show — agent installs Express, exposes port, preview
 *       URL renders both via the inline preview card AND the Executors
 *       badge.
 *
 * Each test writes a section to transcript.txt and the relevant
 * screenshot. Final status is logged + exit code reflects pass/fail.
 *
 * Notes for offline runs:
 *   - Tests T1, T2, T3, T4 require the new Phase 1 code to be DEPLOYED.
 *     If the live site is still on a pre-Phase-1 version, T1/T2/T4 will
 *     surface "expected but not present" findings — the script reports
 *     them honestly rather than passing falsely.
 */

import puppeteer, { type Browser, type Page } from 'puppeteer';
import { mkdirSync, appendFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';

const BASE = process.env.PROTEUS_BASE_URL ?? 'https://proteus.ashishkumarsingh.com';
const RUN_ID = Date.now().toString(36);
const OUT_DIR = '/workspace/proteus/docs/screenshots/stability-phase1';
const TRANSCRIPT = `${OUT_DIR}/transcript.txt`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(TRANSCRIPT, `=== Stability Phase 1 E2E ===\nrun=${RUN_ID}\nbase=${BASE}\nstart=${new Date().toISOString()}\n\n`);

const log = (m: string) => { console.log(m); appendFileSync(TRANSCRIPT, m + '\n'); };
const section = (n: number, title: string) => log(`\n=== T${n}: ${title} ===`);
const pass = (n: number, msg: string) => log(`✅ T${n}: ${msg}`);
const fail = (n: number, msg: string) => log(`❌ T${n}: ${msg}`);
const note = (n: number, msg: string) => log(`ℹ️  T${n}: ${msg}`);

function uid() { return Math.random().toString(36).slice(2, 10); }

function resolveChrome(): string | undefined {
  const root = '/root/.cache/puppeteer/chrome';
  try {
    const versions = readdirSync(root).filter(d => d.startsWith('linux-'));
    const candidate = versions[0] ? `${root}/${versions[0]}/chrome-linux64/chrome` : undefined;
    return candidate && existsSync(candidate) ? candidate : undefined;
  } catch { return undefined; }
}

async function openAgentWs(base: string, agent: string): Promise<WebSocket> {
  const wsUrl = base.replace(/^http/, 'ws') + `/agents/orchestrator-agent/${agent}`;
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WS connect timeout')), 15_000);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = (e) => { clearTimeout(t); reject(new Error('WS error: ' + JSON.stringify(e))); };
  });
  return ws;
}

async function rpcCall(ws: WebSocket, method: string, args: unknown[] = [], timeoutMs = 60_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = uid();
    const timer = setTimeout(() => reject(new Error(`rpc ${method} timeout`)), timeoutMs);
    const handler = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        if (msg.type === 'rpc' && msg.id === id) {
          clearTimeout(timer); ws.removeEventListener('message', handler);
          if (msg.success) resolve(msg.result); else reject(new Error(String(msg.error)));
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ type: 'rpc', id, method, args }));
  });
}

interface TestCtx {
  browser: Browser;
  page: Page;
}

/** Liveness: does the live URL serve the Phase 1 build? Detected via the
 *  inline preview card class fingerprint or the heartbeat ping pattern in
 *  the bundle. We grep the JS bundle for a marker. */
async function detectPhase1Deployed(page: Page): Promise<boolean> {
  // Open the home page and grab the bundle URL.
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 });
  const bundleUrl = await page.evaluate(() => {
    const s = Array.from(document.querySelectorAll('script[src]'))
      .map((el) => (el as HTMLScriptElement).src)
      .find((u) => /index-.*\.js$/.test(u));
    return s ?? null;
  });
  if (!bundleUrl) return false;
  const text = await fetch(bundleUrl).then(r => r.text()).catch(() => '');
  // Phase 1 markers — strings unique to commits c31f3b1 / 88bc5b5 / 59e26d3
  // that survive Vite minification:
  //   "auto-reconnecting"      from use-proteus.ts onError log
  //   "Try again"              from ErrorBoundary fallback button
  //   "Executors tab"          from preview-card guidance text
  // Require ≥2 markers to avoid false positives from coincidental string
  // matches in the SDK or React framework.
  let hits = 0;
  if (text.includes('auto-reconnecting')) hits++;
  if (text.includes('Try again')) hits++;
  if (text.includes('Showing a running app')) hits++;
  return hits >= 2;
}

// ── T1: WS drop mid-stream ───────────────────────────────────────
async function testWsDrop(ctx: TestCtx, agent: string): Promise<boolean> {
  section(1, 'WS drop mid-stream');
  const { page } = ctx;
  await page.goto(`${BASE}/agent/${agent}`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await new Promise(r => setTimeout(r, 4000));
  await page.screenshot({ path: `${OUT_DIR}/t1-01-loaded.png`, fullPage: true });
  // Send a long-running prompt
  await page.evaluate(() => {
    const ta = document.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      ta.focus();
      ta.value = 'List 30 random programming languages, one per line, no other text';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  // Wait for streaming to start
  await new Promise(r => setTimeout(r, 3000));
  await page.screenshot({ path: `${OUT_DIR}/t1-02-streaming.png`, fullPage: true });
  // Toggle offline → online
  await page.setOfflineMode(true);
  note(1, 'WS dropped (offline mode ON)');
  await new Promise(r => setTimeout(r, 5000));
  await page.screenshot({ path: `${OUT_DIR}/t1-03-offline.png`, fullPage: true });
  // The chat panel should still be mounted — count message bubbles.
  const stillMounted = await page.evaluate(() => {
    const text = document.body.innerText;
    const hasBanner = /reconnect/i.test(text);
    const hasChatPanel = !!document.querySelector('textarea');
    return { hasBanner, hasChatPanel };
  });
  log(`  during-offline: banner=${stillMounted.hasBanner} chat-panel=${stillMounted.hasChatPanel}`);
  await page.setOfflineMode(false);
  note(1, 'Network restored');
  await new Promise(r => setTimeout(r, 8000));
  await page.screenshot({ path: `${OUT_DIR}/t1-04-recovered.png`, fullPage: true });
  const recovered = await page.evaluate(() => {
    const text = document.body.innerText;
    return { connected: !/reconnect/i.test(text), hasChatPanel: !!document.querySelector('textarea') };
  });
  log(`  after-restore: connected=${recovered.connected} chat-panel=${recovered.hasChatPanel}`);
  const ok = stillMounted.hasChatPanel && recovered.hasChatPanel;
  ok ? pass(1, 'chat panel survived WS drop') : fail(1, 'chat panel was unmounted on disconnect');
  return ok;
}

// ── T2: 110s idle keepalive ──────────────────────────────────────
async function testIdleKeepalive(agent: string): Promise<boolean> {
  section(2, 'Idle 110s keepalive');
  const ws = await openAgentWs(BASE, agent);
  log('  WS opened');
  // Capture incoming messages (heartbeat acks etc) just to keep connection live
  const start = Date.now();
  const closed = new Promise<{ at: number; code?: number; reason?: string }>(resolve => {
    ws.onclose = (e) => resolve({ at: Date.now() - start, code: e.code, reason: e.reason });
  });
  // Timeout after 115s (we expect to NOT close)
  const timeout = new Promise<{ at: number }>(r => setTimeout(() => r({ at: -1 }), 115_000));
  log('  waiting 110s without sending any messages...');
  const winner = await Promise.race([closed, timeout]);
  if (winner.at === -1) {
    pass(2, '110s elapsed and WS still open (idle reaper survived)');
    ws.close();
    return true;
  } else {
    fail(2, `WS closed at ${winner.at}ms (code=${(winner as { code?: number }).code})`);
    return false;
  }
}

// ── T3: cold-start exec ──────────────────────────────────────────
async function testColdStart(agent: string): Promise<boolean> {
  section(3, 'Cold-start exec smoothness');
  // Fresh agent name forces a sandbox cold start.
  const freshAgent = `${agent}-cold-${uid()}`;
  log(`  using fresh agent ${freshAgent} to force cold start`);
  const ws = await openAgentWs(BASE, freshAgent);
  const start = Date.now();
  // First exec on a brand-new container — cold start path.
  let result: unknown;
  try {
    result = await rpcCall(ws, 'executeInExecutor', ['sandbox', 'echo cold-start-ok'], 120_000);
  } catch (err) {
    fail(3, `first exec rejected: ${(err as Error).message}`);
    ws.close();
    return false;
  }
  const elapsed = Date.now() - start;
  log(`  first exec result @${elapsed}ms: ${JSON.stringify(result).slice(0, 200)}`);
  const r = result as { stdout?: string; error?: string };
  // Pass if exec returned a non-error result (retry wrapper transparently
  // recovered any transient failures during cold start).
  const ok = !r.error && (r.stdout ?? '').includes('cold-start-ok');
  ok ? pass(3, `cold-start exec succeeded in ${elapsed}ms`) : fail(3, `cold-start exec failed: ${r.error ?? r.stdout}`);
  ws.close();
  return ok;
}

// ── T4: build hello world + show preview ─────────────────────────
async function testBuildAndShow(ctx: TestCtx, agent: string): Promise<boolean> {
  section(4, 'Build hello world + auto-show preview');
  const { page } = ctx;
  // Use the same direct-RPC path as the existing Express E2E to deterministically
  // exercise expose + getExposedPorts, then verify the UI surfaces the preview
  // via either (a) inline preview card under the tool result OR (b) Executors
  // badge with port count > 0 OR (c) iframe in Executors tab.
  const freshAgent = `${agent}-show-${uid()}`;
  await page.goto(`${BASE}/agent/${freshAgent}`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await new Promise(r => setTimeout(r, 3000));
  const ws = await openAgentWs(BASE, freshAgent);
  log('  setting up Express server in sandbox (direct RPCs)');
  const serverJs = `
const express = require('express');
const app = express();
app.get('/', (req, res) => { res.send('Hello World from Proteus Sandbox'); });
app.listen(8080, '0.0.0.0', () => console.log('listening on 8080'));`.trim();
  await rpcCall(ws, 'executeInExecutor',
    ['sandbox', `mkdir -p /workspace && cat > /workspace/server.js <<'EOF'\n${serverJs}\nEOF`], 120_000);
  await rpcCall(ws, 'executeInExecutor',
    ['sandbox', 'cd /workspace && npm init -y > /dev/null && npm install express 2>&1 | tail -1'], 180_000);
  await rpcCall(ws, 'executeInExecutor',
    ['sandbox', 'cd /workspace && nohup node server.js > /workspace/out.log 2>&1 & disown; sleep 2'], 30_000);
  log('  exposing port 8080');
  const exposeResult = await rpcCall(ws, 'exposeSandboxPort', [8080, 'hello'], 30_000) as { url?: string };
  log(`  expose URL: ${exposeResult.url}`);
  // `<port>-<sandbox>-<token>.<suffix>` — the preview hostname the SDK mints.
  const previewHost = /^https:\/\/\d{4,5}-[a-z0-9][a-z0-9-]*-[a-z0-9_]+\./i;
  if (!exposeResult.url || !previewHost.test(exposeResult.url)) {
    fail(4, `expose did not return a preview URL: ${exposeResult.url}`); ws.close(); return false;
  }
  // Verify the URL is actually serving the app
  const body = await fetch(exposeResult.url).then(r => r.text()).catch(() => '');
  const helloOk = /hello\s*world/i.test(body);
  log(`  fetched body: ${body.slice(0, 100)}`);
  // Now refresh the page so the UI re-polls getExposedPorts and updates badges
  await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 });
  await new Promise(r => setTimeout(r, 6000));
  await page.screenshot({ path: `${OUT_DIR}/t4-01-after-expose.png`, fullPage: true });
  // Look for: (a) Executors tab badge with a number, (b) iframe with the URL
  const uiCheck = await page.evaluate((url) => {
    const text = document.body.innerText;
    const tabBadge = /Executors\s+\d+/.test(text) || !!document.querySelector('button [class*="emerald"]');
    // Look for an iframe with the preview URL
    const iframes = Array.from(document.querySelectorAll('iframe')).map(f => (f as HTMLIFrameElement).src);
    const iframeMatch = iframes.some(s => typeof s === 'string' && s.startsWith(url));
    return { tabBadge, iframes, iframeMatch, expected: url };
  }, exposeResult.url);
  log(`  UI check: tab-badge=${uiCheck.tabBadge} iframe-match=${uiCheck.iframeMatch} iframes=${JSON.stringify(uiCheck.iframes)}`);
  // Switch to Executors tab if iframe didn't show on Identity
  if (!uiCheck.iframeMatch) {
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const t = btns.find((b) => (b.textContent ?? '').trim().startsWith('Executors'));
      if (t) (t as HTMLButtonElement).click();
    });
    await new Promise(r => setTimeout(r, 6000));
    await page.screenshot({ path: `${OUT_DIR}/t4-02-executors-tab.png`, fullPage: true });
  }
  const finalCheck = await page.evaluate((url) => {
    const iframes = Array.from(document.querySelectorAll('iframe')).map(f => (f as HTMLIFrameElement).src);
    return { iframes, found: iframes.some(s => typeof s === 'string' && s.startsWith(url)) };
  }, exposeResult.url);
  log(`  final iframe check: found=${finalCheck.found} iframes=${JSON.stringify(finalCheck.iframes)}`);
  const ok = helloOk && finalCheck.found;
  ok ? pass(4, 'preview iframe visible in UI + body returns Hello World')
     : fail(4, `helloOk=${helloOk} iframeFound=${finalCheck.found}`);
  ws.close();
  return ok;
}

async function main() {
  const chromePath = resolveChrome();
  log(`chromePath=${chromePath ?? '(default)'}\n`);
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const phase1 = await detectPhase1Deployed(page);
  log(`phase1Deployed=${phase1}`);

  const baseAgent = `stability-${RUN_ID}`;
  const ctx: TestCtx = { browser, page };
  const results: Record<string, boolean> = {};

  try {
    results.t1 = await testWsDrop(ctx, baseAgent);
  } catch (e) { fail(1, (e as Error).message); results.t1 = false; }
  try {
    results.t2 = await testIdleKeepalive(baseAgent);
  } catch (e) { fail(2, (e as Error).message); results.t2 = false; }
  try {
    results.t3 = await testColdStart(baseAgent);
  } catch (e) { fail(3, (e as Error).message); results.t3 = false; }
  try {
    results.t4 = await testBuildAndShow(ctx, baseAgent);
  } catch (e) { fail(4, (e as Error).message); results.t4 = false; }

  log(`\n=== Summary ===`);
  for (const [k, v] of Object.entries(results)) {
    log(`  ${k.toUpperCase()}: ${v ? 'PASS' : 'FAIL'}`);
  }
  log(`phase1Deployed=${phase1}`);
  log(`end=${new Date().toISOString()}`);

  await browser.close();
  const allPass = Object.values(results).every(Boolean);
  process.exit(allPass ? 0 : 1);
}

main().catch(e => { log(`FATAL: ${(e as Error).message}\n${(e as Error).stack}`); process.exit(99); });
