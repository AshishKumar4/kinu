/**
 * REAL OS-sandbox enforcement tests. These spawn actual processes under the
 * backend this host supports (bwrap on this Linux box) and assert the OS
 * blocks what the policy forbids. Tests for backends the host lacks are
 * skipped with explicit markers — whatever runs here is real enforcement,
 * not mocks.
 */
import { afterAll, describe, expect, test, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveSandboxPolicy, type SandboxBackend, type SandboxPolicy } from '@proteus/core';
import { detectSandboxBackend, type HostSandbox } from '../src/sandbox.js';
import { createHostShell, createCLIRuntime } from '../src/runtime.js';
import { createSandboxedExecutor } from '../src/executor.js';
import { Database } from 'bun:sqlite';

const backend = detectSandboxBackend();
const hasBwrap = backend === 'bwrap';
const hasCurl = Bun.which('curl') !== null;

// /tmp is tmpfs-shadowed under 'read-only', so the test workspace lives in
// /var/tmp where the host filesystem is visible inside the sandbox.
const workspace = mkdtempSync('/var/tmp/proteus-sandbox-test-');
const outsideTarget = join(homedir(), `.proteus-sandbox-canary-${Date.now()}`);
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outsideTarget, { force: true });
});

const sandbox = (policy: SandboxPolicy, b: SandboxBackend = backend): HostSandbox =>
  ({ backend: b, getPolicy: () => policy });
const wsWrite = (network = false) =>
  resolveSandboxPolicy({ mode: 'workspace-write', workspaceRoot: workspace, tmpDir: '/tmp', network });
const readOnly = resolveSandboxPolicy({ mode: 'read-only', workspaceRoot: workspace });
const full = resolveSandboxPolicy({ mode: 'full', workspaceRoot: workspace });

/** Serve on loopback so network tests need no internet. */
async function withLocalServer(fn: (url: string) => Promise<void>): Promise<void> {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('proteus-net-ok') });
  try {
    await fn(`http://127.0.0.1:${server.port}/`);
  } finally {
    server.stop(true);
  }
}

describe.skipIf(!hasBwrap)('bwrap enforcement (REAL on this host)', () => {
  test('workspace-write: a write outside the workspace FAILS and surfaces escalation', async () => {
    const shell = createHostShell(workspace, sandbox(wsWrite()));
    const result = await shell.exec(`touch ${outsideTarget}`);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Read-only file system');
    expect(result.stderr).toContain('"kind":"sandbox_escalation"');
    expect(result.stderr).toContain('"blocked":"filesystem"');
    expect(result.stderr).toContain('mode=workspace-write');
    expect(existsSync(outsideTarget)).toBe(false);
  });

  test('workspace-write: writes inside the workspace succeed', async () => {
    const shell = createHostShell(workspace, sandbox(wsWrite()));
    const result = await shell.exec('echo hello > inside.txt && cat inside.txt');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(existsSync(join(workspace, 'inside.txt'))).toBe(true);
  });

  test('read-only: blocks writes INSIDE the workspace too', async () => {
    const shell = createHostShell(workspace, sandbox(readOnly));
    const result = await shell.exec('touch blocked-in-ws.txt');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Read-only file system');
    expect(result.stderr).toContain('"kind":"sandbox_escalation"');
    expect(existsSync(join(workspace, 'blocked-in-ws.txt'))).toBe(false);
  });

  test.skipIf(!hasCurl)('network: blocked by default in workspace-write, allowed in full', async () => {
    await withLocalServer(async (url) => {
      const blocked = await createHostShell(workspace, sandbox(wsWrite())).exec(`curl -sS --max-time 3 ${url}`);
      expect(blocked.exitCode).not.toBe(0);
      expect(blocked.stdout).not.toContain('proteus-net-ok');
      expect(blocked.stderr).toContain('"kind":"sandbox_escalation"');
      expect(blocked.stderr).toContain('"blocked":"network"');

      const allowed = await createHostShell(workspace, sandbox(full)).exec(`curl -sS --max-time 3 ${url}`);
      expect(allowed.exitCode).toBe(0);
      expect(allowed.stdout).toContain('proteus-net-ok');
    });
  });

  test.skipIf(!hasCurl)('network: workspace-write with network granted reaches the server', async () => {
    await withLocalServer(async (url) => {
      const result = await createHostShell(workspace, sandbox(wsWrite(true))).exec(`curl -sS --max-time 3 ${url}`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('proteus-net-ok');
    });
  });

  test('codemode executor: read-only blocks fs writes from LLM code', async () => {
    const executor = createSandboxedExecutor(sandbox(readOnly));
    const result = await executor.execute(
      `require('fs').writeFileSync(${JSON.stringify(join(workspace, 'from-code.txt'))}, 'x'); 'wrote'`,
    );
    expect(result.result).toBeUndefined();
    expect(result.error).toContain('read-only');
    expect(result.error).toContain('"kind":"sandbox_escalation"');
    expect(existsSync(join(workspace, 'from-code.txt'))).toBe(false);
  });

  test('codemode executor: normal evaluation still works sandboxed', async () => {
    const result = await createSandboxedExecutor(sandbox(wsWrite())).execute('7 * 6');
    expect(result).toEqual({ result: 42 });
  });
});

// unshare is independently usable on this host even though bwrap wins the
// probe — exercise the degraded fallback for real.
const unshareUsable = Bun.spawnSync(['unshare', '-Ucn', '/bin/true']).exitCode === 0;
describe.skipIf(!unshareUsable)('unshare fallback (REAL on this host)', () => {
  test.skipIf(!hasCurl)('blocks network but warns that filesystem enforcement is missing', async () => {
    const warn = spyOn(console, 'warn');
    try {
      await withLocalServer(async (url) => {
        const shell = createHostShell(workspace, sandbox(wsWrite(), 'unshare'));
        const result = await shell.exec(`curl -sS --max-time 3 ${url}`);
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).not.toContain('proteus-net-ok');
      });
      const warning = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('bwrap'));
      expect(warning).toContain('NOT enforced');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('no-backend degradation', () => {
  test('runs UNSANDBOXED with a loud warning naming what is missing', async () => {
    const warn = spyOn(console, 'warn');
    try {
      const shell = createHostShell(workspace, sandbox(readOnly, 'none'));
      const result = await shell.exec('echo still-works');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('still-works');
      const warning = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('UNSANDBOXED'));
      expect(warning).toBeDefined();
      expect(warning).toContain('bwrap');
      expect(warning).toContain('sandbox-exec');
      expect(warning).toContain("mode 'read-only'");
    } finally {
      warn.mockRestore();
    }
  });
});

describe('runtime wiring', () => {
  test('createCLIRuntime defaults to workspace-write from the config store', async () => {
    const dir = mkdtempSync('/var/tmp/proteus-rt-test-');
    try {
      const db = new Database(join(dir, 'agent.db'));
      const rt = createCLIRuntime(db as never, {
        dbPath: join(dir, 'agent.db'),
        llm: { name: 'x', baseURL: 'http://localhost', headers: {}, model: 'm' },
      });
      // The host shell enforces the default policy: cwd is writable…
      const inside = await rt.shell!.exec('echo ok > rt-inside.txt');
      expect(inside.exitCode).toBe(0);
      if (hasBwrap) {
        // …and outside the workspace is not (REAL enforcement via bwrap).
        const outside = await rt.shell!.exec(`touch ${outsideTarget}`);
        expect(outside.exitCode).not.toBe(0);
        expect(outside.stderr).toContain('"kind":"sandbox_escalation"');
        expect(existsSync(outsideTarget)).toBe(false);
      }
      db.close();
    } finally {
      rmSync(join(process.cwd(), 'rt-inside.txt'), { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
