/**
 * The panes the workspace snapshot seeds may not report absence for a read that
 * never came back.
 *
 * The failure this locks down shipped: an owner opened a workspace, the snapshot
 * RPC rejected with `Network connection lost.`, and the Agent surface drew "No
 * memories yet" and "No tools discovered yet" under a banner that said the load
 * had failed. Both claims were about data nobody had read. The World model
 * section in the same file already got this right, off `useAsyncResource`'s
 * tri-state — the snapshot-seeded panes branched on array length instead.
 *
 * `renderToStaticMarkup` runs the components for real and returns what a reader
 * would see. No effects run, and none are needed: the ladder under test is
 * derived from props.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentSurface } from '../src/components/surfaces/AgentSurface';
import type { AgentStatus } from '../src/hooks/use-kinu';
import type { AsyncResource } from '../src/hooks/use-async-resource';
import type { Rpc, ToolInfo } from '../src/lib/protocol';

/** `Section` persists which sections a reader folded. Server rendering has no
 *  storage, so the suite gives it one rather than the component a branch. */
beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => { store.clear(); },
      key: () => null,
      length: 0,
    },
  });
});

const STATUS: AgentStatus = {
  name: 'checkout-fixes',
  displayName: 'Checkout fixes',
  purpose: 'Keep checkout working',
  soul: '',
  createdAt: 0,
  scaffoldVersion: 3,
  searchNodeCount: 0,
  craftedToolCount: 0,
  messageCount: 4,
  model: 'anthropic/claude-opus-4',
  forkLineage: null,
};

const TOOL: ToolInfo = {
  name: 'run',
  description: 'Run a command.',
  summary: 'Run a command.',
  learned: false,
  usageCount: 2,
  qualityScore: 0,
  exposure: 'native',
  wired: true,
};

const MEMORY_MD = '## Checkout\n\n- The coupon path goes through `/api/cart/apply`.\n';

/** The reason the transport gives, verbatim, when a cross-object call drops. */
const CONNECTION_LOST = 'Network connection lost.';

/** No pane may need an answer to draw the state under test. */
const neverAnswers: Rpc = () => Promise.withResolvers<never>().promise;

/** What a reader sees: the markup with its entity escapes resolved, so every
 *  assertion below can quote the product's own words. */
function readable(markup: string): string {
  return markup
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
}

function render(
  snapshot: AsyncResource<AgentStatus>,
  overrides: { tools?: ToolInfo[]; memoryContent?: string } = {},
): string {
  const { tools = [], memoryContent = '' } = overrides;
  return readable(renderToStaticMarkup(createElement(AgentSurface, {
    snapshot,
    tools,
    memory: [],
    memoryContent,
    onSearchMemory: () => {},
    onRetryLoad: () => {},
    rpc: neverAnswers,
  })));
}

describe('panes fed by the workspace snapshot', () => {
  test('a snapshot that failed with nothing loaded offers a retry, never an empty memory', () => {
    const markup = render({ status: 'error', message: CONNECTION_LOST, last: null });

    expect(markup).not.toContain('No memories yet');
    expect(markup).toContain('Could not load memory');
    expect(markup).toContain('Retry');
  });

  test('the same failure never claims the agent has no tools', () => {
    const markup = render({ status: 'error', message: CONNECTION_LOST, last: null });

    expect(markup).not.toContain('No tools discovered yet');
    expect(markup).toContain('Could not load tools');
  });

  test('no pane repeats the reason the banner already gives once', () => {
    const markup = render({ status: 'error', message: CONNECTION_LOST, last: null });

    expect(markup).not.toContain(CONNECTION_LOST);
  });

  test('a snapshot still in flight claims nothing about what the workspace holds', () => {
    const markup = render({ status: 'loading' });

    expect(markup).not.toContain('No memories yet');
    expect(markup).not.toContain('No tools discovered yet');
    expect(markup).not.toContain('Could not load');
  });

  test('a workspace that loaded and holds nothing does say so', () => {
    const markup = render({ status: 'ready', value: STATUS });

    expect(markup).toContain('No memories yet');
    expect(markup).toContain('No tools discovered yet');
    expect(markup).not.toContain('Could not load memory');
  });

  test('a dropped connection keeps the last snapshot on screen rather than emptying it', () => {
    const markup = render(
      { status: 'error', message: CONNECTION_LOST, last: STATUS },
      { tools: [TOOL], memoryContent: MEMORY_MD },
    );

    expect(markup).toContain('/api/cart/apply');
    expect(markup).toContain(TOOL.name);
    expect(markup).not.toContain('No memories yet');
    expect(markup).not.toContain('Could not load memory');
    expect(markup).toContain(STATUS.displayName);
  });

  test('a workspace whose memory emptied while its snapshot was stale reports empty, not broken', () => {
    const markup = render({ status: 'error', message: CONNECTION_LOST, last: STATUS });

    expect(markup).toContain('No memories yet');
    expect(markup).not.toContain('Could not load memory');
  });
});
