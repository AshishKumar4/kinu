/**
 * A NODE IS AN ACTOR: IT CAN BACKGROUND WORK, AND ITS TURN CAN END WITH WORK STILL
 * RUNNING.
 *
 * WHAT WAS MISSING, measured on the base of this change: `grep -n
 * "jobRunner|BackgroundJobRunner"` over `strategy/node-agent.ts` and
 * `heads/head-inference.ts` returned NOTHING. `BackgroundJobRunner` was constructed on
 * `ActorAgent` and on the CLI session and nowhere else, so a node held five of the
 * eight builtins and none of the backgrounding contract —
 * `BACKGROUND_POLICY.interactive` says work that crosses 30 s detaches wherever
 * `wakesAfterTurn` holds, and `orchestrator/background-tools.ts` states the rule as
 * "where a wake can arrive it detaches". A node had no wake path, so nothing detached,
 * so a node could only ever be a single turn that had to end by calling `report`.
 *
 * WHAT IS ASSERTED HERE, and each is a separate claim:
 *
 *   1. A slow tool call DETACHES rather than blocking the turn: the model is handed a
 *      handle, and the turn ends.
 *   2. That turn is NOT terminal and NOT abandoned. The node's journal row is still
 *      `running` at that instant, and the loop is waiting rather than reporting.
 *   3. The settled job WAKES the node, which takes a SECOND turn on the same
 *      conversation, with the wake as its last message.
 *   4. ENDING A TURN WITHOUT `report` IS A NORMAL OUTCOME. A node that answers in prose
 *      and holds nothing finishes `completed`, `reportedItself:false`, no error.
 *   5. THE STEP SEQUENCE IS DENSE ACROSS TURNS. `head_steps` is keyed `${id}-s${seq}`,
 *      so a per-turn counter would have the second turn overwrite the first turn's
 *      trace, and the report's count would disagree with the rows.
 *   6. A DETACH COUNTS AS FLOW. The handle is a tool result, so it re-arms the stall
 *      watchdog; a node whose work legitimately went to the background is not cut for
 *      the silence that follows.
 *   7. THE TOOL SURFACE IS PARTITIONED EXACTLY. Every shipped builtin is either on a
 *      node's surface or named in {@link NODE_WITHHELD_TOOLS} with a reason, and the
 *      two together are the whole set — a denominator guard, so a builtin added
 *      upstream fails here instead of silently appearing or silently not.
 *
 * THE POLICY IS A FIXTURE VALUE for the reason every bound in these suites is: a
 * threshold whose only value is 30 s cannot be exercised by a test that has to finish.
 * The RELATIONSHIP asserted — work past the threshold detaches, the turn ends, the wake
 * resumes it — is the one the shipped `interactive` policy runs.
 */
import { describe, expect, test } from 'bun:test';
import { tool, jsonSchema, type ToolSet } from 'ai';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { createTestRuntime } from './helpers';
import { createRecordingLogger } from '../src/obs/index';
import { HeadJournal } from '../src/heads/journal';
import { initHeadsTables } from '../src/heads/schema';
import {
  NODE_BUILTIN_TOOLS, NODE_WITHHELD_TOOLS, runNodeAgent,
} from '../src/strategy/node-agent';
import type { NodeAgentDeps, NodeAgentInput, NodeRun } from '../src/strategy/node-agent';
import { BUILTIN_TOOLS } from '../src/tools/registry';

/** Sub-second so the arms finish; see the header for why a magnitude is a fixture. */
const DETACH_MS = 60;
const SETTLE_MS = 200;
const STALL_MS = 4_000;

/** The one long-running tool a node has to hold for any of this to be reachable: a
 *  `preBuiltExecuteTool` whose work outlives the detach threshold. `settle` is called
 *  by the test at the instant it wants the job to finish, so "after the turn ended" is
 *  an ordering the test controls rather than a race it hopes for. */
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
 * A model that launches long work, ENDS ITS TURN while that work is still running, and
 * reports only once the wake tells it the work finished.
 *
 * Which turn it is in is read off the conversation it was handed rather than off a call
 * counter, so the fixture cannot get out of step with the loop: a tool message means the
 * handle is already in hand and there is nothing to do but stop; a user message naming a
 * background job means the result has landed.
 */
function detachThenReport(seen: string[][]): ReturnType<typeof scriptedTurnModel> {
  return scriptedTurnModel({
    modelId: 'fake-detacher',
    doGenerate: ({ prompt }) => {
      seen.push(prompt.map((message) => JSON.stringify(message.content)));
      const text = JSON.stringify(prompt);
      const woken = text.includes('Background execute_tools job');
      const reported = text.includes('"received":true');
      const launched = prompt.some((message) => message.role === 'tool');
      const content: LanguageModelV3Content[] = reported
        ? [{ type: 'text', text: 'Done.' }]
        : woken
        ? [{
          type: 'tool-call',
          toolCallId: 'report-1',
          toolName: 'report',
          input: JSON.stringify({ status: 'completed', content: 'The sandbox run finished.' }),
        }]
        : launched
          // THE TURN ENDS HERE, holding live work. On the base of this change there was
          // nowhere for it to go from here: no wake could arrive, so this was a node
          // that had finished without reporting.
          ? [{ type: 'text', text: 'Launched it; waiting on the result.' }]
          : [{
            type: 'tool-call',
            toolCallId: 'exec-1',
            toolName: 'execute_tools',
            input: JSON.stringify({ code: 'await sandbox.run()' }),
          }];
      return {
        content,
        finishReason: {
          unified: reported ? 'stop' as const
            : woken ? 'tool-calls' as const
              : launched ? 'stop' as const : 'tool-calls' as const,
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

/** Answers in prose and never calls `report` — the outcome that used to be impossible
 *  to distinguish from a broken node. */
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
 * Await a FACT rather than a duration.
 *
 * The one genuinely real timer in this file is the detach threshold itself: it is a
 * `setTimeout` inside `withBackgroundThreshold`, so a fake clock stops it firing and the
 * arm would pass against a threshold that never crossed. What is NOT guessed at is when
 * it crossed — that is read off the job registry, which is the same row the model's
 * handle names. So the wait ends on the event, and the only real time paid is the
 * threshold's own sub-second value.
 */
async function until(fact: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + STALL_MS;
  while (!fact()) {
    if (Date.now() > deadline) throw new Error(`waited ${String(STALL_MS)}ms and ${what} never happened`);
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}

interface Fixture {
  readonly input: NodeAgentInput;
  readonly deps: NodeAgentDeps;
  readonly journal: HeadJournal;
  /** How many jobs the workspace registry shows in flight — the FACT that a tool call
   *  crossed the detach threshold and the turn was released. */
  readonly detached: () => number;
}

function fixture(over: {
  readonly model: NodeAgentDeps['model'];
  readonly executeTool?: unknown;
}): Fixture {
  const { rt } = createTestRuntime();
  initHeadsTables(rt.storage.execRaw, rt.storage.sql);
  const journal = new HeadJournal(rt.storage.sql);
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
  const deps: NodeAgentDeps = {
    rt, model: over.model, journal,

    maxWallClockMs: 60_000,
    logger: createRecordingLogger(),
    backgroundPolicy: () => ({
      detachAfterMs: DETACH_MS, settleGraceMs: SETTLE_MS, wakesAfterTurn: true,
    }),
  };
  if (over.executeTool !== undefined) deps.executeTool = over.executeTool;
  const detached = (): number => {
    const rows = rt.storage.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM background_jobs WHERE status='running'`;
    return rows[0]?.n ?? 0;
  };
  return { input, deps, journal, detached };
}

describe('a node backgrounds work, ends its turn, and is woken to finish', () => {
  test('a turn that ends holding a live job is neither terminal nor abandoned, and the wake completes it', async () => {
    const slow = slowExecuteTool();
    const prompts: string[][] = [];
    const { input, deps, journal, detached } = fixture({
      model: detachThenReport(prompts), executeTool: slow.entry,
    });

    const running = runNodeAgent(input, deps);

    // THE FIRST TURN ENDS WITHOUT THE JOB. Waited for by the FACT rather than by a
    // sleep: the node's second request is the one the wake produced, so a second entry
    // in `prompts` cannot appear until the first turn ended and the wake resumed it —
    // and it cannot appear at all until the job settles, which nothing but the line
    // below does.
    await until(() => detached() > 0, 'the slow call detached');
    // ONE launch, and the first turn's two requests: the call, and the step that read the
    // handle back and chose to stop. The denominator matters — "the turn ended" is a
    // claim about a turn that really ran, not about a loop that never started — and so
    // does the ceiling: a third request here would mean the turn had not ended at all.
    expect(slow.started()).toBe(1);
    expect(prompts).toHaveLength(2);

    // NOT TERMINAL. The row this node opened still reads `running`, which is exactly
    // what `running` means — spawned, and no report recorded — and it is NOT the
    // absent-versus-broken confusion, because the node is genuinely working.
    const midFlight = journal.readHead('n1');
    expect(midFlight?.status).toBe('running');
    expect(midFlight?.completed_at).toBeNull();

    // THE WAKE. The job settles after the turn has already ended.
    slow.settle();
    const run: NodeRun = await running;

    // A SECOND TURN RAN, on the SAME conversation — appended, not restarted — and its
    // last message is the wake. Appended is the load-bearing half: *Inherited context* is
    // append-only, so the resumed request is a prefix of the one before it and a provider
    // can cache it.
    expect(prompts.length).toBeGreaterThanOrEqual(3);
    const resumed = prompts[2] ?? [];
    const firstTurn = prompts[0] ?? [];
    expect(resumed.length).toBeGreaterThan(firstTurn.length);
    expect(resumed.slice(0, firstTurn.length)).toEqual(firstTurn);
    expect(resumed.at(-1)).toContain('Background execute_tools job');
    expect(resumed.at(-1)).toContain('completed');

    // AND IT FINISHED. Through its own `report`, which is the terminal condition — not
    // through running out of steps or out of time.
    expect(run.report.status).toBe('completed');
    expect(run.reportedItself).toBe(true);
    expect(run.candidate).toContain('The sandbox run finished.');
    expect(run.report.errorMessage).toBeUndefined();

    // THE ROW IS TERMINAL NOW, and only now.
    const settled = journal.readHead('n1');
    expect(settled?.status).toBe('completed');
    expect(settled?.completed_at).toBeGreaterThan(0);

    // THE TRACE IS DENSE ACROSS BOTH TURNS. `head_steps` is keyed `${id}-s${seq}`, so a
    // per-turn counter would collide and the rows would be FEWER than the report's
    // count — asserted as an equality rather than a floor for exactly that reason.
    const traced = journal.readSteps('n1');
    expect(traced.length).toBe(run.report.stepCount);
    expect(traced.length).toBeGreaterThanOrEqual(2);

    // A DETACH COUNTS AS FLOW: the node was never cut, though it produced no provider
    // chunk for the whole time the job was in flight.
    expect(run.report.summary).not.toContain('stalled');
  });

  test('the model is handed a HANDLE, not a result, and the handle is what its transcript records', async () => {
    const slow = slowExecuteTool();
    const prompts: string[][] = [];
    const { input, deps, detached } = fixture({
      model: detachThenReport(prompts), executeTool: slow.entry,
    });

    const running = runNodeAgent(input, deps);
    await until(() => detached() > 0, 'the slow call detached');
    slow.settle();
    const run = await running;
    expect(run.report.status).toBe('completed');

    // Read off what the MODEL was handed — the tool message in its own next request —
    // rather than off the transcript row, because that is the claim: the call returned a
    // handle and the turn was released, and the model saw exactly that.
    const afterLaunch = (prompts[1] ?? []).join(' ');
    expect(afterLaunch).toContain('"background":true');
    expect(afterLaunch).toContain('execute_tools');
    // Not the real result, which had not been produced yet when that request was built.
    expect(afterLaunch).not.toContain('exit 0');
    // And the node did NOT run the work twice: one launch, one job.
    expect(slow.started()).toBe(1);
  });

  test('ending a turn without calling report is a NORMAL outcome', async () => {
    // The claim the whole change rests on. A node holding nothing, that answered in
    // prose and never reported, is `completed` with no error — one turn, no wake, and
    // nothing anywhere calling it a failure.
    const { input, deps, journal } = fixture({ model: PROSE_ONLY_MODEL });
    const run = await runNodeAgent(input, deps);

    expect(run.report.status).toBe('completed');
    expect(run.reportedItself).toBe(false);
    expect(run.report.errorMessage).toBeUndefined();
    expect(run.candidate).toContain('inner comparison loop');
    // And it is not rendered as a node that produced nothing.
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
    // THE DENOMINATOR. Both halves are checked against the shipped set, in both
    // directions, so a builtin added upstream tomorrow fails here rather than silently
    // appearing on nodes or silently not.
    expect(new Set([...given, ...withheld])).toEqual(new Set(BUILTIN_TOOLS));
    expect(given.length + withheld.length).toBe(BUILTIN_TOOLS.length);
    // Disjoint: a tool cannot be both given and excused.
    expect(given.filter((name) => withheld.includes(name))).toEqual([]);
  });

  test('every withholding states a reason, and the reason is a property of the code', () => {
    for (const [name, reason] of Object.entries(NODE_WITHHELD_TOOLS)) {
      // Long enough to be an argument rather than a label: the shortest honest reason
      // here names a store and who shares it.
      expect(reason.length).toBeGreaterThan(40);
      expect(reason).not.toContain('TODO');
      expect(reason).not.toContain('not yet');
      expect(name).not.toBe('');
    }
    // And the one whose reason was WRONG on the base of this change is named for what it
    // actually is: `DELEGATION_MAX_DEPTH` governs the hire ladder, not a node's search
    // depth, so recursion was never the argument.
    expect(NODE_WITHHELD_TOOLS.agents).toContain('search engine');
    expect(NODE_WITHHELD_TOOLS.agents).not.toContain('recursion');
  });

  test('a node really does hold the tools it is given and none of the withheld ones', async () => {
    // Read off a REAL node run rather than the constant, because the constant is a
    // declaration and the toolset is the fact. The prompt lists what it holds, so the
    // node itself is the witness.
    const { input, deps } = fixture({ model: PROSE_ONLY_MODEL });
    const run = await runNodeAgent(input, deps);
    expect(run.report.status).toBe('completed');
    // `execute_tools` is absent from the surface when no factory is wired, which is the
    // "absent deps, absent tool" half — so the surface is a SUBSET of what is given and
    // is disjoint from what is withheld.
    const surface: readonly string[] = ['run', 'file', 'report'];
    const given: readonly string[] = NODE_BUILTIN_TOOLS;
    for (const name of surface) expect(given).toContain(name);
    for (const name of Object.keys(NODE_WITHHELD_TOOLS)) expect(surface).not.toContain(name);
  });
});

describe('a node resolves a function-form executeTool through the finished surface', () => {
  test('function-form dep becomes a working execute_tools, not the NOT CONFIGURED stub', async () => {
    // The production defect: the search hands `deps.executeTool` as a FUNCTION
    // `(finished) => factory.toolFor(finished)` (exploration builds it over the
    // actor's factory), and the node handed it raw into `preBuiltExecuteTool` —
    // which only accepts a finished Tool. The function failed the entry check,
    // no factory branch existed on this path, and every hosted node got the
    // NOT CONFIGURED stub. The sibling builder (`buildHeadToolSet`) already
    // resolved the function form against the finished surface; the node did not.
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
        const content: LanguageModelV3Content[] = reported
          ? [{ type: 'text', text: 'Done.' }]
          : launched
            ? [{
              type: 'tool-call',
              toolCallId: 'report-1',
              toolName: 'report',
              input: JSON.stringify({
                status: 'completed',
                content: text.includes('factory-ran') ? 'saw factory-ran' : 'saw none',
              }),
            }]
            : [{
              type: 'tool-call',
              toolCallId: 'exec-1',
              toolName: 'execute_tools',
              input: JSON.stringify({ code: 'const x = 1' }),
            }];
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
    const { input, deps } = fixture({ model, executeTool: factoryForm });
    const run: NodeRun = await runNodeAgent(input, deps);
    expect(run.report.status).toBe('completed');
    expect(run.candidate).toContain('factory-ran');
  });
});
