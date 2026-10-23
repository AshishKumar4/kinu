/**
 * An account's MCP server answers the first call after the account's object has slept. The account's object (UserDO)
 * hibernates after seconds idle and every wake dials each server again. This case connects the tiers' own server
 * (scripts/scripted-mcp.ts), calls it, ends the account's activation as hibernation does (the eval-only
 * `POST /api/user/eval/abort`), and calls again at once. That second call is the first request of the wake, and it reads
 * the account's tool surface the way a turn does (a slate's call goes through `userMcp_toolDescriptors`).
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { JsonValueSchema } from '@kinu.run/core';
import { SCRIPTED_MODEL_KEY_ENV, SCRIPTED_MODEL_ORIGIN } from '../../packages/test-utils/src/scripted-model-spec';
import { SCRIPTED_MCP_PATH, SCRIPTED_MCP_TOOL, SessionAnswerSchema } from '../../scripts/scripted-mcp';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { webHeaders } from '../../evals/src/workspace-roster';

const SUITE = 'First-run · mcp-wake';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'The owner, 2026-10-23: "github disconnected? Why do MCPs disconnect randomly?" Production telemetry: the owner\'s '
    + 'UserDO woke 22 times in 20 minutes, each after 14-56 s idle, and each wake dialled every server again (GitHub ready '
    + '1-2 s in). A turn whose own call woke the object read its tools at once, so it opened with GitHub "not connected '
    + 'when this turn opened".',
  missedBecause: 'packages/cf-backend/tests/unit-user-mcp-lifecycle.test.ts pinned the descriptor read as never waiting for a '
    + 'dial ("it returns promptly while a server is still connecting"), and no deployed row ever let an account sleep '
    + 'before using its connection.',
  provedRedAt: null,
  redDirection: 'RED on a build whose descriptor read does not wait for its wake\'s dials: the call after the wake answers "Your '
    + 'connections do not offer …", so `answers-first-call-after-wake` is missed. Green requires the account\'s activation to '
    + 'end on request, the call before it and the first call after it to answer, and the server to be removed.',
};

const PLAN = firstRunCasePlan(SUITE, 'mcpwake');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const Answered = v.object({ ok: v.literal(true), value: JsonValueSchema });

const Exec = v.object({ stdout: v.optional(v.string()), exitCode: v.optional(v.number()), error: v.optional(v.string()) });

const McpConnection = v.object({ id: v.string(), authUrl: v.nullable(v.string()) });

const McpAnswer = v.object({
  content: v.tuple([v.object({ type: v.literal('text'), text: v.pipe(v.string(), v.parseJson(), SessionAnswerSchema) })]),
  isError: v.optional(v.literal(false)),
});

const SLATE = 'mcpwake';

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    const key = process.env[SCRIPTED_MODEL_KEY_ENV] ?? '';

    if (key === '') throw new Error(`${SCRIPTED_MODEL_KEY_ENV} is not set: the tiers' MCP server answers only that bearer`);

    await runFirstRunCase(PLAN, {
      id: CASE, defect: DEFECT, modelCalls: 'none', genesis: false,
      budgetMs: 180_000,
      purpose: 'Disposable MCP wake probe; no model task.',
      async run({ session, plan }) {
        const headers = webHeaders(plan.identity);

        const setup = v.parse(Exec, await session.execute('workspace', `mkdir -p /slates/${SLATE}
cat > /slates/${SLATE}/package.json <<'END'
{"name":"${SLATE}","description":"MCP wake probe","main":"server.ts","slate":{"title":"MCP wake probe"}}
END
cat > /slates/${SLATE}/server.ts <<'END'
import { SlateObject } from "kinu:slate";
export class Slate extends SlateObject {
  async session(name) { return await this.env.workspace.mcp[name].${SCRIPTED_MCP_TOOL}({}); }
}
END`));

        if ((setup.exitCode ?? 1) !== 0) throw new Error('Could not author the probe slate: ' + (setup.error ?? setup.stdout ?? ''));
        const name = `eval-wake-${crypto.randomUUID().slice(0, 8)}`;

        const connected = await fetch(`${plan.origin}/api/user/mcp/servers`, {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            name, serverUrl: `${SCRIPTED_MODEL_ORIGIN}${SCRIPTED_MCP_PATH}`, transport: 'streamable-http',
            headers: { authorization: `Bearer ${key}` }, allowedTools: [SCRIPTED_MCP_TOOL],
          }),
        });

        const connectedText = await connected.text();
        const connection = connected.ok ? v.safeParse(v.pipe(v.string(), v.parseJson(), McpConnection), connectedText) : undefined;

        if (connection?.success !== true || connection.output.authUrl !== null) {
          throw new Error(`Could not connect the probe server: ${String(connected.status)} ${connectedText.slice(0, 200)}`);
        }

        /** One call through the slate: whether it answered, and what it said. */
        const called = async (): Promise<{ answered: boolean; detail: string }> => {
          const raw = await session.slateOp({ op: 'call', id: SLATE, method: 'session', args: [name] });
          const answered = v.safeParse(Answered, raw);

          return { answered: answered.success && v.is(McpAnswer, answered.output.value), detail: JSON.stringify(raw).slice(0, 300) };
        };

        const subgoals: EvalSubgoal[] = [];

        try {
          const before = await called();

          subgoals.push({ what: 'answers-before-wake', reached: before.answered, detail: before.detail });
          // The account's activation ends as hibernation ends it; the next call is the first request of its wake.
          const aborted = await fetch(`${plan.origin}/api/user/eval/abort`, { method: 'POST', headers });

          subgoals.push({ what: 'account-activation-ended', reached: aborted.status === 202, detail: `abort answered ${String(aborted.status)}` });
          const after = await called();

          subgoals.push({ what: 'answers-first-call-after-wake', reached: after.answered, detail: after.detail });
        } finally {
          const removed = await fetch(`${plan.origin}/api/user/mcp/servers/${encodeURIComponent(connection.output.id)}`, { method: 'DELETE', headers });

          subgoals.push({ what: 'server-removed', reached: removed.ok, detail: `DELETE answered ${String(removed.status)}` });
        }

        return subgoals;
      },
    }, observations);
  });
});
