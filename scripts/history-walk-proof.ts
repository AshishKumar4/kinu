#!/usr/bin/env bun
/**
 * history-walk-proof — chat history never vanishes (#67), proven at runtime.
 *
 * The client's live list is the agents SDK's `get-messages` seed, bounded by
 * Think's hydrationByteBudget. A long transcript therefore starts PARTIAL: the
 * window holds the newest rows and cuts the oldest. Everything older exists
 * only in storage and is reached one cursored page at a time, over
 * `getChatHistoryPage`, triggered by scrolling the real container to its top.
 * This script proves that walk loses nothing:
 *
 *   seed  — write ~300 mixed rows (operator turns, replies, steers,
 *           programmatic cards of every kind) straight into the workspace DO's
 *           SQLite, sized so the shipped window provably cuts the oldest rows.
 *           Run with the dev server STOPPED.
 *   walk  — cold-load the real client, confirm the initial view IS the
 *           window's tail (the oldest rows missing), scroll to the top until
 *           the boundary reports the conversation's beginning, and assert
 *           every seeded row renders exactly once, in order, wearing its
 *           correct card — programmatic rows keep their ProgrammaticTurnCard
 *           after pagination. Screenshots: initial window, mid-walk, oldest
 *           row. Run with the dev server RUNNING.
 *
 * Conventions follow scripts/liveness-capture.ts: timestamped stages, an
 * env-overridable origin, artifacts under scripts/artifacts/.
 *
 * Zero product diff: this drives the shipped behaviour with no knobs.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import * as v from "valibot";
import puppeteer, { type Browser, type ElementHandle, type Page } from "puppeteer";

/* ── configuration ─────────────────────────────────────────────────────────── */

const ORIGIN = (process.env.KINU_HISTORY_PROOF_ORIGIN ?? "http://127.0.0.1:5187").replace(/\/+$/, "");
const WORKSPACE = process.env.KINU_HISTORY_PROOF_WORKSPACE ?? "history-walk-proof";
const ROWS = Number(process.env.KINU_HISTORY_PROOF_ROWS ?? 300);
/** Serialized text size for the rows whose text the client actually renders.
 *  Sized so that, against the shipped ~24 MiB hydration window, the oldest
 *  rows of the transcript start OUTSIDE it — the premise the walk disproves. */
const TEXT_BYTES = Number(process.env.KINU_HISTORY_PROOF_TEXT_BYTES ?? 105_000);
const DB_DIR = process.env.KINU_HISTORY_PROOF_DB_DIR
  ?? "packages/cf-backend/.wrangler/state/v3/do/kinu-OrchestratorAgent";
const ARTIFACTS = process.env.KINU_HISTORY_PROOF_ARTIFACTS ?? "scripts/artifacts/history-walk";
/** Clear pre-existing rows in the target workspace before seeding. */
const FRESH = process.env.KINU_HISTORY_PROOF_FRESH === "1";

const CHROME_CANDIDATES = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
const WALK_POLL_MS = 500;
const PAGE_WAIT_MS = 30_000;
const MAX_WALK_ITERATIONS = 120;

const t0 = Date.now();
function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] +${String(Date.now() - t0).padStart(6)}ms ${msg}`);
}
function fail(msg: string): never {
  log(`FAIL ${msg}`);
  process.exit(1);
}

/* ── the seed: one deterministic transcript ────────────────────────────────── */

export type RowKind =
  | "workspace_created" | "background_job" | "deferred_approval" | "advisor"
  | "event_drain" | "steer" | "user" | "assistant";

export interface SeedRow {
  readonly i: number;
  readonly kind: RowKind;
  /** Stored row id. Programmatic rows carry the provenance prefix the client's
   *  classifier reads; operator rows never do. */
  readonly id: string;
  readonly role: "user" | "assistant";
  /** Serialized UI message exactly as the durable store holds it. */
  readonly content: string;
  /** Unique marker the rendered text carries. The three label-only cards fold
   *  their text away and are matched by their rendered label instead. */
  readonly marker: string;
  readonly jobKind: string | null;
}

/** Metadata values a seeded row can carry: the provenance markers the client's
 *  classifier reads, and nothing else. */
type SeedMetadata = Record<string, string | number | boolean>;

const PADDING_SOURCE = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ";

/** `marker` followed by filler, `bytes` long — the marker stays at the head so
 *  a truncating card still renders it. */
function padded(marker: string, bytes: number): string {
  const fill = PADDING_SOURCE.repeat(Math.ceil((bytes - marker.length) / PADDING_SOURCE.length));
  return `${marker} ${fill}`.slice(0, Math.max(marker.length + 1, bytes - 1));
}

/** The row plan. Deterministic in `i` alone, so `seed` and `walk` agree without
 *  passing anything between them, and a re-run replays the same transcript. */
export function rowFor(i: number): SeedRow {
  const marker = `[seed ${i}]`;
  const programmatic = i === 1 || i % 13 === 0 || i % 17 === 0 || i % 23 === 0 || i % 29 === 0;
  const id = `${programmatic ? "programmatic:" : ""}hw-${String(i).padStart(4, "0")}`;

  const card = (event: string, extra: SeedMetadata, text = marker): string => JSON.stringify({
    id, role: "user", parts: [{ type: "text", text }],
    metadata: { kinuAuthor: "harness", kinuEvent: event, ...extra },
  });

  if (i === 1) {
    return { i, kind: "workspace_created", id, role: "user", content: card("workspace_created", {}), marker, jobKind: null };
  }
  if (i % 17 === 0) {
    const jobKind = `deploy-${i}`;
    return {
      i, kind: "background_job", id, role: "user", marker, jobKind,
      content: card("background_job", { kind: jobKind, status: "completed" }),
    };
  }
  if (i % 23 === 0) {
    return {
      i, kind: "deferred_approval", id, role: "user", marker, jobKind: null,
      content: card("deferred_approval", { decision: "approved", count: (i % 5) + 2 }),
    };
  }
  if (i % 29 === 0) {
    return {
      i, kind: "advisor", id, role: "user", marker, jobKind: null,
      content: card("advisor", { advisorSeverity: "concern" }, `${marker} advisor note on the preceding turn.`),
    };
  }
  if (i % 13 === 0) {
    // Real drained-event wire format, so the card's own parser runs.
    const brief = padded(`${marker} drained event brief.`, TEXT_BYTES);
    return {
      i, kind: "event_drain", id, role: "user", marker, jobKind: null,
      content: card("event_drain", {}, `- [schedule] from proof-source: ${brief}`),
    };
  }
  if (i % 19 === 0) {
    return {
      i, kind: "steer", id, role: "user", marker, jobKind: null,
      content: JSON.stringify({
        id, role: "user", parts: [{ type: "text", text: padded(marker, TEXT_BYTES) }],
        metadata: { kinuSteer: true },
      }),
    };
  }
  const role = i % 2 === 0 ? "assistant" : "user";
  return {
    i, kind: role, id, role, marker, jobKind: null,
    content: JSON.stringify({ id, role, parts: [{ type: "text", text: padded(marker, TEXT_BYTES) }] }),
  };
}

export function plan(): SeedRow[] {
  return Array.from({ length: ROWS }, (_, k) => rowFor(k + 1));
}

/* ── seed ──────────────────────────────────────────────────────────────────── */

function newestWorkspaceDb(): string {
  const dir = DB_DIR.startsWith("/") ? DB_DIR : join(process.cwd(), DB_DIR);
  if (!existsSync(dir)) fail(`no Durable Object state under ${dir} — start the dev server once, create the workspace, stop it`);
  const newest = readdirSync(dir).filter((f) => f.endsWith(".sqlite"))
    .map((f) => ({ path: join(dir, f), modified: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.modified - a.modified)[0];
  if (newest === undefined) fail(`no *.sqlite under ${dir}`);
  return newest.path;
}

async function seed(): Promise<void> {
  let servingStatus: string | null = null;
  try {
    const probe = await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(2000) });
    servingStatus = `HTTP ${probe.status}`;
  } catch (err) {
    // A refused connection is exactly the state direct seeding requires. Any
    // other failure (timeout, TLS, name resolution) does not establish that the
    // server is stopped, and seeding under a live writer would race it.
    const reason = err instanceof Error ? err.message : String(err);
    if (!/refused|ECONNREFUSED|Unable to connect|failed to connect/i.test(reason)) {
      fail(`could not establish whether ${ORIGIN} is serving: ${reason}`);
    }
    log(`origin refuses connections (${reason}) — as direct seeding requires`);
  }
  if (servingStatus !== null) {
    fail(`${ORIGIN} is serving (${servingStatus}) — stop the dev server before writing its SQLite directly`);
  }

  const dbPath = process.env.KINU_HISTORY_PROOF_DB ?? newestWorkspaceDb();
  log(`seeding ${dbPath}`);
  const db = new Database(dbPath);
  try {
    // The session provider's own schema: created here too, so a workspace whose
    // agent has never taken a turn can still be seeded.
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL DEFAULT '',
        parent_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_assistant_msg_parent ON assistant_messages(parent_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_assistant_msg_session ON assistant_messages(session_id)`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS assistant_fts USING fts5(id UNINDEXED, session_id UNINDEXED, role UNINDEXED, content, tokenize='porter unicode61')`);

    const held = db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM assistant_messages`).get();
    const existing = held?.n ?? 0;
    if (existing > 0) {
      if (!FRESH) fail(`${dbPath} already holds ${existing} rows — pass KINU_HISTORY_PROOF_FRESH=1 to clear this throwaway proof workspace`);
      db.exec(`DELETE FROM assistant_messages`);
      db.exec(`DELETE FROM assistant_fts`);
      log(`cleared ${existing} pre-existing rows`);
    }

    const rows = plan();
    const insert = db.prepare(
      `INSERT INTO assistant_messages (id, session_id, parent_id, role, content, created_at)
       VALUES (?, '', ?, ?, ?, ?)`,
    );
    const fts = db.prepare(
      `INSERT INTO assistant_fts (id, session_id, role, content) VALUES (?, '', ?, ?)`,
    );
    const base = Date.parse("2026-08-21T08:00:00Z");
    let parent: string | null = null;
    db.transaction(() => {
      for (const row of rows) {
        insert.run(row.id, parent, row.role, row.content, new Date(base + row.i * 1000).toISOString());
        fts.run(row.id, row.role, row.content);
        parent = row.id;
      }
    })();

    const stored = db.query<{ bytes: number; n: number }, []>(
      `SELECT SUM(LENGTH(CAST(content AS BLOB))) bytes, COUNT(*) n FROM assistant_messages`).get();
    const counts: Partial<Record<RowKind, number>> = {};
    for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
    log(`seeded ${stored?.n ?? 0} rows, ${((stored?.bytes ?? 0) / (1024 * 1024)).toFixed(2)} MiB — ${JSON.stringify(counts)}`);
    log(`start the dev server, then: bun scripts/history-walk-proof.ts walk`);
  } finally {
    db.close();
  }
}

/* ── walk ──────────────────────────────────────────────────────────────────── */

/** One rendered row as the DOM reports it: the card the surface chose, and the
 *  row number when that card renders its text. Parsed, because the page is a
 *  trust boundary like any other. */
const DomRowSchema = v.object({
  kind: v.pipe(v.string(), v.nonEmpty()),
  seed: v.nullable(v.number()),
});
const DomRowsSchema = v.array(DomRowSchema);
type DomRow = v.InferOutput<typeof DomRowSchema>;

/** The walk's state as the page reports it after a scroll to the top. */
const WalkTickSchema = v.union([v.literal("end"), v.literal("error"), v.number()]);

/** In-page sampler: classify every direct child of the chat scroller. Runs
 *  inside the page, so it is self-contained and mirrors MessageView's own
 *  branch order — data attributes first, then each card's rendered label. */
const SAMPLE_FN = `
() => {
  const scroller = document.querySelector('[data-proof-scroller]');
  if (!scroller) return null;
  const classify = (child) => {
    const t = child.textContent ?? '';
    if (t.includes('Beginning of the conversation')) return { kind: ':boundary-exhausted', seed: null };
    if (t.includes('Loading earlier messages')) return { kind: ':boundary-loading', seed: null };
    if (t.includes('Could not load earlier')) return { kind: ':boundary-error', seed: null };
    const seedMatch = t.match(/\\[seed (\\d+)\\]/);
    const seed = seedMatch ? Number(seedMatch[1]) : null;
    const sys = child.querySelector('[data-system-event]');
    if (sys) return { kind: 'system_event:' + sys.getAttribute('data-system-event'), seed };
    const adv = child.querySelector('[data-advisor-severity]');
    if (adv) return { kind: 'advisor:' + adv.getAttribute('data-advisor-severity'), seed };
    const job = t.match(/Background (\\S+) task (completed|failed|was cancelled)/);
    if (job) return { kind: 'background_job:' + job[1], seed };
    if (t.includes('Workspace created')) return { kind: 'workspace_created', seed };
    if (/You (approved|denied) \\d+ queued commands?/.test(t)) return { kind: 'deferred_approval', seed };
    if (t.includes('Background event')) return { kind: 'event_drain', seed };
    const bubble = child.querySelector('.p-user-bubble');
    if (bubble) return { kind: t.includes('steered mid-turn') ? 'steer' : 'user', seed };
    return { kind: 'assistant', seed };
  };
  return [...scroller.children].map(classify);
}`;

/** The scroller, pinned under a marker attribute so later evaluations address
 *  exactly the container this one found. */
const PIN_SCROLLER_FN = `
() => {
  const candidates = [...document.querySelectorAll('div.overflow-y-auto.space-y-5')];
  const el = candidates.find((c) => /\\[seed \\d+\\]/.test(c.textContent ?? ''));
  if (!el) return false;
  el.setAttribute('data-proof-scroller', '1');
  return true;
}`;

/** What the page reports after a scroll to the top: the walk's terminal states,
 *  or the child count, which grows as a page lands. */
const WALK_TICK_FN = `
() => {
  const el = document.querySelector('[data-proof-scroller]');
  if (!el) return false;
  const children = [...el.children];
  if (children.some((c) => (c.textContent ?? '').includes('Could not load earlier'))) return 'error';
  if (children.some((c) => (c.textContent ?? '').includes('Beginning of the conversation'))) return 'end';
  return el.children.length;
}`;

/** The card signature row `i` must wear, mirroring the sampler's vocabulary. */
function expectedKind(row: SeedRow): string {
  return row.kind === "background_job" ? `background_job:${row.jobKind}`
    : row.kind === "advisor" ? "advisor:concern"
      : row.kind;
}

async function launchBrowser(): Promise<{ browser: Browser; page: Page }> {
  const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
  const options: Parameters<typeof puppeteer.launch>[0] = {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  };
  if (executablePath !== undefined) options.executablePath = executablePath;
  const browser = await puppeteer.launch(options);
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  return { browser, page };
}

/** Every rendered row, boundary affordances stripped, order preserved. */
function renderedRows(sampled: readonly DomRow[]): DomRow[] {
  return sampled.filter((row) => !row.kind.startsWith(":boundary"));
}

async function sample(page: Page): Promise<DomRow[]> {
  const sampled = await page.evaluate(SAMPLE_FN);
  if (sampled === null) fail("the chat scroller vanished while sampling");
  return v.parse(DomRowsSchema, sampled);
}

async function pinScroller(page: Page): Promise<ElementHandle<Element>> {
  await page.waitForFunction(PIN_SCROLLER_FN, { timeout: 300_000, polling: WALK_POLL_MS });
  const pinned = await page.$("[data-proof-scroller]");
  if (pinned === null) fail("could not pin the chat scroller");
  return pinned;
}

/** How many times `needle` appears in the whole scroller — the duplicate check,
 *  read from the rendered text rather than from the row list. */
async function occurrences(page: Page, needle: string): Promise<number> {
  const counted = await page.evaluate(`
    () => {
      const el = document.querySelector('[data-proof-scroller]');
      return (el.textContent ?? '').split(${JSON.stringify(needle)}).length - 1;
    }`);
  return v.parse(v.number(), counted);
}

function firstDivergence(actual: readonly DomRow[], expected: readonly SeedRow[]): string | null {
  for (let k = 0; k < Math.max(actual.length, expected.length); k++) {
    const want = expected[k] === undefined ? "<absent>" : `${expectedKind(expected[k])}@${expected[k].i}`;
    const seen = actual[k];
    const got = seen === undefined ? "<absent>"
      : `${seen.kind}@${seen.seed ?? (expected[k] === undefined ? "?" : expected[k].i)}`;
    if (want !== got) return `position ${k}: want ${want}, got ${got}`;
  }
  return null;
}

async function walk(): Promise<void> {
  const rows = plan();
  const url = `${ORIGIN}/workspace/${WORKSPACE}`;
  mkdirSync(ARTIFACTS, { recursive: true });

  log(`stage 1: cold-loading ${url}`);
  const { browser, page } = await launchBrowser();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
    log("stage 2: page loaded — waiting for the hydration window to render");

    const scroller = await pinScroller(page);
    const initial = renderedRows(await sample(page));

    // Premise: the shipped window cuts the OLDEST rows, so the initial view is
    // a proper suffix of the transcript. A full view would prove nothing.
    if (initial.length >= ROWS) {
      fail(`initial view already holds ${initial.length}/${ROWS} rows — nothing was cut; raise KINU_HISTORY_PROOF_TEXT_BYTES or ROWS`);
    }
    const tailDivergence = firstDivergence(initial, rows.slice(-initial.length));
    if (tailDivergence !== null) fail(`initial view is not the window's tail — ${tailDivergence}`);
    const cut = ROWS - initial.length;
    const seededBytes = rows.reduce((sum, row) => sum + row.content.length, 0);
    log(`stage 3: window holds the NEWEST ${initial.length} of ${ROWS} rows `
      + `(${(seededBytes / (1024 * 1024)).toFixed(2)} MiB seeded) — oldest ${cut} cut, premise proven`);

    await page.screenshot({ path: join(ARTIFACTS, "1-initial-window.png") });
    log(`stage 4: screenshot 1-initial-window.png — walking ${Math.ceil(cut / 40)}+ pages to the oldest row`);

    let midWalkCaptured = false;
    let reachedBeginning = false;
    for (let iteration = 1; iteration <= MAX_WALK_ITERATIONS; iteration++) {
      const before = renderedRows(await sample(page)).length;
      await scroller.evaluate((el) => { el.scrollTop = 0; });
      const ticked = await page.waitForFunction(WALK_TICK_FN, { timeout: PAGE_WAIT_MS, polling: WALK_POLL_MS })
        .then((handle) => handle.jsonValue());
      const tick = v.parse(WalkTickSchema, ticked);
      if (tick === "error") fail("the page's own HistoryBoundary reported: Could not load earlier messages");

      const rendered = renderedRows(await sample(page));
      log(`stage 5: page ${iteration} — ${rendered.length}/${ROWS} rows rendered (+${rendered.length - before})`);
      if (!midWalkCaptured && rendered.length > initial.length) {
        await page.screenshot({ path: join(ARTIFACTS, "2-mid-walk.png") });
        midWalkCaptured = true;
        log("stage 6: screenshot 2-mid-walk.png");
      }
      if (tick === "end") {
        reachedBeginning = true;
        break;
      }
    }
    if (!reachedBeginning) fail(`the walk never reached the conversation's beginning in ${MAX_WALK_ITERATIONS} pages`);

    await page.evaluate(`
      () => {
        const el = document.querySelector('[data-proof-scroller]');
        el?.children[0]?.scrollIntoView({ block: 'start' });
      }`);
    await Bun.sleep(800);

    /* ── the assertions ─────────────────────────────────────────────────── */

    const final = renderedRows(await sample(page));
    log(`stage 7: boundary states the conversation's beginning — ${final.length} rows rendered`);

    if (final.length !== ROWS) {
      fail(`VANISHED OR DUPLICATED: ${final.length} rendered rows, expected ${ROWS} — ${firstDivergence(final, rows) ?? "sequence otherwise equal"}`);
    }
    const divergence = firstDivergence(final, rows);
    if (divergence !== null) fail(`REORDERED OR LOST ITS CARD: ${divergence}`);

    for (const row of rows) {
      // The three label-only cards fold their text away by design; their unique
      // labels were matched positionally above.
      if (row.kind === "background_job" || row.kind === "deferred_approval" || row.kind === "workspace_created") continue;
      const hits = await occurrences(page, row.marker);
      if (hits !== 1) fail(`row ${row.i} (${row.kind}) renders ${hits} times, expected exactly once`);
    }

    await page.screenshot({ path: join(ARTIFACTS, "3-oldest-row.png") });
    log("stage 8: screenshot 3-oldest-row.png");
    log(`PROOF GREEN: ${ROWS} seeded rows, each rendered exactly once, in order, wearing its own card — `
      + `the ${cut} rows the hydration window cut were all recovered by the walk`);
  } finally {
    await browser.close();
  }
}

/* ── main ──────────────────────────────────────────────────────────────────── */

const command = process.argv[2] ?? "walk";
if (command === "seed") await seed();
else if (command === "walk") await walk();
else fail(`unknown command "${command}" — use "seed" or "walk"`);
