/**
 * §8 of docs/EVOLUTION-REDESIGN.md, run against the eval deployment: `bun run evals:reactive`. KINU_REACTIVE_SEGMENTS
 * (200), KINU_REACTIVE_SEEDS (3), KINU_REACTIVE_FAMILIES (every task) and KINU_REACTIVE_HELD_OUT (the last family) shape
 * it; KINU_EVAL_MODELS names the model.
 * Learning on is held against learning off (dreaming), and against crafting off (crafted tools).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'vitest';
import { evalMatrix } from '../src/config';
import { collectEvalTasks } from '../src/eval';
import { learningVerdict, REACTIVE_ARMS, reactivePlan, type ArmRun } from '../src/reactive';
import { renderThrownChain } from '../../packages/core/src/obs/index';
import { runArm } from '../src/reactive-run';
import { trialSlot } from '../src/slot';
import { ARMS, resolveEvalTarget } from '../src/target';

test('learning on beats learning off', async () => {
  const env = process.env;
  const segments = Number(env.KINU_REACTIVE_SEGMENTS ?? '200');
  const seeds = Number(env.KINU_REACTIVE_SEEDS ?? '3');
  const matrix = { ...evalMatrix(env, ARMS.map((arm) => arm.id)), arms: [...REACTIVE_ARMS], trials: seeds };
  const [model] = matrix.models;
  const target = resolveEvalTarget(env);
  const tasks = new Map((await collectEvalTasks()).map((task) => [task.id, task]));
  const families = (env.KINU_REACTIVE_FAMILIES?.split(',') ?? [...tasks.keys()]).sort();
  const unknown = families.filter((family) => !tasks.has(family));

  if (unknown.length > 0) throw new Error(`KINU_REACTIVE_FAMILIES names ${unknown.join(', ')}; the tasks are ${[...tasks.keys()].join(', ')}`);
  const heldOut = env.KINU_REACTIVE_HELD_OUT ?? families.at(-1);

  if (model === undefined || heldOut === undefined) throw new Error('KINU_EVAL_MODELS names no model, or no task is declared');
  const runs: { on: ArmRun; off: ArmRun; craftingOff: ArmRun; heldOut: string }[] = [];
  const arms: ArmRun[] = [];

  for (let seed = 1; seed <= seeds; seed++) {
    const plan = reactivePlan(families, segments, seed, heldOut);
    const runner = basename(import.meta.filename);

    // Each arm apart: one that cannot open, or stops, is recorded with why, and the others run on.
    const settled = await Promise.allSettled(REACTIVE_ARMS.map((arm) => runArm({
      target, model, arm, seed, plan, tasks,
      account: trialSlot({ taskFiles: [runner], task: runner, matrix, model, arm, trial: seed }),
    })));

    const [on, off, craftingOff] = settled.map((result, at): ArmRun => (result.status === 'fulfilled' ? result.value : {
      arm: REACTIVE_ARMS[at] ?? 'unknown', seed, segments: [], lastSatisfaction: null, spend: null, error: renderThrownChain({ cause: result.reason }),
    }));

    arms.push(...[on, off, craftingOff].filter((arm) => arm !== undefined));

    // Only a seed every arm ran to its end is judged.
    if (on !== undefined && off !== undefined && craftingOff !== undefined && [on, off, craftingOff].every((arm) => arm.error === undefined)) {
      runs.push({ on, off, craftingOff, heldOut });
    }
  }

  const verdict = learningVerdict(runs);
  const crafting = learningVerdict(runs.map((run) => ({ on: run.on, off: run.craftingOff, heldOut: run.heldOut })));
  const out = join(env.BENCH_ARTIFACTS ?? tmpdir(), `reactive-${String(Date.now())}.json`);
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ arms, runs, verdict, crafting }, null, 2)}\n`);

  for (const arm of arms.filter((ran) => ran.error !== undefined)) {
    process.stdout.write(`[reactive] ${arm.arm} seed ${String(arm.seed)} stopped after ${String(arm.segments.length)} segments: ${arm.error ?? ''}\n`);
  }

  process.stdout.write(`[reactive] ${verdict.wins ? 'learning wins' : 'learning does not win'}: ${JSON.stringify(verdict)}\n`);
  process.stdout.write(`[reactive] ${crafting.wins ? 'crafting wins' : 'crafting does not win'}: ${JSON.stringify(crafting)}; evidence ${out}\n`);
});
