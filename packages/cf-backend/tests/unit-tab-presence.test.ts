/**
 * The gated right-pane tabs — Releases and Exploration earn their place only
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
import type { ForkNode, Rpc, TabPresence } from '../src/lib/protocol';
import { WorkSurface } from '../src/components/surfaces/WorkSurface';
import {
  resolveGatedSurface,
  surfaceHasContent,
} from '../src/components/surfaces/presence';

const EMPTY_TREES: ReadonlyMap<string, ForkNode> = new Map();
const oneTree = (): ReadonlyMap<string, ForkNode> => new Map([
  ['n000', {
    id: 'n000', parentId: null, depth: 0, value: null, visits: null,
    status: 'open', action: '', children: [],
  }],
]);
const FRESH: TabPresence = { releases: false, explorations: false };
const FULL: TabPresence = { releases: true, explorations: true };

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
  test('a fresh workspace shows neither Releases nor Explore', () => {
    expect(surfaceHasContent('Releases', FRESH, EMPTY_TREES, [])).toBe(false);
    expect(surfaceHasContent('Exploration', FRESH, EMPTY_TREES, [])).toBe(false);
  });

  test('every ungated surface stays visible on a fresh workspace', () => {
    const html = renderStrip(FRESH);
    for (const surface of ['Output', 'Work', 'Files', 'Agent', 'Environment']) {
      expect(html).toContain(`aria-label="${surface}"`);
    }
    expect(html).not.toContain('aria-label="Releases"');
    expect(html).not.toContain('aria-label="Exploration"');
  });

  test('a workspace with content shows the gated tabs in the strip', () => {
    const html = renderStrip(FULL);
    expect(html).toContain('aria-label="Releases"');
    expect(html).toContain('aria-label="Exploration"');
  });


  test('a release change makes Releases appear', () => {
    expect(surfaceHasContent('Releases', { ...FRESH, releases: true }, EMPTY_TREES, [])).toBe(true);
  });

  test('an exploration run makes Explore appear', () => {
    expect(surfaceHasContent('Exploration', { ...FRESH, explorations: true }, EMPTY_TREES, [])).toBe(true);
  });


  test('a search in flight appears through the live trees without waiting for the next refresh', () => {
    expect(surfaceHasContent('Exploration', FRESH, oneTree(), [])).toBe(true);
  });

  test('an absent presence keeps every tab visible — fixture frames claim nothing about ledgers', () => {
    expect(surfaceHasContent('Releases', undefined, EMPTY_TREES, [])).toBe(true);
    expect(surfaceHasContent('Exploration', undefined, EMPTY_TREES, [])).toBe(true);
  });
});

describe('an active tab whose content vanishes falls back', () => {
  test('being on Releases when the lane empties lands on Work', () => {
    expect(resolveGatedSurface('Releases', FRESH, EMPTY_TREES, [])).toBe('Work');
  });

  test('being on Explore when the last run goes away lands on Work', () => {
    expect(resolveGatedSurface('Exploration', FRESH, EMPTY_TREES, [])).toBe('Work');
  });

  test('a live tree keeps an active Explore tab exactly where it is', () => {
    expect(resolveGatedSurface('Exploration', FRESH, oneTree(), [])).toBe('Exploration');
  });

  test('ungated surfaces are never moved', () => {
    for (const surface of ['Output', 'Work', 'Files', 'Agent', 'Environment'] as const) {
      expect(resolveGatedSurface(surface, FRESH, EMPTY_TREES, [])).toBe(surface);
    }
  });

  test('content present means no move, even on a gated tab', () => {
    expect(resolveGatedSurface('Releases', FULL, EMPTY_TREES, [])).toBe('Releases');
    expect(resolveGatedSurface('Exploration', FULL, EMPTY_TREES, [])).toBe('Exploration');
  });
});
