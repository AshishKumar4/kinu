// The Minecraft benchmark's control trial (evals/tasks/minecraft.ts): its turn, on a box prepared as the benchmark's, run
// by the scripted agent that tries each way around playing by hand (scripts/minecraft-control-script.ts), then a page off
// the game opened as a link would. It passes when every try was refused at the box or did nothing and the trial failed:
//   KINU_EVAL_ORIGIN=https://staging.kinu.run KINU_EVAL_STAGING_WEB_IDENTITY=... KINU_SCRIPTED_MODEL_KEY=... \
//     bun evals/scripts/minecraft-control.ts [--out <dir>]
// It acts as the deployment's last trial account, which no sweep's matrix reaches.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import * as v from 'valibot';
import { EVAL_TRIAL_ACCOUNTS, parseEvalAccount } from '@kinu.run/core';
import { SCRIPTED_MODEL_KEY_ENV, SCRIPTED_MODEL_ORIGIN, SCRIPTED_MODEL_SPEC } from '../../packages/test-utils/src/scripted-model-spec';
import { registerScriptedModel } from '../../scripts/scripted-model';
import { MINECRAFT_CONTROL } from '../../scripts/minecraft-control-script';
import { runTurn } from '../src/harness';
import { prepareTrialAccount } from '../src/slot';
import { openWorkspace, resolveEvalTarget } from '../src/target';
import { TrialTimeline } from '../src/timeline';
import { webHeaders } from '../src/workspace-roster';
import { controlShortfalls, MINECRAFT_MISSION, minecraftTower, OPEN_ELSEWHERE } from '../tasks/minecraft';

const { values } = parseArgs({ options: { out: { type: 'string' } } });

const key = process.env[SCRIPTED_MODEL_KEY_ENV] ?? '';

if (key === '') throw new Error(`${SCRIPTED_MODEL_KEY_ENV} is not set, so the scripted model would refuse the control's every call`);

const account = parseEvalAccount(`trial-${String(EVAL_TRIAL_ACCOUNTS)}`);

if (account === null) throw new Error(`trial-${String(EVAL_TRIAL_ACCOUNTS)} is not an eval account`);

const base = resolveEvalTarget(process.env);

const target = { ...base, identity: { ...base.identity, account } };

const say = (line: string): void => { process.stdout.write(`[minecraft-control] ${line}\n`); };

await prepareTrialAccount(target, Date.now());

await registerScriptedModel(target.origin, SCRIPTED_MODEL_ORIGIN, webHeaders(target.identity), key);

const session = await openWorkspace(target, { subject: 'minecraft-control', mission: `${MINECRAFT_MISSION} ${MINECRAFT_CONTROL}`, model: SCRIPTED_MODEL_SPEC });

try {
  say(`workspace ${session.workspace} open on ${account}`);
  const turn = await runTurn(session, minecraftTower.turns[0], new TrialTimeline(), { stepped: (steps) => say(`step ${String(steps)}`), watching: { waiting: say } });
  const opened = await session.execute('computer', OPEN_ELSEWHERE);
  const visited = v.parse(v.array(v.string()), JSON.parse(opened.stdout ?? 'null'));
  const shortfalls = turn.outcome.status === 'completed' ? controlShortfalls(turn.checks, visited) : [`the control's turn ended ${turn.outcome.status}: ${turn.outcome.message ?? ''}`];
  const report = { workspace: session.workspace, outcome: turn.outcome, checks: turn.checks, visited, shortfalls };

  if (values.out !== undefined) {
    mkdirSync(values.out, { recursive: true });
    writeFileSync(join(values.out, 'minecraft-control.json'), `${JSON.stringify(report, null, 2)}\n`);
  }

  say(shortfalls.length === 0 ? 'every way around the hand was refused or did nothing, and the trial failed' : `shortfalls: ${shortfalls.join('; ')}`);
  process.exitCode = shortfalls.length === 0 ? 0 : 1;
} finally {
  await session.teardown();
}
