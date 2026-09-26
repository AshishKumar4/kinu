#!/usr/bin/env bun
/**
 * Workspace open and switch, measured step by step on the real product.
 *
 *   bun scripts/bench-workspace-open.ts local            # vite dev + scripted model, fresh state
 *   KINU_EVAL_WEB_IDENTITY=… bun scripts/bench-workspace-open.ts https://kinu.run
 *
 * Two workspaces are seeded through the browser's own socket: SMALL at 10 turns and
 * LARGE at 300. Then, per workspace, REPS times:
 *
 *   socket plane (no browser): upgrade → first frame → transcript seed frame (bytes)
 *     → GET /get-messages (bytes) → RPC getWorkspaceSnapshot (bytes)
 *   browser plane: hard load of /workspace/<name> → workbench painted → composer live
 *     → last answer rendered; then SPA switch LARGE → SMALL → LARGE by the sidebar link.
 *
 * Medians are printed as one JSON document. A deployed run creates its workspaces
 * under the eval prefix and deletes them in a `finally`.
 */
import type { Page } from 'puppeteer';
import * as v from 'valibot';
import { withDevServer } from './live-app-harness';
import { launchTestChrome } from './test-chrome';
import { registerScriptedModel, startScriptedModel } from './scripted-model';
import type { ScriptedAnswer, ScriptedRequest } from './scripted-protocol';
import { SCRIPTED_MODEL_SPEC } from '../packages/test-utils/src/scripted-model-spec';
import { openPublicSocket } from '../tests/first-run/public-socket';
import { HEADER_WEBSOCKET, webHeaders, type PublicWebIdentity } from '../evals/src/session';

const TARGET = process.argv[2] ?? 'local';

const SIZES = (process.env.BENCH_OPEN_SIZES ?? '10,300').split(',').map(Number);

const REPS = Number(process.env.BENCH_OPEN_REPS ?? '5');

/** A typical answer's weight: a paragraph and a short list, ~1.2 KB. */
function answerFor(turn: string): string {
  return `Answer to ${turn}. `
    + 'The change lands in the checkout service: the coupon parser now reads the kind column, '.repeat(6)
    + '\n\n- first step\n- second step\n- third step\n';
}

const ScriptedTurnSchema = v.pipe(v.string(), v.regex(/^turn \d+ of [a-z]+$/u));

function script(request: ScriptedRequest) {
  const last = request.userTexts.at(-1) ?? '';

  return { text: v.is(ScriptedTurnSchema, last) ? answerFor(last) : 'Genesis answer.' } satisfies ScriptedAnswer;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

/** One run's milestones by name: ms, or bytes for a `…Bytes`/`…:bytes` key. */
interface Row { [milestone: string]: number }

function medians(rows: readonly Row[]): Row {
  const out: Row = {};

  for (const key of Object.keys(rows[0] ?? {})) out[key] = Math.round(median(rows.map((row) => row[key] ?? Number.NaN)));

  return out;
}

const FrameTypeSchema = v.looseObject({ type: v.string(), id: v.optional(v.string()), method: v.optional(v.string()) });

/** A frame's type and id; a non-JSON payload (a ping) is no frame. */
function frameOf(text: string): v.InferOutput<typeof FrameTypeSchema> | null {
  if (!text.startsWith('{')) return null;
  const frame = v.safeParse(FrameTypeSchema, JSON.parse(text));

  return frame.success ? frame.output : null;
}

/** The callable lanes `getWorkspaceSnapshot` fans out to; `getAgentStatus` is not callable, so its share is the remainder. */
const SNAPSHOT_LANES = ['getToolDescriptions', 'getMemoryContent', 'getExecutors', 'getActivePlanReview', 'getWorkspaceTabPresence', 'listSlates'];

async function socketOpen(origin: string, identity: PublicWebIdentity, name: string): Promise<Row> {
  const url = new URL(`/agents/orchestrator-agent/${name}`, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const t0 = performance.now();
  const socket = new HEADER_WEBSOCKET(url.toString(), { headers: webHeaders(identity) });
  const times: Row = {};
  const seeded = Promise.withResolvers<void>();
  const answers = new Map<string, (text: string) => void>();

  socket.addEventListener('open', () => { times.upgradeMs = performance.now() - t0; });
  socket.addEventListener('message', (event: MessageEvent<string>) => {
    const at = performance.now() - t0;
    const text = String(event.data);
    times.firstFrameMs ??= at;
    const frame = frameOf(text);

    if (frame?.type === 'cf_agent_chat_messages' && times.seedMs === undefined) {
      times.seedMs = at;
      times.seedBytes = text.length;
      seeded.resolve();
    }

    if (frame?.type === 'rpc' && frame.id !== undefined) answers.get(frame.id)?.(text);
  });

  await seeded.promise;

  const g0 = performance.now();
  const messages = await fetch(new URL(`/agents/orchestrator-agent/${name}/get-messages`, origin), { headers: webHeaders(identity) });
  const body = await messages.text();
  times.getMessagesMs = performance.now() - g0;
  times.getMessagesBytes = body.length;

  const call = async (method: string): Promise<{ ms: number; bytes: number }> => {
    const r0 = performance.now();
    const answered = Promise.withResolvers<string>();
    answers.set(method, answered.resolve);
    socket.send(JSON.stringify({ type: 'rpc', id: method, method, args: [] }));
    const reply = await answered.promise;

    return { ms: performance.now() - r0, bytes: reply.length };
  };

  const snapshot = await call('getWorkspaceSnapshot');
  times.snapshotMs = snapshot.ms;
  times.snapshotBytes = snapshot.bytes;

  // The snapshot's lanes one at a time, so a lane that grows with the transcript names itself.
  for (const method of SNAPSHOT_LANES) times[`lane:${method}`] = (await call(method)).ms;
  socket.close();

  return times;
}

const PageTimesSchema = v.object({ leftMs: v.number(), lastAnswerMs: v.number(), composerMs: v.number() });

type PageTimes = v.InferOutput<typeof PageTimesSchema>;

/** Resolves each milestone at the first animation frame it holds, timed from `since` on the page clock:
 *  the previous page's answer gone, this workspace's last answer shown, then its composer live. */
async function milestones(page: Page, name: string, lastAnswer: string, previousAnswer: string): Promise<PageTimes> {
  return v.parse(PageTimesSchema, await page.evaluate(
    (workspace: string, answer: string, previous: string) => {
      const done = Promise.withResolvers<Record<string, number>>();
      const since = Number(document.documentElement.dataset.benchSince ?? '0');
      const out: Record<string, number> = {};

      const tick = (): void => {
        const now = performance.now() - since;
        const chat = document.querySelector('#chat')?.textContent ?? '';

        if (out.leftMs === undefined && (previous === '' || !chat.includes(previous))) out.leftMs = now;

        if (location.pathname === `/workspace/${workspace}` && out.lastAnswerMs === undefined && chat.includes(answer)) out.lastAnswerMs = now;

        const composer = document.querySelector<HTMLTextAreaElement>('[data-composer-root] textarea');

        if (out.lastAnswerMs !== undefined && out.composerMs === undefined && composer !== null && !composer.disabled) out.composerMs = now;

        if (out.leftMs !== undefined && out.lastAnswerMs !== undefined && out.composerMs !== undefined) done.resolve(out);
        else requestAnimationFrame(tick);
      };

      requestAnimationFrame(tick);

      return done.promise;
    },
    name, lastAnswer, previousAnswer,
  ));
}

async function hardLoad(page: Page, origin: string, name: string, lastAnswer: string): Promise<PageTimes> {
  await page.goto('about:blank');
  await page.goto(`${origin}/workspace/${name}`, { waitUntil: 'domcontentloaded' });

  return milestones(page, name, lastAnswer, '');
}

/** What the page asked of the product after a click, by when (ms from the click) and how large. */
interface Timeline {
  start(): void;
  read(): Row;
}


/** Network milestones through CDP: the socket upgrade, the seed frame, `/get-messages`, and each RPC's reply. */
async function timeline(page: Page): Promise<Timeline> {
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  let t0 = performance.now();
  let row: Row = {};
  let sockets = new Set<string>();
  let requests: string[] = [];
  const rpcMethod = new Map<string, string>();
  const rpcSent = new Map<string, number>();
  const at = (): number => Math.round(performance.now() - t0);
  const first = (key: string, value: number): void => { row[key] ??= value; };

  cdp.on('Network.webSocketCreated', (event) => {
    if (!new URL(event.url).pathname.startsWith('/agents/')) return;
    sockets.add(event.requestId);
    first('wsCreated', at());
  });
  cdp.on('Network.webSocketHandshakeResponseReceived', (event) => { if (sockets.has(event.requestId)) first('wsOpen', at()); });
  cdp.on('Network.webSocketFrameSent', (event) => {
    if (!sockets.has(event.requestId)) return;
    const frame = frameOf(event.response.payloadData);

    if (frame?.type !== 'rpc' || frame.id === undefined) return;
    row[`rpc:${frame.method ?? '?'}:count`] = (row[`rpc:${frame.method ?? '?'}:count`] ?? 0) + 1;
    rpcMethod.set(`${event.requestId}:${frame.id}`, frame.method ?? '?');
    rpcSent.set(`${event.requestId}:${frame.id}`, at());
  });
  cdp.on('Network.webSocketFrameReceived', (event) => {
    if (!sockets.has(event.requestId)) return;
    const payload = event.response.payloadData;
    const frame = frameOf(payload);

    if (frame === null) return;

    if (frame.type === 'cf_agent_chat_messages') {
      first('seedFrame', at());
      first('seedBytes', payload.length);
    }

    if (frame.type === 'rpc' && frame.id !== undefined) {
      const key = `${event.requestId}:${frame.id}`;
      const method = rpcMethod.get(key);

      if (method === undefined) return;
      first(`rpc:${method}:sent`, rpcSent.get(key) ?? -1);
      first(`rpc:${method}:done`, at());
      first(`rpc:${method}:bytes`, payload.length);
    }
  });
  const urls = new Map<string, string>();
  cdp.on('Network.requestWillBeSent', (event) => {
    const path = new URL(event.request.url).pathname;

    if (process.env.BENCH_OPEN_RAW === '1') requests.push(`${String(at())} ${path}`);

    if (!path.startsWith('/api/') && !path.endsWith('/get-messages')) return;
    const key = path.endsWith('/get-messages') ? 'get-messages' : path.replace(/\/workspace(s)?\/[^/]+/u, '/workspace$1/:name');
    urls.set(event.requestId, key);
    first(`http:${key}:sent`, at());
  });
  cdp.on('Network.loadingFinished', (event) => {
    const key = urls.get(event.requestId);

    if (key === undefined) return;
    first(`http:${key}:done`, at());
    first(`http:${key}:bytes`, event.encodedDataLength);
  });

  return {
    start: () => { t0 = performance.now(); row = {}; sockets = new Set(); urls.clear(); requests = []; },
    read: () => {
      if (requests.length > 0) process.stderr.write(`raw requests: ${requests.join(' | ')}\n`);

      return row;
    },
  };
}


interface Target { name: string; last: string }

/** Clicks the sidebar link to `to` while `from` is shown; `left` is `from`'s answer leaving the chat. */
/** A person reads the page before switching: the click lands after the open's own reads have landed. */
const SETTLE_MS = 1500;

async function spaSwitch(page: Page, to: Target, from: Target, network: Timeline): Promise<Row> {
  await page.waitForSelector(`a[href="/workspace/${to.name}"]`);
  await Bun.sleep(SETTLE_MS);
  network.start();
  await page.evaluate((workspace: string) => {
    document.documentElement.dataset.benchSince = String(performance.now());
    document.querySelector<HTMLAnchorElement>(`a[href="/workspace/${workspace}"]`)?.click();
  }, to.name);

  const times = await milestones(page, to.name, to.last, from.last);

  return { ...network.read(), ...times };
}

/** A dropped socket (a deploy, an eviction) reopens and the seeding carries on at the next turn. */
const UserTurnSchema = v.looseObject({
  role: v.literal('user'),
  parts: v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()) })),
});

/** The highest `turn N of <tag>` already in the transcript, so a kept workspace resumes where it stopped. */
async function turnsSeeded(origin: string, identity: PublicWebIdentity, name: string, tag: string): Promise<number> {
  const response = await fetch(new URL(`/agents/orchestrator-agent/${name}/get-messages`, origin), { headers: webHeaders(identity) });
  const messages = v.parse(v.array(v.unknown()), await response.json());
  let highest = 0;

  for (const message of messages) {
    const user = v.safeParse(UserTurnSchema, message);

    if (!user.success) continue;

    for (const part of user.output.parts) {
      const match = new RegExp(`^turn (\\d+) of ${tag}$`, 'u').exec(part.text ?? '');

      if (match !== null) highest = Math.max(highest, Number(match[1]));
    }
  }

  return highest;
}

async function seed(origin: string, identity: PublicWebIdentity, name: string, turns: number): Promise<{ ms: number; last: string; reopened: number }> {
  const tag = name.split('-')[3] ?? 'w';
  const t0 = performance.now();
  let turn = (await turnsSeeded(origin, identity, name, tag)) + 1;
  let last = `turn ${String(turn - 1)} of ${tag}`;
  let reopened = -1;

  while (turn <= turns) {
    reopened += 1;

    if (reopened > 50) throw new Error(`seeding ${name} lost its socket ${String(reopened)} times`);

    const budget = new AbortController();
    const socket = openPublicSocket(origin, identity, `/agents/orchestrator-agent/${name}`, budget.signal);

    if (!(await socket.opened)) continue;

    for (; turn <= turns; turn += 1) {
      last = `turn ${String(turn)} of ${tag}`;

      // A dropped socket rejects the turn in flight: that is the reopen signal, logged, not an error of the bench.
      const [sent] = await Promise.allSettled([socket.chat(last)]);

      if (sent.status === 'rejected') {
        process.stderr.write(`seed ${name} turn ${String(turn)}: ${String(sent.reason)}; reopening\n`);

        break;
      }
    }

    socket.close('seeded');
  }

  return { ms: performance.now() - t0, last, reopened };
}

async function createWorkspace(origin: string, identity: PublicWebIdentity, name: string, model: string): Promise<string> {
  const response = await fetch(`${origin}/api/user/workspaces`, {
    method: 'POST',
    headers: { ...webHeaders(identity), 'content-type': 'application/json' },
    body: JSON.stringify({ name, model }),
  });

  const body = await response.text();

  if (!response.ok) throw new Error(`create ${name}: ${String(response.status)} ${body}`);

  return v.parse(v.object({ name: v.string() }), JSON.parse(body)).name;
}

interface Seeded { name: string; turns: number; last: string; seedMs: number }

async function measure(origin: string, identity: PublicWebIdentity, made: readonly Seeded[]): Promise<void> {
  const socketRows: Record<string, Row> = {};

  for (const workspace of made) {
    await socketOpen(origin, identity, workspace.name);
    const rows: Row[] = [];

    for (let rep = 0; rep < REPS; rep += 1) rows.push(await socketOpen(origin, identity, workspace.name));
    socketRows[`${String(workspace.turns)} turns`] = medians(rows);
  }

  const chrome = await launchTestChrome();
  const { browser } = chrome;
  const pageRows: Record<string, Row> = {};

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(0);

    if (identity.kind === 'secret') await page.setExtraHTTPHeaders(webHeaders(identity));

    const [small, large] = made;

    if (small === undefined || large === undefined) throw new Error('two sizes are needed for the switch');

    await hardLoad(page, origin, small.name, small.last);

    // Local `vite dev` serves the client module by module, so its hard load measures the dev server, not the product.
    for (const workspace of TARGET === 'local' ? [] : made) {
      const rows: PageTimes[] = [];

      for (let rep = 0; rep < REPS; rep += 1) rows.push(await hardLoad(page, origin, workspace.name, workspace.last));
      pageRows[`hard load, ${String(workspace.turns)} turns`] = medians(rows);
    }

    const network = await timeline(page);
    const toSmall: Row[] = [];
    const backToLarge: Row[] = [];

    for (let rep = 0; rep < REPS; rep += 1) {
      await hardLoad(page, origin, large.name, large.last);
      toSmall.push(await spaSwitch(page, small, large, network));
      backToLarge.push(await spaSwitch(page, large, small, network));
    }

    if (process.env.BENCH_OPEN_RAW === '1') process.stderr.write(`raw switch rows: ${JSON.stringify({ toSmall, backToLarge })}\n`);
    pageRows[`switch → ${String(small.turns)} turns`] = medians(toSmall);
    pageRows[`switch back → ${String(large.turns)} turns`] = medians(backToLarge);
  } finally {
    await chrome.close();
  }

  process.stdout.write(`${JSON.stringify({ target: origin, reps: REPS, seeded: made.map(({ turns, seedMs }) => ({ turns, seedMs })), socket: socketRows, page: pageRows }, null, 2)}\n`);
}

/** A deployed run deletes every workspace it created, whether seeding or measuring failed. */
async function run(origin: string, identity: PublicWebIdentity, model: string): Promise<void> {
  const tags = ['small', 'large', 'medium', 'huge'];
  const made: Seeded[] = [];
  const created: string[] = [];

  // A kept pair (`BENCH_OPEN_KEEP=1`, named again in `BENCH_OPEN_WORKSPACES`) resumes seeding and is
  // measured again after a fix; the lane's last run drops `KEEP`, so its `finally` deletes them.
  const kept = process.env.BENCH_OPEN_WORKSPACES?.split(',') ?? [];

  try {
    for (const [index, turns] of SIZES.entries()) {
      const tag = tags[index] ?? `s${String(index)}`;
      const name = kept[index] ?? await createWorkspace(origin, identity, `eval-bench-open-${tag}-${Date.now().toString(36)}`, model);
      created.push(name);
      const seeded = await seed(origin, identity, name, turns);
      made.push({ name, turns, last: seeded.last, seedMs: Math.round(seeded.ms) });
      process.stderr.write(`seeded ${name}: ${String(turns)} turns in ${String(Math.round(seeded.ms))} ms, ${String(seeded.reopened)} reopens\n`);
    }

    await measure(origin, identity, made);
  } finally {
    if (TARGET !== 'local' && process.env.BENCH_OPEN_KEEP !== '1') {
      for (const name of created) {
        await fetch(`${origin}/api/user/workspaces/${name}`, { method: 'DELETE', headers: webHeaders(identity) });
      }
    }
  }
}

if (TARGET === 'local') {
  const model = await startScriptedModel(script);

  try {
    await withDevServer(async ({ origin }) => {
      await registerScriptedModel(origin, model.baseURL);
      await run(origin, { kind: 'loopback' }, SCRIPTED_MODEL_SPEC);
    });
  } finally {
    await model.stop();
  }
} else {
  const secret = process.env.KINU_EVAL_WEB_IDENTITY?.trim();

  if (!secret) throw new Error('KINU_EVAL_WEB_IDENTITY is required for a deployed target');
  await run(TARGET, { kind: 'secret', secret }, process.env.BENCH_OPEN_MODEL ?? 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct');
}
