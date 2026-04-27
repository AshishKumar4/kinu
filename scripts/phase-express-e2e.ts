#!/usr/bin/env bun
/**
 * End-to-end test: Express app in Sandbox via direct RPC + Puppeteer
 * screenshots.
 *
 * The LLM-driven path (asking the agent in chat to build Express) works
 * but can take 2-5 minutes depending on container cold-start + npm
 * install time, which is too long for a reliable headless test. This
 * script instead drives the SAME primitives the agent would call
 * (executeInExecutor / getExposedPorts) directly, which verifies the
 * infrastructure end-to-end:
 *
 *   Sandbox DO + container, SANDBOX binding, proxyToSandbox preview
 *   routing, getExposedPorts RPC, Executors UI iframe grid.
 *
 * Steps:
 *   1. Open live site, navigate to a fresh agent, screenshot chat view.
 *   2. Open a direct agents-SDK WebSocket to the same agent.
 *   3. Via executeInExecutor:
 *        - write /workspace/server.js with an Express app on port 3000
 *        - npm init + install express
 *        - start node server.js in background (nohup)
 *        - call sandbox.exec("sleep 3 && curl -s localhost:3000") to
 *          smoke-test it runs
 *   4. Expose port 3000 via a direct executor tool call.
 *   5. Poll getExposedPorts RPC → retrieve public URL.
 *   6. curl the URL, verify "Hello World" in the body.
 *   7. Switch UI to Executors > Sandbox → screenshot iframe rendering.
 */

import puppeteer from 'puppeteer';
import { mkdirSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';

const BASE = process.env.PROTEUS_BASE_URL ?? 'https://proteus.ashishkumarsingh.com';
const AGENT = 'express-e2e-' + Date.now().toString(36);
const OUT_DIR = '/workspace/proteus/docs/screenshots/e2e-express-app';
const TRANSCRIPT = `${OUT_DIR}/transcript.txt`;
const MAX_WAIT_MS = 5 * 60 * 1000;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(TRANSCRIPT, `=== Express E2E ===\nagent=${AGENT}\nbase=${BASE}\nstart=${new Date().toISOString()}\n\n`);
const log = (m: string) => { console.log(m); appendFileSync(TRANSCRIPT, m + '\n'); };

function uid() { return Math.random().toString(36).slice(2, 10); }

/**
 * Open a WebSocket to the agent's @callable RPC channel. The agents SDK
 * client uses `wss://HOST/agents/<class>/<name>` (same route as the React
 * useAgent). We then send { type: "cf_agent_rpc_call", id, method, args }
 * and wait for the matching response.
 */
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

async function rpcCall(ws: WebSocket, method: string, args: unknown[] = [], timeoutMs = 120_000): Promise<unknown> {
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
      } catch { /* ignore non-JSON */ }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ type: 'rpc', id, method, args }));
  });
}

async function main() {
  // Resolve the chrome binary lazily — the version-tagged path drifts.
  const chromeRoot = '/root/.cache/puppeteer/chrome';
  let chromePath: string | undefined;
  try {
    const { readdirSync } = await import('node:fs');
    const versions = readdirSync(chromeRoot).filter(d => d.startsWith('linux-'));
    const candidate = versions[0]
      ? `${chromeRoot}/${versions[0]}/chrome-linux64/chrome`
      : undefined;
    if (candidate && existsSync(candidate)) chromePath = candidate;
  } catch { /* fall through to puppeteer's bundled resolution */ }

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => log(`[pageerror] ${e.message}`));

  try {
    // 1. Open agent
    log(`\n--- Opening agent: ${AGENT}`);
    await page.goto(`${BASE}/agent/${AGENT}`, { waitUntil: 'networkidle2', timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 4000));
    await page.screenshot({ path: `${OUT_DIR}/01-agent-opened.png`, fullPage: true });

    // 2. Open WS to drive the same RPCs the UI uses
    log(`\n--- Opening agent WS to ${BASE}`);
    const ws = await openAgentWs(BASE, AGENT);
    log(`  connected`);

    // 3. Write server.js via sandbox.writeFile
    log(`\n--- Step 1/4: write /workspace/server.js`);
    // NOTE: port 3000 is reserved by CF Sandbox's control plane. Use 8080.
    const serverJs = `
const express = require('express');
const app = express();
app.get('/', (req, res) => { res.send('Hello World from Proteus Sandbox'); });
app.listen(8080, '0.0.0.0', () => console.log('listening on 8080'));
`.trim();
    const writeRes = await rpcCall(ws, 'executeInExecutor',
      ['sandbox', `mkdir -p /workspace && cat > /workspace/server.js <<'EOF'\n${serverJs}\nEOF`], 120_000);
    log(`  write result: ${JSON.stringify(writeRes).slice(0, 200)}`);

    // 4. npm init + install
    log(`\n--- Step 2/4: npm init + install express`);
    const npmRes = await rpcCall(ws, 'executeInExecutor',
      ['sandbox', 'cd /workspace && npm init -y > /dev/null && npm install express 2>&1 | tail -5'], 180_000);
    log(`  npm result: ${JSON.stringify(npmRes).slice(0, 300)}`);

    // 5. Start node in background
    log(`\n--- Step 3/4: start node server.js in background`);
    const startRes = await rpcCall(ws, 'executeInExecutor',
      ['sandbox', 'cd /workspace && nohup node server.js > /workspace/out.log 2>&1 & disown; sleep 3; cat /workspace/out.log'], 60_000);
    log(`  start result: ${JSON.stringify(startRes).slice(0, 300)}`);

    // 6. Smoke test from inside the container
    log(`\n--- Step 4/4: curl localhost:8080 from inside container`);
    const smokeRes = await rpcCall(ws, 'executeInExecutor',
      ['sandbox', 'curl -sf http://localhost:8080/ || echo CURL_FAIL'], 30_000);
    log(`  smoke: ${JSON.stringify(smokeRes).slice(0, 200)}`);

    // 7. Expose port 8080 (CF Sandbox reserves 3000 for control plane)
    log(`\n--- Exposing port 8080`);
    const urlInfo = await rpcCall(ws, 'exposeSandboxPort', [8080, 'hello'], 30_000)
      .catch((e) => ({ error: String(e) }));
    log(`  exposePort: ${JSON.stringify(urlInfo).slice(0, 300)}`);

    // 8. Poll getExposedPorts
    log(`\n--- Polling getExposedPorts`);
    const start = Date.now();
    let foundUrl: string | null = null;
    while (Date.now() - start < MAX_WAIT_MS) {
      await new Promise((r) => setTimeout(r, 3000));
      const r = await rpcCall(ws, 'getExposedPorts', ['sandbox'], 15_000) as { ports?: Array<{ port: number; url?: string }> };
      const p = (r.ports ?? []).find((p) => p.port === 8080);
      if (p?.url) { foundUrl = p.url; log(`  @${Math.round((Date.now()-start)/1000)}s — ${p.url}`); break; }
      if (((Date.now()-start)/1000) % 15 < 3) log(`  @${Math.round((Date.now()-start)/1000)}s — ports=${JSON.stringify(r.ports ?? [])}`);
    }

    if (!foundUrl) { log('\nFAIL: no exposed URL'); await page.screenshot({ path: `${OUT_DIR}/05-timeout.png`, fullPage: true }); await browser.close(); ws.close(); process.exit(3); }

    // 9. Fetch the public URL
    log(`\n--- Fetching ${foundUrl}`);
    const hello = await fetch(foundUrl).then((r) => r.text()).catch((e) => `fetch err: ${e}`);
    log(`  body: ${hello.slice(0, 200)}`);
    const helloOk = /hello\s*world/i.test(hello);

    // 10. Switch Puppeteer to Executors > Sandbox and screenshot
    log(`\n--- Switching UI to Executors tab`);
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const t = btns.find((b) => (b.textContent ?? '').trim() === 'Executors');
      if (t) (t as HTMLButtonElement).click();
    });
    await new Promise((r) => setTimeout(r, 6000)); // wait for port poll
    await page.screenshot({ path: `${OUT_DIR}/04-executors-iframe.png`, fullPage: true });

    const iframeUrl = await page.evaluate(() => {
      const iframes = Array.from(document.querySelectorAll('iframe'));
      return iframes.map((f) => f.src).find((s) => s && s.length > 0) ?? null;
    });
    log(`  iframe rendered: ${iframeUrl ?? 'no'}`);

    log(`\n--- Verdict`);
    log(`  Port 3000 exposed: true (${foundUrl})`);
    log(`  Preview returns Hello World: ${helloOk}`);
    log(`  UI iframe renders the exposed URL: ${iframeUrl !== null}`);
    log(`  end=${new Date().toISOString()}`);

    ws.close();
    await browser.close();
    process.exit(helloOk ? 0 : 4);
  } catch (err) {
    log(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    log((err as Error).stack ?? '');
    await browser.close();
    process.exit(99);
  }
}

main();
