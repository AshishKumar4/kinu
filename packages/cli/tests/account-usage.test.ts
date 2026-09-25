// /stats counts spend per provider account over every workspace this person holds: each local workspace on
// this machine and, when signed in, the cloud ones. A source it cannot read is named, never counted as zero.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as v from 'valibot';
import {
  AccountUsageSchema, initWorkspaceSchema, openWorkspaceMainActor,
  type AccountUsage, type CallAccount, type LLMProviderConfig, type Usage,
} from '@kinu.run/core';
import { createWorkspace } from '@kinu.run/core/workspace-birth';
import { makeSql, makeWorkspaceSchemaSql } from '@kinu.run/cli-backend';
import { scratchDir } from '@kinu.run/test-utils';

const repoRoot = resolve(import.meta.dir, '../../..');

const DUMMY_LLM: LLMProviderConfig = { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' };

/** A local workspace whose ledger holds one model call per entry, each paid by `account`. */
async function localWorkspace(home: string, name: string, calls: ReadonlyArray<{ usage: Usage; usd: number; account: CallAccount }>) {
  mkdirSync(join(home, name), { recursive: true });
  const db = new Database(join(home, name, 'agent.db'));

  try {
    await createWorkspace(db, { name, purpose: 'Spend fixture', llm: DUMMY_LLM });
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const actorId = openWorkspaceMainActor(makeSql(db)).actorId;

    for (const [index, call] of calls.entries()) {
      const at = new Date(index * 1_000).toISOString();

      db.run('INSERT INTO run_events (actor_id, run_id, event_index, type, payload, ts) VALUES (?, ?, ?, \'model_call\', ?, ?)', [
        actorId, 'workspace', index, JSON.stringify({ source: 'fast', ...call, eventIndex: index, runId: 'workspace', timestamp: at }), at,
      ]);
    }
  } finally {
    db.close();
  }
}

/** The CLI's own reader, in a process whose home is `home`. */
async function readUsage(home: string, env: Record<string, string> = {}): Promise<AccountUsage> {
  const proc = Bun.spawn([process.execPath, '-e', `
    const { readAllAccountUsage } = await import('./packages/cli/src/account-usage.ts');
    console.log(JSON.stringify(await readAllAccountUsage()));
  `], { cwd: repoRoot, env: { ...process.env, KINU_HOME: home, KINU_TOKEN: '', OPENROUTER_API_KEY: '', ...env }, stdout: 'pipe', stderr: 'pipe' });

  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(exitCode, stderr).toBe(0);

  return v.parse(AccountUsageSchema, JSON.parse(stdout.trim().split('\n').at(-1) ?? ''));
}

const work = (remaining: number, at: number): CallAccount => ({
  provider: 'anthropic', name: 'work', quota: { at, windows: [{ measure: 'requests', limit: 50, remaining }] },
});

describe('/stats reads every workspace this person holds', () => {
  test('the local workspaces on this machine add up per account, with the account\'s newest quota', async () => {
    const home = scratchDir('usage-local');
    await localWorkspace(home, 'alpha', [{ usage: { input: 100, output: 10 }, usd: 0.5, account: work(40, 1_000) }]);
    await localWorkspace(home, 'beta', [
      { usage: { input: 200, output: 20 }, usd: 0.25, account: work(12, 3_000) },
      { usage: { input: 5 }, usd: 0.125, account: { provider: 'openai', name: 'main' } },
    ]);

    const usage = await readUsage(home);

    expect(usage.workspaces).toBe(2);
    expect(usage.unread).toEqual([]);
    expect(usage.accounts.map((row) => [row.provider, row.account, row.calls, row.usd])).toEqual([
      ['anthropic', 'work', 2, 0.75], ['openai', 'main', 1, 0.125],
    ]);
    expect(usage.accounts[0]?.usage).toEqual({ input: 300, output: 30 });
    expect(usage.accounts[0]?.quota?.windows[0]?.remaining).toBe(12);
  });

  test('signed in, the cloud workspaces join the local ones, and a cloud workspace it could not read is named', async () => {
    const home = scratchDir('usage-cloud');
    await localWorkspace(home, 'alpha', [{ usage: { input: 100, output: 10 }, usd: 0.5, account: work(40, 1_000) }]);

    const cloud: AccountUsage = {
      accounts: [{
        provider: 'anthropic', account: 'work', calls: 3, callsWithoutUsage: 0, unpricedCalls: 0,
        usage: { input: 900, output: 90 }, usd: 1.5,
        quota: { at: 5_000, windows: [{ measure: 'requests', limit: 50, remaining: 3 }] },
      }],
      workspaces: 2,
      unread: ['cloud-gone'],
      limits: [{ provider: 'codex', account: 'work', at: 5_000, windows: [{ name: '5h', usedPercent: 40, resetsAt: 9_000 }] }],
    };

    const seen: string[] = [];

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(`${new URL(request.url).pathname} ${request.headers.get('authorization') ?? ''}`);

        return Response.json(cloud);
      },
    });

    try {
      const usage = await readUsage(home, { KINU_ORIGIN: `http://127.0.0.1:${String(server.port)}`, KINU_TOKEN: 'pta_fixture' });

      expect(seen).toEqual(['/api/cli/usage Bearer pta_fixture']);
      expect(usage.workspaces).toBe(3);
      expect(usage.unread).toEqual(['cloud-gone']);
      expect(usage.accounts.map((row) => [row.provider, row.account, row.calls, row.usd])).toEqual([['anthropic', 'work', 4, 2]]);
      expect(usage.accounts[0]?.quota?.windows[0]?.remaining).toBe(3);
      expect(usage.limits).toEqual(cloud.limits);
    } finally {
      await server.stop(true);
    }
  });

  test('a cloud it cannot reach is named, and the local workspaces still count', async () => {
    const home = scratchDir('usage-offline');
    await localWorkspace(home, 'alpha', [{ usage: { input: 100, output: 10 }, usd: 0.5, account: work(40, 1_000) }]);

    const usage = await readUsage(home, { KINU_ORIGIN: 'http://127.0.0.1:9', KINU_TOKEN: 'pta_fixture' });

    expect(usage.workspaces).toBe(1);
    expect(usage.unread).toEqual(['your cloud workspaces']);
    expect(usage.accounts.map((row) => [row.provider, row.account, row.calls])).toEqual([['anthropic', 'work', 1]]);
  });
});
