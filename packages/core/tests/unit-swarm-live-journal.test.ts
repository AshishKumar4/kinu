/**
 * The swarm's own journal writes announce (`LiveHeadJournal`). Each announcement records what the
 * journal held at that instant, so the test asserts the row's durable sequence, not a callback count.
 */
import { describe, expect, test } from 'bun:test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import { createTestRuntime } from './helpers';
import { hostedSeatsOver } from './helpers-actor-host';
import { createRecordingLogger } from '../src/obs/index';
import { runSwarm, type SwarmRunDeps } from '../src/strategy/swarm-run';
import { resolveSwarm, swarmValidity } from '../src/strategy/swarm';
import { HeadJournal } from '../src/heads/journal';
import { headStatusUnsettled } from '../src/heads/types';
import type { AnnounceHeadActivity } from '../src/heads/live-journal';
import type { ResolvedSwarm } from '../src/strategy/swarm';

function resolved(): ResolvedSwarm {
  const call = resolveSwarm({
    preset: 'custom',
    label: 'live-journal',
    task: 'Name two ways to make the coupon guard safe.',
    config: {
      unit: { kind: 'answer' },
      context: 'fresh',
      expand: 'sample',
      score: { kind: 'none' },
      advance: { kind: 'none' },
      carry: { kind: 'none' },
    },
    depth: 1,
    branches: 2,
  });

  if ('reason' in call) throw new Error(`the suite's own composition does not resolve: ${call.error}`);
  const illegal = swarmValidity(call);

  if (illegal) throw new Error(`the suite's own composition is not legal: ${illegal.error}`);

  return call;
}

/** Reports then closes: two steps. Scripted off its own turns, since both nodes run concurrently. */
function reportingNode() {
  return scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-live-journal',
    doGenerate: async ({ prompt }) => {
      let lastUser = -1;

      for (const [index, message] of prompt.entries()) {
        if (message.role === 'user') lastUser = index;
      }

      const own = prompt.slice(lastUser + 1).filter((message) => message.role === 'assistant').length;
      const content: LanguageModelV3Content[] = [];
      let finish: 'stop' | 'tool-calls' = 'tool-calls';

      if (own === 0) {
        content.push({ type: 'text', text: 'Guarding at the reader is the cheaper of the two.' });
        content.push({
          type: 'tool-call', toolCallId: `report-${String(lastUser)}-${String(own)}`, toolName: 'report',
          input: JSON.stringify({
            status: 'completed',
            content: 'Guard the read: `rules[coupon.kind ?? inferKind(coupon)]`.',
          }),
        });
      } else {
        // The last word must be prose: a tool call makes the SDK step again, ending as `budget_exceeded`.
        content.push({ type: 'text', text: 'Reported.' });
        finish = 'stop';
      }

      return {
        content,
        finishReason: { unified: finish, raw: undefined },
        usage: {
          inputTokens: { total: 40, noCache: 40, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 12, text: 12, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

interface Announcement {
  readonly headId: string;
  /** Null for the run's own header row, written by `recordSplit` before any node. */
  readonly status: string | null;
  readonly steps: number;
}

async function run(announce?: AnnounceHeadActivity) {
  const { rt, db } = createTestRuntime();
  const reader = new HeadJournal(rt.storage.sql, rt.actor);
  const seen: Announcement[] = [];

  const deps: SwarmRunDeps = {
    rt,
    // A real seat per node over this runtime's database; the journal is read back through `rt.actor`.
    hostNode: hostedSeatsOver({ rt, db }).hostNode,
    model: reportingNode(),
    mode: 'build',
    logger: createRecordingLogger(),
  };

  // An absent seam must be an absent key: that absence makes the ledgers build the plain journal.
  if (announce !== undefined) {
    Object.assign(deps, {
      announceHeadActivity: (headId: string) => {
        const row = reader.readHead(headId);
        seen.push({ headId, status: row?.status ?? null, steps: reader.countSteps(headId).steps });
        announce(headId);
      },
    });
  }

  const result = await runSwarm(deps, resolved());

  if ('reason' in result) throw new Error(`the run must not refuse: ${result.error}`);
  const rootId = reader.listRuns(1)[0]?.rootId ?? '';
  expect(rootId).not.toBe('');
  const nodes = reader.readTree(rootId).filter((row) => row.id !== rootId);

  return { seen, nodes, reader, rootId };
}

describe('a swarm journals out loud', () => {
  test('every node announces its spawn, its steps and its report, in that order', async () => {
    const announced: string[] = [];
    const { seen, nodes, rootId } = await run((headId) => { announced.push(headId); });

    // The run's `recordSplit` row is announced before any node.
    expect(announced[0]).toBe(rootId);

    // Non-vacuity: a node ran.
    expect(nodes.length).toBeGreaterThan(0);

    for (const node of nodes) {
      const forNode = seen.filter((entry) => entry.headId === node.id);
      expect(forNode.length).toBeGreaterThanOrEqual(3);

      // Spawn: row exists, running, no trace yet.
      expect(forNode[0]).toEqual({ headId: node.id, status: 'running', steps: 0 });

      // Step: the trace grew while running; retires the live `head_stream` tail.
      expect(forNode.some((entry) => entry.status === 'running' && entry.steps > 0)).toBe(true);

      // Report: the node settled.
      const last = forNode.at(-1);
      expect(last?.steps).toBeGreaterThan(0);
      expect(headStatusUnsettled(last?.status ?? 'running')).toBe(false);
    }
  });

  test('with no listener the same run journals in silence rather than failing', async () => {
    const { nodes, reader } = await run();

    // The seam is optional: without it the durable rows, traces and settlement are identical.
    expect(nodes.length).toBeGreaterThan(0);

    for (const node of nodes) {
      expect(reader.countSteps(node.id).steps).toBeGreaterThan(0);
      expect(headStatusUnsettled(node.status)).toBe(false);
    }
  });
});
