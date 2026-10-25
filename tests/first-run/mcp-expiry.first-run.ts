/**
 * An account's OAuth MCP server through its access token expiring under three calls made at once, as a turn's parallel
 * calls and a connection's discovery send them. Each attempt connects the tiers' OAuth server
 * (scripts/scripted-mcp-oauth.ts) and signs it in as a person would, makes the call that expires its token, then three
 * at once, through the product's one MCP call path from a slate. Every failure is counted by step and cause; nothing
 * waits on a clock. A session the server ends is mcp-reconnect's.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { APP_ROUTES, connectEndedOf, JsonValueSchema, type JsonObject } from '@kinu.run/core';
import { SCRIPTED_MODEL_KEY_ENV, SCRIPTED_MODEL_ORIGIN } from '../../packages/test-utils/src/scripted-model-spec';
import { SCRIPTED_MCP_TOOL } from '../../scripts/scripted-mcp';
import { SCRIPTED_MCP_OAUTH_PATH } from '../../scripts/scripted-mcp-oauth';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { webHeaders } from '../../evals/src/workspace-roster';

const SUITE = 'First-run · mcp-expiry';

const CASE = firstRunCaseId(import.meta.url);

const DEFECT: FirstRunDefect = {
  found: 'The owner, 2026-10-08: "MCP seems to feel a bit unreliable? it sometimes seems to disconnect?" Calls meeting an expired token at once each refreshed it, and a provider that rotates refresh tokens revoked the grant on the second, so the account had to sign in again.',
  missedBecause: 'The tiers\' only MCP server had no OAuth: nothing drove a deployed account through expiry or a parallel refresh (packages/cf-backend/tests/unit-mcp-oauth-refresh.test.ts reproduces the refresh on the SDK alone).',
  provedRedAt: null,
  redDirection: 'Green requires every connect (the OAuth server signed in through the product\'s callback) and every call to answer, the three made together after the token expired included. Not proved red on a deployed build: the fixture deploys with the fix.',
};

const PLAN = firstRunCasePlan(SUITE, 'mcp');

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const SLATE = 'mcpexpiry';

const Answered = v.object({ ok: v.literal(true), value: JsonValueSchema });

const Exec = v.object({ stdout: v.optional(v.string()), exitCode: v.optional(v.number()), error: v.optional(v.string()) });

const McpConnection = v.object({ id: v.string(), signIn: v.boolean() });

const ToolAnswer = v.looseObject({ content: v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()) })), isError: v.optional(v.boolean()) });

/** The tiers' OAuth server, its tokens living an hour: only the case's own `expire` call ends one. */
const OAUTH_SERVER = `${SCRIPTED_MODEL_ORIGIN}${SCRIPTED_MCP_OAUTH_PATH}/3600`;

/** How many times the run connects the server and drives it through its token's expiry. */
const ATTEMPTS = 3;

/** Failures of one step, by cause, out of its attempts. */
class Tally {
  attempts = 0;

  readonly causes = new Map<string, number>();

  failed(cause: string): void {
    this.causes.set(cause, (this.causes.get(cause) ?? 0) + 1);
  }

  goal(what: string): EvalSubgoal {
    const failures = [...this.causes.values()].reduce((sum, count) => sum + count, 0);

    return { what, reached: this.attempts > 0 && failures === 0, detail: JSON.stringify({ attempts: this.attempts, failures, causes: Object.fromEntries(this.causes) }) };
  }
}

function causeOf(text: string): string {
  return text.replace(/\s+/gu, ' ').slice(0, 160);
}

describe(SUITE, () => {
  test.skipIf(PLAN === null)(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    const key = process.env[SCRIPTED_MODEL_KEY_ENV] ?? '';

    if (key === '') throw new Error(`${SCRIPTED_MODEL_KEY_ENV} is not set: the tiers' MCP servers answer only that bearer`);

    await runFirstRunCase(PLAN, {
      id: CASE, defect: DEFECT, modelCalls: 'none', genesis: false,
      // Each attempt: a connect and its sign-in, four calls and a removal; and the slate's authoring.
      budgetMs: ATTEMPTS * 60_000 + 60_000,
      purpose: 'Disposable MCP expiry probe; no model task.',
      async run({ session, plan, budget }) {
        const headers = webHeaders(plan.identity);
        const tallies = { connect: new Tally(), call: new Tally(), parallel: new Tally() };

        const setup = v.parse(Exec, await session.execute('workspace', `mkdir -p /slates/${SLATE}
cat > /slates/${SLATE}/package.json <<'END'
{"name":"${SLATE}","description":"MCP expiry probe","main":"server.ts","slate":{"title":"MCP expiry probe"}}
END
cat > /slates/${SLATE}/server.ts <<'END'
import { SlateObject } from "kinu:slate";
export class Slate extends SlateObject {
  async session(name, args) { return await this.env.workspace.mcp[name].${SCRIPTED_MCP_TOOL}(args); }
}
END`));

        if ((setup.exitCode ?? 1) !== 0) throw new Error('Could not author the probe slate: ' + (setup.error ?? setup.stdout ?? ''));

        /** Signs the OAuth server in as a person would from its row: a sign-in begun for a run of the page's own, the
         *  authorize link (with the tiers' key), then the product's callback as the owner, which ends on the finish
         *  page naming that run. The cause it failed on, or null. */
        const signIn = async (serverId: string): Promise<string | null> => {
          const run = crypto.randomUUID();

          const begun = await fetch(`${plan.origin}/api/user/mcp/servers/${encodeURIComponent(serverId)}/connect`, {
            method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ run }),
          });

          const beginText = await begun.text();
          const begin = begun.ok ? v.safeParse(v.pipe(v.string(), v.parseJson(), v.object({ authUrl: v.string() })), beginText) : undefined;

          if (begin?.success !== true) return `begin ${String(begun.status)}: ${causeOf(beginText)}`;
          const authorized = await fetch(begin.output.authUrl, { headers: { authorization: `Bearer ${key}` }, redirect: 'manual' });
          const callback = authorized.headers.get('location');

          if (callback === null) return `authorize ${String(authorized.status)}: ${causeOf(await authorized.text())}`;
          const landed = await fetch(callback, { headers, redirect: 'manual' });
          const finish = new URL(landed.headers.get('location') ?? 'https://unknown/');
          const ended = connectEndedOf(finish.searchParams);

          return finish.pathname === APP_ROUTES.connected && ended.run === run && ended.error === null
            ? null
            : `callback: ${causeOf(finish.pathname + finish.search)}`;
        };

        /** The server's id, connected and signed in under `name`, or null with the failure counted. */
        const connect = async (name: string): Promise<string | null> => {
          const body = { name, serverUrl: OAUTH_SERVER, transport: 'streamable-http', allowedTools: [SCRIPTED_MCP_TOOL] };

          tallies.connect.attempts++;
          const connected = await fetch(`${plan.origin}/api/user/mcp/servers`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
          const text = await connected.text();
          const connection = connected.ok ? v.safeParse(v.pipe(v.string(), v.parseJson(), McpConnection), text) : undefined;
          let cause: string | null = connection?.success === true ? null : `connect ${String(connected.status)}: ${causeOf(text)}`;

          // An add that waits for a sign-in: the person signs in from its row.
          if (connection?.success === true && connection.output.signIn) cause = await signIn(connection.output.id);

          if (cause !== null) tallies.connect.failed(cause);

          return cause === null && connection?.success === true ? connection.output.id : null;
        };

        /** The session that served one call through the slate, or the cause it failed on. */
        const called = async (name: string, args: JsonObject): Promise<{ session: string } | { cause: string }> => {
          const raw = await session.slateOp({ op: 'call', id: SLATE, method: 'session', args: [name, args] });
          const answered = v.safeParse(Answered, raw);
          const answer = answered.success ? v.safeParse(ToolAnswer, answered.output.value) : undefined;

          const served = answer?.success === true && answer.output.isError !== true
            ? /"session":"([^"]+)"/u.exec(answer.output.content.map((part) => part.text ?? '').join(''))?.[1]
            : undefined;

          return served === undefined ? { cause: causeOf(JSON.stringify(raw)) } : { session: served };
        };

        /** The OAuth server: a call that expires its token, then three at once, each of which meets the expired one. */
        const throughExpiry = async (name: string): Promise<void> => {
          tallies.call.attempts++;
          const expiring = await called(name, { expire: true });

          if ('cause' in expiring) {
            tallies.call.failed(expiring.cause);

            return;
          }

          tallies.parallel.attempts++;
          const together = await Promise.all([1, 2, 3].map(async () => called(name, {})));

          for (const answer of together) if ('cause' in answer) tallies.parallel.failed(answer.cause);
        };

        /** Probe servers a removal did not take: the account keeps them, so the case fails on them. */
        const left: string[] = [];

        for (let attempt = 1; attempt <= ATTEMPTS && !budget.aborted; attempt++) {
          // A server of its own each attempt, so no attempt meets what the last one left.
          const name = `eval-expiry-${String(attempt)}-${crypto.randomUUID().slice(0, 8)}`;
          const id = await connect(name);

          if (id === null) continue;

          try {
            await throughExpiry(name);
          } finally {
            const removed = await fetch(`${plan.origin}/api/user/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE', headers });

            if (!removed.ok) left.push(`${name}: ${String(removed.status)}`);
          }
        }

        if (left.length > 0) throw new Error(`Removing the probe's MCP servers failed: ${left.join(', ')}`);

        return [
          tallies.connect.goal('mcp-connects-and-signs-in'),
          tallies.call.goal('mcp-calls-answer'),
          tallies.parallel.goal('mcp-calls-together-after-token-expiry-answer'),
        ];
      },
    }, observations);
  });
});
