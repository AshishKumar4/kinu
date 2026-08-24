/**
 * TUI screen capture harness.
 *
 * Renders the real screens through the opentui test renderer — the same
 * renderer packages/cli/tests/tui.test.tsx measures the chrome with — and
 * writes one char frame per screen. The design-review workflow photographs
 * the current surface with it: pass a set name, compare sets side by side.
 *
 * Run: `bun scripts/tui-capture.ts <set>`   (default set: "current")
 * Output: ${TUI_CAPTURE_DIR:-/tmp/review-TuiRedesign2}/<set>/*.txt
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AlternateTakeSet } from '../packages/core/src/mcts/takes';
import type { AgentSearchNode } from '../packages/cli/src/agent-client';
import type { DisplayMessage } from '../packages/cli/src/tui/messages';

const set = process.argv[2] ?? 'current';
const outDir = `${process.env.TUI_CAPTURE_DIR ?? '/tmp/review-TuiRedesign2'}/${set}`;
mkdirSync(outDir, { recursive: true });

const MODEL = '@cf/deepseek-ai/deepseek-v4-pro-0813';
const WORKSPACE = 'checkout';
const SESSION = '20260821-checkout01';

function prepareHome(): string {
  const home = mkdtempSync(join(tmpdir(), `kinu-tui-cap-${set}-`));
  for (const name of ['checkout', 'pricing-guard', 'docs-sweep', 'infra-audit']) {
    mkdirSync(join(home, name), { recursive: true });
    writeFileSync(join(home, name, 'agent.db'), '');
  }
  writeFileSync(join(home, 'config.json'), `${JSON.stringify({
    model: MODEL,
    reasoningEffort: 'medium',
    providers: { openai: { apiKey: 'sk-capture-fixture-not-a-real-key' } },
    agents: {
      checkout: {
        name: 'checkout', mode: 'local', localName: 'checkout',
        createdAt: '2026-08-18T09:00:00.000Z', updatedAt: '2026-08-21T09:00:00.000Z',
      },
      'pricing-guard': {
        name: 'pricing-guard', mode: 'local', localName: 'pricing-guard',
        createdAt: '2026-08-19T09:00:00.000Z', updatedAt: '2026-08-20T09:00:00.000Z',
      },
      'docs-sweep': {
        name: 'docs-sweep', mode: 'local', localName: 'docs-sweep',
        createdAt: '2026-08-19T10:00:00.000Z', updatedAt: '2026-08-20T11:00:00.000Z',
      },
    },
  }, null, 2)}\n`);
  return home;
}

const home = prepareHome();
process.env.KINU_HOME = home;
process.env.KINU_BASE_URL = 'https://api.example.invalid/v1';
process.env.KINU_AUTH = 'Bearer capture-fixture-not-a-real-key';

// The CLI config module captures KINU_HOME at import time. Load every app
// module only after the fixture home and endpoint are set.
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot } = await import('@opentui/react');
const React = await import('react');
const { HomeApp } = await import('../packages/cli/src/tui/home-app');
const { MessageList } = await import('../packages/cli/src/tui/messages');
const { StatusBar } = await import('../packages/cli/src/tui/status-bar');
const { PhaseLine, TakesOverlay, CommandHintOverlay } = await import('../packages/cli/src/tui/overlays');
const { DEFAULT_THEME_REGISTRY } = await import('../packages/cli/src/tui/theme');
const captureColors = DEFAULT_THEME_REGISTRY.get('kinu-dark').colors;
const { renderSearchTree, SLASH_COMMANDS } = await import('../packages/cli/src/slash-commands');

async function settle(renderOnce: () => Promise<void>, passes = 12): Promise<void> {
  for (let i = 0; i < passes; i++) {
    await renderOnce();
    await Bun.sleep(8);
  }
}

async function shoot(name: string, width: number, height: number, element: React.ReactElement, passes = 12): Promise<void> {
  const renderer = await createTestRenderer({ width, height, useThread: false, maxFps: Number.POSITIVE_INFINITY });
  const root = createRoot(renderer.renderer);
  try {
    root.render(element);
    await settle(renderer.renderOnce, passes);
    const frame = renderer.captureCharFrame();
    writeFileSync(join(outDir, `${name}.txt`), frame.endsWith('\n') ? frame : `${frame}\n`);
  } finally {
    root.render(React.createElement('box'));
    renderer.renderer.destroy();
  }
}

/* ── chat arrangement, exactly ChatApp's ─────────────────────────────── */
function chatScreen(messages: readonly DisplayMessage[], phase: string | null, processing: boolean, overlay?: React.ReactElement): React.ReactElement {
  const title = processing ? '⟳ processing…' : `${WORKSPACE} · ${SESSION} · Ctrl+P model ›`;
  const placeholder = processing
    ? 'Type to steer · Tab queues · Ctrl+B branches · Esc interrupts'
    : 'Type a message or /help · Shift+Enter for a new line';
  return React.createElement(
    'box',
    { flexDirection: 'column', style: { width: '100%', height: '100%', backgroundColor: captureColors.background.canvas } },
    React.createElement(StatusBar, {
      key: 'bar', name: WORKSPACE, mode: 'local' as const, model: MODEL,
      reasoningEffort: 'medium' as const, connected: true,
      contextTokens: 2300, contextWindow: 128_000, toolCount: 14, autoEvolve: false,
    }),
    React.createElement(
      'scrollbox',
      {
        key: 'log',
        focused: false,
        stickyScroll: true,
        stickyStart: 'bottom',
        style: {
          flexGrow: 1,
          rootOptions: { backgroundColor: captureColors.background.canvas },
          viewportOptions: { backgroundColor: captureColors.background.canvas },
          contentOptions: { backgroundColor: captureColors.background.canvas },
          scrollbarOptions: { trackOptions: { foregroundColor: captureColors.border.subtle, backgroundColor: captureColors.background.surface } },
        },
      },
      React.createElement(MessageList, { key: 'list', messages: [...messages] }),
      React.createElement(PhaseLine, { key: 'phase', label: phase }),
    ),
    React.createElement(
      'box',
      {
        key: 'input',
        style: { height: 3, border: true, borderStyle: 'single' as const, borderColor: processing ? captureColors.border.subtle : captureColors.border.default, backgroundColor: captureColors.background.surface, paddingLeft: 1 },
        title,
      },
      React.createElement('text', { key: 't' }, placeholder),
    ),
    ...(overlay ? [overlay] : []),
  );
}

const message = (id: string, role: DisplayMessage['role'], content: string, extra: Partial<DisplayMessage> = {}): DisplayMessage =>
  ({ id, role, content, ...extra });
const WELCOME: DisplayMessage[] = [message('w', 'system', 'Connected to checkout. Type a message or /help for commands.')];

const MIDTURN: DisplayMessage[] = [
  message('u1', 'user', 'The checkout tests are failing on main — find out why and fix it.'),
  message('a1', 'assistant', 'Reading the failure first.', { live: true }),
];

const TOOLS: DisplayMessage[] = [
  message('u1', 'user', 'Run the test suite, then summarize what is broken.'),
  message('a1', 'assistant', 'Running the suite now.'),
  message('t1', 'tool_call', '', { toolName: 'exec', args: '{"cmd":"bun test packages/checkout"}' }),
  message('r1', 'tool_result', '37 pass\n2 fail\ntotals.ts:41 expected 1187, received 1204'),
  message('t2', 'tool_call', '', { toolName: 'write_file', args: '{"path":"totals.ts"}' }),
  message('r2', 'tool_result', JSON.stringify({ reason: 'denied', error: 'Writing outside this workspace needs approval.\nThe path /etc/hosts.conf is not inside the workspace.' })),
  message('a2', 'assistant', 'Two failures share one cause: `lineTotal` counts shipping as taxable.\nA third-party refusal blocked a config write — not needed for the fix.'),
];

const TAKES_SET: AlternateTakeSet = {
  id: 'takes-fixture-1',
  turnId: 'turn-9',
  sessionId: 'sess-1',
  task: 'Decide how to fix the flaky retry test without masking real races.',
  source: 'mcts',
  winnerNodeId: 'node-b',
  chosenNodeId: null,
  candidates: [
    { nodeId: 'node-b', text: 'Retry only network-class errors with backoff, keep assertion failures fatal.', score: 0.87, visits: 12, depth: 2 },
    { nodeId: 'node-a', text: 'Mark the test flaky-tolerant and rerun once on any failure.', score: 0.85, visits: 10, depth: 2 },
    { nodeId: 'node-c', text: 'Split the test: transport retries covered separately from handler logic.', score: 0.84, visits: 9, depth: 3 },
  ],
  createdAt: 1755700000000,
  pickedAt: null,
};

const TREE_NODES: readonly AgentSearchNode[] = [
  { depth: 0, status: 'terminal', value: 0.87, visits: 31, action: null },
  { depth: 1, status: 'terminal', value: 0.85, visits: 12, action: 'retry-network-only' },
  { depth: 1, status: 'terminal', value: 0.84, visits: 9, action: 'split-transport-handler' },
  { depth: 1, status: 'pruned', value: 0.42, visits: 4, action: 'mark-flaky-tolerant' },
  { depth: 2, status: 'failed', value: 0.11, visits: 2, action: 'rerun-with-timeout' },
];

try {
  // Home, populated.
  await shoot('home-populated-88x28', 88, 28, React.createElement(HomeApp, { opts: {} }), 14);
  await shoot('home-populated-100x40', 100, 40, React.createElement(HomeApp, { opts: {} }), 14);

  // Chat states.
  await shoot('chat-idle-88x28', 88, 28, chatScreen(WELCOME, null, false));
  await shoot('chat-midturn-88x28', 88, 28, chatScreen(MIDTURN, 'writing', true));
  await shoot('chat-tools-88x28', 88, 28, chatScreen(TOOLS, null, false));
  await shoot('chat-tools-64x24', 64, 24, chatScreen(TOOLS, null, false));
  await shoot('takes-88x28', 88, 28, chatScreen(TOOLS, null, false, React.createElement(TakesOverlay, {
    set: TAKES_SET,
    terminal: { width: 88, height: 28 },
    onSelect: () => {},
  })));
  await shoot('tree-88x28', 88, 28, chatScreen([
    ...TOOLS,
    message('tree', 'system', `MCTS Tree (${TREE_NODES.length} nodes):\n${renderSearchTree(TREE_NODES)}`),
  ], null, false));

  // Status bar across widths.
  for (const width of [52, 72, 88, 120]) {
    await shoot(`statusbar-${width}x6`, width, 6, React.createElement(StatusBar, {
      name: WORKSPACE, mode: 'local' as const, model: MODEL, reasoningEffort: 'high' as const,
      connected: true, scaffoldVersion: 12, toolCount: 14, autoEvolve: false,
      contextTokens: 2300, contextWindow: 128_000, branchCount: 2,
    }));
  }

  // Command hints palette.
  await shoot('hints-80x24', 80, 24, React.createElement(
    'box',
    { style: { width: '100%', height: '100%' } },
    React.createElement(CommandHintOverlay, {
      commands: SLASH_COMMANDS,
      terminal: { width: 80, height: 24 },
    }),
  ));

  process.stdout.write(`captured ${set}: done\n`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
process.exit(0);
