/** The reactive-user eval's arms against the eval deployment (docs/EVOLUTION-REDESIGN.md §8); `evals/reactive/` runs them. */
import type { RunEvent } from '@kinu.run/core';
import { Seeded } from '../tasks/seeded';
import { runTurn } from './harness';
import { LAST_SEGMENTS, reactiveReply, THUMB_RATE, type ArmRun, type SegmentResult } from './reactive';
import type { KinuPublicSession } from './session';
import { ARMS, openWorkspace, type EvalTarget } from './target';
import type { EvalTask, EvalTurn } from './task';
import { TrialTimeline } from './timeline';
import { measure } from './transcript';

const newRuns = (events: readonly RunEvent[], before: ReadonlySet<string>) => events.filter((event) => !before.has(event.runId));

/** One task in a fresh conversation (a cold cache, so a new segment): each turn answered until it passes or the user gives up. */
export async function runSegment(session: KinuPublicSession, task: EvalTask, rng: Seeded, say: (line: string) => void): Promise<SegmentResult> {
  const timeline = new TrialTimeline();
  await session.abortActivation();
  session.disconnect();
  await session.connect();
  await session.clearConversation();
  await session.setMission(task.mission);
  const before = new Set((await session.runEvents()).map((event) => event.runId));
  const hooks = { stepped: () => {}, watching: { waiting: say } };
  let replies = 0;
  let thumbs = 0;
  let passed = true;

  for (const turn of task.turns) {
    let ask: EvalTurn = turn;

    for (let attempt = 0; ; attempt++) {
      const result = await runTurn(session, ask, timeline, hooks);
      const failed = result.outcome.status === 'completed' ? result.checks.filter((check) => !check.pass).map((check) => check.id) : [result.outcome.status];
      replies += 1;

      if (rng.next() < THUMB_RATE) thumbs += await thumb(session, failed.length === 0);
      const next = reactiveReply(turn.prompt, failed, attempt);

      if (failed.length === 0) break;

      if (next === null) {
        passed = false;
        break;
      }

      // A correction or a repeat rewrites no seeded file: the agent's work stays where it left it.
      ask = { prompt: next, ...(turn.verify !== undefined && { verify: turn.verify }) };
    }

    if (!passed) break;
  }

  const metrics = measure(newRuns(await session.runEvents(), before));

  return { family: task.id, passed, replies, toolErrors: metrics.toolErrors, steps: metrics.modelTurns, thumbs };
}

async function thumb(session: KinuPublicSession, up: boolean): Promise<number> {
  const answer = [...await session.history()].reverse().find((row) => row.role === 'assistant');

  if (answer?.id === undefined) return 0;
  await session.rate(answer.id, up ? 'positive' : 'negative');

  return 1;
}

/** Mean rated satisfaction and how many ratings, over every day the Quality tab reads. */
async function satisfaction(session: KinuPublicSession): Promise<{ sum: number; n: number }> {
  return (await session.quality(30)).reduce((total, day) => ({
    sum: total.sum + day.satisfaction.mean * day.satisfaction.n, n: total.n + day.satisfaction.n,
  }), { sum: 0, n: 0 });
}


/** One arm over the plan in one persistent workspace, so what it learns carries from segment to segment. */
export async function runArm(input: {
  readonly target: EvalTarget;
  readonly model: string;
  readonly arm: 'learning-on' | 'learning-off';
  readonly seed: number;
  readonly plan: readonly string[];
  readonly tasks: ReadonlyMap<string, EvalTask>;
}): Promise<ArmRun> {
  const say = (line: string) => process.stdout.write(`[reactive] ${input.arm} seed ${String(input.seed)}: ${line}\n`);
  const session = await openWorkspace(input.target, { subject: `reactive-${input.arm}-${String(input.seed)}`, mission: 'Help with each task as it comes.', model: input.model });
  const rng = new Seeded(input.seed * 7919 + (input.arm === 'learning-on' ? 1 : 2));
  const segments: SegmentResult[] = [];
  let mid = { sum: 0, n: 0 };

  try {
    await ARMS.find((arm) => arm.id === input.arm)?.apply(session);

    for (const [at, family] of input.plan.entries()) {
      const task = input.tasks.get(family);

      if (task === undefined) throw new Error(`no task named ${family}`);

      if (at === input.plan.length - LAST_SEGMENTS) mid = await satisfaction(session);
      const segment = await runSegment(session, task, rng, say);
      segments.push(segment);
      say(`segment ${String(at + 1)} of ${String(input.plan.length)}, ${family}: ${segment.passed ? 'passed' : 'failed'} in ${String(segment.replies)} replies`);
    }

    const end = await satisfaction(session);
    const rated = end.n - mid.n;

    return { arm: input.arm, seed: input.seed, segments, lastSatisfaction: rated > 0 ? (end.sum - mid.sum) / rated : null, spend: await session.spend() };
  } finally {
    await session.teardown();
  }
}
