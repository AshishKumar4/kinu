/**
 * Capture the product's TUI components with scripted clients and a CLI renderer.
 *
 * Run: bun scripts/tui-capture.ts <set> (default: current)
 * Output: ${TUI_CAPTURE_DIR:-$TMPDIR/review-TuiRedesign2}/<set>/*.txt
 */
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import type { MockInput } from '@opentui/core/testing';
import type { AlternateTakeSet } from '../packages/core/src/mcts/takes';
import type { AgentSearchNode, AgentTranscriptMessage } from '../packages/cli/src/agent-client';

const set = process.argv[2] ?? 'current';

// Terminal setup and teardown write protocol bytes; keep them off the command's stdout.
if (process.env.KINU_TUI_CAPTURE_WORKER !== '1') {
  const worker = Bun.spawn([process.execPath, import.meta.path, set], {
    env: { ...process.env, KINU_TUI_CAPTURE_WORKER: '1' },
    stdin: 'ignore', stdout: 'ignore', stderr: 'inherit',
  });

  const code = await worker.exited;

  if (code === 0) process.stdout.write(`captured ${set}: done\n`);
  process.exit(code);
}

const outDir = join(process.env.TUI_CAPTURE_DIR ?? join(tmpdir(), 'review-TuiRedesign2'), set);

mkdirSync(outDir, { recursive: true });

const MODEL = '@cf/deepseek-ai/deepseek-v4-pro-0813';

const WORKSPACE = 'checkout';

const home = mkdtempSync(join(tmpdir(), `kinu-tui-cap-${set}-`));

writeFileSync(join(home, 'config.json'), JSON.stringify({
  providers: { openai: { apiKey: 'sk-capture-fixture-not-a-real-key' } },
}));

process.env.KINU_HOME = home;

process.env.KINU_BASE_URL = 'https://api.example.invalid/v1';

process.env.KINU_AUTH = 'Bearer capture-fixture-not-a-real-key';

// Config captures KINU_HOME at import time.
const { createCliRenderer } = await import('@opentui/core');

const { createMockKeys } = await import('@opentui/core/testing');

const { createRoot, flushSync } = await import('@opentui/react');

const { createElement } = await import('react');

const { HomeApp } = await import('../packages/cli/src/tui/home-app');

const { ChatApp } = await import('../packages/cli/src/tui/chat-app');

const { StatusBar } = await import('../packages/cli/src/tui/status-bar');

const { TuiProductProvider, agentSourceFromList } = await import('../packages/cli/src/tui/tui-shell');

const { fakeClient, soloHub } = await import('../packages/cli/tests/helpers/chat-app-fixture');

const { createMemoryTuiPreferenceStore } = await import('../packages/cli/tests/helpers/tui-preferences');

const workspaceSource = agentSourceFromList(() => ['checkout', 'pricing-guard', 'docs-sweep', 'infra-audit']
  .map((name) => ({ name, label: name, mode: 'local' as const })));

function captureRuntime() {
  const preferenceStore = createMemoryTuiPreferenceStore();
  preferenceStore.write({ ...preferenceStore.read(), theme: { mode: 'theme', themeId: 'kinu-dark' } });

  return { preferenceStore, colorCapability: 'truecolor' as const };
}

type WaitFor = (predicate: (frame: string) => boolean) => Promise<void>;

interface Shot {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly element: ReactElement;
  readonly settled: (frame: string) => boolean;
  readonly drive?: (input: MockInput, waitFor: WaitFor) => Promise<void>;
}

async function shoot({ name, width, height, element, settled, drive }: Shot): Promise<void> {
  const renderer = await createCliRenderer({
    width, height, bufferedOutput: 'memory', useThread: false,
    exitOnCtrlC: false, exitSignals: [], externalOutputMode: 'passthrough',
  });

  const root = createRoot(renderer);

  const frame = () => new TextDecoder().decode(renderer.currentRenderBuffer.getRealCharBytes(true));

  const waitFor: WaitFor = async (predicate) => {
    while (!predicate(frame())) await once(renderer, 'frame');
  };

  try {
    root.render(element);
    renderer.start();
    await waitFor(settled);

    if (drive) await drive(createMockKeys(renderer), waitFor);
    let captured = frame();

    for (let quietFrames = 0; quietFrames < 2;) {
      await once(renderer, 'frame');
      const next = frame();
      quietFrames = next === captured ? quietFrames + 1 : 0;
      captured = next;
    }

    writeFileSync(join(outDir, `${name}.txt`), captured.endsWith('\n') ? captured : `${captured}\n`);
  } finally {
    flushSync(() => { root.unmount(); });
    renderer.destroy();
  }
}

const TOOLS: AgentTranscriptMessage[] = [
  { id: 'u1', role: 'user', content: 'Run the test suite, then summarize what is broken.' },
  { id: 'a1', role: 'assistant', content: 'Running the suite now.' },
  { id: 't1', role: 'tool_call', content: '', toolName: 'exec', toolCallId: 'test', args: '{"cmd":"bun test packages/checkout"}' },
  { id: 'r1', role: 'tool_result', toolName: 'exec', toolCallId: 'test', success: true, content: '37 pass\n2 fail\ntotals.ts:41 expected 1187, received 1204' },
  { id: 't2', role: 'tool_call', content: '', toolName: 'write_file', toolCallId: 'write', args: '{"path":"totals.ts"}' },
  { id: 'r2', role: 'tool_result', toolName: 'write_file', toolCallId: 'write', success: false, content: JSON.stringify({ reason: 'denied', error: 'Writing outside this workspace needs approval.\nThe path /etc/hosts.conf is not inside the workspace.' }) },
  { id: 'a2', role: 'assistant', content: 'Two failures share one cause: `lineTotal` counts shipping as taxable.\nA third-party refusal blocked a config write — not needed for the fix.' },
];

const TAKES_SET: AlternateTakeSet = {
  id: 'takes-fixture-1',
  turnId: 'turn-9',
  sessionId: 'sess-1',
  task: 'Decide how to fix the flaky retry test without masking real races.',
  winnerNodeId: 'node-b',
  chosenNodeId: null,
  candidates: [
    { nodeId: 'node-b', text: 'Retry only network-class errors with backoff, keep assertion failures fatal.', origin: 'live' },
    { nodeId: 'node-a', text: 'Mark the test flaky-tolerant and rerun once on any failure.', origin: 'branch' },
  ],
  createdAt: 1755700000000,
};

const TREE_NODES: readonly AgentSearchNode[] = [
  { depth: 0, status: 'terminal', value: 0.87, visits: 31, action: null },
  { depth: 1, status: 'terminal', value: 0.85, visits: 12, action: 'retry-network-only' },
  { depth: 1, status: 'terminal', value: 0.84, visits: 9, action: 'split-transport-handler' },
  { depth: 1, status: 'pruned', value: 0.42, visits: 4, action: 'mark-flaky-tolerant' },
  { depth: 2, status: 'failed', value: 0.11, visits: 2, action: 'rerun-with-timeout' },
];

function chat(history: readonly AgentTranscriptMessage[] = []) {
  const agent = fakeClient({
    name: WORKSPACE,
    history: async () => [...history],
    status: async () => ({
      name: WORKSPACE, purpose: 'Own the checkout.', model: MODEL, reasoningEffort: 'medium',
      toolCount: 14, autoEvolve: false,
      context: { tokens: 2300, window: 128_000, source: 'provider', at: '2026-08-21T09:00:00.000Z' },
    }),
    listModels: async () => ({
      models: [{ provider: 'cloudflare', label: 'DeepSeek V4 Pro', spec: MODEL, capabilities: ['tools', 'streaming'], contextWindow: 128_000 }],
      failures: [],
    }),
  });

  agent.client.latestTakes = async () => TAKES_SET;
  agent.client.searchNodes = async () => [...TREE_NODES];

  return {
    agent,
    element: createElement(ChatApp, {
      client: agent.client, tui: captureRuntime(), workspaceSource,
      hubData: soloHub(agent.client), readHub: async (target) => soloHub(target),
    }),
  };
}

const chatReady = (frame: string) => frame.includes('Send a message');

try {
  for (const [width, height] of [[88, 28], [100, 40]] as const) {
    await shoot({
      name: `home-populated-${width}x${height}`, width, height,
      element: createElement(HomeApp, { opts: { tui: captureRuntime(), workspaceSource } }),
      settled: (frame) => frame.includes('Open a workspace') && frame.includes('Local workspace')
        && (width < 100 || frame.includes('checkout')),
    });
  }

  await shoot({ name: 'chat-idle-88x28', width: 88, height: 28, element: chat().element, settled: chatReady });

  const midturn = chat([{ id: 'u1', role: 'user', content: 'The checkout tests are failing on main — find out why and fix it.' }]);
  await shoot({
    name: 'chat-midturn-88x28', width: 88, height: 28, element: midturn.element, settled: chatReady,
    drive: async (_input, waitFor) => {
      midturn.agent.emit({ type: 'turn-start', kind: 'user', text: '' });
      midturn.agent.emit({ type: 'text-delta', delta: 'Reading the failure first.' });
      await waitFor((frame) => frame.includes('Reading the failure first.') && frame.includes('writing'));
    },
  });

  for (const [width, height] of [[88, 28], [64, 24]] as const) {
    await shoot({
      name: `chat-tools-${width}x${height}`, width, height,
      element: chat(TOOLS).element,
      settled: (frame) => chatReady(frame) && frame.includes('lineTotal'),
    });
  }

  for (const [name, command, shown] of [
    ['takes-88x28', '/takes', 'Alternate takes'],
    ['tree-88x28', '/tree', 'Search tree (5 nodes)'],
  ]) {
    await shoot({
      name, width: 88, height: 28, element: chat(TOOLS).element, settled: chatReady,
      drive: async (input, waitFor) => {
        await input.typeText(command);
        input.pressEnter();
        await waitFor((frame) => frame.includes(shown));
      },
    });
  }

  for (const width of [52, 72, 88, 120]) {
    await shoot({
      name: `statusbar-${width}x6`, width, height: 6,
      element: createElement(TuiProductProvider, {
        runtime: captureRuntime(),
        children: createElement(StatusBar, {
          name: WORKSPACE, mode: 'local', model: MODEL, reasoningEffort: 'high',
          connected: true, scaffoldVersion: 12, toolCount: 14, autoEvolve: false,
          contextTokens: 2300, contextWindow: 128_000, branchCount: 2,
        }),
      }),
      settled: (frame) => frame.includes('kinu'),
    });
  }

  await shoot({
    name: 'hints-80x24', width: 80, height: 24, element: chat().element, settled: chatReady,
    drive: async (input, waitFor) => {
      await input.typeText('/');
      await waitFor((frame) => frame.includes('Type to filter') && frame.includes('/status'));
    },
  });
} finally {
  rmSync(home, { recursive: true, force: true });
}

process.exit(0);
