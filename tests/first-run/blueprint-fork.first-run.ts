/**
 * A blueprint published from a slate carries no mapped bindings; a second
 * workspace imports it, then connects its own MCP server and calls it through
 * the fork. Cloudflare's public documentation MCP needs no OAuth credentials.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import {
  BlueprintForkSchema, JsonValueSchema, parseSlateProject, PublishedBlueprintSchema, SlateCapabilityGraphSchema,
} from '@kinu.run/core';
import { FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { webHeaders } from '../evals/public-session';

const SUITE = 'First-run · blueprint-fork';

const CASE = 'blueprint-fork' as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const Answered = v.object({ ok: v.literal(true), value: JsonValueSchema });

const Exec = v.object({ stdout: v.optional(v.string()), exitCode: v.optional(v.number()), error: v.optional(v.string()) });

const PublishedLink = v.object({ id: v.string(), share: v.string() });

const McpConnection = v.object({ id: v.string(), authUrl: v.nullable(v.string()) });

const McpAnswer = v.object({
  content: v.array(v.object({ type: v.literal('text'), text: v.string() })),
  isError: v.optional(v.boolean()),
});

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
        const mcpName = `eval-fork-${crypto.randomUUID()}`;

        const setup = v.parse(Exec, await session.execute('workspace', `mkdir -p /home/main/slates/${SLATE}
cat > /home/main/slates/${SLATE}/package.json <<'END'
{"name":"${SLATE}","description":"Blueprint fork probe","main":"server.ts","slate":{"title":"Fork probe","bindings":{"DOCS":{"kind":"mcp","server":"${mcpName}","tools":["search_cloudflare_documentation"]},"FILES":{"kind":"namespace","namespace":"workspace","members":["readFile"]}}}}
END
cat > /home/main/slates/${SLATE}/server.ts <<'END'
import { SlateObject } from "kinu:slate";
export class Slate extends SlateObject {
  async hello() { return { ok: true }; }
  async docs() { return await this.env.DOCS.search_cloudflare_documentation({ query: "Cloudflare Durable Objects storage" }); }
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
        let mcpId: string | null = null;

        try {
          const forkResponse = await fetch(`${plan.origin}/api/shared/fork`, {
            method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ blueprint: link.id, workspace: forked.workspace }),
          });

          const forkText = await forkResponse.text();

          if (!forkResponse.ok) throw new Error(`POST /api/shared/fork answered ${String(forkResponse.status)}: ${forkText.slice(0, 200)}`);

          const fork = v.parse(BlueprintForkSchema, JSON.parse(forkText));

          const graph = v.parse(SlateCapabilityGraphSchema, v.parse(Answered, await forked.slateOp({ op: 'graph', id: fork.slate })).value);
          const problem = graph.bindings.find((binding) => binding.name === 'DOCS')?.problem ?? '';

          const hello = v.safeParse(Answered, await forked.slateOp({ op: 'call', id: fork.slate, method: 'hello', args: [] }));

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
            what: 'forked-slate-serves',
            reached: hello.success,
            detail: JSON.stringify({ hello: hello.success ? hello.output : null, problem: problem.slice(0, 160) }),
          });

          const connected = await fetch(`${plan.origin}/api/user/mcp/servers`, {
            method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({
              name: mcpName, serverUrl: 'https://docs.mcp.cloudflare.com/mcp', transport: 'streamable-http',
              allowedTools: ['search_cloudflare_documentation'],
            }),
          });

          const connectedText = await connected.text();

          if (!connected.ok) throw new Error(`Connect fork MCP answered ${String(connected.status)}: ${connectedText.slice(0, 200)}`);
          const connection = v.parse(McpConnection, JSON.parse(connectedText));
          mcpId = connection.id;
          const manifestPath = `/home/main/slates/${fork.slate}/package.json`;
          const project = parseSlateProject(JSON.parse(await forked.readFile(manifestPath)));
          const binding = project.slate.bindings.DOCS;

          if (binding?.kind !== 'mcp') throw new Error('The fork lost its DOCS MCP binding');
          await forked.writeFile(manifestPath, JSON.stringify({
            ...project,
            slate: {
              ...project.slate,
              bindings: { ...project.slate.bindings, DOCS: { ...binding, server: connection.id } },
            },
          }));

          const mappedGraph = v.parse(SlateCapabilityGraphSchema, v.parse(Answered,
            await forked.slateOp({ op: 'graph', id: fork.slate })).value);

          const docs = v.safeParse(Answered, await forked.slateOp({ op: 'call', id: fork.slate, method: 'docs', args: [] }));
          const answer = v.safeParse(McpAnswer, docs.success ? docs.output.value : null);
          const mapped = mappedGraph.bindings.find((mapping) => mapping.name === 'DOCS');

          goals.push({
            what: 'own-mcp-mapping-works',
            reached: connection.authUrl === null && mapped !== undefined && !mapped.problem
              && answer.success && answer.output.isError !== true
              && answer.output.content.some((part) => part.text.includes('developers.cloudflare.com')),
            detail: JSON.stringify({ server: mcpName, problem: mapped?.problem, called: docs.success, answered: answer.success }),
          });
        } finally {
          await Promise.all([
            forked.teardown(),
            mcpId === null ? Promise.resolve() : fetch(
              `${plan.origin}/api/user/mcp/servers/${encodeURIComponent(mcpId)}`, { method: 'DELETE', headers },
            ).then((removed) => {
              if (!removed.ok) throw new Error(`Remove fork MCP answered ${String(removed.status)}`);
            }),
          ]);
        }

        return goals;
      },
    }, observations);
  });
});

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
