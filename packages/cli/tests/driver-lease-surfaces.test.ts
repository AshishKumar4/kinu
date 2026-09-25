/**
 * Interactive client vs scheduler daemon for one conversation's driver lease: both hold one SQLite
 * file and `EventLog.markConsumed` has no compare-and-set. The rival is a real `sleep` process
 * holding the lease, since the lease only asks whether the holder's pid exists.
 */
import { runToExit } from '@kinu.run/test-utils';
import { scratchDir } from '../../test-utils/src/scratch';

import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parseJsonObject, type JsonObject } from '@kinu.run/core';
import * as v from 'valibot';

const repoRoot = resolve(__dirname, '../../..');

function freshDir(prefix: string): string {
  const dir = scratchDir(prefix);

  return dir;
}

/** One placed agent, then `body` under the scenario's home; `rivalHolds(kind)` gives the lease to a sleeping process. */
function printed(result: JsonObject, key: string): string {
  const value = v.parse(v.union([v.string(), v.number(), v.boolean()]), result[key]);

  return String(value);
}

async function scenario(body: string): Promise<JsonObject> {
  const home = freshDir('kinu-lease-home-');
  const project = freshDir('kinu-lease-project-');

  const script = `
    const { mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { Database } = await import('bun:sqlite');
    const { createWorkspace } = await import('@kinu.run/core/identity');
    const { initWorkspaceSchema } = await import('@kinu.run/core');
    const { DriverLeaseHold, makeExecRaw, makeSql, makeWorkspaceSchemaSql } =
      await import('./packages/cli-backend/src/index.ts');
    const { leaseHolder } = await import('./packages/cli-backend/tests/driver-lease-probe.ts');
    const { resolveLLMConfig, upsertAgentConfig } = await import('./packages/cli/src/config.ts');
    const { openLocalAgentClient } = await import('./packages/cli/src/local-agent-client.ts');
    const { daemonCommand } = await import('./packages/cli/src/commands/daemon.ts');

    const dir = join(process.env.KINU_HOME, 'leasebot');
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'agent.db');
    {
      const seed = new Database(dbPath);
      seed.exec('PRAGMA journal_mode = WAL');
      await createWorkspace(seed, { name: 'leasebot', purpose: 'lease', llm: resolveLLMConfig() });
      initWorkspaceSchema(makeWorkspaceSchemaSql(seed));
      seed.close();
    }
    const now = new Date().toISOString();
    await upsertAgentConfig({
      name: 'leasebot', mode: 'local', localName: 'leasebot',
      cwd: process.env.KINU_PROJECT, workspaceId: 'lease',
      createdAt: now, updatedAt: now,
    });

    const rivals = [];
    function rivalHolds(kind) {
      const rival = Bun.spawn({ cmd: ['sleep', '120'], stdout: 'ignore', stderr: 'ignore' });
      rivals.push(rival);
      const db = new Database(dbPath);
      try {
        const hold = new DriverLeaseHold({
          sql: makeSql(db), execRaw: makeExecRaw(db),
          proc: { pid: rival.pid, isAlive: () => true },
        }, kind);
        if (hold.acquire()) throw new Error('the rival could not take the lease');
        return rival.pid;
      } finally { db.close(); }
    }
    function holder() {
      const db = new Database(dbPath);
      try { return leaseHolder(db); } finally { db.close(); }
    }

    try {
      ${body}
    } finally {
      for (const rival of rivals) rival.kill();
      // An opened client leaves live work behind on purpose — the detached
      // titling call, the session's own alarm — and this scenario's whole job is
      // the one JSON line above, so it exits rather than waiting the loop out.
      process.exit(0);
    }
  `;

  const proc = await runToExit([process.execPath, '-e', script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      KINU_HOME: home,
      KINU_PROJECT: project,
      // The daemon must never auto-start: the scripted rival is the only other driver.
      KINU_SKIP_DAEMON: '1',
      // An endpoint nothing connects to: opening a client and taking the lease must not need the network.
      KINU_BASE_URL: 'http://127.0.0.1:1/v1',
      KINU_AUTH: 'Bearer offline',
      KINU_MODEL: '@cf/test/model',
      NO_COLOR: '1',
    },
  });

  if (proc.exitCode !== 0) {
    throw new Error(`lease scenario failed (${proc.exitCode}): ${proc.stderr}`);
  }

  return parseJsonObject(proc.stdout.trim().split('\n').at(-1) ?? '{}');
}

describe('the interactive client and the driver lease', () => {
  test('opening a client takes the conversation from a live daemon', async () => {
    const result = await scenario(`
      const daemonPid = rivalHolds('daemon');
      const client = await openLocalAgentClient('leasebot', { cwd: process.env.KINU_PROJECT });
      let opened = true;
      let failure = null;
      try { await client.connect(); } catch (error) { opened = false; failure = String(error?.message ?? error); }
      const after = holder();
      await client.close();
      console.log(JSON.stringify({
        opened, failure, daemonPid,
        heldKind: after?.kind ?? null, heldPid: after?.pid ?? null,
        us: process.pid,
        releasedOnClose: holder() === null,
      }));
    `);

    // A person waiting at a prompt outranks background maintenance.
    expect(result.opened).toBe(true);
    expect(result.heldKind).toBe('interactive');
    expect(result.heldPid).toBe(result.us);
    expect(result.heldPid).not.toBe(result.daemonPid);
    expect(result.releasedOnClose).toBe(true);
  });

  test('a second interactive client is refused, and says who has the conversation', async () => {
    const result = await scenario(`
      const otherPid = rivalHolds('interactive');
      const client = await openLocalAgentClient('leasebot', { cwd: process.env.KINU_PROJECT });
      let opened = true;
      let failure = null;
      try { await client.connect(); } catch (error) { opened = false; failure = String(error?.message ?? error); }
      const after = holder();
      await client.close();
      console.log(JSON.stringify({
        opened, failure, otherPid,
        heldKind: after?.kind ?? null, heldPid: after?.pid ?? null,
      }));
    `);

    // A second person is told before they can type into the conversation.
    expect(result.opened).toBe(false);
    expect(printed(result, 'failure')).toContain(printed(result, 'otherPid'));
    expect(printed(result, 'failure')).toContain('interactive');
    expect(result.heldKind).toBe('interactive');
    expect(result.heldPid).toBe(result.otherPid);
  });

  test('a foreground daemon tick reports a deferred pass instead of printing a tick', async () => {
    const result = await scenario(`
      const ownerPid = rivalHolds('interactive');
      const lines = [];
      const log = console.log;
      console.log = (...args) => { lines.push(args.join(' ')); };
      try {
        await daemonCommand('tick', 'leasebot');
      } finally {
        console.log = log;
      }
      log(JSON.stringify({ ownerPid, printed: lines.join('\\n'), heldPid: holder()?.pid ?? null }));
    `);

    // It names the holder instead of printing a tick it did not perform.
    expect(printed(result, 'printed')).toContain('deferred');
    expect(printed(result, 'printed')).toContain('leasebot');
    expect(printed(result, 'printed')).toContain(printed(result, 'ownerPid'));
    expect(printed(result, 'printed')).not.toContain('ticked');
    // A daemon never takes the conversation from a live person.
    expect(result.heldPid).toBe(result.ownerPid);
  });
});
