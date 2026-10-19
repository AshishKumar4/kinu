/**
 * An account's MCP servers through what ends a connection: an OAuth access token expiring while three calls go at once,
 * an outage while the account sleeps, and a session the server ends. Each round connects a server of each kind (the
 * OAuth one signed in as a person would), calls it, idles past the token's life, and calls again; servers connected
 * once at the start are called every round too, as an account's are. The servers are the tiers' own
 * (scripts/scripted-mcp.ts, scripts/scripted-mcp-oauth.ts), reached through the product's one MCP call path from a
 * slate. Every failure is counted by step and cause. `MCP_SOAK_GAPS` (seconds) and `MCP_SOAK_ROUNDS` make it a soak;
 * `MCP_SOAK_OUT` appends every step as a JSON line.
 */
import { appendFileSync } from 'node:fs';
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { JsonValueSchema, type JsonObject } from '@kinu.run/core';
import { SCRIPTED_MODEL_KEY_ENV, SCRIPTED_MODEL_ORIGIN } from '../../packages/test-utils/src/scripted-model-spec';
import { SCRIPTED_MCP_PATH, SCRIPTED_MCP_TOOL } from '../../scripts/scripted-mcp';
import { SCRIPTED_MCP_OAUTH_PATH } from '../../scripts/scripted-mcp-oauth';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { webHeaders } from '../../evals/src/workspace-roster';

const SUITE = 'First-run · mcp-expiry';

const CASE = firstRunCaseId(import.meta.url);

const DEFECT: FirstRunDefect = {
  found: 'The owner, 2026-10-08: "MCP seems to feel a bit unreliable? it sometimes seems to disconnect?" Calls meeting an expired token at once each refreshed it, and a provider that rotates refresh tokens revoked the grant; a dial that failed at a wake left the server\'s tools gone until the next.',
  missedBecause: 'The tiers\' only MCP server had no OAuth and never went down: nothing drove a deployed account through expiry, a parallel refresh or an outage (packages/cf-backend/tests/unit-mcp-oauth-refresh.test.ts reproduces the refresh on the SDK alone).',
  provedRedAt: null,
  redDirection: 'Green requires every connect (the OAuth server signed in through the product\'s callback) and every call to answer, the three calls made together after the token expired included, and the server down during the idle to answer after it. Not proved red on a deployed build: the fixture deploys with the fixes.',
};

const PLAN = firstRunCasePlan(SUITE, 'mcp');

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

/** The OAuth server's access-token lifetime: the idle outlasts it, so every call after the idle meets an expired one. */
const TOKEN_TTL_S = 20;

const GAPS_S = (process.env['MCP_SOAK_GAPS'] ?? String(TOKEN_TTL_S + 10)).split(',').map(Number);

const ROUNDS = Number(process.env['MCP_SOAK_ROUNDS'] ?? '1');

const OUT = process.env['MCP_SOAK_OUT'];

const SLATE = 'mcpexpiry';

const Answered = v.object({ ok: v.literal(true), value: JsonValueSchema });

const Exec = v.object({ stdout: v.optional(v.string()), exitCode: v.optional(v.number()), error: v.optional(v.string()) });

const McpConnection = v.object({ id: v.string(), authUrl: v.nullable(v.string()) });

const ToolAnswer = v.looseObject({ content: v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()) })), isError: v.optional(v.boolean()) });

type Label = 'scripted' | 'oauth' | 'outage';

interface Kind {
  readonly label: Label;
  /** The server's URL for a connection made at `now` that will idle `gapMs`. */
  readonly url: (now: number, gapMs: number) => string;
  readonly keyed: boolean;
}

const KINDS: readonly Kind[] = [
  { label: 'scripted', url: () => `${SCRIPTED_MODEL_ORIGIN}${SCRIPTED_MCP_PATH}`, keyed: true },
  { label: 'oauth', url: () => `${SCRIPTED_MODEL_ORIGIN}${SCRIPTED_MCP_OAUTH_PATH}/${String(TOKEN_TTL_S)}`, keyed: false },
  // Down from a fifth into the idle to four fifths: the account's list read at the middle wakes it inside the outage.
  { label: 'outage', url: (now, gapMs) => `${SCRIPTED_MODEL_ORIGIN}${SCRIPTED_MCP_PATH}?down=${String(now + gapMs / 5)}-${String(now + (gapMs * 4) / 5)}`, keyed: true },
];

/** Where a step happened. */
interface At {
  readonly round: number;
  readonly gapMs: number;
  readonly role: 'fresh' | 'standing';
}

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

function idle(ms: number): Promise<void> {
  const waited = Promise.withResolvers<void>();

  setTimeout(waited.resolve, ms);

  return waited.promise;
}

describe(SUITE, () => {
  test.skipIf(PLAN === null)(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    const key = process.env[SCRIPTED_MODEL_KEY_ENV] ?? '';

    if (key === '') throw new Error(`${SCRIPTED_MODEL_KEY_ENV} is not set: the tiers' MCP servers answer only that bearer`);

    await runFirstRunCase(PLAN, {
      id: CASE, defect: DEFECT, modelCalls: 'none', genesis: false,
      budgetMs: ROUNDS * GAPS_S.reduce((sum, gap) => sum + gap * 1000 + 120_000, 0) + 120_000,
      purpose: 'Disposable MCP expiry probe; no model task.',
      async run({ session, plan, budget }) {
        const headers = webHeaders(plan.identity);
        const run = crypto.randomUUID().slice(0, 8);
        const tallies = { connect: new Tally(), call: new Tally(), parallel: new Tally(), outage: new Tally(), renewed: new Tally() };

        /** One step's line, its cause beside it when it failed. */
        const record = (row: JsonObject, cause: string | null): void => {
          if (OUT === undefined) return;
          const stamped = { run, at: new Date().toISOString(), ...row };

          appendFileSync(OUT, `${JSON.stringify(cause === null ? { ...stamped, ok: true } : { ...stamped, ok: false, cause })}\n`);
        };

        const setup = v.parse(Exec, await session.execute('workspace', `mkdir -p /slates/${SLATE}
cat > /slates/${SLATE}/package.json <<'END'
{"name":"${SLATE}","description":"MCP expiry probe","main":"server.ts","slate":{"title":"MCP expiry probe"}}
END
cat > /slates/${SLATE}/server.ts <<'END'
import { SlateObject } from "kinu:slate";
export class Slate extends SlateObject {
  async session(name, end) { return await this.env.workspace.mcp[name].${SCRIPTED_MCP_TOOL}(end === undefined ? {} : { end }); }
}
END`));

        if ((setup.exitCode ?? 1) !== 0) throw new Error('Could not author the probe slate: ' + (setup.error ?? setup.stdout ?? ''));

        /** Signs the OAuth server in as a person would: the authorize link (with the tiers' key), then the product's
         *  callback as the owner. The cause it failed on, or null. */
        const signIn = async (authUrl: string): Promise<string | null> => {
          const authorized = await fetch(authUrl, { headers: { authorization: `Bearer ${key}` }, redirect: 'manual' });
          const callback = authorized.headers.get('location');

          if (callback === null) return `authorize ${String(authorized.status)}: ${causeOf(await authorized.text())}`;
          const landed = await fetch(callback, { headers, redirect: 'manual' });
          const settings = new URL(landed.headers.get('location') ?? 'https://unknown/');

          return settings.searchParams.get('mcp_auth') === 'ok' ? null : `callback: ${causeOf(settings.search)}`;
        };

        /** The server's id, connected (and signed in) under `name`, or null with the failure counted. */
        const connect = async (kind: Kind, name: string, at: At): Promise<string | null> => {
          const server = { name, serverUrl: kind.url(Date.now(), at.gapMs), transport: 'streamable-http', allowedTools: [SCRIPTED_MCP_TOOL] };
          const body = kind.keyed ? { ...server, headers: { authorization: `Bearer ${key}` } } : server;

          tallies.connect.attempts++;
          const connected = await fetch(`${plan.origin}/api/user/mcp/servers`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
          const text = await connected.text();
          const connection = connected.ok ? v.safeParse(v.pipe(v.string(), v.parseJson(), McpConnection), text) : undefined;
          let cause: string | null = connection?.success === true ? null : `connect ${String(connected.status)}: ${causeOf(text)}`;

          if (connection?.success === true && connection.output.authUrl !== null) cause = await signIn(connection.output.authUrl);
          record({ step: 'connect', server: kind.label, ...at }, cause);

          if (cause !== null) tallies.connect.failed(`${kind.label}: ${cause}`);

          return cause === null && connection?.success === true ? connection.output.id : null;
        };

        /** The session that served one call through the slate, or the cause it failed on; `end` ends a session first. */
        const called = async (call: { readonly kind: Kind; readonly name: string; readonly step: string; readonly end?: string }, at: At): Promise<{ session: string } | { cause: string }> => {
          const raw = await session.slateOp({ op: 'call', id: SLATE, method: 'session', args: call.end === undefined ? [call.name] : [call.name, call.end] });
          const answered = v.safeParse(Answered, raw);
          const answer = answered.success ? v.safeParse(ToolAnswer, answered.output.value) : undefined;

          const served = answer?.success === true && answer.output.isError !== true
            ? /"session":"([^"]+)"/u.exec(answer.output.content.map((part) => part.text ?? '').join(''))?.[1]
            : undefined;

          const step = { step: call.step, server: call.kind.label, ...at };

          if (served === undefined) {
            const cause = causeOf(JSON.stringify(raw));

            record(step, cause);

            return { cause };
          }

          record(step, null);

          return { session: served };
        };

        /** After the idle: the OAuth server called three times at once, the expiring one with its session then ended. */
        const afterIdle = async (kind: Kind, name: string, at: At): Promise<void> => {
          if (kind.label === 'oauth') {
            tallies.parallel.attempts++;
            const answers = await Promise.all([1, 2, 3].map(async (n) => called({ kind, name, step: `after-idle-${String(n)}` }, at)));

            for (const answer of answers) if ('cause' in answer) tallies.parallel.failed(answer.cause);

            return;
          }

          const tally = kind.label === 'outage' ? tallies.outage : tallies.call;

          tally.attempts++;
          const after = await called({ kind, name, step: 'after-idle' }, at);

          if ('cause' in after) {
            tally.failed(`${kind.label}: ${after.cause}`);

            return;
          }

          if (kind.label !== 'scripted') return;
          tallies.renewed.attempts++;
          const renewed = await called({ kind, name, step: 'after-session-end', end: after.session }, at);

          if ('cause' in renewed) tallies.renewed.failed(renewed.cause);
          else if (renewed.session === after.session) tallies.renewed.failed('served on the session it ended');
        };

        const remove = async (id: string): Promise<void> => {
          const removed = await fetch(`${plan.origin}/api/user/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE', headers });

          if (!removed.ok) throw new Error(`Removing a probe MCP server failed: ${String(removed.status)}`);
        };

        const standing = new Map<Kind, { name: string; id: string }>();

        for (const kind of KINDS.filter((each) => each.label !== 'outage')) {
          const name = `expiry-standing-${kind.label}-${run}`;
          const id = await connect(kind, name, { round: 0, gapMs: 0, role: 'standing' });

          if (id !== null) standing.set(kind, { name, id });
        }

        const round = async (n: number, gapMs: number): Promise<void> => {
          const fresh = new Map<Kind, { name: string; id: string }>();

          for (const kind of KINDS) {
            const name = `expiry-${kind.label}-${String(n)}-${String(gapMs / 1000)}-${run}`;
            const id = await connect(kind, name, { round: n, gapMs, role: 'fresh' });

            if (id !== null) fresh.set(kind, { name, id });
          }

          try {
            for (const [kind, { name }] of [...fresh, ...standing]) {
              const role = fresh.get(kind)?.name === name ? 'fresh' : 'standing';

              tallies.call.attempts++;
              const before = await called({ kind, name, step: 'before-idle' }, { round: n, gapMs, role });

              if ('cause' in before) tallies.call.failed(`${kind.label} before the idle: ${before.cause}`);
            }

            await idle(gapMs / 2);
            // Inside the outage: the read wakes the account, whose restore dials the server that is down.
            await fetch(`${plan.origin}/api/user/mcp/servers`, { headers });
            await idle(gapMs / 2);

            for (const [kind, { name }] of fresh) await afterIdle(kind, name, { round: n, gapMs, role: 'fresh' });

            for (const [kind, { name }] of standing) await afterIdle(kind, name, { round: n, gapMs, role: 'standing' });
          } finally {
            for (const { id } of fresh.values()) await remove(id);
          }
        };

        try {
          for (let n = 1; n <= ROUNDS && !budget.aborted; n++) {
            for (const gap of GAPS_S) {
              if (!budget.aborted) await round(n, gap * 1000);
            }
          }
        } finally {
          for (const { id } of standing.values()) await remove(id);
        }

        return [
          tallies.connect.goal('mcp-connects-and-signs-in'),
          tallies.call.goal('mcp-calls-answer-across-an-idle'),
          tallies.parallel.goal('mcp-calls-together-after-token-expiry-answer'),
          tallies.outage.goal('mcp-server-down-while-the-account-sleeps-answers-after'),
          tallies.renewed.goal('mcp-call-after-session-end-answers-on-a-new-session'),
        ];
      },
    }, observations);
  });
});
