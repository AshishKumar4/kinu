import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import { parseRefusal } from '@kinu.run/core';
import type { EvalObservation } from '@kinu.run/test-utils';
import { FIRST_RUN_DEFECTS, publishFirstRunRecord, runFirstRunCase, type FirstRunSubgoal } from './first-run';
import { operatorFirstRunPlan } from './operator-session';

const CASE = 'command-refusal';
const SUITE = 'First-run · command-refusal (CLI operator, no model)';
const PLAN = operatorFirstRunPlan();
const observations: EvalObservation[] = [];
const Exec = v.object({ stdout: v.string(), exitCode: v.number() });
const Answer = v.object({ ok: v.literal(true), value: v.string() });
const Queue = v.array(v.object({ command: v.string(), status: v.string(), executor: v.string() }));

afterAll(() => publishFirstRunRecord(SUITE, [CASE], observations, 'no-model'));

describe(SUITE, () => {
  test.skipIf(PLAN === null)('MEASURED: command-refusal', async () => {
    if (PLAN === null) throw new Error('Explicit operator plan required');
    let calls = 0;
    await runFirstRunCase(PLAN, {
      id: CASE, modelCalls: 'none', purpose: 'Disposable command-boundary verification; no model task.', calls: () => calls,
      async run({ session }) {
        const exec = async (command: string) => {
          calls += 1;
          return v.parse(Exec, await session.rpc('executeInExecutor', ['workspace', command]));
        };
        const setup = await exec(`mkdir -p /home/user/slates/gate
cat > /home/user/slates/gate/package.json <<'END'
{"main":"server.js","slate":{"bindings":{"FILES":{"kind":"namespace","namespace":"workspace","members":["exec"]}}}}
END
cat > /home/user/slates/gate/server.js <<'END'
export default { async fetch(request, env) { const [command] = await request.json(); return Response.json(await env.FILES.exec(command)); } };
END`);
        if (setup.exitCode !== 0) throw new Error('Could not author test slate: ' + setup.stdout);
        const command = 'printf executed > /home/user/first-run-command-effect; npm publish --dry-run';
        const goals: FirstRunSubgoal[] = [];
        for (const policy of ['deny_all', 'strict']) {
          await session.rpc('setShellApprovalMode', [policy]);
          const expected = policy === 'deny_all' ? 'denied' : 'unavailable';
          const direct = await exec(command);
          calls += 1;
          // This particular authored app returns the executor's declared TEXT
          // channel. Generic app/binding success is not inferred from its bytes.
          const binding = v.parse(Answer, await session.rpc('slate', [{ op: 'call', id: 'gate', method: 'exec', args: [command] }]));
          const marker = await exec('if test -e /home/user/first-run-command-effect; then printf present; else printf absent; fi');
          goals.push(
            { what: policy + '-executor-class', reached: parseRefusal(direct.stdout)?.reason === expected,
              detail: JSON.stringify({ deployedSha: session.deployedSha, expected, actual: direct }) },
            { what: policy + '-binding-text-class', reached: parseRefusal(binding.value)?.reason === expected,
              detail: JSON.stringify({ expected, text: binding.value }) },
            { what: policy + '-did-not-execute', reached: marker.exitCode === 0 && marker.stdout === 'absent', detail: JSON.stringify(marker) },
          );
        }
        const queued = v.parse(Queue, await session.rpc('listDeferredApprovals'));
        goals.push({ what: 'one-existing-approval-queue', reached: queued.length === 1 && queued[0]?.command === command
          && queued[0]?.status === 'queued' && queued[0]?.executor === 'workspace', detail: JSON.stringify(queued) });
        // Do not decide it: a decision wakes the model. Deleting this fresh
        // workspace in the runner's finally removes its pending queue as well.
        return goals;
      },
    }, observations);
  });
});

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
