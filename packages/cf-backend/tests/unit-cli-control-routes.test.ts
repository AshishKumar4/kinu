import { describe, expect, test } from 'bun:test';
import { handleCliRequest } from '../src/cli/routes.js';

const USER_ID = '0123456789abcdef0123456789abcdef';
const TOKEN = `ptc_${USER_ID}_abcdefghijklmnopqrstuvwxyz`;

function setupEnv() {
  const calls: string[] = [];
  const userDO = {
    async verifyCliToken(token: string) {
      return {
        ok: token === TOKEN,
        tokenHash: 'hash',
        user: { id: USER_ID, email: 'ashish@example.com', displayName: 'Ashish' },
      };
    },
    async hasAgent(name: string) {
      return name === 'jarvis';
    },
    async issueCliAgentConnectTicket(input: { userId: string; agentName: string; cliTokenHash: string }) {
      calls.push(`connect-ticket:${input.userId}:${input.agentName}:${input.cliTokenHash}`);
      return { ok: true, ticket: `pat_${USER_ID}_ticket`, expiresAt: 1234 };
    },
  };
  const agent = {
    async claimOwner(userId: string) {
      calls.push(`claim:${userId}`);
      return { owner: userId };
    },
    async getAgentStatus() {
      calls.push('status');
      return { name: 'jarvis', purpose: 'help', messageCount: 3 };
    },
    async getToolDescriptions() {
      calls.push('tools');
      return { builtIn: [{ name: 'run', description: 'Run command' }], crafted: [], executors: [] };
    },
    async getChatHistory(limit: number) {
      calls.push(`messages:${limit}`);
      return [
        { id: 'u1', role: 'user', content: 'hello', createdAt: '2026-06-08 00:00:00.000' },
        { id: 'a1', role: 'assistant', content: 'hi', createdAt: '2026-06-08 00:00:00.001' },
      ];
    },
    async listPendingConsents() {
      calls.push('consents:list');
      return [{ consentId: 'cons-1', deviceLabel: 'Workstation', method: 'exec', command: 'pwd', scope: 'all_local_actions', createdAt: 1 }];
    },
    async resolveDeviceConsent(id: string, decision: string) {
      calls.push(`consents:resolve:${id}:${decision}`);
      return { ok: true };
    },
    async getStoredModelSpec() {
      calls.push('model:get');
      return { spec: 'workers-ai/@cf/moonshotai/kimi-k2.6' };
    },
    async setModel(spec: string) {
      calls.push(`model:set:${spec}`);
      return { ok: true, spec };
    },
    async listTriggers() {
      calls.push('triggers:list');
      return { triggers: [] };
    },
    async createTimerTrigger(opts: unknown) {
      calls.push(`triggers:create:${JSON.stringify(opts)}`);
      return { id: 'trg_1', kind: 'timer_oneshot', nextFireAt: 123 };
    },
    async cancelTrigger(id: string) {
      calls.push(`triggers:cancel:${id}`);
      return { ok: true, changed: true };
    },
    async listBackgroundJobs(limit: number) {
      calls.push(`jobs:list:${limit}`);
      return [{ id: 'job_1', kind: 'run', status: 'running' }];
    },
    async cancelBackgroundJob(id: string) {
      calls.push(`jobs:cancel:${id}`);
      return { ok: true };
    },
    async cancelCurrentWork() {
      calls.push('work:cancel');
      return { ok: true, cancelledJobs: ['job_1'], abortedTools: 1 };
    },
    async getWorkspaceSnapshot() {
      calls.push('state');
      return { status: { name: 'jarvis' }, tools: { builtIn: [], crafted: [], executors: [] } };
    },
    async getMemoryContent() {
      calls.push('memory:content');
      return '# Memory';
    },
    async searchMemoryHybrid(query: string, limit: number) {
      calls.push(`memory:search:${query}:${limit}`);
      return [{ path: 'memory/MEMORY.md', snippet: 'hit', score: 1 }];
    },
    async listRecentEvents(opts: unknown) {
      calls.push(`events:${JSON.stringify(opts)}`);
      return { events: [{ id: 'evt_1' }] };
    },
    async getRunTimeline(opts: unknown) {
      calls.push(`timeline:${JSON.stringify(opts)}`);
      return [{ label: 'turn' }];
    },
    async getMctsTree() {
      calls.push('mcts:tree');
      return [{ id: 'root' }];
    },
    async getMctsNodeDetail(id: string) {
      calls.push(`mcts:detail:${id}`);
      return { id };
    },
    async getHeadRuns(limit: number) {
      calls.push(`heads:${limit}`);
      return [{ rootId: 'head-root' }];
    },
    async getGepaRuns(limit: number) {
      calls.push(`gepa:runs:${limit}`);
      return [{ runId: 'gepa_1' }];
    },
    async getGepaRun(id: string) {
      calls.push(`gepa:run:${id}`);
      return { run: { runId: id }, candidates: [] };
    },
    async getExecutors() {
      calls.push('executors:list');
      return [{ name: 'workspace', available: true }];
    },
    async executeInExecutor(id: string, command: string) {
      calls.push(`executors:exec:${id}:${command}`);
      return { stdout: 'ok', exitCode: 0 };
    },
    async getProductChangeBoard(limit: number) {
      calls.push(`product:${limit}`);
      return { changes: [] };
    },
    async createDurableWebhook(opts: unknown) {
      calls.push(`triggers:webhook:${JSON.stringify(opts)}`);
      return { trigger_id: 'trg_webhook', url: '/api/agents/jarvis/webhook/trg_webhook', secret: 'secret' };
    },
  };
  const env = {
    UserDO: {
      idFromName(name: string) { return name; },
      get() { return userDO; },
    },
    OrchestratorAgent: {
      idFromName(name: string) { return name; },
      get() { return agent; },
    },
  } as unknown as Env;
  return { env, calls };
}

function cliRequest(path: string, init: RequestInit = {}) {
  return new Request(`https://proteus.example.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
}

describe('CLI control routes', () => {
  test('mints scoped agent websocket tickets for owned agents', async () => {
    const { env, calls } = setupEnv();

    const ticket = await handleCliRequest(cliRequest('/api/cli/agents/jarvis/connect-ticket', { method: 'POST' }), env);
    expect(ticket?.status).toBe(200);
    expect(ticket?.headers.get('cache-control')).toBe('no-store');
    expect(await ticket?.json()).toEqual({ ticket: `pat_${USER_ID}_ticket`, expiresAt: 1234 });
    expect(calls).toContain(`connect-ticket:${USER_ID}:jarvis:hash`);

    const missing = await handleCliRequest(cliRequest('/api/cli/agents/unknown/connect-ticket', { method: 'POST' }), env);
    expect(missing?.status).toBe(404);
  });

  test('forward cloud control commands through the owned OrchestratorAgent', async () => {
    const { env, calls } = setupEnv();

    const status = await handleCliRequest(cliRequest('/api/cli/agents/jarvis/status'), env);
    expect(status?.status).toBe(200);
    expect(await status?.json()).toMatchObject({ name: 'jarvis', messageCount: 3 });

    const tools = await handleCliRequest(cliRequest('/api/cli/agents/jarvis/tools'), env);
    expect(await tools?.json()).toMatchObject({ builtIn: [{ name: 'run' }] });

    const messages = await handleCliRequest(cliRequest('/api/cli/agents/jarvis/messages?limit=17'), env);
    expect(await messages?.json()).toEqual([
      { id: 'u1', role: 'user', content: 'hello', createdAt: '2026-06-08 00:00:00.000' },
      { id: 'a1', role: 'assistant', content: 'hi', createdAt: '2026-06-08 00:00:00.001' },
    ]);

    const consents = await handleCliRequest(cliRequest('/api/cli/agents/jarvis/consents'), env);
    expect(await consents?.json()).toEqual([
      { consentId: 'cons-1', deviceLabel: 'Workstation', method: 'exec', command: 'pwd', scope: 'all_local_actions', createdAt: 1 },
    ]);

    const consent = await handleCliRequest(cliRequest('/api/cli/agents/jarvis/consents/cons-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'once' }),
    }), env);
    expect(await consent?.json()).toEqual({ ok: true });

    const model = await handleCliRequest(cliRequest('/api/cli/agents/jarvis/model', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: 'openai/gpt-5.1' }),
    }), env);
    expect(await model?.json()).toEqual({ ok: true, spec: 'openai/gpt-5.1' });

    const trigger = await handleCliRequest(cliRequest('/api/cli/agents/jarvis/triggers/timer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ atMs: 123, label: 'wake' }),
    }), env);
    expect(trigger?.status).toBe(201);
    expect(await trigger?.json()).toMatchObject({ id: 'trg_1', nextFireAt: 123 });

    const jobs = await handleCliRequest(cliRequest('/api/cli/agents/jarvis/jobs?limit=7'), env);
    expect(await jobs?.json()).toEqual([{ id: 'job_1', kind: 'run', status: 'running' }]);

    const cancel = await handleCliRequest(cliRequest('/api/cli/agents/jarvis/jobs/job_1', { method: 'DELETE' }), env);
    expect(await cancel?.json()).toEqual({ ok: true });

    expect(await (await handleCliRequest(cliRequest('/api/cli/agents/jarvis/state'), env))?.json()).toMatchObject({ status: { name: 'jarvis' } });
    expect(await (await handleCliRequest(cliRequest('/api/cli/agents/jarvis/stop', { method: 'POST' }), env))?.json()).toMatchObject({ ok: true, abortedTools: 1 });
    expect(await (await handleCliRequest(cliRequest('/api/cli/agents/jarvis/memory?q=repo&limit=3'), env))?.json()).toEqual([{ path: 'memory/MEMORY.md', snippet: 'hit', score: 1 }]);
    expect(await (await handleCliRequest(cliRequest('/api/cli/agents/jarvis/events?limit=4'), env))?.json()).toEqual({ events: [{ id: 'evt_1' }] });
    expect(await (await handleCliRequest(cliRequest('/api/cli/agents/jarvis/timeline?limit=5'), env))?.json()).toEqual([{ label: 'turn' }]);
    expect(await (await handleCliRequest(cliRequest('/api/cli/agents/jarvis/mcts'), env))?.json()).toEqual([{ id: 'root' }]);
    expect(await (await handleCliRequest(cliRequest('/api/cli/agents/jarvis/mcts/root'), env))?.json()).toEqual({ id: 'root' });
    expect(await (await handleCliRequest(cliRequest('/api/cli/agents/jarvis/heads?limit=6'), env))?.json()).toEqual([{ rootId: 'head-root' }]);
    expect(await (await handleCliRequest(cliRequest('/api/cli/agents/jarvis/gepa'), env))?.json()).toEqual([{ runId: 'gepa_1' }]);
    expect(await (await handleCliRequest(cliRequest('/api/cli/agents/jarvis/gepa/gepa_1'), env))?.json()).toMatchObject({ run: { runId: 'gepa_1' } });
    expect(await (await handleCliRequest(cliRequest('/api/cli/agents/jarvis/executors'), env))?.json()).toEqual([{ name: 'workspace', available: true }]);
    expect(await (await handleCliRequest(cliRequest('/api/cli/agents/jarvis/executors/workspace/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'pwd' }),
    }), env))?.json()).toEqual({ stdout: 'ok', exitCode: 0 });
    expect(await (await handleCliRequest(cliRequest('/api/cli/agents/jarvis/product'), env))?.json()).toEqual({ changes: [] });
    expect(await (await handleCliRequest(cliRequest('/api/cli/agents/jarvis/triggers/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'github', auth_mode: 'hmac', secret: 'secret' }),
    }), env))?.json()).toMatchObject({ trigger_id: 'trg_webhook' });

    expect(calls).toContain(`claim:${USER_ID}`);
    expect(calls).toContain('status');
    expect(calls).toContain('tools');
    expect(calls).toContain('messages:17');
    expect(calls).toContain('consents:list');
    expect(calls).toContain('consents:resolve:cons-1:once');
    expect(calls).toContain('model:set:openai/gpt-5.1');
    expect(calls).toContain('triggers:create:{"atMs":123,"label":"wake","trust":"owner"}');
    expect(calls).toContain('jobs:list:7');
    expect(calls).toContain('jobs:cancel:job_1');
    expect(calls).toContain('work:cancel');
    expect(calls).toContain('memory:search:repo:3');
    expect(calls).toContain('executors:exec:workspace:pwd');
    expect(calls).toContain('triggers:webhook:{"label":"github","auth_mode":"hmac","secret":"secret","trust":"owner"}');
  });
});
