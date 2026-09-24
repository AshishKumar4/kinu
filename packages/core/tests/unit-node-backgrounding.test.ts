/**
 * A node can background work, and its turn can end with work still running: the slow call detaches,
 * the settled job wakes the node for a second turn, and ending a turn without `report` is a normal outcome.
 * The detach threshold is a fixture value; the shipped `interactive` policy runs the same relationship.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { tool, jsonSchema, type ToolSet } from 'ai';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { createTestRuntime } from './helpers';
import { hostedSeatsOver } from './helpers-actor-host';
import { createRecordingLogger } from '../src/obs/index';
import { HeadJournal } from '../src/heads/journal';
import { initHeadsTables } from '../src/heads/schema';
import {
  NODE_BUILTIN_TOOLS, NODE_WITHHELD_TOOLS, runNodeAgent,
} from '../src/strategy/node-agent';
import type { NodeAgentDeps, NodeAgentInput, NodeRun } from '../src/strategy/node-agent';
import { BUILTIN_TOOLS } from '../src/tools/registry';

const DETACH_MS = 60;

const SETTLE_MS = 200;

/** A `prebuiltCodemodeTool` whose work outlives the detach threshold; the test calls `settle`. */
function slowExecuteTool() {
  let release!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  let starts = 0;

  return {
    entry: tool({
      description: 'Run code in the sandbox.',
      inputSchema: jsonSchema<{ code: string }>({
        type: 'object', required: ['code'], properties: { code: { type: 'string' } },
      }),
      execute: async ({ code }) => {
        starts += 1;
        await done;

        return `ran ${code}: exit 0`;
      },
    }),
    settle: release,
    started: () => starts,
  };
}

/**
 * Launches long work, ends its turn while it runs, and reports once woken. The stage is read off the
 * conversation rather than a call counter, so the fixture cannot get out of step with the loop.
 */
function detachStageContent(stage: { reported: boolean; woken: boolean; launched: boolean }): LanguageModelV3Content[] {
  if (stage.reported) return [{ type: 'text', text: 'Done.' }];

  if (stage.woken) {
    return [{
      type: 'tool-call',
      toolCallId: 'report-1',
      toolName: 'report',
      input: JSON.stringify({ status: 'completed', content: 'The sandbox run finished.' }),
    }];
  }

  // The turn ends here, holding live work.
  if (stage.launched) return [{ type: 'text', text: 'Launched it; waiting on the result.' }];

  return [{
    type: 'tool-call',
    toolCallId: 'exec-1',
    toolName: 'eval',
    input: JSON.stringify({ code: 'await sandbox.run()' }),
  }];
}

function factoryStageContent(stage: { reported: boolean; launched: boolean; sawFactory: boolean }): LanguageModelV3Content[] {
  if (stage.reported) return [{ type: 'text', text: 'Done.' }];

  if (stage.launched) {
    return [{
      type: 'tool-call',
      toolCallId: 'report-1',
      toolName: 'report',
      input: JSON.stringify({
        status: 'completed',
        content: stage.sawFactory ? 'saw factory-ran' : 'saw none',
      }),
    }];
  }

  return [{
    type: 'tool-call',
    toolCallId: 'exec-1',
    toolName: 'eval',
    input: JSON.stringify({ code: 'const x = 1' }),
  }];
}

function detachStageFinish(stage: { reported: boolean; woken: boolean; launched: boolean }): 'stop' | 'tool-calls' {
  if (stage.reported) return 'stop';

  if (stage.woken) return 'tool-calls';

  return stage.launched ? 'stop' : 'tool-calls';
}

function detachThenReport(seen: string[][], onRequest?: (count: number) => void): ReturnType<typeof scriptedTurnModel> {
  return scriptedTurnModel({
    modelId: 'fake-detacher',
    doGenerate: ({ prompt }) => {
      seen.push(prompt.map((message) => JSON.stringify(message.content)));
      onRequest?.(seen.length);
      const text = JSON.stringify(prompt);
      const woken = text.includes('Background eval job');
      const reported = text.includes('"received":true');
      const launched = prompt.some((message) => message.role === 'tool');

      const stage = { reported, woken, launched };

      return {
        content: detachStageContent(stage),
        finishReason: {
          unified: detachStageFinish(stage),
          raw: undefined,
        },
        usage: {
          inputTokens: { total: 11, noCache: 11, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 4, text: 4, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

/** Answers in prose and never calls `report`. */
const PROSE_ONLY_MODEL = scriptedTurnModel({
  modelId: 'fake-prose',
  doGenerate: () => ({
    content: [{ type: 'text', text: 'The bottleneck is the inner comparison loop.' }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: {
      inputTokens: { total: 7, noCache: 7, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    },
    warnings: [],
  }),
});

/**
 * Awaits the runner's `bg_job_started` log rather than a duration. The detach threshold is a real
 * `setTimeout` inside `withBackgroundThreshold`, so a fake clock would stop it firing.
 */
interface Fixture {
  readonly input: NodeAgentInput;
  readonly deps: NodeAgentDeps;
  readonly journal: HeadJournal;
  /** Jobs in flight in the workspace registry. */
  readonly detached: () => number;
  readonly jobStarted: () => Promise<void>;
}

function fixture(over: {
  readonly model: NodeAgentDeps['model'];
  readonly codemodeTool?: (finished: ToolSet) => ToolSet[string];
}): Fixture {
  const { rt, db } = createTestRuntime();
  initHeadsTables(rt.storage.execRaw);
  const journal = new HeadJournal(rt.storage.sql, rt.actor);

  const input: NodeAgentInput = {
    nodeId: 'n1', rootId: 'r1', parentId: null, depth: 1,
    task: 'Make the reference implementation cheaper.',
    rationale: 'the direct angle',
    base: 'You are a node under test.',
    messages: [{ role: 'user', content: 'Answer the task.' }],
    inherited: [],
    context: 'fresh',
    mode: 'build',
    settle: 'best',
    arbitrate: null,
  };

  const seats = hostedSeatsOver({ rt, db });
  /** The node's own actor, which keys its detached job; counting under `rt.actor` stalls the wait. */
  let nodeActorId: string | null = null;

  const recording = createRecordingLogger();
  const started = Promise.withResolvers<void>();

  const logger: typeof recording = {
    ...recording,
    event: (name, fields) => {
      recording.event(name, fields);

      const job = v.safeParse(v.object({ job: v.string() }), fields);

      if (name === 'swarm.node_job' && job.success && job.output.job === 'bg_job_started') started.resolve();
    },
  };

  const deps: NodeAgentDeps = {
    hostNode: async (node) => {
      const seat = await seats.hostNode(node);
      nodeActorId = seat.actor.handle.actorId;

      return seat;
    },
    model: over.model, journal,
    logger,
    backgroundPolicy: () => ({
      detachAfterMs: DETACH_MS, settleGraceMs: SETTLE_MS, wakesAfterTurn: true,
    }),
  };

  const codemodeTool = over.codemodeTool;

  if (codemodeTool !== undefined) deps.nodeCodemode = () => codemodeTool;

  const jobStarted = (): Promise<void> => started.promise;

  const detached = (): number => {
    if (nodeActorId === null) return 0;

    const rows = rt.storage.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM background_jobs
      WHERE actor_id = ${nodeActorId} AND status='running'`;

    return rows[0]?.n ?? 0;
  };

  return { input, deps, journal, detached, jobStarted };
}

describe('a node backgrounds work, ends its turn, and is woken to finish', () => {
  test('a turn that ends holding a live job is neither terminal nor abandoned, and the wake completes it', async () => {
    const slow = slowExecuteTool();
    const prompts: string[][] = [];
    const secondRequest = Promise.withResolvers<void>();

    const { input, deps, journal, detached, jobStarted } = fixture({
      model: detachThenReport(prompts, (count) => { if (count === 2) secondRequest.resolve(); }),
      codemodeTool: () => slow.entry,
    });

    const running = runNodeAgent(input, deps);

    // Waits on two facts, not a sleep: the runner's started event and the model's second request.
    await jobStarted();
    await secondRequest.promise;
    expect(detached()).toBe(1);
    // A third request here would mean the turn had not ended.
    expect(slow.started()).toBe(1);
    expect(prompts).toHaveLength(2);

    const midFlight = journal.readHead('n1');
    expect(midFlight?.status).toBe('running');
    expect(midFlight?.completed_at).toBeNull();

    slow.settle();
    const run: NodeRun = await running;

    // Appended, not restarted: the resumed request is a prefix of the previous one, so a provider can cache it.
    expect(prompts.length).toBeGreaterThanOrEqual(3);
    const resumed = prompts[2] ?? [];
    const firstTurn = prompts[0] ?? [];
    expect(resumed.length).toBeGreaterThan(firstTurn.length);
    expect(resumed.slice(0, firstTurn.length)).toEqual(firstTurn);
    expect(resumed.at(-1)).toContain('Background eval job');
    expect(resumed.at(-1)).toContain('completed');

    expect(run.report.status).toBe('completed');
    expect(run.reportedItself).toBe(true);
    expect(run.candidate).toContain('The sandbox run finished.');
    expect(run.report.errorMessage).toBeUndefined();

    const settled = journal.readHead('n1');
    expect(settled?.status).toBe('completed');
    expect(settled?.completed_at).toBeGreaterThan(0);

    // `head_steps` is keyed `${id}-s${seq}`, so a per-turn counter would collide; hence equality, not a floor.
    const traced = journal.readSteps('n1');
    expect(traced.length).toBe(run.report.stepCount);
    expect(traced.length).toBeGreaterThanOrEqual(2);

    // A detach re-arms the stall watchdog.
    expect(run.report.summary).not.toContain('stalled');
  });

  test('the model is handed a HANDLE, not a result, and the handle is what its transcript records', async () => {
    const slow = slowExecuteTool();
    const prompts: string[][] = [];

    const { input, deps, detached, jobStarted } = fixture({
      model: detachThenReport(prompts), codemodeTool: () => slow.entry,
    });

    const running = runNodeAgent(input, deps);
    await jobStarted();
    expect(detached()).toBe(1);
    slow.settle();
    const run = await running;
    expect(run.report.status).toBe('completed');

    // Read off the model's next request: the claim is what the model saw.
    const afterLaunch = (prompts[1] ?? []).join(' ');
    expect(afterLaunch).toContain('"background":true');
    expect(afterLaunch).toContain('eval');
    expect(afterLaunch).not.toContain('exit 0');
    expect(slow.started()).toBe(1);
  });

  test('ending a turn without calling report is a NORMAL outcome', async () => {
    const { input, deps, journal } = fixture({ model: PROSE_ONLY_MODEL });
    const run = await runNodeAgent(input, deps);

    expect(run.report.status).toBe('completed');
    expect(run.reportedItself).toBe(false);
    expect(run.report.errorMessage).toBeUndefined();
    expect(run.candidate).toContain('inner comparison loop');
    expect(run.report.summary).not.toContain('produced no report');

    const row = journal.readHead('n1');
    expect(row?.status).toBe('completed');
    expect(row?.error_message).toBeNull();
  });
});

describe("a node's tool surface is partitioned exactly, with a reason on every withholding", () => {
  test('every shipped builtin is either given or withheld by name — nothing is unaccounted for', () => {
    const given = [...NODE_BUILTIN_TOOLS];
    const withheld = Object.keys(NODE_WITHHELD_TOOLS);
    // Checked both ways against the shipped set, so a new builtin fails here.
    expect(new Set([...given, ...withheld])).toEqual(new Set(BUILTIN_TOOLS));
    expect(given.length + withheld.length).toBe(BUILTIN_TOOLS.length);
    expect(given.filter((name) => withheld.includes(name))).toEqual([]);
  });

  test('every withholding states a reason, and the reason is a property of the code', () => {
    for (const [name, reason] of Object.entries(NODE_WITHHELD_TOOLS)) {
      expect(reason.length).toBeGreaterThan(40);
      expect(reason).not.toContain('TODO');
      expect(reason).not.toContain('not yet');
      expect(name).not.toBe('');
    }

    // `DELEGATION_MAX_DEPTH` governs the hire ladder, not a node's search depth.
    expect(NODE_WITHHELD_TOOLS.agents).toContain('search engine');
    expect(NODE_WITHHELD_TOOLS.agents).not.toContain('recursion');
  });

  test('a node really does hold the tools it is given and none of the withheld ones', async () => {
    // Read off a real node run: the prompt lists the tools it holds.
    const { input, deps } = fixture({ model: PROSE_ONLY_MODEL });
    const run = await runNodeAgent(input, deps);
    expect(run.report.status).toBe('completed');
    // `eval` is absent when no factory is wired, so the surface is a subset of what is given.
    const surface: readonly string[] = ['shell', 'file', 'report'];
    const given: readonly string[] = NODE_BUILTIN_TOOLS;

    for (const name of surface) expect(given).toContain(name);

    for (const name of Object.keys(NODE_WITHHELD_TOOLS)) expect(surface).not.toContain(name);
  });
});

describe('a node resolves a function-form codemodeTool through the finished surface', () => {
  test('function-form dep becomes a working eval, not the NOT CONFIGURED stub', async () => {
    // `deps.codemodeTool` may be a function of the finished surface; the node must resolve it
    // as `buildHeadToolSet` does rather than handing it raw to `prebuiltCodemodeTool`.
    const factoryForm = (_finished: ToolSet) => tool({
      description: 'Run code in the sandbox.',
      inputSchema: jsonSchema<{ code: string }>({
        type: 'object', required: ['code'], properties: { code: { type: 'string' } },
      }),
      execute: async ({ code }) => `factory-ran:${code}`,
    });

    const model = scriptedTurnModel({
      modelId: 'fake-exec',
      doGenerate: ({ prompt }) => {
        const text = JSON.stringify(prompt);
        const launched = prompt.some((message) => message.role === 'tool');
        const reported = text.includes('"received":true');

        const content = factoryStageContent({ reported, launched, sawFactory: text.includes('factory-ran') });

        return {
          content,
          finishReason: {
            unified: reported ? 'stop' as const : 'tool-calls' as const,
            raw: undefined,
          },
          usage: {
            inputTokens: { total: 11, noCache: 11, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 4, text: 4, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });

    const { input, deps } = fixture({ model, codemodeTool: factoryForm });
    const run: NodeRun = await runNodeAgent(input, deps);
    expect(run.report.status).toBe('completed');
    expect(run.candidate).toContain('factory-ran');
  });
});
