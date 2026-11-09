// The Minecraft benchmark's control trial (evals/tasks/minecraft.ts): its turn, on a box prepared as the benchmark's, run
// by the scripted agent that tries each way around playing by hand (scripts/minecraft-control-script.ts), then a page off
// the game opened as a link would. It passes when every try was refused at the box or did nothing and the trial failed:
//   KINU_EVAL_ORIGIN=https://staging.kinu.run KINU_EVAL_STAGING_WEB_IDENTITY=... KINU_SCRIPTED_MODEL_KEY=... \
//     bun evals/scripts/minecraft-control.ts [--out <dir>]
// It acts as a trial account it leases (evals/src/lease.ts), deleted as it ends.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import * as v from 'valibot';
import { parseEvalAccount } from '@kinu.run/core';
import { SCRIPTED_MODEL_KEY_ENV, SCRIPTED_MODEL_ORIGIN, SCRIPTED_MODEL_SPEC } from '../../packages/test-utils/src/scripted-model-spec';
import { registerScriptedModel } from '../../scripts/scripted-model';
import { MINECRAFT_CONTROL } from '../../scripts/minecraft-control-script';
import { runTurn } from '../src/harness';
import { onTrialBlock, prepareTrialAccount, signInTrialAccount } from '../src/slot';
import { leaseBlock } from '../src/lease';
import { kinuArmada, liveClaims } from '../../scripts/evals-lease';
import { openWorkspace, resolveEvalTarget } from '../src/target';
import { TrialTimeline } from '../src/timeline';
import { webHeaders } from '../src/workspace-roster';
import { controlShortfalls, MINECRAFT_MISSION, minecraftTower, OPEN_ELSEWHERE } from '../tasks/minecraft';

const { values } = parseArgs({ options: { out: { type: 'string' } } });

const key = process.env[SCRIPTED_MODEL_KEY_ENV] ?? '';

if (key === '') throw new Error(`${SCRIPTED_MODEL_KEY_ENV} is not set, so the scripted model would refuse the control's every call`);

const base = resolveEvalTarget(process.env);

// Its account is leased as every eval run's is (evals/src/lease.ts), and deleted as it ends (`onTrialBlock`).
const lease = await leaseBlock({ size: 1, pass: true, hosts: [new URL(base.origin).host], liveClaims: async () => liveClaims(kinuArmada()) });

const account = parseEvalAccount(`trial-${String(lease.first)}`);

if (account === null) throw new Error(`trial-${String(lease.first)} is not an eval account`);

const target = { ...base, identity: { ...base.identity, account } };

const say = (line: string): void => { process.stdout.write(`[minecraft-control] ${line}\n`); };

await onTrialBlock(lease, { targets: [target] }, async () => {
  // Signed in first: an account a run before this one deleted is made again only so, never by a read.
  const unsigned = await signInTrialAccount(target);

  if (unsigned !== null) throw new Error(unsigned);
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
});
