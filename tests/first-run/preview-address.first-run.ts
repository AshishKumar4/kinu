import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation } from '@kinu.run/test-utils';
import { FIRST_RUN_DEFECTS, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { operatorFirstRunPlan } from './operator-session';

const CASE = 'preview-address';

const SUITE = 'First-run · preview-address (CLI operator, no model)';

const PLAN = operatorFirstRunPlan();

const observations: EvalObservation[] = [];

const Exec = v.object({ stdout: v.string(), exitCode: v.number() });

const Preview = v.object({ ok: v.literal(true), value: v.object({ url: v.string(), port: v.number() }) });

afterAll(() => publishFirstRunRecord(SUITE, undefined, [CASE], observations));

describe(SUITE, () => {
  test.skipIf(PLAN === null)('MEASURED: preview-address', async () => {
    if (PLAN === null) throw new Error('Explicit operator plan required');
    await runFirstRunCase(PLAN, {
      id: CASE, modelCalls: 'none', purpose: 'Disposable preview address admission verification; no model task.',
      async run({ session }) {
        const suffix = crypto.randomUUID().replaceAll('-', '');
        const longName = 'first-run-address-' + suffix.slice(0, 14);
        const maxName = 'first-run-address-' + suffix.slice(14, 27);

        if (longName.length !== 32 || maxName.length !== 31) throw new Error('Invalid boundary fixture lengths');
        const rejected = await session.create(longName, 'Disposable invalid-name admission probe; no model task.');
        const created = await session.create(maxName, 'Disposable maximum-length preview probe; no model task.');

        if (created.status !== 201 || created.name !== maxName) throw new Error('Valid boundary creation failed: ' + JSON.stringify(created));

        const setup = v.parse(Exec, await session.rpcAt(maxName, 'executeInExecutor', ['workspace', `mkdir -p /home/user/slates/address
cat > /home/user/slates/address/package.json <<'END'
{"main":"server.js","slate":{"port":65535}}
END
cat > /home/user/slates/address/server.js <<'END'
export default { fetch() { return new Response('first-run-preview-address-ok'); } };
END`]));

        if (setup.exitCode !== 0) throw new Error('Could not author boundary slate: ' + setup.stdout);
        // Unsupported is a failure, never an answer to this positive control.
        const preview = v.parse(Preview, await session.rpcAt(maxName, 'previewSlate', ['address']));
        const response = await fetch(preview.value.url);
        const body = await response.text();
        const label = new URL(preview.value.url).hostname.split('.')[0] ?? '';

        return [
          { what: 'reject-32-character-address-at-creation', reached: rejected.status === 400 && rejected.error?.includes('31') === true,
            detail: JSON.stringify({ deployedSha: session.deployedSha, addressLength: longName.length, response: rejected }) },
          { what: 'preserve-31-character-address', reached: created.name === maxName,
            detail: JSON.stringify({ addressLength: maxName.length, nameUnchanged: created.name === maxName }) },
          { what: 'real-preview-http-at-label-boundary', reached: label.length === 63 && preview.value.port === 65535
              && response.status === 200 && body === 'first-run-preview-address-ok',
            detail: JSON.stringify({ labelLength: label.length, port: preview.value.port, status: response.status, body }) },
        ];
      },
    }, observations);
  });
});

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
