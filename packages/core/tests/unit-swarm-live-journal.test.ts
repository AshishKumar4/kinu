/**
 * A SEARCH THAT IS HAPPENING SAYS SO — the swarm's own journal writes announce.
 *
 * THE DEFECT THIS PINS. `LiveHeadJournal`'s whole contract is that "every path
 * into the journal — hosted and unhosted, head and node, top-level and recursive
 * — goes through the instance a backend hands the controller and the node host,
 * so announcing HERE covers all of them". The swarm went through no such
 * instance: `initRunLedgers` built a raw `HeadJournal` of its own, so a node
 * appearing, every step it recorded in this isolate, and its report all landed
 * durably and told nobody. The only swarm write that ever announced was a HOSTED
 * node's step, and only because that one crosses to the parent's
 * `recordHeadStep` — so head liveness was a property of the transport rather
 * than of the search, and the Exploration surface learned about a run it was
 * watching on a poll clock.
 *
 * What that cost a reader, precisely: the transient `head_stream` tail painted
 * the step a node was writing (that seam the swarm DID carry), and the durable
 * step that supersedes it arrived without a push — so the same words sat on
 * screen twice until the reader's own re-read retired them.
 *
 * WHY THE ASSERTIONS READ THE STORE FROM INSIDE THE LISTENER. The claim is not
 * "a callback fired N times"; it is that the announcement RIDES A DURABLE WRITE.
 * So each announcement records what the journal held at that instant, and the
 * test asserts the sequence a node's row actually passed through: appeared and
 * running with no trace, running with a trace, then settled. A wiring test
 * counting calls would pass against an announce loop over ids nobody wrote.
 *
 * The run is the cheapest one that reaches an agent node: `unit:'answer'` with
 * `score`/`advance`/`carry` all `none` — the `ideate` point — so there is no
 * instrument, no judge and no second level, and the model is scripted to report
 * and close. What the node DOES is another suite's subject; that it is journalled
 * out loud is this one's.
 */
import { describe, expect, test } from 'bun:test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import { createTestRuntime } from './helpers';
import { createRecordingLogger } from '../src/obs/index';
import { runSwarm, type SwarmRunDeps } from '../src/strategy/swarm-run';
import { resolveSwarm, swarmValidity } from '../src/strategy/swarm';
import { HeadJournal } from '../src/heads/journal';
import { headStatusUnsettled } from '../src/heads/types';
import type { AnnounceHeadActivity } from '../src/heads/live-journal';
import type { ResolvedSwarm } from '../src/strategy/swarm';

/** The composition: agent nodes, nothing ranked, one level, two of them. */
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

/**
 * A node that reports and closes — two steps, which is the smallest trace that
 * can distinguish "announced its spawn" from "announced a step".
 *
 * Scripted off its OWN turns rather than a shared counter: both nodes are in
 * flight under one `Promise.allSettled`, so a counter would interleave them.
 */
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
        // A tool call makes the SDK take another step whatever the finish reason
        // says, so the node's last word has to be prose or it runs to its step
        // envelope and is reported `budget_exceeded` for having finished.
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

/** What the journal held for one id at the instant it announced that id. */
interface Announcement {
  readonly headId: string;
  /** Null for the RUN's own header row: `recordSplit` writes `head_runs`, which
   *  is the row that makes a search exist before any node does. */
  readonly status: string | null;
  readonly steps: number;
}

async function run(announce?: AnnounceHeadActivity) {
  const { rt } = createTestRuntime();
  const reader = new HeadJournal(rt.storage.sql);
  const seen: Announcement[] = [];
  const deps: SwarmRunDeps = {
    rt,
    model: reportingNode(),
    mode: 'build',
    logger: createRecordingLogger(),
  };
  // Assigned rather than spread, and the shape is the point the run itself
  // depends on: an absent seam must be an ABSENT KEY, because that absence is
  // exactly what makes the ledgers build the plain journal.
  //
  // Every announcement is measured against the store AS IT WAS when the listener
  // ran, which is what makes this a claim about the write and not about the
  // callback.
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

    // The run itself is announced before any node is: `recordSplit` is the row
    // that makes the search exist, and it is the first thing a watching client
    // can learn about it.
    expect(announced[0]).toBe(rootId);

    // A node ran at all — otherwise every assertion below is vacuous.
    expect(nodes.length).toBeGreaterThan(0);

    for (const node of nodes) {
      const forNode = seen.filter((entry) => entry.headId === node.id);
      expect(forNode.length).toBeGreaterThanOrEqual(3);

      // THE SPAWN: the row exists, claims to be executing, and has no trace yet.
      // This is the announcement that puts a node on the canvas.
      expect(forNode[0]).toEqual({ headId: node.id, status: 'running', steps: 0 });

      // A STEP: the trace grew while the node was still running. This is the
      // announcement that retires the live tail the `head_stream` frames painted
      // and re-reads the transcript a reader has open.
      expect(forNode.some((entry) => entry.status === 'running' && entry.steps > 0)).toBe(true);

      // THE REPORT: the last thing said about this node is that it settled — the
      // write a reader watching a running branch is waiting for.
      const last = forNode.at(-1);
      expect(last?.steps).toBeGreaterThan(0);
      expect(headStatusUnsettled(last?.status ?? 'running')).toBe(false);
    }
  }, 60_000);

  test('with no listener the same run journals in silence rather than failing', async () => {
    const { nodes, reader } = await run();

    // The seam is OPTIONAL and absence is a backend with nothing watching — not
    // a degraded run. So the durable half must be identical: the rows, their
    // traces and their settlement all land.
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(reader.countSteps(node.id).steps).toBeGreaterThan(0);
      expect(headStatusUnsettled(node.status)).toBe(false);
    }
  }, 60_000);
});
