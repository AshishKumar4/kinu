import { readFileSync } from 'node:fs';
import * as v from 'valibot';
import { AgentClient } from 'agents/client';
import { JsonValueSchema, RunEventSchema, pageSchema, workspaceSlug, type JsonValue, type RunEvent, type SeekCursor } from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import { compareRunEventOrder } from '@kinu.run/test-utils';
import {
  ActivitySpendSchema, callAgentRpc, createCloudAgentConnectTicket, deleteCloudAgent, listCloudAgents,
} from '../../packages/cli/src/cloud-api';
import { sessionExpired, type CloudAuthConfig } from '../../packages/cli/src/config';
import type { FirstRunPlan, FirstRunSession } from './first-run';

const StoredSession = v.pipe(v.string(), v.parseJson(), v.object({
  origin: v.string(), accessToken: v.pipe(v.string(), v.minLength(1)), tokenExpiresAt: v.optional(v.string()),
}));
const Creation = v.object({ name: v.optional(v.string()), error: v.optional(v.string()) });
const Health = v.object({ build: v.object({ sha: v.string() }) });
const RunPage = pageSchema(v.object({ runId: v.string() }));
const HistoryPage = pageSchema(v.object({ role: v.string(), content: v.string() }));
const RunEvents = v.array(RunEventSchema);

/** Explicit opt-in, separate from the synthetic browser-identity suite. The
 * scratch KINU_HOME remains untouched; only this named config file is read,
 * in place, and neither credentials nor connect tickets enter the record. */
export function operatorFirstRunPlan(): FirstRunPlan<OperatorFirstRunSession> | null {
  if (process.env.KINU_FIRST_RUN_OPERATOR !== '1') return null;
  if (process.env.KINU_EVAL_BACKEND !== 'cloud') throw new Error('Operator first-run requires KINU_EVAL_BACKEND=cloud');
  const path = process.env.KINU_FIRST_RUN_CLI_CONFIG;
  const origin = process.env.KINU_EVAL_ORIGIN;
  const sha = process.env.KINU_FIRST_RUN_DEPLOYED_SHA;
  if (!path || !origin || !sha) throw new Error('Set KINU_FIRST_RUN_CLI_CONFIG, KINU_EVAL_ORIGIN and KINU_FIRST_RUN_DEPLOYED_SHA explicitly');
  const config = v.safeParse(StoredSession, readFileSync(path, 'utf8'));
  if (!config.success) throw new Error('The explicitly selected interactive CLI config is invalid');
  if (config.output.origin !== origin) throw new Error('Operator config origin does not match the requested deployment');
  if (sessionExpired(config.output)) throw new Error('Interactive CLI session expired; run kinu auth');
  const auth: CloudAuthConfig = { origin, token: config.output.accessToken };
  return { open: ({ purpose }) => OperatorFirstRunSession.open(auth, sha, purpose) };
}

export class OperatorFirstRunSession implements FirstRunSession {
  readonly describe: string;
  private readonly owned = new Set<string>();
  private client: AgentClient | null = null;

  private constructor(private readonly auth: CloudAuthConfig, readonly workspace: string,
    readonly deployedSha: string, private readonly baseline: ReadonlySet<string>) {
    this.describe = `CLI REST + AgentClient ${auth.origin}/${workspace}, deployed ${deployedSha}, no model`;
  }

  static async open(auth: CloudAuthConfig, sha: string, purpose: string): Promise<OperatorFirstRunSession> {
    const response = await fetch(auth.origin + '/api/health');
    if (!response.ok) throw new Error('Deployment health returned HTTP ' + response.status);
    const health = v.parse(Health, await response.json());
    if (health.build.sha !== sha) throw new Error(`Requested deployment ${sha}, observed ${health.build.sha}`);
    const baseline = new Set((await listCloudAgents(auth.origin, auth.token)).map(entry => entry.name));
    const session = new OperatorFirstRunSession(auth, workspaceSlug(crypto.randomUUID()), sha, baseline);
    try {
      const created = await session.create(session.workspace, purpose);
      if (created.status !== 201 || created.name !== session.workspace) throw new Error('Fresh operator workspace creation failed: ' + JSON.stringify(created));
      const client = new AgentClient({ host: new URL(auth.origin).host, protocol: 'wss', agent: 'orchestrator-agent', name: session.workspace,
        query: async () => ({ ticket: (await createCloudAgentConnectTicket(auth.origin, auth.token, session.workspace)).ticket }),
      });
      session.client = client;
      await new Promise<void>((resolve, reject) => {
        client.addEventListener('open', () => resolve(), { once: true });
        client.addEventListener('error', event => reject(new KinuError('unavailable', 'Operator WebSocket ' + event.type)), { once: true });
      });
      await session.rpc('listSlates');
      return session;
    } catch (cause) {
      await session.teardown();
      throw new Error('Opening the operator first-run session failed', { cause });
    }
  }

  async create(name: string, purpose: string) {
    if (this.baseline.has(name)) throw new Error('Test address is already owned; refusing to reuse it');
    this.owned.add(name);
    const response = await fetch(this.auth.origin + '/api/cli/workspaces', {
      method: 'POST', headers: { authorization: 'Bearer ' + this.auth.token, 'content-type': 'application/json' },
      body: JSON.stringify({ name, displayName: 'Disposable non-model first-run', purpose }),
    });
    const body = v.parse(Creation, await response.json());
    if (body.name !== undefined && !this.baseline.has(body.name)) this.owned.add(body.name);
    return { status: response.status, ...body };
  }

  async rpc(method: string, args: JsonValue[] = []): Promise<JsonValue> {
    if (this.client === null) throw new Error('Operator session is not connected');
    return v.parse(JsonValueSchema, await this.client.call(method, args));
  }

  rpcAt(workspace: string, method: string, args: JsonValue[] = []): Promise<JsonValue> {
    if (!this.owned.has(workspace)) throw new Error('Refusing RPC outside this case\'s created resources');
    return callAgentRpc(this.auth.origin, this.auth.token, workspace, method, JsonValueSchema, args);
  }

  async runEvents(): Promise<readonly RunEvent[]> {
    const events: RunEvent[] = [];
    let cursor: SeekCursor | null = null;
    for (;;) {
      const page: v.InferOutput<typeof RunPage> = v.parse(RunPage, await this.rpcAt(this.workspace, 'listRuns', [cursor === null ? {} : { cursor: { after: cursor.after } }]));
      for (const run of page.items) {
        let since = 0;
        for (;;) {
          const batch = v.parse(RunEvents, await this.rpcAt(this.workspace, 'getRunEvents', [run.runId, { since }]));
          if (batch.length === 0) break;
          events.push(...batch);
          since = batch.reduce((highest, event) => Math.max(highest, event.eventIndex), since) + 1;
        }
      }
      if (page.status === 'end') return events.sort(compareRunEventOrder);
      cursor = page.next;
    }
  }

  async history(): Promise<readonly { role: string; text: string }[]> {
    const history: { role: string; text: string }[] = [];
    let cursor: SeekCursor | null = null;
    for (;;) {
      const page: v.InferOutput<typeof HistoryPage> = v.parse(HistoryPage, await this.rpc('getChatHistoryPage', [cursor === null ? {} : { cursor: { after: cursor.after } }]));
      history.unshift(...page.items.map(entry => ({ role: entry.role, text: entry.content })));
      if (page.status === 'end') return history;
      cursor = page.next;
    }
  }

  async spend() {
    const main = v.parse(ActivitySpendSchema, await this.rpc('getActivitySnapshot')).spend;
    const live = await listCloudAgents(this.auth.origin, this.auth.token);
    for (const entry of live) {
      if (entry.name !== this.workspace && this.owned.has(entry.name)) {
        const extra = v.parse(ActivitySpendSchema, await this.rpcAt(entry.name, 'getActivitySnapshot')).spend;
        if (extra.total.calls !== 0) throw new Error('Non-model creation probe recorded model calls in ' + entry.name);
      }
    }
    return main;
  }

  async teardown(): Promise<void> {
    this.client?.close();
    this.client = null;
    const listed = await listCloudAgents(this.auth.origin, this.auth.token);
    for (const entry of listed) {
      if (this.owned.has(entry.name) && !this.baseline.has(entry.name)) {
        await deleteCloudAgent(this.auth.origin, this.auth.token, entry.name);
      }
    }
    const remaining = (await listCloudAgents(this.auth.origin, this.auth.token)).filter(entry => this.owned.has(entry.name));
    if (remaining.length !== 0) throw new Error('First-run cleanup left workspaces: ' + remaining.map(entry => entry.name).join(', '));
    console.warn('[first-run cleanup] ' + JSON.stringify({ deployedSha: this.deployedSha, created: [...this.owned], remaining: [] }));
  }
}
