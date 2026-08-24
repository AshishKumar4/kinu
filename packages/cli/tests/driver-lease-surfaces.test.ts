/**
 * Who drives one local conversation, at the two PRODUCT surfaces that compete
 * for it: the interactive client `kinu chat`/`run`/the TUI open, and the
 * scheduler daemon's foreground pass.
 *
 * They really do compete. Every interactive surface auto-starts the resident
 * daemon, so two processes hold one SQLite file open and both drive the same
 * durable work — the pending event drain, the trigger registry, the queued-turn
 * pump — and `EventLog.markConsumed` has no compare-and-set predicate.
 *
 * Both surfaces read `~/.kinu` bound at import, so each scenario runs in its own
 * process with its own `KINU_HOME`. The rival driver is a real sleeping OS
 * process whose pid is written into the lease through the lease's own API: the
 * only fact the lease asks about a holder is whether its pid still exists, so a
 * `sleep` child is genuinely another driver and the surface under test runs
 * against the real `OS_LEASE_PROCESS` with nothing substituted.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { parseJsonObject, type JsonObject } from '@kinu.run/core';

const repoRoot = resolve(__dirname, '../../..');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * One agent placed in one project, exactly as `kinu create` records it, then
 * `body` — which runs with the real production modules imported under the
 * scenario's own home.
 *
 * `rivalHolds(kind)` is available to the body: it spawns a sleeping process and
 * gives it the lease. Killing it is left to process exit, which is the honest
 * end for a driver that went away without releasing.
 */
function scenario(body: string): JsonObject {
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
    upsertAgentConfig({
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
  const proc = Bun.spawnSync({
    cmd: [process.execPath, '-e', script],
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      KINU_HOME: home,
      KINU_PROJECT: project,
      // The daemon must never be auto-started by a scenario: the rival is the
      // only other driver here, and it is a scripted one.
      KINU_SKIP_DAEMON: '1',
      // An endpoint nothing connects to. Opening a client and taking the lease
      // must not need the network, and this proves they did not.
      KINU_BASE_URL: 'http://127.0.0.1:1/v1',
      KINU_AUTH: 'Bearer offline',
      KINU_MODEL: '@cf/test/model',
      NO_COLOR: '1',
    },
  });
  if (proc.exitCode !== 0) {
    throw new Error(`lease scenario failed (${proc.exitCode}): ${proc.stderr.toString()}`);
  }
  return parseJsonObject(proc.stdout.toString().trim().split('\n').at(-1) ?? '{}');
}

describe('the interactive client and the driver lease', () => {
  test('opening a client takes the conversation from a live daemon', () => {
    const result = scenario(`
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
    // And it hands the conversation back, so the daemon can drive it again.
    expect(result.releasedOnClose).toBe(true);
  });

  test('a second interactive client is refused, and says who has the conversation', () => {
    const result = scenario(`
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

    // Two people driving one conversation is the interleaving this prevents, so
    // the second one is told before it can type into it.
    expect(result.opened).toBe(false);
    expect(String(result.failure)).toContain(String(result.otherPid));
    expect(String(result.failure)).toContain('interactive');
    // The refusal changed nothing, and closing did not evict the live holder.
    expect(result.heldKind).toBe('interactive');
    expect(result.heldPid).toBe(result.otherPid);
  });

  test('a foreground daemon tick reports a deferred pass instead of printing a tick', () => {
    const result = scenario(`
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

    // The command used to print a tick it had not performed. It now names the
    // holder, which is also the answer to "why did nothing happen?".
    expect(String(result.printed)).toContain('deferred');
    expect(String(result.printed)).toContain('leasebot');
    expect(String(result.printed)).toContain(String(result.ownerPid));
    expect(String(result.printed)).not.toContain('ticked');
    // A daemon never takes the conversation from a live person.
    expect(result.heldPid).toBe(result.ownerPid);
  });
});
