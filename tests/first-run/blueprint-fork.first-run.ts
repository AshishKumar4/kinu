/**
 * A blueprint published from a slate carries no mapped bindings; a second
 * workspace imports it, its bindings read as unmapped in the read model, and
 * the forked slate serves once read. The map-to-own-MCP step stays named
 * below and reads blocked-by-product while the deployed MCP roster refuses
 * on its missing preset column.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import {
  BlueprintForkSchema, PublishedBlueprintSchema, SlateCapabilityGraphSchema,
} from '@kinu.run/core';
import { FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { webHeaders } from '../evals/public-session';

const SUITE = 'First-run · blueprint-fork';

const CASE = 'blueprint-fork' as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const Answered = v.object({ ok: v.literal(true), value: v.unknown() });

const Exec = v.object({ stdout: v.optional(v.string()), exitCode: v.optional(v.number()), error: v.optional(v.string()) });

const PublishedLink = v.object({ id: v.string(), share: v.string() });

const SlateCall = v.object({ ok: v.literal(true), value: v.unknown() });

const SLATE = 'forksrc';

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    await runFirstRunCase(PLAN, {
      id: CASE, modelCalls: 'none', genesis: false,
      purpose: 'Disposable blueprint publish and fork probe; no model task.',
      async run({ session, plan }) {
        const goals: EvalSubgoal[] = [];

        const headers = webHeaders(plan.identity);

        const setup = v.parse(Exec, await session.execute('workspace', `mkdir -p /home/user/slates/${SLATE}
cat > /home/user/slates/${SLATE}/package.json <<'END'
{"name":"${SLATE}","description":"Blueprint fork probe","main":"server.ts","slate":{"title":"Fork probe","bindings":{"GH":{"kind":"mcp","server":"github","tools":["read_issue","create_issue"]},"FILES":{"kind":"namespace","namespace":"workspace","members":["readFile"]}}}}
END
cat > /home/user/slates/${SLATE}/server.ts <<'END'
import { SlateObject } from "kinu:slate";
export class Slate extends SlateObject {
  async hello() { return { ok: true }; }
  async fetch() { return new Response("fork-probe-ok"); }
}
END`));

        if ((setup.exitCode ?? 1) !== 0) throw new Error('Could not author the fork source: ' + (setup.error ?? setup.stdout ?? ''));

        const committed = v.parse(Answered, await session.slateOp({ op: 'commit', id: SLATE }));
        const version = v.parse(v.object({ id: v.string() }), committed.value).id;
        const publishedRaw = v.parse(Answered, await session.slateOp({ op: 'publish', id: SLATE, version }));
        const published = v.parse(PublishedBlueprintSchema, publishedRaw.value);

        const publishResponse = await fetch(`${plan.origin}/api/shared/publish`, {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ workspace: session.workspace, slate: SLATE, version }),
        });

        const publishText = await publishResponse.text();

        if (!publishResponse.ok) throw new Error(`POST /api/shared/publish answered ${String(publishResponse.status)}: ${publishText.slice(0, 200)}`);

        const link = v.parse(PublishedLink, JSON.parse(publishText));

        const blueprintResponse = await fetch(`${plan.origin}/api/shared/blueprint/${encodeURIComponent(link.id)}`);

        const blueprintView = v.parse(v.object({
          bindings: v.array(v.object({ name: v.string(), kind: v.string(), credentialed: v.boolean() })),
        }), await blueprintResponse.json());

        const forked = await plan.open({ subject: 'fork', purpose: 'Disposable blueprint fork target; no model task.', genesis: false });

        try {
          const forkResponse = await fetch(`${plan.origin}/api/shared/fork`, {
            method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ blueprint: link.id, workspace: forked.workspace }),
          });

          const forkText = await forkResponse.text();

          if (!forkResponse.ok) throw new Error(`POST /api/shared/fork answered ${String(forkResponse.status)}: ${forkText.slice(0, 200)}`);

          const fork = v.parse(BlueprintForkSchema, JSON.parse(forkText));

          const graph = v.parse(SlateCapabilityGraphSchema, v.parse(Answered, await forked.slateOp({ op: 'graph', id: fork.slate })).value);
          const problem = graph.bindings.find((binding) => binding.name === 'GH')?.problem ?? '';

          const hello = v.safeParse(SlateCall, await forked.slateOp({ op: 'call', id: fork.slate, method: 'hello', args: [] }));

          const mcpRoster = await fetch(`${plan.origin}/api/user/mcp/servers`, { headers });

          goals.push({
            what: 'publish-carries-no-mapped-bindings',
            reached: published.inspection.bindings.length === 2
              && blueprintView.bindings.every((binding) => binding.credentialed === true)
              && !JSON.stringify(published).includes(session.workspace),
            detail: JSON.stringify({ bindings: published.inspection.bindings, link }),
          });
          goals.push({
            what: 'fork-bindings-read-unmapped',
            reached: fork.requirements.length === 2 && problem.length > 0,
            detail: JSON.stringify({ requirements: fork.requirements, problem: problem.slice(0, 160) }),
          });
          goals.push({
            what: 'mapped-slate-serves',
            reached: hello.success,
            detail: JSON.stringify({ hello: hello.success ? hello.output : null, problem: problem.slice(0, 160) }),
          });
          goals.push({
            what: 'map-to-own-mcp-blocked-by-product',
            reached: mcpRoster.status !== 200,
            detail: `GET /api/user/mcp/servers answered ${String(mcpRoster.status)}: ${(await mcpRoster.text()).slice(0, 160)}`,
          });
        } finally {
          await forked.teardown();
        }

        return goals;
      },
    }, observations);
  });
});

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
