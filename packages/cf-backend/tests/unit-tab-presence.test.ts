/**
 * The gated right-pane tabs — Releases and Swarms earn their place only
 * when they have content (`surfaceHasContent`, the predicate the tab strip
 * filters through), and a reader left on one whose content just emptied must
 * not be stranded on a tab that no longer renders (`resolveGatedSurface`
 * falls back to the default surface).
 *
 * These are the two seams the component consumes; the rendered strip itself
 * is proved in the browser against the gallery's fresh-workspace and
 * with-content frames.
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
import { appendMemoryNote, PlanReviewStore, TaskListStore } from '@kinu.run/core';
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
    expect(surfaceHasContent('Releases', FRESH, EMPTY_TREES, [])).toBe(false);
    expect(surfaceHasContent('Swarms', FRESH, EMPTY_TREES, [])).toBe(false);
  });

  test('an empty work lane hides the Work tab entirely', () => {
    expect(surfaceHasContent('Work', FRESH, EMPTY_TREES, [])).toBe(false);

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
    expect(surfaceHasContent('Releases', { ...FRESH, releases: true }, EMPTY_TREES, [])).toBe(true);
  });

  test('an exploration run makes Swarms appear', () => {
    expect(surfaceHasContent('Swarms', { ...FRESH, explorations: true }, EMPTY_TREES, [])).toBe(true);
  });


  test('a search in flight appears through the live trees without waiting for the next refresh', () => {
    expect(surfaceHasContent('Swarms', FRESH, oneTree(), [])).toBe(true);
  });

  test('an absent presence keeps every tab visible — fixture frames claim nothing about ledgers', () => {
    expect(surfaceHasContent('Work', undefined, EMPTY_TREES, [])).toBe(true);
    expect(surfaceHasContent('Releases', undefined, EMPTY_TREES, [])).toBe(true);
    expect(surfaceHasContent('Swarms', undefined, EMPTY_TREES, [])).toBe(true);
  });
});

describe('Slate tab presence', () => {
  const slates = [{ id: 'overview', title: 'Overview', bindings: [] }];

  test('a listed Slate stays open and an unlisted one falls back', () => {
    expect(surfaceHasContent('slate:overview', FRESH, EMPTY_TREES, slates)).toBe(true);
    expect(resolveGatedSurface('slate:overview', FRESH, EMPTY_TREES, slates)).toBe('slate:overview');
    expect(resolveGatedSurface('slate:removed', FRESH, EMPTY_TREES, slates)).toBe('Files');
  });
});

describe('an active tab whose content vanishes falls back', () => {
  test('the fallback lands on the first surface that still has content', () => {
    // Work empty → Files; Work live → Work.
    expect(resolveGatedSurface('Releases', FRESH, EMPTY_TREES, [])).toBe('Files');
    expect(resolveGatedSurface('Releases', { ...FRESH, work: true }, EMPTY_TREES, [])).toBe('Work');
    expect(resolveGatedSurface('Swarms', FRESH, EMPTY_TREES, [])).toBe('Files');
  });

  test('a live tree keeps an active Swarms tab exactly where it is', () => {
    expect(resolveGatedSurface('Swarms', FRESH, oneTree(), [])).toBe('Swarms');
  });

  test('ungated surfaces are never moved', () => {
    // Diffs is not ungated — it renders only while a mounted diff tree
    // exists (`hasDiffs`), the one gate the lane counts cannot carry.
    for (const surface of ['Files', 'Agent', 'Environment'] as const) {
      expect(resolveGatedSurface(surface, FRESH, EMPTY_TREES, [])).toBe(surface);
    }
  });

  test('an empty Work tab resolves away and a live one stays', () => {
    expect(resolveGatedSurface('Work', FRESH, EMPTY_TREES, [])).toBe('Files');
    expect(resolveGatedSurface('Work', { ...FRESH, work: true }, EMPTY_TREES, [])).toBe('Work');
  });

  test('content present means no move, even on a gated tab', () => {
    expect(resolveGatedSurface('Releases', FULL, EMPTY_TREES, [])).toBe('Releases');
    expect(resolveGatedSurface('Swarms', FULL, EMPTY_TREES, [])).toBe('Swarms');
  });
});

describe('the presence read over real ledgers', () => {
  // `getWorkspaceTabPresence` is the server half of the strip's gate: the
  // component's `work` flag is its answer, so each case below writes the row a
  // real surface would leave and reads the RPC itself — not the predicate's
  // fixtures, which cannot see a wiring miss between the ledgers and the call.

  test('a fresh workspace has no work to show', async () => {
    const { agent } = orchestratorHarness();
    await agent.activateActor();

    expect((await agent.getWorkspaceTabPresence()).work).toBe(false);
  });

  test('a completed task still counts — settled history is content', async () => {
    const { agent } = orchestratorHarness();
    await agent.activateActor();

    const tasks = new TaskListStore(agent.harnessSql(), agent.harnessActor(), (write) => write());
    const [task] = tasks.add(['done already'], null, 1).added;

    if (!task) throw new Error('The fixture task was not created');
    tasks.update(task.id, { status: 'done' }, 2);

    expect((await agent.getWorkspaceTabPresence()).work).toBe(true);
  });

  test('a plan with zero tasks counts — the plan IS the content', async () => {
    const { agent } = orchestratorHarness();
    await agent.activateActor();

    const plans = new PlanReviewStore(agent.harnessSql(), agent.harnessActor());
    const submitted = plans.submit('default', [{ start: 1, content: '# Empty plan' }]);

    if (!submitted.ok) throw new Error(submitted.error);

    expect((await agent.getWorkspaceTabPresence()).work).toBe(true);
  });

  test('a settled job counts — its record is in the journal the tab draws', async () => {
    const { agent } = orchestratorHarness();
    await agent.activateActor();

    agent.harnessJobs().create({
      id: 'bgjob-settled', kind: 'search', workMode: 'build',
      input: JSON.stringify({ task: 'ran' }), now: Date.now(), label: 'ran',
    });
    agent.harnessJobs().settle('bgjob-settled', 0, 'done', Date.now());

    expect((await agent.getWorkspaceTabPresence()).work).toBe(true);
  });

  test('a changelog entry counts even once seen', async () => {
    const { agent } = orchestratorHarness();
    await agent.activateActor();

    void agent.harnessSql()`INSERT OR REPLACE INTO scaffold_versions
      (actor_id, version, written_at, rationale, status)
      VALUES (${agent.harnessActor().actorId}, 1, ${Date.now()}, 'a landed change', 'current')`;
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
