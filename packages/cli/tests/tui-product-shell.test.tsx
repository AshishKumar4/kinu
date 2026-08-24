/** @jsxImportSource @opentui/react */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScrollBoxRenderable, TextareaRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { useRef, useState } from 'react';
import { describe, expect, test } from 'bun:test';

import { canonicalProjectRoot } from '../src/config';
import { type TuiPreferenceStore } from '../src/tui/preferences';
import { createMemoryTuiPreferenceStore } from './helpers/tui-preferences';
import { createRecordingLogger, setDiagnosticsSink } from '@kinu.run/core/obs';
import {
  TuiProductProvider,
  TuiShell,
  useAgentRoster,
  usePreservedScrollAnchor,
  type ScrollAnchorController,
  type TuiAgentPage,
  type TuiAgentRoster,
  type TuiAgentSource,
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
  const store = createMemoryTuiPreferenceStore();
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
        // A page with no cursor offers no paging row at all.
        expect(frame).not.toContain('Load more');
        const lines = frame.split('\n');
        expect(lines.findIndex((line) => line.includes('shop · 2'))).toBeLessThan(lines.findIndex((line) => line.includes('Cloud · 2')));
      } finally {
        await probe.destroy();
      }
    }
  });

  test('groups order current project first, then foreign projects, then unplaced, then cloud, with one paging row', async () => {
    const probe = await mountProbe({
      width: 160,
      page: pageOf(
        [...GROUPED_ITEMS, { name: 'faraway', label: 'faraway', mode: 'local', cwd: '/elsewhere/repo', workspaceId: 'other' }],
        'page-2',
      ),
    });
    try {
      const frame = probe.frame();
      const lines = frame.split('\n');
      const at = (text: string) => {
        const index = lines.findIndex((line) => line.includes(text));
        if (index < 0) throw new Error(`No frame line containing ${text}`);
        return index;
      };

      // Header counts, and the running dot that only a group with a running
      // peer earns.
      expect(frame).toContain('shop · 2 ●');
      expect(lines[at('docs · 1')]).not.toContain('●');

      // Peers sit under their own header, in page order.
      expect(at('shop · 2')).toBeLessThan(at('● audit'));
      expect(at('● audit')).toBeLessThan(at('fixer'));
      expect(at('fixer')).toBeLessThan(at('docs · 1'));

      // Another project's workspace gets its own group after this project's.
      expect(at('docs · 1')).toBeLessThan(at('other · 1'));
      expect(at('other · 1')).toBeLessThan(at('faraway'));

      // Unplaced legacy agents, then the collapsed cloud section, then paging.
      expect(at('faraway')).toBeLessThan(at('Unplaced · 1'));
      expect(at('Unplaced · 1')).toBeLessThan(at('▸ Cloud · 2'));
      expect(frame).not.toContain('Jarvis');
      expect(at('▸ Cloud · 2')).toBeLessThan(at('Load more · 7 of 7'));
      expect(lines.filter((line) => line.includes('Load more'))).toHaveLength(1);
    } finally {
      await probe.destroy();
    }
  });

  test('a legacy agent placed by no ref groups under Unplaced, never under the current project', async () => {
    const probe = await mountProbe({
      width: 160,
      page: pageOf([{ name: 'oldbot', label: 'oldbot', mode: 'local' }]),
    });
    try {
      const frame = probe.frame();
      expect(frame).toContain('Unplaced · 1');
      expect(frame).toContain('oldbot');
      // Exactly one group header, so the current project never claimed it.
      expect(frame.split('▾ ')).toHaveLength(2);
    } finally {
      await probe.destroy();
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
    const store = createMemoryTuiPreferenceStore();
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

// ── Roster failure ownership — the real hook under the shell ────────────────

let failingRoster: TuiAgentRoster | null = null;

function RosterFailureProbe(props: { readonly store: TuiPreferenceStore; readonly source: TuiAgentSource }) {
  const roster = useAgentRoster(props.source);
  failingRoster = roster;
  return (
    <TuiProductProvider runtime={{ preferenceStore: props.store, terminalAppearance: 'dark', colorCapability: 'truecolor' }}>
      <TuiShell
        scene="chat"
        roster={roster}
        navigationOverlayOpen={false}
        onNavigationOverlayChange={() => {}}
      >
        <box />
      </TuiShell>
    </TuiProductProvider>
  );
}

async function mountRosterProbe(source: TuiAgentSource) {
  const testRenderer = await createTestRenderer({
    width: 160,
    height: 28,
    useThread: false,
    maxFps: Number.POSITIVE_INFINITY,
  });
  const root = createRoot(testRenderer.renderer);
  root.render(<RosterFailureProbe store={createMemoryTuiPreferenceStore()} source={source} />);
  await renderSettled(testRenderer.renderOnce);
  return {
    frame: () => testRenderer.captureCharFrame(),
    async settle() {
      await renderSettled(testRenderer.renderOnce);
    },
    async clickLine(text: string) {
      const index = testRenderer.captureCharFrame().split('\n').findIndex((line) => line.includes(text));
      if (index < 0) throw new Error(`No frame line containing ${text}`);
      await testRenderer.mockMouse.click(4, index);
    },
    async destroy() {
      root.render(<box />);
      await testRenderer.renderOnce();
      testRenderer.renderer.destroy();
      failingRoster = null;
    },
  };
}

const rosterItem = (name: string): TuiAgentSummary => ({
  name, label: name, mode: 'local', cwd: ROOT, workspaceId: 'shop',
});

describe('agent roster failure ownership', () => {
  test('a failed page shows the whole cause chain and keeps Load more retryable', async () => {
    let pageReads = 0;
    const source: TuiAgentSource = {
      load(cursor) {
        if (cursor === null) return { items: [rosterItem('alpha'), rosterItem('beta')], total: 4, nextCursor: 'p2' };
        pageReads += 1;
        if (pageReads === 1) throw new Error('page failed', { cause: new Error('boom') });
        return { items: [rosterItem('gamma'), rosterItem('delta')], total: 4, nextCursor: null };
      },
    };
    const probe = await mountRosterProbe(source);
    try {
      expect(probe.frame()).toContain('Load more');
      await probe.clickLine('Load more');
      await probe.settle();
      const failed = probe.frame();
      // The whole chain reaches the person, and the paging row survives the
      // failure — a failed page must never read as the end of the list.
      expect(failed).toContain('page failed: boom');
      expect(failed).toContain('Load more');
      expect(failed).toContain('2 of 4');
      await probe.clickLine('Load more');
      await probe.settle();
      const recovered = probe.frame();
      expect(recovered).toContain('gamma');
      expect(recovered).toContain('4 of 4');
      expect(recovered).not.toContain('page failed');
      expect(recovered).not.toContain('Load more');
    } finally {
      await probe.destroy();
    }
  });

  test('a failed roster read shows the whole cause chain in the navigator', async () => {
    const source: TuiAgentSource = {
      load() {
        throw new Error('roster failed', { cause: new Error('locked') });
      },
    };
    const probe = await mountRosterProbe(source);
    try {
      expect(probe.frame()).toContain('roster failed: locked');
    } finally {
      await probe.destroy();
    }
  });

  test('a superseded page failure lands in diagnostics, never on the fresh view', async () => {
    const recorder = createRecordingLogger();
    const restore = setDiagnosticsSink(recorder);
    const pending = Promise.withResolvers<TuiAgentPage>();
    const source: TuiAgentSource = {
      load(cursor) {
        if (cursor === null) return { items: [rosterItem('alpha')], total: 2, nextCursor: 'p2' };
        return pending.promise;
      },
    };
    const probe = await mountRosterProbe(source);
    try {
      await probe.clickLine('Load more');
      await probe.settle();
      await failingRoster?.reload();
      await probe.settle();
      pending.reject(new Error('page failed', { cause: new Error('boom') }));
      await probe.settle();
      expect(probe.frame()).not.toContain('page failed');
      const recorded = recorder.emitted.find((line) => line.event === 'tui.roster_page_superseded');
      expect(recorded?.code).toBe('unavailable');
      expect(recorded?.cause).toContain('page failed: boom');
    } finally {
      restore();
      await probe.destroy();
    }
  });
});
