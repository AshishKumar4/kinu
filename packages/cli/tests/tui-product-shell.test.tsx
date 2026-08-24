/** @jsxImportSource @opentui/react */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScrollBoxRenderable, TextareaRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { useRef, useState } from 'react';
import { describe, expect, test } from 'bun:test';

import { canonicalProjectRoot } from '../src/config';
import { DEFAULT_TUI_PREFERENCES, createMemoryTuiPreferenceStore, type TuiPreferenceStore } from '../src/tui/preferences';
import {
  TuiProductProvider,
  TuiShell,
  buildSidebarRows,
  usePreservedScrollAnchor,
  type ScrollAnchorController,
  type TuiAgentPage,
  type TuiAgentRoster,
  type TuiAgentSummary,
} from '../src/tui/tui-shell';

const ROOT = canonicalProjectRoot();
const FRAME_DIR = process.env.TUI_FRAME_DIR ?? '/tmp/grouped-tui-frames';

/** Two virtual workspaces in this directory, one legacy agent, and a cloud
 *  roster that reuses the name `audit` — the duplicate the grouping must keep
 *  apart. */
const GROUPED_ITEMS: readonly TuiAgentSummary[] = [
  {
    name: 'audit', label: 'audit', mode: 'local', cwd: ROOT, workspaceId: 'shop', status: 'running',
    subordinates: [{ id: 'sub-reviewer', label: 'reviewer', status: 'idle', roleId: 'auditor' }],
  },
  { name: 'fixer', label: 'fixer', mode: 'local', cwd: ROOT, workspaceId: 'shop' },
  { name: 'writer', label: 'writer', mode: 'local', cwd: ROOT, workspaceId: 'docs' },
  { name: 'oldbot', label: 'oldbot', mode: 'local' },
  { name: 'jarvis', label: 'Jarvis', mode: 'cloud', cloudName: 'jarvis' },
  { name: 'audit', label: 'audit', mode: 'cloud', cloudName: 'audit' },
];

const pageOf = (items: readonly TuiAgentSummary[], nextCursor: string | null = null): TuiAgentPage => ({
  items,
  total: items.length,
  nextCursor,
});

function saveFrame(name: string, frame: string): void {
  mkdirSync(FRAME_DIR, { recursive: true });
  writeFileSync(join(FRAME_DIR, `${name}.txt`), `${frame}\n`);
}

describe('grouped sidebar projection', () => {
  test('current-cwd workspaces come first, the cloud section starts collapsed, and paging stays a row', () => {
    const rows = buildSidebarRows(
      pageOf([...GROUPED_ITEMS, { name: 'faraway', label: 'faraway', mode: 'local', cwd: '/elsewhere/repo', workspaceId: 'other' }], 'page-2'),
      ROOT,
      { collapsedWorkspaces: [], remoteExpanded: false },
    );
    expect(rows.map((row) => row.kind === 'agent' ? `agent:${row.agent.mode}:${row.agent.name}` : row.key)).toEqual([
      `ws:${ROOT}\u0000shop`,
      'agent:local:audit',
      'agent:local:fixer',
      `ws:${ROOT}\u0000docs`,
      'agent:local:writer',
      'ws:/elsewhere/repo\u0000other',
      'agent:local:faraway',
      'ws:unplaced',
      'agent:local:oldbot',
      'remote',
      'load-more',
    ]);
    const shop = rows[0]!;
    if (shop.kind !== 'workspace') throw new Error('expected a workspace header first');
    expect(shop.label).toBe('shop');
    expect(shop.agentCount).toBe(2);
    expect(shop.runningCount).toBe(1);
    const remote = rows.find((row) => row.kind === 'remote');
    expect(remote?.kind === 'remote' && remote.expanded).toBeFalse();
    expect(remote?.kind === 'remote' && remote.loaded).toBe(2);
  });

  test('expansion state is honored: a collapsed group hides only its peers, an expanded cloud section lists remote agents', () => {
    const rows = buildSidebarRows(pageOf(GROUPED_ITEMS), ROOT, {
      collapsedWorkspaces: [`ws:${ROOT}\u0000shop`],
      remoteExpanded: true,
    });
    const keys = rows.map((row) => row.key);
    expect(keys).not.toContain('agent:local:audit');
    expect(keys).not.toContain('agent:local:fixer');
    expect(keys).toContain('agent:local:writer');
    // The duplicate names survive as distinct rows because mode is part of the key.
    expect(keys).toContain('agent:cloud:audit');
    expect(keys).toContain('agent:cloud:jarvis');
    expect(keys).not.toContain('load-more');
  });

  test('a legacy agent placed by no ref groups under Unplaced, never under the current project', () => {
    const rows = buildSidebarRows(pageOf([{ name: 'oldbot', label: 'oldbot', mode: 'local' }]), ROOT, {
      collapsedWorkspaces: [],
      remoteExpanded: false,
    });
    expect(rows.map((row) => row.key)).toEqual(['ws:unplaced', 'agent:local:oldbot']);
    const header = rows[0]!;
    expect(header.kind === 'workspace' && header.label).toBe('Unplaced');
  });
});

let probeTextarea: TextareaRenderable | null = null;
let probeSetNavigationOpen: ((open: boolean) => void) | null = null;
let probeSetNavigationFocused: ((focused: boolean) => void) | null = null;

function GroupedShellProbe(props: {
  readonly store: TuiPreferenceStore;
  readonly page: TuiAgentPage;
  readonly activations: Array<{ name: string; mode: 'local' | 'cloud' }>;
  readonly loadMore?: () => Promise<void>;
  readonly currentAgent?: { name: string; mode: 'local' | 'cloud' };
}) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [navigationFocused, setNavigationFocused] = useState(false);
  probeSetNavigationOpen = setNavigationOpen;
  probeSetNavigationFocused = setNavigationFocused;
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const roster: TuiAgentRoster = {
    page: props.page,
    loading: false,
    error: null,
    reload: async () => {},
    loadMore: props.loadMore ?? (async () => {}),
  };
  return (
    <TuiProductProvider runtime={{ preferenceStore: props.store, terminalAppearance: 'dark', colorCapability: 'truecolor' }}>
      <TuiShell
        scene="chat"
        roster={roster}
        currentAgent={props.currentAgent}
        navigationOverlayOpen={navigationOpen}
        onNavigationOverlayChange={setNavigationOpen}
        navigationFocused={navigationFocused}
        onNavigationFocusChange={(focused) => {
          if (focused) textareaRef.current?.blur();
          else textareaRef.current?.focus();
        }}
        onAgentSelect={(agent) => {
          props.activations.push({ name: agent.name, mode: agent.mode });
          setNavigationOpen(false);
        }}
      >
        <box flexDirection="column" style={{ width: '100%', height: '100%' }}>
          <box style={{ flexGrow: 1 }} />
          <textarea
            ref={(value) => {
              textareaRef.current = value;
              probeTextarea = value;
            }}
            focused
          />
        </box>
      </TuiShell>
    </TuiProductProvider>
  );
}

async function mountProbe(options: {
  width: number;
  height?: number;
  page: TuiAgentPage;
  loadMore?: () => Promise<void>;
  currentAgent?: { name: string; mode: 'local' | 'cloud' };
}) {
  const testRenderer = await createTestRenderer({
    width: options.width,
    height: options.height ?? 28,
    useThread: false,
    maxFps: Number.POSITIVE_INFINITY,
  });
  const root = createRoot(testRenderer.renderer);
  const store = createMemoryTuiPreferenceStore(DEFAULT_TUI_PREFERENCES);
  const activations: Array<{ name: string; mode: 'local' | 'cloud' }> = [];
  root.render(
    <GroupedShellProbe
      store={store}
      page={options.page}
      activations={activations}
      loadMore={options.loadMore}
      currentAgent={options.currentAgent}
    />,
  );
  await renderSettled(testRenderer.renderOnce);
  return {
    ...testRenderer,
    root,
    activations,
    frame: () => testRenderer.captureCharFrame(),
    async settle() {
      await renderSettled(testRenderer.renderOnce);
    },
    async destroy() {
      root.render(<box />);
      await testRenderer.renderOnce();
      testRenderer.renderer.destroy();
      probeTextarea = null;
      probeSetNavigationOpen = null;
      probeSetNavigationFocused = null;
    },
  };
}

describe('grouped workspace navigator', () => {
  test('wide layouts pin the grouped sidebar with peers, nesting, and a collapsed cloud section (desktop frames at 160 and 120)', async () => {
    for (const [width, label] of [[160, 'desktop-160'], [120, 'desktop-120']] as const) {
      const probe = await mountProbe({ width, page: pageOf(GROUPED_ITEMS) });
      try {
        const frame = probe.frame();
        saveFrame(`chat-${label}`, frame);
        expect(frame).toContain('shop · 2');
        expect(frame).toContain('docs · 1');
        expect(frame).toContain('Unplaced · 1');
        expect(frame).toContain('Cloud · 2');
        expect(frame).toContain('└ reviewer · auditor');
        expect(frame).not.toContain('Jarvis');
        const lines = frame.split('\n');
        expect(lines.findIndex((line) => line.includes('shop · 2'))).toBeLessThan(lines.findIndex((line) => line.includes('Cloud · 2')));
      } finally {
        await probe.destroy();
      }
    }
  });

  test('keyboard walks the grouped overlay: Enter toggles headers and opens agents, duplicates stay apart, focus returns (80 columns)', async () => {
    const probe = await mountProbe({ width: 80, page: pageOf(GROUPED_ITEMS) });
    try {
      probeSetNavigationOpen?.(true);
      await probe.settle();
      expect(probe.frame()).toContain('Workspaces · Esc close');
      expect(probeTextarea?.focused).toBe(false);
      saveFrame('chat-overlay-80', probe.frame());

      // The selection starts on the first agent; Up reaches its workspace
      // header, and Enter on the header collapses the group.
      probe.mockInput.pressArrow('up');
      probe.mockInput.pressEnter();
      await probe.settle();
      expect(probe.frame()).toContain('▸ shop · 2');
      expect(probe.frame()).not.toContain('audit');
      expect(probe.frame()).not.toContain('fixer');
      expect(probe.activations).toEqual([]);

      // Enter again expands it; the peers return.
      probe.mockInput.pressEnter();
      await probe.settle();
      expect(probe.frame()).toContain('▾ shop · 2');
      expect(probe.frame()).toContain('audit');

      // Walk down to the cloud section and expand it.
      for (let step = 0; step < 7; step += 1) probe.mockInput.pressArrow('down');
      probe.mockInput.pressEnter();
      await probe.settle();
      expect(probe.frame()).toContain('▾ Cloud · 2');
      expect(probe.frame()).toContain('Jarvis');

      // Selecting an agent swaps the client and closes the overlay.
      probe.mockInput.pressArrow('down');
      probe.mockInput.pressEnter();
      await probe.settle();
      expect(probe.activations).toEqual([{ name: 'jarvis', mode: 'cloud' }]);
      expect(probe.frame()).not.toContain('Workspaces · Esc close');
      expect(probeTextarea?.focused).toBe(true);

      // The cloud `audit` and the local `audit` are different rows.
      probeSetNavigationOpen?.(true);
      await probe.settle();
      probe.mockInput.pressArrow('down');
      probe.mockInput.pressEnter();
      await probe.settle();
      expect(probe.activations.at(-1)).toEqual({ name: 'audit', mode: 'cloud' });

      probeSetNavigationOpen?.(true);
      await probe.settle();
      for (let step = 0; step < 8; step += 1) probe.mockInput.pressArrow('up');
      probe.mockInput.pressEnter();
      await probe.settle();
      expect(probe.activations.at(-1)).toEqual({ name: 'audit', mode: 'local' });

      // Left jumps from an agent to its section header, then collapses it;
      // Right expands it again. Escape closes and restores the composer.
      probeSetNavigationOpen?.(true);
      await probe.settle();
      probe.mockInput.pressKey('\u001B[D');
      await probe.settle();
      probe.mockInput.pressKey('\u001B[D');
      await probe.settle();
      expect(probe.frame()).toContain('▸ shop · 2');
      probe.mockInput.pressKey('\u001B[C');
      await probe.settle();
      expect(probe.frame()).toContain('▾ shop · 2');
      probe.mockInput.pressEscape();
      await probe.settle();
      expect(probe.frame()).not.toContain('Workspaces · Esc close');
      expect(probeTextarea?.focused).toBe(true);
    } finally {
      await probe.destroy();
    }
  });

  test('mouse toggles headers, opens agents, and pages the roster (wide)', async () => {
    let loaded = 0;
    const probe = await mountProbe({
      width: 160,
      page: pageOf(GROUPED_ITEMS, 'page-2'),
      loadMore: async () => { loaded += 1; },
    });
    try {
      const lineAt = (text: string, occurrence = 0) => {
        const hits = probe.frame().split('\n')
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => line.includes(text));
        const hit = hits[occurrence];
        if (hit === undefined) throw new Error(`No frame line ${occurrence} containing ${text}`);
        return hit.index;
      };

      await probe.mockMouse.click(4, lineAt('Cloud · 2'));
      await probe.settle();
      expect(probe.frame()).toContain('Jarvis');

      await probe.mockMouse.click(4, lineAt('Jarvis'));
      await probe.settle();
      expect(probe.activations.at(-1)).toEqual({ name: 'jarvis', mode: 'cloud' });

      // The status dots keep the duplicate rows apart: the running local
      // `audit` renders `● audit`, the idle cloud one `○ audit`.
      await probe.mockMouse.click(4, lineAt('○ audit'));
      await probe.settle();
      expect(probe.activations.at(-1)).toEqual({ name: 'audit', mode: 'cloud' });

      await probe.mockMouse.click(4, lineAt('● audit'));
      await probe.settle();
      expect(probe.activations.at(-1)).toEqual({ name: 'audit', mode: 'local' });

      await probe.mockMouse.click(4, lineAt('Load more'));
      await probe.settle();
      expect(loaded).toBe(1);

      await probe.mockMouse.click(4, lineAt('shop · 2'));
      await probe.settle();
      expect(probe.frame()).not.toContain('fixer');
      await probe.mockMouse.click(4, lineAt('shop · 2'));
      await probe.settle();
      expect(probe.frame()).toContain('fixer');
    } finally {
      await probe.destroy();
    }
  });

  test('page keys move by the navigator viewport and drive paging at the end (40-column mobile overlay)', async () => {
    const many: TuiAgentSummary[] = [
      ...Array.from({ length: 6 }, (_, i) => ({
        name: `shop-${i}`, label: `shop-${i}`, mode: 'local' as const, cwd: ROOT, workspaceId: 'shop',
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        name: `docs-${i}`, label: `docs-${i}`, mode: 'local' as const, cwd: ROOT, workspaceId: 'docs',
      })),
      { name: 'jarvis', label: 'Jarvis', mode: 'cloud' as const },
    ];
    let loaded = 0;
    const probe = await mountProbe({
      width: 40,
      height: 14,
      page: { items: many, total: 40, nextCursor: 'page-2' },
      loadMore: async () => { loaded += 1; },
    });
    try {
      probeSetNavigationOpen?.(true);
      await probe.settle();
      saveFrame('chat-overlay-mobile-40', probe.frame());
      expect(probe.frame()).toContain('13 of 40');

      probe.mockInput.pressKey('\u001B[6~');
      await probe.settle();
      // One page down from the `shop` header lands inside `docs`.
      expect(lineWithMarker(probe.frame())).toContain('docs');

      probe.mockInput.pressKey('\u001B[6~');
      await probe.settle();
      // The second page reaches the explicit paging row; the top scrolled away.
      expect(lineWithMarker(probe.frame())).toContain('Load more');
      expect(probe.frame()).not.toContain('shop-0');
      expect(loaded).toBe(0);

      probe.mockInput.pressKey('\u001B[6~');
      await probe.settle();
      expect(loaded).toBe(1);

      probe.mockInput.pressKey('\u001B[5~');
      await probe.settle();
      expect(lineWithMarker(probe.frame())).not.toContain('Load more');
    } finally {
      await probe.destroy();
    }
  });

  test('the open agent auto-expands its section and keyboard focus starts on it (pinned, duplicate-safe)', async () => {
    const probe = await mountProbe({
      width: 120,
      page: pageOf(GROUPED_ITEMS),
      currentAgent: { name: 'audit', mode: 'cloud' },
    });
    try {
      // The cloud section expanded on its own because the open agent lives there.
      expect(probe.frame()).toContain('Jarvis');
      probeSetNavigationFocused?.(true);
      await probe.settle();
      const frame = probe.frame();
      const lines = frame.split('\n');
      const marked = lines.findIndex((line) => line.includes('›'));
      expect(lines[marked]).toContain('audit');
      expect(marked).toBeGreaterThan(lines.findIndex((line) => line.includes('Cloud · 2')));

      // Pinned-focus keyboard: the selection walks and Enter opens the agent.
      probe.mockInput.pressArrow('up');
      probe.mockInput.pressEnter();
      await probe.settle();
      expect(probe.activations).toEqual([{ name: 'jarvis', mode: 'cloud' }]);
    } finally {
      await probe.destroy();
    }
  });
});

function lineWithMarker(frame: string): string {
  return frame.split('\n').find((line) => line.includes('›')) ?? '';
}

describe('adaptive TUI shell renderer', () => {
  test('wide, medium, and narrow transitions preserve draft, focus, and scroll while paging stays explicit', async () => {
    const { renderer, mockInput, renderOnce, captureCharFrame, resize } = await createTestRenderer({
      width: 120,
      height: 28,
      useThread: false,
      maxFps: Number.POSITIVE_INFINITY,
    });
    const root = createRoot(renderer);
    const store = createMemoryTuiPreferenceStore(DEFAULT_TUI_PREFERENCES);
    try {
      root.render(<ShellProbe store={store} />);
      await renderSettled(renderOnce);
      expect(captureCharFrame()).toContain('checkout');
      expect(captureCharFrame()).toContain('2 of 4');
      expect(captureCharFrame()).toContain('Load more');

      await mockInput.typeText('draft survives');
      shellScroll?.scrollTo(3);
      shellScrollAnchor?.remember();
      const textarea = shellTextarea;
      const scroll = shellScroll;
      expect(textarea?.focused).toBe(true);

      resize(80, 28);
      await Bun.sleep(20);
      await renderSettled(renderOnce);
      shellSetNavigationOpen?.(true);
      await renderSettled(renderOnce);
      expect(shellTextarea).toBe(textarea);
      expect(shellTextarea?.plainText).toBe('draft survives');
      expect(shellTextarea?.focused).toBe(false);
      expect(shellScroll).toBe(scroll);
      expect(captureCharFrame()).toContain('Workspaces · Esc close');
      expect(shellScroll?.scrollTop).toBe(3);
      shellSetNavigationOpen?.(false);
      await renderSettled(renderOnce);
      expect(shellTextarea?.focused).toBe(true);
      expect(captureCharFrame()).toContain('survives');

      resize(40, 28);
      await Bun.sleep(20);
      await renderSettled(renderOnce);
      shellSetNavigationOpen?.(true);
      await renderSettled(renderOnce);
      expect(captureCharFrame()).toContain('Workspaces · Esc close');
      expect(shellTextarea?.focused).toBe(false);
      expect(captureCharFrame()).toContain('2 of 4');
      expect(shellTextarea).toBe(textarea);
      expect(shellTextarea?.plainText).toBe('draft survives');
      expect(shellScroll?.scrollTop).toBe(3);
      shellSetNavigationOpen?.(false);
      await renderSettled(renderOnce);
      expect(shellTextarea?.focused).toBe(true);
      expect(captureCharFrame()).toContain('survives');
    } finally {
      root.render(<box />);
      renderer.destroy();
      shellTextarea = null;
      shellScroll = null;
    }
  });
});
let shellTextarea: TextareaRenderable | null = null;
let shellScroll: ScrollBoxRenderable | null = null;
let shellSetNavigationOpen: ((open: boolean) => void) | null = null;
let shellScrollAnchor: ScrollAnchorController | null = null;

function ShellProbe(props: {
  readonly store: TuiPreferenceStore;
}) {
  const [draft, setDraft] = useState('');
  const [navigationOpen, setNavigationOpen] = useState(false);
  shellSetNavigationOpen = setNavigationOpen;
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  shellScrollAnchor = usePreservedScrollAnchor(scrollRef);
  const roster: TuiAgentRoster = {
    page: {
      items: [
        {
          name: 'checkout', label: 'checkout', mode: 'local', cwd: ROOT, workspaceId: 'checkout', status: 'running',
          subordinates: [{ id: 'reviewer', label: 'Reviewer', status: 'idle', roleId: 'auditor' }],
        },
        { name: 'jarvis', label: 'Jarvis', mode: 'cloud', status: 'idle' },
      ],
      total: 4,
      nextCursor: 'page-2',
    },
    loading: false,
    error: null,
    reload: async () => {},
    loadMore: async () => {},
  };
  return (
    <TuiProductProvider runtime={{ preferenceStore: props.store, terminalAppearance: 'dark', colorCapability: 'truecolor' }}>
      <TuiShell
        scene="chat"
        roster={roster}
        currentAgent={{ name: 'checkout', mode: 'local' }}
        navigationOverlayOpen={navigationOpen}
        onNavigationOverlayChange={setNavigationOpen}
        onNavigationFocusChange={(focused) => {
          if (focused) textareaRef.current?.blur();
          else textareaRef.current?.focus();
        }}
      >
        <box flexDirection="column" style={{ width: '100%', height: '100%' }}>
          <scrollbox
            ref={(value) => {
              scrollRef.current = value;
              shellScroll = value;
            }}
            stickyScroll={false}
            style={{ flexGrow: 1 }}
          >
            {Array.from({ length: 60 }, (_, index) => <text key={index}>anchor {index}</text>)}
          </scrollbox>
          <textarea
            ref={(value) => {
              textareaRef.current = value;
              shellTextarea = value;
            }}
            focused
            initialValue={draft}
            onContentChange={() => setDraft(textareaRef.current?.plainText ?? '')}
          />
        </box>
      </TuiShell>
    </TuiProductProvider>
  );
}

/** Six paint passes: the navigator's scrollbox takes more than one commit to
 *  lay out under the test renderer, and a burst of key events needs its state
 *  flushed through effects before the frame is meaningful. */
async function renderSettled(renderOnce: () => Promise<void>): Promise<void> {
  for (let pass = 0; pass < 6; pass += 1) {
    await renderOnce();
    await Bun.sleep(5);
  }
}
