/**
 * Ask the model to author a TypeScript fetch app, then open its HTTP preview.
 * Listing alone cannot prove that the authored app starts or answers requests.
 * This case needs a deployment and a model; no deployed run is claimed here.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';

import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import {
  firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';

const SUITE = 'First-run · slate';

const CASE = 'slate';

const ID = 'hello';

const ASK = 'Use the file tool to create a slate at /home/user/slates/hello/. '
  + 'Write package.json with main "server.ts" and slate {"title":"Hello","port":8787,"bindings":{}}. '
  + 'Write server.ts as a TypeScript module whose default export has fetch(request, env). '
  + 'The request is an ordinary Request. For GET /ping, respond with JSON '
  + '{"message":"pong","method":request.method,"path":new URL(request.url).pathname}. '
  + 'Return HTTP 404 for other paths. Start its preview yourself and verify GET /ping. Reply with pong on its own line and the working preview URL.';

const ExpectedResponse = v.strictObject({
  message: v.literal('pong'),
  method: v.literal('GET'),
  path: v.literal('/ping'),
});

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    await runFirstRunCase(PLAN, {
      id: CASE,
      modelCalls: 'expected',
      purpose: 'A precise engineer who builds small TypeScript HTTP apps.',
      async run({ session }) {
        const before = await session.listSlates();
        const beforePorts = await session.exposedPorts('workspace');
        const turn = await session.prompt(ASK);
        const listing = await session.listSlates();
        const row = listing.slates.find((slate) => slate.id === ID);
        // Inspect only: the harness must not start the preview the agent was asked to start.
        const ports = await session.exposedPorts('workspace');
        const preview = row?.port === 8787 ? ports.find((port) => port.port === row.port) : undefined;
        let answered = false;
        let responseDetail = 'No HTTP request was made because the preview did not start.';

        if (preview !== undefined) {
          const url = new URL(preview.url);
          url.pathname = url.pathname.replace(/\/$/, '') + '/ping';

          try {
            const response = await fetch(url);
            const body = await response.text();
            const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), ExpectedResponse), body);
            answered = response.ok && parsed.success;
            responseDetail = `HTTP ${String(response.status)}: ${body.slice(0, 200)}`;
          } catch (error) {
            responseDetail = 'Preview request failed: ' + (error instanceof Error ? error.message : String(error));
          }
        }

        const history = await session.history();
        const reply = history.filter((entry) => entry.role === 'assistant').at(-1)?.text ?? turn.text;

        const subgoals: EvalSubgoal[] = [
          {
            what: 'listed',
            reached: row !== undefined && !before.slates.some((slate) => slate.id === ID),
            detail: row === undefined
              ? `No ${ID} slate: ${JSON.stringify(listing)}`
              : `${row.id} is listed with title ${row.title}`,
          },
          {
            what: 'previewed',
            reached: preview !== undefined && !beforePorts.some((port) => port.port === 8787),
            detail: preview === undefined ? 'The named slate owns no current live preview on the requested port.' : JSON.stringify(preview),
          },
          {
            what: 'answered',
            reached: answered,
            detail: responseDetail,
          },
          {
            what: 'replied',
            reached: /^pong$/m.test(reply) && preview !== undefined && reply.includes(preview.url),
            detail: `Stored reply: ${JSON.stringify(reply).slice(0, 200)}`,
          },
        ];

        return subgoals;
      },
    }, observations);
  });
});
