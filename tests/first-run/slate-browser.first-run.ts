/**
 * A slate's class drives a real browser end to end, as an eval program does: it opens a Chrome session its caller
 * owns, connects it through the same gate, loads a page and reads its title, then closes the session; and it does
 * the same with a Kitesurf browser, opened for the call.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';

const SUITE = 'First-run · slate-browser';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'A slate\'s class opened a Chrome session as its caller, connected it through the eval program\'s browser gate, loaded a page and read its title, and did the same with a Kitesurf browser.',
  missedBecause: 'The slate surface exposed openBrowser but refused connectBrowser: the sandbox half of driving a browser was installed only in eval programs, and a slate\'s egress carried no actor, so the gate refused every Chrome session.',
  provedRedAt: null,
  redDirection: 'Green requires title(engine, url) to answer \'Example Domain\' for both chrome and kitesurf. Before this, connectBrowser from a slate answered "runs only inside an eval program"; '
    + 'packages/cf-backend/tests/workerd/slate-share.test.ts proves the gate admits the caller\'s own session and refuses another\'s.',
};

const PLAN = firstRunCasePlan(SUITE, 'browse');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const Exec = v.object({ stdout: v.optional(v.string()), exitCode: v.optional(v.number()), error: v.optional(v.string()) });

const Driven = v.object({ ok: v.literal(true), value: v.object({ title: v.string() }) });

const SLATE = 'browserdrive';

/** Served by every staging run's own egress; its title does not change. */
const PAGE = 'https://example.com/';

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    await runFirstRunCase(PLAN, {
      id: CASE, defect: DEFECT, modelCalls: 'none', budgetMs: 5 * 60_000, genesis: false,
      purpose: 'Disposable slate that drives Chrome and Kitesurf from its class; no model task.',
      async run({ session }) {
        const setup = v.parse(Exec, await session.execute('workspace', `mkdir -p /slates/${SLATE}
cat > /slates/${SLATE}/package.json <<'END'
{"main":"server.ts","slate":{"title":"Browser drive probe"}}
END
cat > /slates/${SLATE}/server.ts <<'END'
import { SlateObject } from "kinu:slate";
export class Slate extends SlateObject {
  async title(engine, url) {
    const web = this.env.workspace.web;
    const { id } = await web.openBrowser({ browser: engine });
    try {
      const browser = await web.connectBrowser(id);
      const page = await browser.newPage();
      await page.goto(url);
      const title = await page.title();
      await browser.disconnect();
      return { title };
    } finally {
      if (engine === "chrome") await web.closeBrowser(id);
    }
  }
}
END`));

        if ((setup.exitCode ?? 1) !== 0) throw new Error('Could not author the probe slate: ' + (setup.error ?? setup.stdout ?? ''));
        const goals: EvalSubgoal[] = [];

        for (const engine of ['chrome', 'kitesurf'] as const) {
          const answer = await session.slateOp({ op: 'call', id: SLATE, method: 'title', args: [engine, PAGE] });
          const driven = v.safeParse(Driven, answer);

          goals.push({
            what: `${engine}-page-driven-from-a-slate`,
            reached: driven.success && driven.output.value.title === 'Example Domain',
            detail: JSON.stringify(answer).slice(0, 400),
          });
        }

        return goals;
      },
    }, observations);
  });
});
