/**
 * Gated right-pane tabs appear only with content (`surfaceHasContent`), and a reader on one that just
 * emptied falls back to the default surface (`resolveGatedSurface`). The rendered strip is proved in the browser.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ForkNode, Rpc, TabPresence } from '@kinu.run/core';
import { WorkSurface } from '../src/components/surfaces/WorkSurface';
import {
  resolveGatedSurface,
  surfaceHasContent,
} from '../src/components/surfaces/presence';
import { appendMemoryNote, BackgroundJobStore, openWorkspaceMainActor, PlanReviewStore, TaskListStore } from '@kinu.run/core';
import { sqlOver } from '@kinu.run/test-utils';
import { orchestratorHarness } from './helpers/actor-harness';


const EMPTY_TREES: ReadonlyMap<string, ForkNode> = new Map();

const oneTree = (): ReadonlyMap<string, ForkNode> => new Map([
  ['n000', {
    id: 'n000', parentId: null, depth: 0, value: null, visits: null,
    status: 'open', action: '', children: [],
  }],
]);

const FRESH: TabPresence = { releases: false, explorations: false, work: false };

const FULL: TabPresence = { releases: true, explorations: true, work: true };

const SILENT_RPC: Rpc = () => Promise.withResolvers<never>().promise;

const renderStrip = (tabPresence: TabPresence | undefined): string =>
  renderToStaticMarkup(createElement(WorkSurface, {
    surface: 'Work',
    onSurface: () => {},
    pinnedPorts: [],
    previewError: null,
    onRefreshPorts: () => {},
    plan: null,
    snapshot: { status: 'loading' },
    tools: [],
    memory: [],
    memoryContent: '',
    onSearchMemory: () => {},
    onRetryLoad: () => {},
    mctsTrees: EMPTY_TREES,
    headActivity: new Map(),
    isStreaming: false,
    executors: [],
    executorOutputs: new Map(),
    onExecute: () => Promise.withResolvers<never>().promise,
    backgroundJobs: [],
    onRefreshJobs: () => {},
    pendingActions: [],
    tabPresence,
    rpc: SILENT_RPC,
  }));


describe('the gated tabs appear only with content', () => {
  test('a fresh workspace shows neither Releases nor Swarms', () => {
    expect(surfaceHasContent('Releases', { tabPresence: FRESH, mctsTrees: EMPTY_TREES, slates: [] })).toBe(false);
    expect(surfaceHasContent('Swarms', { tabPresence: FRESH, mctsTrees: EMPTY_TREES, slates: [] })).toBe(false);
  });

  test('an empty work lane hides the Work tab entirely', () => {
    expect(surfaceHasContent('Work', { tabPresence: FRESH, mctsTrees: EMPTY_TREES, slates: [] })).toBe(false);

    const html = renderStrip(FRESH);

    expect(html).not.toContain('aria-label="Work"');
    expect(html).toContain('aria-label="Files"');
  });

  test('every ungated surface stays visible on a fresh workspace', () => {
    const html = renderStrip(FRESH);

    for (const surface of ['Files', 'Agent', 'Environment']) {
      expect(html).toContain(`aria-label="${surface}"`);
    }

    expect(html).not.toContain('aria-label="Releases"');
    expect(html).not.toContain('aria-label="Swarms"');
  });

  test('a workspace with content shows the gated tabs in the strip', () => {
    const html = renderStrip(FULL);
    expect(html).toContain('aria-label="Work"');
    expect(html).toContain('aria-label="Releases"');
    expect(html).toContain('aria-label="Swarms"');
  });


  test('a release change makes Releases appear', () => {
    expect(surfaceHasContent('Releases', { tabPresence: { ...FRESH, releases: true }, mctsTrees: EMPTY_TREES, slates: [] })).toBe(true);
  });

  test('an exploration run makes Swarms appear', () => {
    expect(surfaceHasContent('Swarms', { tabPresence: { ...FRESH, explorations: true }, mctsTrees: EMPTY_TREES, slates: [] })).toBe(true);
  });


  test('a search in flight appears through the live trees without waiting for the next refresh', () => {
    expect(surfaceHasContent('Swarms', { tabPresence: FRESH, mctsTrees: oneTree(), slates: [] })).toBe(true);
  });

  test('an absent presence keeps every tab visible — fixture frames claim nothing about ledgers', () => {
    expect(surfaceHasContent('Work', { tabPresence: undefined, mctsTrees: EMPTY_TREES, slates: [] })).toBe(true);
    expect(surfaceHasContent('Releases', { tabPresence: undefined, mctsTrees: EMPTY_TREES, slates: [] })).toBe(true);
    expect(surfaceHasContent('Swarms', { tabPresence: undefined, mctsTrees: EMPTY_TREES, slates: [] })).toBe(true);
  });
});

describe('Slate tab presence', () => {
  const slates = [{ id: 'overview', title: 'Overview', bindings: [] }];

  test('a listed Slate stays open and an unlisted one falls back', () => {
    expect(surfaceHasContent('slate:overview', { tabPresence: FRESH, mctsTrees: EMPTY_TREES, slates })).toBe(true);
    expect(resolveGatedSurface('slate:overview', { tabPresence: FRESH, mctsTrees: EMPTY_TREES, slates })).toBe('slate:overview');
    expect(resolveGatedSurface('slate:removed', { tabPresence: FRESH, mctsTrees: EMPTY_TREES, slates })).toBe('Files');
  });
});

describe('an active tab whose content vanishes falls back', () => {
  test('the fallback lands on the first surface that still has content', () => {
    expect(resolveGatedSurface('Releases', { tabPresence: FRESH, mctsTrees: EMPTY_TREES, slates: [] })).toBe('Files');
    expect(resolveGatedSurface('Releases', { tabPresence: { ...FRESH, work: true }, mctsTrees: EMPTY_TREES, slates: [] })).toBe('Work');
    expect(resolveGatedSurface('Swarms', { tabPresence: FRESH, mctsTrees: EMPTY_TREES, slates: [] })).toBe('Files');
  });

  test('a live tree keeps an active Swarms tab exactly where it is', () => {
    expect(resolveGatedSurface('Swarms', { tabPresence: FRESH, mctsTrees: oneTree(), slates: [] })).toBe('Swarms');
  });

  test('ungated surfaces are never moved', () => {
    // Diffs renders only while a mounted diff tree exists (`hasDiffs`), a gate lane counts cannot carry.
    for (const surface of ['Files', 'Agent', 'Environment'] as const) {
      expect(resolveGatedSurface(surface, { tabPresence: FRESH, mctsTrees: EMPTY_TREES, slates: [] })).toBe(surface);
    }
  });

  test('an empty Work tab resolves away and a live one stays', () => {
    expect(resolveGatedSurface('Work', { tabPresence: FRESH, mctsTrees: EMPTY_TREES, slates: [] })).toBe('Files');
    expect(resolveGatedSurface('Work', { tabPresence: { ...FRESH, work: true }, mctsTrees: EMPTY_TREES, slates: [] })).toBe('Work');
  });

  test('content present means no move, even on a gated tab', () => {
    expect(resolveGatedSurface('Releases', { tabPresence: FULL, mctsTrees: EMPTY_TREES, slates: [] })).toBe('Releases');
    expect(resolveGatedSurface('Swarms', { tabPresence: FULL, mctsTrees: EMPTY_TREES, slates: [] })).toBe('Swarms');
  });
});

describe('the presence read over real ledgers', () => {
  // Reads the RPC itself, not predicate fixtures, which cannot see a wiring miss between the ledgers and the call.

  test('a fresh workspace has no work to show', async () => {
    const { agent } = orchestratorHarness();
    await agent.activateActor();

    expect((await agent.getWorkspaceTabPresence()).work).toBe(false);
  });

  test('a completed task still counts — settled history is content', async () => {
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();
    const sql = sqlOver(db);
    const tasks = new TaskListStore(sql, openWorkspaceMainActor(sql), (write) => write());
    const [task] = tasks.add(['done already'], null, 1).added;

    if (!task) throw new Error('The fixture task was not created');
    tasks.update(task.id, { status: 'done' }, 2);

    expect((await agent.getWorkspaceTabPresence()).work).toBe(true);
  });

  test('a plan with zero tasks counts — the plan IS the content', async () => {
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();
    const sql = sqlOver(db);
    const plans = new PlanReviewStore(sql, openWorkspaceMainActor(sql));
    const submitted = plans.submit('default', [{ start: 1, content: '# Empty plan' }]);

    if (!submitted.ok) throw new Error(submitted.error);

    expect((await agent.getWorkspaceTabPresence()).work).toBe(true);
  });

  test('a settled job counts — its record is in the journal the tab draws', async () => {
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();
    const sql = sqlOver(db);
    const jobs = new BackgroundJobStore(sql, openWorkspaceMainActor(sql));
    jobs.create({
      id: 'bgjob-settled', kind: 'search', workMode: 'build',
      input: JSON.stringify({ task: 'ran' }), now: Date.now(), label: 'ran',
    });
    jobs.settle('bgjob-settled', 0, 'done', Date.now());

    expect((await agent.getWorkspaceTabPresence()).work).toBe(true);
  });

  test('a changelog entry counts even once seen', async () => {
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();
    const sql = sqlOver(db);
    const actor = openWorkspaceMainActor(sql);
    void sql`INSERT OR REPLACE INTO scaffold_versions
      (actor_id, version, written_at, rationale, status)
      VALUES (${actor.actorId}, 1, ${Date.now()}, 'a landed change', 'current')`;
    await agent.markChangelogSeen();

    expect((await agent.getWorkspaceTabPresence()).work).toBe(true);
  });

  test('a saved learning counts', async () => {
    const { agent } = orchestratorHarness();
    await agent.activateActor();

    await appendMemoryNote(agent.observeRuntime().memory, 'the checkout coupons need a kind');

    expect((await agent.getWorkspaceTabPresence()).work).toBe(true);
  });
});
