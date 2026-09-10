import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import { ERROR_CODES } from '@kinu.run/core/obs';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { FIRST_RUN_DEFECTS, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { operatorFirstRunPlan } from './operator-session';

const CASE = 'command-refusal';

const SUITE = 'First-run · command-refusal (CLI operator, no model)';

const PLAN = operatorFirstRunPlan();

const observations: EvalObservation[] = [];

const Refusal = v.object({ reason: v.picklist(ERROR_CODES), error: v.string() });

const Exec = v.object({ stdout: v.string(), exitCode: v.number(), refusal: v.optional(Refusal) });

const Answer = v.variant('ok', [
  v.object({ ok: v.literal(true), value: v.string() }),
  v.object({ ok: v.literal(false), reason: v.picklist(ERROR_CODES), error: v.string() }),
]);

const Queue = v.array(v.object({ command: v.string(), status: v.string(), executor: v.string() }));

afterAll(() => publishFirstRunRecord(SUITE, undefined, [CASE], observations));

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

        const call = async (command: string) => {
          calls += 1;

          return v.parse(Answer, await session.rpc('slate', [{ op: 'call', id: 'gate', method: 'exec', args: [command] }]));
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
        const goals: EvalSubgoal[] = [];

        for (const policy of ['deny_all', 'strict']) {
          await session.rpc('setShellApprovalMode', [policy]);
          const expected = policy === 'deny_all' ? 'denied' : 'unavailable';
          const direct = await exec(command);
          const binding = await call(command);
          const marker = await exec('if test -e /home/user/first-run-command-effect; then printf present; else printf absent; fi');
          goals.push(
            { what: policy + '-executor-class', reached: direct.refusal?.reason === expected && direct.exitCode !== 0,
              detail: JSON.stringify({ deployedSha: session.deployedSha, expected, actual: direct }) },
            { what: policy + '-binding-refusal', reached: !binding.ok && binding.reason === expected,
              detail: JSON.stringify({ expected, actual: binding }) },
            { what: policy + '-did-not-execute', reached: marker.exitCode === 0 && marker.stdout === 'absent', detail: JSON.stringify(marker) },
          );
        }

        const queued = v.parse(Queue, await session.rpc('listDeferredApprovals'));
        goals.push({ what: 'one-existing-approval-queue', reached: queued.length === 1 && queued[0]?.command === command
          && queued[0]?.status === 'queued' && queued[0]?.executor === 'workspace', detail: JSON.stringify(queued) });

        // Ordinary command failure is distinct from refusal before execution.
        // Side effects before false prove these commands actually reached the shell.
        const failedDirect = await exec('printf ran > /home/user/first-run-direct-ran; printf actual-stdout; printf actual-stderr >&2; false');
        const failedBinding = await call('printf ran > /home/user/first-run-binding-ran; printf actual-stdout; printf actual-stderr >&2; false');
        const ran = await exec('cat /home/user/first-run-direct-ran /home/user/first-run-binding-ran');
        goals.push(
          { what: 'executed-failure-class', reached: failedDirect.exitCode !== 0 && failedDirect.refusal?.reason === 'io'
              && failedDirect.refusal.error.includes('actual-stdout') && failedDirect.refusal.error.includes('actual-stderr'), detail: JSON.stringify(failedDirect) },
          { what: 'executed-binding-failure-class', reached: !failedBinding.ok && failedBinding.reason === 'io'
              && failedBinding.error.includes('actual-stdout') && failedBinding.error.includes('actual-stderr'), detail: JSON.stringify(failedBinding) },
          { what: 'failed-commands-did-execute', reached: ran.exitCode === 0 && ran.stdout === 'ranran', detail: JSON.stringify(ran) },
        );

        // Stdout is data, even when it looks exactly like a refusal record.
        const businessData = JSON.stringify({ reason: 'denied', error: 'historical incident' });
        const printData = "printf '%s' '" + businessData + "'";
        const successfulDirect = await exec(printData);
        const successfulBinding = await call(printData);
        goals.push(
          { what: 'successful-stdout-is-data', reached: successfulDirect.exitCode === 0 && successfulDirect.refusal === undefined
              && successfulDirect.stdout === businessData, detail: JSON.stringify(successfulDirect) },
          { what: 'successful-binding-stdout-is-data', reached: successfulBinding.ok && successfulBinding.value === businessData,
            detail: JSON.stringify(successfulBinding) },
        );

        // Do not decide it: a decision wakes the model. Deleting this fresh
        // workspace in the runner's finally removes its pending queue as well.
        return goals;
      },
    }, observations);
  });
});

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
