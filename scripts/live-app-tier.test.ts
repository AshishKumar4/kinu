/**
 * The live-app e2e suite: the real product in a real browser, ONE suite with
 * a parameterised origin.
 *
 * `KINU_E2E_ORIGIN` points the rows at the product to drive:
 *   unset (the pre-publish run) — the suite boots the local dev server itself
 *     (vite dev = real Worker in workerd, real Durable Objects, real client)
 *     through live-app-harness, plus a local scripted model the workspaces are
 *     configured to use, so the visual rows have live content to render.
 *   an https origin (the comprehensive run) — the same three rows run against
 *     that deployment with no second harness and no second copy of any row.
 *
 * SCOPE. This suite owns only what a rendered document can prove: geometry,
 * node identity, and what the DOM shows after a real interaction. The
 * behavioural half of the old draft — a subagent chat opening and answering,
 * text rendering before the tool card it preceded — is RPC and data shape,
 * provable inside the workerd pool without a DOM, and lives there (the
 * cloudflare-os in-pool session harness); it is deliberately NOT here.
 *
 * Every assertion is geometry, identity or counts — never a copied sentence,
 * never a source-text match.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import * as v from 'valibot';
import { createServer as createHttpServer, type Server } from 'node:http';
import { parseJsonValue, type JsonValue } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';

import { withLiveApp, type LiveApp } from './live-app-harness';


const OutboundMessageSchema = v.object({ role: v.optional(v.string()) });

const OutboundBodySchema = v.object({ messages: v.optional(v.array(OutboundMessageSchema)) });

/** The fake model behind the local origin: live SSE so the panes render real content. */
interface FakeModel {
  server: Server | null;
  port: number;
}

async function startFakeModel(): Promise<FakeModel> {
  const state: FakeModel = { server: null, port: 0 };

  const http = createHttpServer((request, response) => {
    let body = '';

    request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://fake.invalid');

      if (url.pathname === '/models' && request.method === 'GET') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-live', name: 'Fake Live' }] }));

        return;
      }

      if (url.pathname === '/chat/completions' && request.method === 'POST') {
        v.parse(OutboundBodySchema, parseJsonValue(body));
        const base = { index: 0, delta: { content: 'Live answer from the fake model.' } };

        const chunk = {
          id: 'chatcmpl-live-tier', object: 'chat.completion.chunk', created: 1, model: 'fake-live',
          choices: [base, { ...base, delta: { role: 'assistant' }, finish_reason: 'stop' }],
        };

        response.setHeader('content-type', 'text/event-stream');
        response.end(`data: ${JSON.stringify(chunk)}\n\n data: [DONE]\n\n`);

        return;
      }

      response.statusCode = 404;
      response.end('nope');
    });
  });

  const listening = Promise.withResolvers<void>();

  http.once('error', listening.reject);
  http.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;

  const parsed = v.parse(v.object({ port: v.number() }), http.address());

  state.server = http;
  state.port = parsed.port;

  return state;
}

async function stopFakeModel(fake: { server: Server | null }): Promise<void> {
  const server = fake.server;

  if (server === null) throw new Error('fake model never bound its server');

  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const WorkspaceEntrySchema = v.object({ name: v.string() });

/** The route's JSON answer, parsed as a value rather than passed as unknown. */
async function apiJson(origin: string, path: string, init?: RequestInit): Promise<JsonValue> {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  const text = await response.text();

  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${String(response.status)}: ${text.slice(0, 200)}`);

  return text ? parseJsonValue(text) : null;
}

async function createWorkspace(origin: string, name: string, purpose: string): Promise<string> {
  const created = v.parse(
    WorkspaceEntrySchema,
    await apiJson(origin, '/api/user/workspaces', {
      method: 'POST', body: JSON.stringify({ name, purpose, model: 'openai-compat/fake-live' }),
    }),
  );

  return created.name;
}

async function openWorkspace(newPage: LiveApp['newPage'], origin: string, workspace: string): Promise<Page> {
  const page = await newPage();

  await page.goto(`${origin}/workspace/${workspace}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(`document.querySelector('textarea') !== null`, { polling: 100 });

  return page;
}

/** Click the control; an absent control throws, and that is the finding. */
const ClickScripts = {
  newAgent: `(() => {
    const create = [...document.querySelectorAll('nav[aria-label="Workspace agents"] button')]
      .find((b) => (b.getAttribute('aria-label') ?? '').includes('New agent'));
    if (create === undefined) throw new Error('no New agent control');
    create.click();
  })()`,
  lastAgentTab: `(() => {
    const tabs = [...document.querySelectorAll('nav[aria-label="Workspace agents"] a')];
    const target = tabs.pop();
    if (target === undefined) throw new Error('no agent tab to open');
    target.click();
  })()`,
  mainTab: `(() => {
    const first = [...document.querySelectorAll('nav[aria-label="Workspace agents"] a')][0];
    if (first === undefined) throw new Error('no Main tab to return to');
    first.click();
  })()`,
  filesTab: `(() => {
    const files = [...document.querySelectorAll('.p-tabstrip')]
      .flatMap((el) => [...el.querySelectorAll('button')])
      .find((b) => b.textContent?.trim() === 'Files');
    if (files === undefined) throw new Error('no Files tab');
    files.click();
  })()`,
} as const;

/** RPC method counts over the socket via CDP, split by direction. */
interface RpcCounts {
  readonly sent: Readonly<Record<string, number>>;
  readonly received: Readonly<Record<string, number>>;
}

const SocketFrameSchema = v.object({ method: v.optional(v.string()), type: v.optional(v.string()) });

interface RpcCounter {
  counts(): RpcCounts;
  stop(): Promise<void>;
}

async function countRpc(page: Page): Promise<RpcCounter> {
  const cdp = await page.createCDPSession();

  await cdp.send('Network.enable');

  const sent: Record<string, number> = {};
  const received: Record<string, number> = {};

  const bump = (table: Record<string, number>, payload: string): void => {
    const parsed = v.safeParse(SocketFrameSchema, parseJsonValue(payload));
    const key = parsed.success ? (parsed.output.method ?? parsed.output.type ?? '?') : 'nonjson';

    table[key] = (table[key] ?? 0) + 1;
  };

  cdp.on('Network.webSocketFrameSent', (event: { response?: { payloadData?: string } }) => {
    bump(sent, event.response?.payloadData ?? '');
  });
  cdp.on('Network.webSocketFrameReceived', (event: { response?: { payloadData?: string } }) => {
    bump(received, event.response?.payloadData ?? '');
  });

  return {
    counts: (): RpcCounts => ({ sent: { ...sent }, received: { ...received } }),
    stop: async (): Promise<void> => { await cdp.detach(); },
  };
}

/** Workspace-scoped reads the right panel owns; Agent and Activity are per agent. */
const WORKSPACE_READS = [
  'getWorkspaceSnapshot', 'getExposedPorts', 'listPendingActions', 'getMemoryContent',
  'getToolDescriptions', 'getExecutors', 'listBackgroundJobs', 'listSlates',
  'listPendingConsents', 'getActivePlanReview',
] as const;

function workspaceReadCount(sent: Readonly<Record<string, number>>): number {
  return WORKSPACE_READS.reduce((total, method) => total + (sent[method] ?? 0), 0);
}

interface PanelVerdict {
  readonly nodeSurvives: boolean;
  readonly scrollSurvives: boolean;
  readonly scrollValue: number;
  readonly workspaceReadsOnSwitch: number;
  readonly workspaceReadsOnBack: number;
}

interface PlanTabsVerdict {
  readonly labels: readonly string[];
  readonly planBearing: number;
}

interface StripGeometry {
  readonly ruleBottom: number;
  readonly stripBottom: number;
  readonly activeBottom: number;
  readonly mode: string;
}

interface GeometryVerdict {
  readonly dark: StripGeometry;
  readonly light: StripGeometry;
}

interface TierVerdicts {
  bootFailure: string | null;
  panel: PanelVerdict | null;
  planTabs: PlanTabsVerdict | null;
  geometry: GeometryVerdict | null;
}

const StripGeometrySchema = v.object({
  ruleBottom: v.number(), stripBottom: v.number(), activeBottom: v.number(), mode: v.string(),
});

const observed: TierVerdicts = { bootFailure: null, panel: null, planTabs: null, geometry: null };

/** Row 1: the right panel keeps Work, Files and Env state across a chat-tab switch. */
async function measurePanel(newPage: LiveApp['newPage'], origin: string): Promise<PanelVerdict> {
  const workspace = await createWorkspace(origin, 'live-row-panel', 'panel state probe');
  const page = await openWorkspace(newPage, origin, workspace);
  const counter = await countRpc(page);

  await page.evaluate(ClickScripts.filesTab);
  await page.waitForFunction(
    `[...document.querySelectorAll('.p-tabstrip')].flatMap(el => [...el.querySelectorAll('button')]).some(b => b.textContent.trim() === 'Files' && b.className.includes('p-tab-active'))`,
    { polling: 100 },
  );

  const marked = v.parse(
    v.object({ ok: v.literal(true), scrollTop: v.number() }),
    await page.evaluate(() => {
      const strips = [...document.querySelectorAll('.p-tabstrip')];
      const workStrip = strips.find((el) => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Work'));
      const content = workStrip?.parentElement?.parentElement?.children[1];

      if (!content) return { ok: false as const, scrollTop: -1 };

      content.setAttribute('data-live-probe', 'work-surface');
      content.scrollTop = 53;

      return { ok: true as const, scrollTop: content.scrollTop };
    }),
  );

  counter.counts();
  await page.evaluate(ClickScripts.newAgent);
  await page.waitForFunction(
    `[...document.querySelectorAll('nav[aria-label="Workspace agents"] a')].length > 1`,
    { polling: 100 },
  );
  await page.evaluate(ClickScripts.lastAgentTab);
  await page.waitForFunction(`location.pathname.includes('/agents/')`, { polling: 100 });

  const workspaceReadsOnSwitch = workspaceReadCount(counter.counts().sent);

  await page.evaluate(ClickScripts.mainTab);
  await page.waitForFunction(`!location.pathname.includes('/agents/')`, { polling: 100 });

  const workspaceReadsOnBack = workspaceReadCount(counter.counts().sent) - workspaceReadsOnSwitch;

  const survives = v.parse(
    v.object({ same: v.boolean(), scrollTop: v.number() }),
    await page.evaluate(() => {
      const node = document.querySelector('[data-live-probe="work-surface"]');

      return { same: node !== null, scrollTop: node?.scrollTop ?? -1 };
    }),
  );

  await counter.stop();
  await page.close();

  return {
    nodeSurvives: survives.same,
    scrollSurvives: survives.scrollTop === marked.scrollTop,
    scrollValue: survives.scrollTop,
    workspaceReadsOnSwitch,
    workspaceReadsOnBack,
  };
}

/** Row 2: plan appears once in the right panel. */
async function measurePlanTabs(newPage: LiveApp['newPage'], origin: string): Promise<PlanTabsVerdict> {
  const workspace = await createWorkspace(origin, 'live-row-plan', 'plan probe');
  const page = await openWorkspace(newPage, origin, workspace);

  const labels = v.parse(
    v.array(v.string()),
    await page.evaluate(() => {
      const strip = [...document.querySelectorAll('.p-tabstrip')].find((el) =>
        [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Work'));

      return [...(strip?.querySelectorAll('button') ?? [])].map((b) => (b.textContent ?? '').trim());
    }),
  );

  await page.close();

  return { labels, planBearing: labels.filter((label) => label.includes('Plan')).length };
}

const readStripGeometry = `(() => {
  const strip = [...document.querySelectorAll('.p-tabstrip')].find((el) =>
    [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Work'));
  if (strip === undefined) throw new Error('no Work strip');
  const rule = strip.parentElement;
  if (rule === null) throw new Error('no strip rule container');
  const active = [...strip.querySelectorAll('button')].find((b) => b.className.includes('p-tab-active'));
  if (active === undefined) throw new Error('no active tab');
  return {
    ruleBottom: Math.round(rule.getBoundingClientRect().bottom),
    stripBottom: Math.round(strip.getBoundingClientRect().bottom),
    activeBottom: active.getBoundingClientRect().bottom,
    mode: document.documentElement.getAttribute('data-mode') ?? '?',
  };
})()`;

/** Row 3: the tab strip's rule is continuous and the active underline sits on it, dark and light. */
async function measureGeometry(newPage: LiveApp['newPage'], origin: string): Promise<GeometryVerdict> {
  const workspace = await createWorkspace(origin, 'live-row-geometry', 'geometry probe');
  const page = await openWorkspace(newPage, origin, workspace);
  const dark = v.parse(StripGeometrySchema, await page.evaluate(readStripGeometry));

  await page.evaluate(() => localStorage.setItem('theme', 'light'));
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(`document.querySelector('textarea') !== null`, { polling: 100 });

  const light = v.parse(StripGeometrySchema, await page.evaluate(readStripGeometry));

  await page.close();

  return { dark, light };
}

/** The staging origin, when the comprehensive run is asked for by name. */
const stagingOrigin = process.env.KINU_E2E_ORIGIN;

async function run(): Promise<void> {
  const rows = async (newPage: LiveApp['newPage'], origin: string): Promise<void> => {
    observed.panel = await measurePanel(newPage, origin);
    observed.planTabs = await measurePlanTabs(newPage, origin);
    observed.geometry = await measureGeometry(newPage, origin);
  };

  if (stagingOrigin === undefined) {
    // Pre-publish: boot the product locally, configure the fake model, run.
    const fake = await startFakeModel();

    await withLiveApp(async ({ newPage, origin }) => {
      await apiJson(origin, '/api/user/credentials/openai-compat.default', {
        method: 'POST',
        body: JSON.stringify({ kind: 'openai-compat', baseURL: `http://127.0.0.1:${String(fake.port)}`, apiKey: 'fake-key' }),
      });
      await rows(newPage, origin);
    }, { port: 5191 });

    await stopFakeModel(fake);

    return;
  }

  // Comprehensive: same three rows against the named deployment. The dev
  // identity there is the deployment's; the rows are the same code.
  await withLiveApp(async ({ newPage, browser }) => {
    const page = await newPage();

    await page.goto(stagingOrigin, { waitUntil: 'networkidle0' });
    await rows(newPage, stagingOrigin);
    await page.close();
    await browser.close();
  }, { port: 5191 });
}

beforeAll(async () => {
  try {
    await run();
  } catch (cause) {
    observed.bootFailure = renderThrownChain({ cause });
  }
});

afterAll(() => {
  if (observed.bootFailure !== null) throw new Error(observed.bootFailure);
});

describe('the right panel keeps its Work, Files and Env state when the chat tab changes', () => {
  test('the Work surface DOM node identity and scroll position survive', () => {
    expect(observed.panel?.nodeSurvives).toBe(true);
    expect(observed.panel?.scrollSurvives).toBe(true);
  });

  test('no refetch of the workspace-scoped reads occurs on either switch', () => {
    expect(observed.panel?.workspaceReadsOnSwitch).toBe(0);
    expect(observed.panel?.workspaceReadsOnBack).toBe(0);
  });
});

describe('plan appears once in the right panel', () => {
  test('the set of tab labels contains exactly one plan-bearing tab', () => {
    expect(observed.planTabs?.planBearing).toBe(1);
  });
});

describe("the tab strip's rule is continuous and the active underline sits on it", () => {
  test('dark: one rule, underline on it', () => {
    expect(observed.geometry?.dark.mode).toBe('dark');
    expect(observed.geometry?.dark.ruleBottom).toBe(observed.geometry?.dark.stripBottom);
    expect(Math.abs((observed.geometry?.dark.activeBottom ?? 0) - (observed.geometry?.dark.ruleBottom ?? 0))).toBeLessThanOrEqual(1);
  });

  test('light: one rule, underline on it', () => {
    expect(observed.geometry?.light.mode).toBe('light');
    expect(observed.geometry?.light.ruleBottom).toBe(observed.geometry?.light.stripBottom);
    expect(Math.abs((observed.geometry?.light.activeBottom ?? 0) - (observed.geometry?.light.ruleBottom ?? 0))).toBeLessThanOrEqual(1);
  });
});
