/**
 * FIRST RUN: a swarm the agent starts runs its nodes as hosted agents, settles,
 * and shows on the Swarms pane.
 *
 * THE ASK. Exploration on the deployed product: the agent reaches for a swarm
 * through its `agents` tool, the swarm's nodes run as agents of the workspace
 * (docs/EXPLORATION.md, "A node is an agent"), every node settles, and the run
 * reads back on the Swarms pane with each node's transcript, through
 * `getExplorationCanvas`, the read the pane makes.
 *
 * THE SMALLEST SEARCH THE PRODUCT RUNS. `ideate` is a flat wave of five
 * answering nodes with no value signal. Every swarm deeper than one level needs
 * a measured objective or a judge of at least twenty samples per node
 * (`judgeMarginalisationRefusal`), so a tree of uneven depth is the subordinate
 * tree's row (`delegation-tree`), not this one.
 *
 * THE ONLY SWARM ON THE DEPLOYMENT. The retired eval tier's swarm arm asserted
 * only that a search row existed; it read neither the pane nor whether the
 * nodes settled.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { isBackgroundHandle, ORCHESTRATOR_AGENT_SLUG, type RunEvent } from '../../packages/core/src/index';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase, type FirstRunSession,
} from './first-run';
import { SWARM_ASK as ASK } from './asks';
import { openBrowser, signedInPage } from './browser';
import type { TestChrome } from '../../scripts/test-chrome';
import { ask, openPublicSocket, rpcDetail, type PublicSocket } from './public-socket';

const SUITE = 'First-run · exploration';

const CASE = 'exploration' as const;

/** The lowercase words of `text`. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^a-z]+/u).filter((word) => word.length > 2);
}

/** The words the ask itself put in every node's mouth, which prove nothing. */
const ASKED = new Set(wordsOf(ASK));

const PLAN = firstRunCasePlan(SUITE, CASE);

const PanelAgentSchema = v.looseObject({
  key: v.string(), category: v.string(), activity: v.string(), tab: v.boolean(),
  open: v.looseObject({ kind: v.string() }),
});

interface OpenedWorker {
  readonly counter: string;
  readonly stream: string;
  readonly composer: boolean;
  readonly stop: boolean;
}

async function openWorkerFromPanel(browser: TestChrome, plan: { origin: string; identity: Parameters<typeof signedInPage>[1] }, workspace: string, key: string): Promise<OpenedWorker> {
  const page = await signedInPage(browser.browser, plan.identity);
  await page.goto(`${plan.origin}/workspace/${encodeURIComponent(workspace)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-agents-counter]');
  const counter = await page.$eval('[data-agents-counter]', (button) => button.getAttribute('aria-label') ?? '');
  await page.click('[data-agents-counter]');
  await page.waitForSelector(`[data-agent-row="${key}"]`);
  await page.click(`[data-agent-row="${key}"]`);
  const pane = `[data-agent-pane="node/${key}"]`;
  await page.waitForFunction((selector: string) => (document.querySelector(selector)?.textContent ?? '').includes('Task'), {}, pane);

  const drawn = await page.$eval(pane, (node) => ({
    stream: node.textContent ?? '',
    composer: node.querySelector('textarea') !== null,
    stop: node.querySelector('[data-view-only]') !== null,
  }));

  return { ...drawn, counter };
}

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

const SwarmArgsSchema = v.looseObject({ action: v.literal('swarm') });

const HeadSchema = v.looseObject({
  id: v.string(), depth: v.number(), status: v.string(), summary: v.nullable(v.string()), lastStepAt: v.nullable(v.number()),
});

const CanvasSchema = v.looseObject({
  items: v.array(v.looseObject({
    run: v.looseObject({ id: v.string(), status: v.string(), hasNodeTranscripts: v.boolean(), branches: v.number() }),
    head: v.nullable(v.looseObject({ heads: v.array(HeadSchema) })),
  })),
});

/**
 * THE WAKE IS THE BOUND. A detached swarm reports in a turn whose opening
 * message names its job; wait for that turn to close, one done frame at a
 * time, and the case budget ends a wake that never comes.
 */
async function swarmWakeClosed(session: FirstRunSession, socket: PublicSocket, job: string): Promise<void> {
  const closed = async (): Promise<boolean> => {
    const events = await session.runEvents();
    const wakes = events.filter((event) => event.type === 'run_start' && event.userMessage?.includes(job) === true);

    return wakes.length > 0 && wakes.every((wake) => events.some((end) => end.type === 'run_end' && end.runId === wake.runId));
  };

  for (let next = socket.turnClosed(); !(await closed()); next = socket.turnClosed()) {
    if (!(await next)) return;
  }
}

/** The Agents panel lists every node, one opens in the chat column read-only, and the counter is the roster's. */
async function panelSubgoal({ socket, opened }: { socket: PublicSocket; opened: boolean }, plan: Parameters<typeof openWorkerFromPanel>[1], workspace: string, nodes: number): Promise<EvalSubgoal> {
  if (!opened) return { what: 'panel-opens-a-worker-read-only', reached: false, detail: 'the workspace socket never opened' };
  const listed = await ask(socket, 'listWorkspaceAgents', []);
  const agents = listed.ok ? v.safeParse(v.array(PanelAgentSchema), listed.value) : null;
  const rows = agents?.success === true ? agents.output : [];
  const workers = rows.filter((agent) => agent.category === 'swarm');
  const hidden = rows.filter((agent) => ['working', 'waiting'].includes(agent.activity) && !agent.tab).length;
  const worker = workers[0];
  let browser: TestChrome | null = null;

  try {
    browser = await openBrowser();
    const drawn = worker === undefined ? null : await openWorkerFromPanel(browser, plan, workspace, worker.key);

    if (drawn === null) {
      return { what: 'panel-opens-a-worker-read-only', reached: false, detail: `the panel listed ${String(workers.length)} swarm worker(s) for ${String(nodes)} node(s)` };
    }

    const counted = Number(/(\d+) active/u.exec(drawn.counter)?.[1] ?? 0);

    return {
      what: 'panel-opens-a-worker-read-only',
      reached: workers.length === nodes && !drawn.composer && drawn.stop && drawn.stream.includes('Task') && counted === hidden,
      detail: `${String(workers.length)} worker(s) listed; ${worker?.key ?? ''} drew ${String(drawn.stream.length)} chars, `
        + `composer ${String(drawn.composer)}, view-only bar ${String(drawn.stop)}; counter "${drawn.counter}" against ${String(hidden)} hidden active`,
    };
  } finally {
    await browser?.close();
  }
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      modelCalls: 'expected',
      genesis: false,
      purpose: 'An assistant that uses the search it is asked to use and reports what it found in one line.',
      async run({ session, plan, budget }) {
        const subgoals: EvalSubgoal[] = [];
        // Open before the ask: a swarm detaches once it spawns, and its report
        // arrives as a wake turn whose done frame this tab must be there to see.
        const socket = openPublicSocket(plan.origin, plan.identity, `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(session.workspace)}`, budget);

        try {
          const opened = await socket.opened;

          await session.prompt(ASK);

          const swarms = (await session.runEvents())
            .filter((event): event is ToolCallEnd => event.type === 'tool_call_end' && event.name === 'agents')
            .filter((call) => v.safeParse(SwarmArgsSchema, call.args).success);

          const answered = swarms.find((call) => call.error === undefined && call.outcome?.success !== false);

          subgoals.push({
            what: 'swarm-started',
            reached: answered !== undefined,
            detail: answered !== undefined
              ? `agents#${answered.toolCallId} (swarm) answered`
              : `${String(swarms.length)} swarm call(s), none answered: ${swarms.map((call) => (call.error ?? JSON.stringify(call.outcome ?? null)).slice(0, 160)).join('; ') || 'no swarm call'}`,
          });

          if (opened && isBackgroundHandle(answered?.result)) await swarmWakeClosed(session, socket, answered.result.jobId);

          const answer = opened ? await ask(socket, 'getExplorationCanvas', []) : null;
          const canvas = answer?.ok === true ? v.safeParse(CanvasSchema, answer.value) : null;
          const [entry] = canvas?.success === true ? canvas.output.items : [];
          const heads = entry?.head?.heads ?? [];

          const detail = answer === null ? `${socket.path} refused the upgrade` : rpcDetail({
            rpc: 'getExplorationCanvas', answer, refusal: 'refused', said: canvas?.success === true ? `the pane reads ${JSON.stringify(entry?.run ?? null)}` : null,
          });

          subgoals.push({
            what: 'pane-shows-the-run',
            reached: entry !== undefined && entry.run.hasNodeTranscripts && heads.length === entry.run.branches && heads.length > 0,
            detail: `${detail}; ${String(heads.length)} node transcript(s)`,
          });

          const unsettled = heads.filter((head) => head.status !== 'completed' || head.summary === null || head.lastStepAt === null);

          subgoals.push({
            what: 'every-node-an-agent-that-settled',
            reached: heads.length > 0 && unsettled.length === 0 && entry?.run.status === 'completed',
            detail: unsettled.length === 0
              ? `${String(heads.length)} node(s) took steps and reported; the run is ${entry?.run.status ?? 'absent'}`
              : `${String(unsettled.length)} of ${String(heads.length)} node(s) unsettled: ${unsettled.map((head) => `${head.id.slice(0, 8)} ${head.status}`).join(', ')}`,
          });

          subgoals.push(await panelSubgoal({ socket, opened }, plan, session.workspace, heads.length));

          const reply = (await session.history()).filter((row) => row.role === 'assistant').at(-1)?.text.toLowerCase() ?? '';
          const named = [...new Set(heads.flatMap((head) => wordsOf(head.summary ?? '')))].filter((word) => !ASKED.has(word));
          const used = named.filter((word) => wordsOf(reply).includes(word));

          subgoals.push({
            what: 'reply-uses-the-nodes',
            reached: used.length > 0,
            detail: `the nodes named ${JSON.stringify(named.slice(0, 12))}; the reply ${used.length > 0 ? `names ${used.join(', ')}` : 'names none'}: ${JSON.stringify(reply.slice(0, 200))}`,
          });

          return subgoals;
        } finally {
          socket.close('the row is done');
        }
      },
    }, observations);
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules. */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
