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
 *   seed  — write 300 mixed rows (operator turns, replies, steers, and a
 *           programmatic card of every kind) straight into the workspace DO's
 *           SQLite. At the default size that is 32.14 MiB, of which the window
 *           hydrates 224 rows and cuts the oldest 76 — two pages of walk.
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
/**
 * Serialized text size for the rows whose text the client actually renders.
 *
 * Measured against the shipped window at this default: 300 rows seed 32.14 MiB,
 * the window hydrates the newest 224, and the oldest 76 start outside it — a
 * walk of two full `CHAT_PAGE_SIZE` pages (+40, +36). That multi-page walk is
 * the point: the cursor is a rowid seek, so its failure modes live at page
 * boundaries, and a one-page walk crosses none.
 */
const TEXT_BYTES = Number(process.env.KINU_HISTORY_PROOF_TEXT_BYTES ?? 130_000);
const DB_DIR = process.env.KINU_HISTORY_PROOF_DB_DIR
  ?? "packages/cf-backend/.wrangler/state/v3/do/kinu-OrchestratorAgent";
const ARTIFACTS = process.env.KINU_HISTORY_PROOF_ARTIFACTS ?? "scripts/artifacts/history-walk";
/** Clear pre-existing rows in the target workspace before seeding. */
const FRESH = process.env.KINU_HISTORY_PROOF_FRESH === "1";

const CHROME_CANDIDATES = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
const WALK_POLL_MS = 500;
const PAGE_WAIT_MS = 30_000;
/** Page size of `getChatHistoryPage`, mirroring `CHAT_PAGE_SIZE` in
 *  `packages/cf-backend/src/hooks/use-chat-thread.ts`. Estimate logging only;
 *  the walk itself stops on the boundary, never on a count. */
const HISTORY_PAGE_SIZE = 40;
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

/**
 * The workspace's own Durable Object storage.
 *
 * The directory also holds miniflare's `metadata.sqlite`, which has no
 * conversation in it, and one file per addressed DO id. Pick by "carries the
 * session provider's table", never by name or mtime: the server touches
 * metadata on every boot, and one wrong pick seeds a transcript nothing reads.
 */
function workspaceDb(): string {
  const dir = DB_DIR.startsWith("/") ? DB_DIR : join(process.cwd(), DB_DIR);
  if (!existsSync(dir)) fail(`no Durable Object state under ${dir} — start the dev server once, create the workspace, stop it`);
  const candidates = readdirSync(dir)
    .filter((file) => file.endsWith(".sqlite") && file !== "metadata.sqlite")
    .map((file) => ({ path: join(dir, file), size: statSync(join(dir, file)).size }))
    .sort((a, b) => b.size - a.size);
  const withTranscript = candidates.filter((candidate) => {
    const db = new Database(candidate.path, { readonly: true });
    try {
      return db.query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assistant_messages'`).get() !== null;
    } finally {
      db.close();
    }
  });
  const chosen = (withTranscript.length > 0 ? withTranscript : candidates)[0];
  if (chosen === undefined) fail(`no workspace *.sqlite under ${dir}`);
  if (candidates.length > 1) {
    log(`${candidates.length} workspace databases present — seeding the largest with a transcript table; set KINU_HISTORY_PROOF_DB to choose`);
  }
  return chosen.path;
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

  const dbPath = process.env.KINU_HISTORY_PROOF_DB ?? workspaceDb();
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

/** Marker attribute the pin puts on the chat scroller, so every later
 *  evaluation addresses exactly the container the pin found. */
const SCROLLER_MARK = "data-proof-scroller";

/**
 * In-page sampler: the card every direct child of the chat scroller is wearing.
 *
 * Mirrors MessageView's own branch order — data attributes first, then each
 * card's rendered label, then the user bubble — because that order is what
 * decides the card, and a sampler that guessed differently would report a
 * disagreement between itself and the surface as a defect in the surface.
 */
function sampleScroller(): { kind: string; seed: number | null }[] | null {
  const scroller = document.querySelector("[data-proof-scroller]");
  if (scroller === null) return null;
  return [...scroller.children].map((child) => {
    const text = child.textContent ?? "";
    // The walk's own affordance. Idle it renders EMPTY, which is why this is
    // decided on text at all: every real row carries either a seed marker or a
    // card's label, so a child with no text is never a message.
    if (text.trim() === "") return { kind: ":boundary-idle", seed: null };
    if (text.includes("Beginning of the conversation")) return { kind: ":boundary-exhausted", seed: null };
    if (text.includes("Loading earlier messages")) return { kind: ":boundary-loading", seed: null };
    if (text.includes("Could not load earlier")) return { kind: ":boundary-error", seed: null };
    const marked = text.match(/\[seed (\d+)\]/);
    const seed = marked === null ? null : Number(marked[1]);
    // The card's marker attribute sits on the row's OWN root — a card is what
    // MessageView returns — so a descendant-only lookup reads a system or
    // advisor row as an ordinary reply.
    const attributed = (name: string): string | null =>
      child.matches(`[${name}]`) ? child.getAttribute(name) : child.querySelector(`[${name}]`)?.getAttribute(name) ?? null;
    const system = attributed("data-system-event");
    if (system !== null) return { kind: `system_event:${system}`, seed };
    const advisor = attributed("data-advisor-severity");
    if (advisor !== null) return { kind: `advisor:${advisor}`, seed };
    const job = text.match(/Background (\S+) task (completed|failed|was cancelled)/);
    if (job !== null) return { kind: `background_job:${job[1]}`, seed };
    if (text.includes("Workspace created")) return { kind: "workspace_created", seed };
    if (/You (approved|denied) \d+ queued commands?/.test(text)) return { kind: "deferred_approval", seed };
    if (text.includes("Background event")) return { kind: "event_drain", seed };
    if (child.querySelector(".p-user-bubble") !== null) {
      return { kind: text.includes("steered mid-turn") ? "steer" : "user", seed };
    }
    return { kind: "assistant", seed };
  });
}

/** Pin the chat scroller: the one scroll container already showing seeded rows.
 *  Returns false until the hydration window has rendered. */
function pinScrollerInPage(mark: string): boolean {
  const found = [...document.querySelectorAll("div.overflow-y-auto.space-y-5")]
    .find((candidate) => /\[seed \d+\]/.test(candidate.textContent ?? ""));
  if (found === undefined) return false;
  found.setAttribute(mark, "1");
  return true;
}

/**
 * What the page reports after a scroll to the top, polled until it is truthy:
 * a terminal state of the walk, or the new child count once a page has landed.
 *
 * `previous` is what makes this a wait rather than a read — the count is
 * always truthy, so returning it unconditionally would report "moved" on the
 * first poll and the proof would walk past pages it never saw arrive.
 */
function walkTickInPage(previous: number): "end" | "error" | number | false {
  const scroller = document.querySelector("[data-proof-scroller]");
  if (scroller === null) return false;
  const children = [...scroller.children];
  if (children.some((child) => (child.textContent ?? "").includes("Could not load earlier"))) return "error";
  if (children.some((child) => (child.textContent ?? "").includes("Beginning of the conversation"))) return "end";
  return children.length > previous ? children.length : false;
}

/** How many times `needle` appears in the whole scroller. */
function countInPage(needle: string): number {
  const scroller = document.querySelector("[data-proof-scroller]");
  return ((scroller?.textContent ?? "").split(needle).length) - 1;
}

/** Bring the oldest rendered row into view for the final capture. */
function showOldestInPage(): void {
  document.querySelector("[data-proof-scroller]")?.children[0]?.scrollIntoView({ block: "start" });
}

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
  const sampled = await page.evaluate(sampleScroller);
  if (sampled === null) fail("the chat scroller vanished while sampling");
  return v.parse(DomRowsSchema, sampled);
}

async function pinScroller(page: Page): Promise<ElementHandle<Element>> {
  await page.waitForFunction(pinScrollerInPage, { timeout: 300_000, polling: WALK_POLL_MS }, SCROLLER_MARK);
  const pinned = await page.$(`[${SCROLLER_MARK}]`);
  if (pinned === null) fail("could not pin the chat scroller");
  return pinned;
}

/** The duplicate check, read from the rendered text rather than from the row
 *  list, so a row drawn twice under one container is still caught. */
async function occurrences(page: Page, needle: string): Promise<number> {
  return await page.evaluate(countInPage, needle);
}

/**
 * The view once it has stopped changing: the same row list twice in a row.
 *
 * A seed of this size renders over several commits, and a sample taken during
 * one reports a list the client is still building. Measured on this transcript:
 * the settled view never changes a row's card afterwards (100 samples over 25s,
 * zero changes), so settling is what separates "the client is still painting"
 * from "the client lost something" — and only the second is a defect.
 */
async function settled(page: Page): Promise<DomRow[]> {
  let previous = await sample(page);
  for (let attempt = 0; attempt < 240; attempt++) {
    await Bun.sleep(WALK_POLL_MS);
    const current = await sample(page);
    const same = current.length === previous.length
      && current.every((row, k) => row.kind === previous[k].kind && row.seed === previous[k].seed);
    if (same) return current;
    previous = current;
  }
  fail("the transcript never stopped changing — the client kept rewriting rows");
}

/** Whether the row's card renders the stored text at all. Three of them fold it
 *  away by design and carry a unique LABEL instead, so they have no marker to
 *  check — their identity is the label, matched by `expectedKind`. */
function rendersItsText(row: SeedRow): boolean {
  return row.kind !== "background_job" && row.kind !== "deferred_approval" && row.kind !== "workspace_created";
}

/**
 * The first place the rendered thread stops being the seeded one, or null.
 *
 * Every term on the "got" side comes from the DOM. Nothing is filled in from
 * the expectation — an earlier version substituted the expected row number
 * whenever a child carried no marker, which reported an empty affordance div as
 * a seeded row rendering under the wrong card.
 */
function firstDivergence(actual: readonly DomRow[], expected: readonly SeedRow[]): string | null {
  for (let k = 0; k < Math.max(actual.length, expected.length); k++) {
    const want = expected[k];
    const seen = actual[k];
    if (want === undefined) return `position ${k}: nothing left to expect, got ${seen?.kind}@${seen?.seed ?? "no marker"}`;
    const wanted = `${expectedKind(want)}@${want.i}`;
    if (seen === undefined) return `position ${k}: want ${wanted}, got nothing — the thread ended early`;
    if (seen.kind !== expectedKind(want)) return `position ${k}: want ${wanted}, got ${seen.kind}@${seen.seed ?? "no marker"}`;
    if (rendersItsText(want) && seen.seed !== want.i) {
      return `position ${k}: want ${wanted}, got that card carrying ${seen.seed ?? "no marker"}`;
    }
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
    const initial = renderedRows(await settled(page));

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
    log(`stage 4: screenshot 1-initial-window.png — walking ${Math.ceil(cut / HISTORY_PAGE_SIZE)}+ pages to the oldest row`);

    let midWalkCaptured = false;
    let reachedBeginning = false;
    for (let iteration = 1; iteration <= MAX_WALK_ITERATIONS; iteration++) {
      const before = await sample(page);
      const renderedBefore = renderedRows(before).length;
      await scroller.evaluate((el) => { el.scrollTop = 0; });
      // Truthy only once the walk has actually moved: a page landed, or the
      // store stated an end. A timeout here is a stalled walk, which is the
      // defect this proof exists to catch.
      const ticked = await page.waitForFunction(
        walkTickInPage, { timeout: PAGE_WAIT_MS, polling: WALK_POLL_MS }, before.length,
      );
      const tick = v.parse(WalkTickSchema, await ticked.jsonValue());
      if (tick === "error") fail("the page's own HistoryBoundary reported: Could not load earlier messages");

      const rendered = renderedRows(await settled(page));
      log(`stage 5: page ${iteration} — ${rendered.length}/${ROWS} rows rendered (+${rendered.length - renderedBefore})`);
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

    await page.evaluate(showOldestInPage);
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
      if (!rendersItsText(row)) continue;
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
