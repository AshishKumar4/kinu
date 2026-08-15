#!/usr/bin/env bun
/**
 * Empirical verification that the Sandbox executor works end-to-end on the
 * live production Proteus worker. Uses Puppeteer against
 * https://proteus.ashishkumarsingh.com and captures:
 *   1. Full-page screenshot of the UI after navigating to the Executors tab
 *   2. Screenshot after running `ls` in the Sandbox terminal
 *   3. The captured output rows (to verify single-output, no double-execute)
 *
 * Writes all artifacts to /workspace/proteus/docs/screenshots/ and a
 * transcript to /tmp/sandbox-verify-transcript.txt.
 */

import puppeteer from 'puppeteer';
import { appendFileSync, writeFileSync, existsSync } from 'node:fs';

const BASE = process.env.PROTEUS_BASE_URL ?? 'https://proteus.ashishkumarsingh.com';
const AGENT = 'sandbox-verify-' + Date.now().toString(36);
const OUT_DIR = '/workspace/proteus/docs/screenshots';
const TRANSCRIPT = '/tmp/sandbox-verify-transcript.txt';

function log(msg: string) { console.log(msg); appendFileSync(TRANSCRIPT, msg + '\n'); }

async function main() {
  writeFileSync(TRANSCRIPT, `=== Sandbox verification ===\nagent=${AGENT}\nbase=${BASE}\nstart=${new Date().toISOString()}\n\n`);

  // Find installed Chrome
  const chromePath = existsSync('/root/.cache/puppeteer/chrome/linux-147.0.7727.56/chrome-linux64/chrome')
    ? '/root/.cache/puppeteer/chrome/linux-147.0.7727.56/chrome-linux64/chrome'
    : undefined;
  log(`chrome: ${chromePath ?? 'auto'}`);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });

    // Capture console + request errors
    page.on('console', m => log(`[console:${m.type()}] ${m.text().slice(0, 200)}`));
    page.on('pageerror', e => log(`[pageerror] ${e.message}`));

    // 1. Home page loads
    log(`\n--- Navigating to ${BASE}`);
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 });
    await new Promise(r => setTimeout(r, 2000));
    const title = await page.title();
    log(`title: ${title}`);
    await page.screenshot({ path: `${OUT_DIR}/01-home.png`, fullPage: true });

    // 2. Navigate directly to /agent/:agentId — the orchestrator creates the
    // DO on first RPC. The React UI reads agentId from the URL param.
    log(`\n--- Opening agent: ${AGENT}`);
    const agentUrl = `${BASE}/agent/${AGENT}`;
    await page.goto(agentUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
    await new Promise(r => setTimeout(r, 5000));
    await page.screenshot({ path: `${OUT_DIR}/02-agent-chat.png`, fullPage: true });
    log(`agent chat loaded`);

    // 3. Click Executors tab
    log(`\n--- Clicking Executors tab`);
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => (b.textContent ?? '').trim() === 'Executors');
      if (btn) { btn.click(); return true; }
      return false;
    });
    log(`  clicked: ${clicked}`);
    await new Promise(r => setTimeout(r, 2500));
    await page.screenshot({ path: `${OUT_DIR}/03-executors-tab.png`, fullPage: true });

    // 4. Click Sandbox executor tab (may already be active)
    log(`\n--- Activating Sandbox tab`);
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => (b.textContent ?? '').trim() === 'Sandbox');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 1500));
    await page.screenshot({ path: `${OUT_DIR}/04-sandbox-active.png`, fullPage: true });

    // 5. Type `ls -la /` in the terminal input and press Enter. A bare `ls`
    // in an empty /workspace shows nothing — list root to prove exec works.
    const testCmd = 'ls -la /';
    log(`\n--- Typing \`${testCmd}\` in terminal`);
    const inputSelector = 'input[placeholder="Type a command..."]';
    const input = await page.$(inputSelector);
    if (!input) {
      log('FAIL: terminal input not found');
      process.exit(2);
    }
    await input.click();
    await input.type(testCmd, { delay: 50 });
    await page.screenshot({ path: `${OUT_DIR}/05-typed-ls.png`, fullPage: true });
    await page.keyboard.press('Enter');

    // 6. Wait for output (container boot may take 10-30s on first run)
    log(`--- Waiting for ls output (up to 60s)`);
    let outputCount = 0;
    let finalHtml = '';
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const row = await page.evaluate(() => {
        const pres = Array.from(document.querySelectorAll('pre'));
        return {
          count: pres.length,
          texts: pres.map(p => p.textContent?.slice(0, 200) ?? ''),
        };
      });
      if (row.count > outputCount) {
        outputCount = row.count;
        log(`  @t=${i + 1}s pre-count=${row.count} last=${JSON.stringify(row.texts[row.texts.length - 1]?.slice(0, 100))}`);
      }
      if (row.count > 0) {
        finalHtml = JSON.stringify(row.texts);
        // Snapshot once we have any output; wait a few more seconds to confirm it's stable.
        if (i > 5 && row.count === outputCount) {
          await new Promise(r => setTimeout(r, 3000));
          break;
        }
      }
    }

    await page.screenshot({ path: `${OUT_DIR}/06-ls-output.png`, fullPage: true });

    // 7. Count the rendered command rows — each pre tag represents one
    // command's stdout. The double-execute bug would produce 2 pre-tags for
    // a single command.
    const rowCount = outputCount;
    log(`\n--- Render analysis (ls)`);
    log(`  terminal output rows: ${rowCount}`);
    log(`  pre-tag count: ${outputCount}`);
    log(`  final texts: ${finalHtml.slice(0, 500)}`);

    // 8. Second scenario — echo + cat
    log(`\n--- Scenario 2: echo hi > /tmp/x && cat /tmp/x`);
    await input.click();
    await input.type('echo hi > /tmp/x && cat /tmp/x', { delay: 30 });
    await page.keyboard.press('Enter');
    let scen2Text = '';
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const t = await page.evaluate(() => {
        const pres = Array.from(document.querySelectorAll('pre'));
        return pres.map(p => p.textContent ?? '').join(' | ');
      });
      if (t.includes('hi')) { scen2Text = t; break; }
    }
    log(`  final pre contents: ${scen2Text.slice(0, 400)}`);
    const scen2Ok = scen2Text.includes('hi');
    await page.screenshot({ path: `${OUT_DIR}/07-echo-cat.png`, fullPage: true });

    const rowCount2 = await page.evaluate(() => document.querySelectorAll('pre').length);
    log(`  total rows after 2 commands: ${rowCount2} (expect 2)`);

    // Fetch the DO server log via the activity RPC? Skip — the screenshot is authoritative.

    const ok = outputCount > 0 && rowCount === 1 && scen2Ok && rowCount2 === 2;
    log(`\n--- Verdict: ${ok ? 'PASS' : 'FAIL'}`);
    log(`  Scenario 1 (ls -la /): output visible = ${outputCount > 0}, rows = ${rowCount} (want 1)`);
    log(`  Scenario 2 (echo+cat): 'hi' in output = ${scen2Ok}, total rows = ${rowCount2} (want 2)`);
    log(`  Double-execute: ${rowCount > 1 || rowCount2 > 2 ? 'DETECTED (bug still present)' : 'no duplicate rows'}`);

    await browser.close();
    log(`\nScreenshots saved to ${OUT_DIR}/`);
    log(`end=${new Date().toISOString()}`);
    process.exit(ok ? 0 : 1);
  } catch (err) {
    log(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    log(err instanceof Error ? err.stack ?? '' : '');
    await browser.close();
    process.exit(99);
  }
}

main();
