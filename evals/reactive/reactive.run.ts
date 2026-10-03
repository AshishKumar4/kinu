/**
 * §8 of docs/EVOLUTION-REDESIGN.md, run against the eval deployment: `bun run evals:reactive`. KINU_REACTIVE_SEGMENTS
 * (200), KINU_REACTIVE_SEEDS (3) and KINU_REACTIVE_HELD_OUT (the last family) shape it; KINU_EVAL_MODELS names the model.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'vitest';
import { evalMatrix } from '../src/config';
import { collectEvalTasks } from '../src/eval';
import { learningVerdict, reactivePlan } from '../src/reactive';
import { runArm } from '../src/reactive-run';
import { ARMS, resolveEvalTarget } from '../src/target';

test('learning on beats learning off', async () => {
  const env = process.env;
  const segments = Number(env.KINU_REACTIVE_SEGMENTS ?? '200');
  const seeds = Number(env.KINU_REACTIVE_SEEDS ?? '3');
  const [model] = evalMatrix(env, ARMS.map((arm) => arm.id)).models;
  const target = resolveEvalTarget(env);
  const tasks = new Map((await collectEvalTasks()).map((task) => [task.id, task]));
  const families = [...tasks.keys()].sort();
  const heldOut = env.KINU_REACTIVE_HELD_OUT ?? families.at(-1);

  if (model === undefined || heldOut === undefined) throw new Error('KINU_EVAL_MODELS names no model, or no task is declared');
  const runs = [];

  for (let seed = 1; seed <= seeds; seed++) {
    const plan = reactivePlan(families, segments, seed, heldOut);
    const [on, off] = await Promise.all((['learning-on', 'learning-off'] as const).map((arm) => runArm({ target, model, arm, seed, plan, tasks })));

    if (on !== undefined && off !== undefined) runs.push({ on, off, heldOut });
  }

  const verdict = learningVerdict(runs);
  const out = join(env.BENCH_ARTIFACTS ?? tmpdir(), `reactive-${String(Date.now())}.json`);
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ runs, verdict }, null, 2)}\n`);
  process.stdout.write(`[reactive] ${verdict.wins ? 'learning wins' : 'learning does not win'}: ${JSON.stringify(verdict)}; evidence ${out}\n`);
});
