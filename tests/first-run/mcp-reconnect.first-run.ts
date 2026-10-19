/**
 * An account's MCP server ends its sessions, and the account's calls keep answering: each attempt connects the
 * server, calls it twice on one session, then makes the call that ends that session, which must answer on a new one.
 * The server is the tiers' own (scripts/scripted-mcp.ts), which answers 404 to a call ending the session it arrived on,
 * reached through the product's one MCP call path (`callUserMcpTool`) from a slate. Every step's failures are counted
 * by cause.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { JsonValueSchema } from '@kinu.run/core';
import { SCRIPTED_MODEL_KEY_ENV, SCRIPTED_MODEL_ORIGIN } from '../../packages/test-utils/src/scripted-model-spec';
import { SCRIPTED_MCP_PATH, SCRIPTED_MCP_TOOL, SessionAnswerSchema } from '../../scripts/scripted-mcp';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { webHeaders } from '../../evals/src/workspace-roster';

const SUITE = 'First-run · mcp-reconnect';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'The owner, 2026-10-08: "MCP seems to feel a bit unreliable? it sometimes seems to disconnect?" A server that ends a session answers 404, and the product has to start a new one and answer the call.',
  missedBecause: 'packages/cf-backend/tests/unit-mcp-session-expiry.test.ts:129-172 drives the renewal against a local server through the SDK client alone; nothing drove an account\'s connected server through the deployed UserDO, its call path and a session that ends between calls.',
  provedRedAt: null,
  redDirection: 'Green requires every attempt to connect with no authorization step, both calls before the session ends to answer on one session, and the call the server answers 404 to answer on a new one. A 404 surfaced to the caller, a call left on the ended session, or a connect that fails reads red, with the failures counted by cause. Not proved red on a deployed build: every build this case can reach renews (callRenewingExpiredSession predates it); first green on staging rc20, 4 of 4 attempts with no failure (2026-10-19).',
};

const PLAN = firstRunCasePlan(SUITE, 'mcp');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

/** Connect, call, end the session and reconnect, this many times: the run is bounded by attempts. */
const ATTEMPTS = 4;

const Answered = v.object({ ok: v.literal(true), value: JsonValueSchema });

const Exec = v.object({ stdout: v.optional(v.string()), exitCode: v.optional(v.number()), error: v.optional(v.string()) });

const McpConnection = v.object({ id: v.string(), authUrl: v.nullable(v.string()) });

const McpAnswer = v.object({
  content: v.tuple([v.object({ type: v.literal('text'), text: v.pipe(v.string(), v.parseJson(), SessionAnswerSchema) })]),
  isError: v.optional(v.literal(false)),
});

const SLATE = 'mcpprobe';

/** Failures of one step, by cause, out of its attempts. */
class Tally {
  attempts = 0;
  readonly causes = new Map<string, number>();

  failed(cause: string): void {
    this.causes.set(cause, (this.causes.get(cause) ?? 0) + 1);
  }

  goal(what: string): EvalSubgoal {
    const failures = [...this.causes.values()].reduce((sum, count) => sum + count, 0);

    return {
      what,
      reached: this.attempts === ATTEMPTS && failures === 0,
      detail: JSON.stringify({ attempts: this.attempts, failures, causes: Object.fromEntries(this.causes) }),
    };
  }
}

/** The first words of a refusal, as its cause. */
function causeOf(text: string): string {
  return text.replace(/\s+/gu, ' ').slice(0, 120);
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    const key = process.env[SCRIPTED_MODEL_KEY_ENV] ?? '';

    if (key === '') throw new Error(`${SCRIPTED_MODEL_KEY_ENV} is not set: the tiers' MCP server answers only that bearer`);

    await runFirstRunCase(PLAN, {
      id: CASE, defect: DEFECT, modelCalls: 'none', genesis: false,
      // A connect, three calls and a removal each attempt, and the slate's authoring.
      budgetMs: ATTEMPTS * 45_000 + 60_000,
      purpose: 'Disposable MCP reconnect probe; no model task.',
      async run({ session, plan, budget }) {
        const headers = webHeaders(plan.identity);

        const setup = v.parse(Exec, await session.execute('workspace', `mkdir -p /slates/${SLATE}
cat > /slates/${SLATE}/package.json <<'END'
{"name":"${SLATE}","description":"MCP reconnect probe","main":"server.ts","slate":{"title":"MCP reconnect probe"}}
END
cat > /slates/${SLATE}/server.ts <<'END'
import { SlateObject } from "kinu:slate";
export class Slate extends SlateObject {
  async session(name, end) { return await this.env.workspace.mcp[name].${SCRIPTED_MCP_TOOL}(end === undefined ? {} : { end }); }
}
END`));

        if ((setup.exitCode ?? 1) !== 0) throw new Error('Could not author the probe slate: ' + (setup.error ?? setup.stdout ?? ''));

        const tallies = { connect: new Tally(), call: new Tally(), sameSession: new Tally(), renewed: new Tally() };
        /** Probe servers a removal did not take: the account keeps them, so the case fails on them. */
        const left: string[] = [];

        /** One call through the slate to the server named `name`, ending the session `end` names: the session that served
         *  it, or the cause it failed on. */
        const called = async (name: string, end?: string): Promise<{ session: string } | { cause: string }> => {
          const raw = await session.slateOp({ op: 'call', id: SLATE, method: 'session', args: end === undefined ? [name] : [name, end] });
          const answered = v.safeParse(Answered, raw);
          const answer = answered.success ? v.safeParse(McpAnswer, answered.output.value) : undefined;

          if (answer?.success === true) return { session: answer.output.content[0].text.session };

          return { cause: causeOf(JSON.stringify(raw)) };
        };

        for (let attempt = 1; attempt <= ATTEMPTS && !budget.aborted; attempt++) {
          // A server of its own each attempt, so no attempt meets what the last one left.
          const name = `eval-reconnect-${String(attempt)}-${crypto.randomUUID().slice(0, 8)}`;
          tallies.connect.attempts++;

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
            tallies.connect.failed(`connect ${String(connected.status)}: ${causeOf(connectedText)}`);
            continue;
          }

          try {
            tallies.call.attempts++;
            const first = await called(name);
            const second = await called(name);
            const refusal = [first, second].find((call) => 'cause' in call);

            tallies.sameSession.attempts++;

            if (refusal !== undefined && 'cause' in refusal) {
              tallies.call.failed(`before the session ended: ${refusal.cause}`);
              tallies.sameSession.failed('a call before the session ended failed');
            } else if ('session' in first && 'session' in second && first.session !== second.session) {
              tallies.sameSession.failed('two calls inside one session lifetime were served on two sessions');
            }

            // The call ends the session it arrives on: the server answers it 404, and the product must start a new session.
            tallies.renewed.attempts++;
            const third = 'session' in second ? await called(name, second.session) : { cause: 'no session to end' };

            if ('cause' in third) tallies.renewed.failed(`after the session ended: ${third.cause}`);
            else if ('session' in second && third.session === second.session) tallies.renewed.failed('the call after the session ended was served on the ended session');
          } finally {
            const removed = await fetch(`${plan.origin}/api/user/mcp/servers/${encodeURIComponent(connection.output.id)}`, { method: 'DELETE', headers });

            if (!removed.ok) left.push(`${name}: ${String(removed.status)}`);
          }
        }

        if (left.length > 0) throw new Error(`Removing the probe's MCP servers failed: ${left.join(', ')}`);

        return [
          tallies.connect.goal('mcp-connects'),
          tallies.call.goal('mcp-calls-answer'),
          tallies.sameSession.goal('mcp-calls-share-a-live-session'),
          tallies.renewed.goal('mcp-call-after-session-end-answers-on-a-new-session'),
        ];
      },
    }, observations);
  });
});
