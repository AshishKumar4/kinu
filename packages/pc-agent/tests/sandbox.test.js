/**
 * PC-daemon sandbox tests — policy plumbing at the protocol level (unit) plus
 * REAL enforcement through the actual `exec` handler where this host's
 * backend supports it (bwrap on this Linux box).
 */
const { describe, expect, test, afterAll } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildSandboxPolicy,
  clampSandboxMode,
  isPathWritable,
  buildSandboxedArgv,
  detectSandboxBackend,
  annotateDenial,
  sandboxReport,
  createHandler,
} = require('../src/index.js');

const backend = detectSandboxBackend();
const hasBwrap = backend === 'bwrap';

// Workspace in /var/tmp: visible inside the sandbox (unlike tmpfs'd /tmp).
const home = fs.mkdtempSync('/var/tmp/proteus-daemon-home-');
const env = { home, tmp: os.tmpdir() };
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

/** Drive the real handler; resolve with the rpc frame it sends back. */
function call(handler, method, params) {
  return new Promise((resolve) => {
    handler({ id: 'rpc-1', method, params }, { send: (data) => resolve(JSON.parse(data)) });
  });
}

describe('device sandbox policy (config + protocol plumbing)', () => {
  test('defaults: workspace-write rooted at $HOME + tmp, network OFF', () => {
    const p = buildSandboxPolicy(undefined, env);
    expect(p.mode).toBe('workspace-write');
    expect(p.writableRoots).toContain(home);
    expect(p.writableRoots).toContain(os.tmpdir());
    expect(p.network).toBe(false);
  });

  test('config can grant network or full; garbage modes fall back', () => {
    expect(buildSandboxPolicy({ network: true }, env).network).toBe(true);
    expect(buildSandboxPolicy({ mode: 'full' }, env).network).toBe(true);
    expect(buildSandboxPolicy({ mode: 'yolo' }, env).mode).toBe('workspace-write');
    expect(buildSandboxPolicy({ writableRoots: ['/data', 'rel/nope'] }, env).writableRoots).toContain('/data');
  });

  test('per-call override clamps DOWNWARD only', () => {
    expect(clampSandboxMode('workspace-write', 'read-only')).toBe('read-only');
    expect(clampSandboxMode('workspace-write', 'full')).toBe('workspace-write');
    expect(clampSandboxMode('read-only', 'full')).toBe('read-only');
    expect(clampSandboxMode('workspace-write', undefined)).toBe('workspace-write');
  });

  test('writeFile outside the writable roots is rejected with a structured escalation', async () => {
    const handler = createHandler({ rawConfig: undefined, backend: 'none', env });
    const res = await call(handler, 'writeFile', ['/etc/proteus-blocked.txt', 'x']);
    expect(res.error).toContain('sandbox_escalation');
    expect(res.error).toContain('outside writable roots');
    expect(fs.existsSync('/etc/proteus-blocked.txt')).toBe(false);
  });

  test('writeFile inside the writable roots succeeds', async () => {
    const handler = createHandler({ rawConfig: undefined, backend: 'none', env });
    const target = path.join(home, 'allowed.txt');
    const res = await call(handler, 'writeFile', [target, 'content']);
    expect(res.result).toEqual({ success: true });
    expect(fs.readFileSync(target, 'utf8')).toBe('content');
  });

  test('read-only config blocks writeFile everywhere', async () => {
    const handler = createHandler({ rawConfig: { mode: 'read-only' }, backend: 'none', env });
    const res = await call(handler, 'writeFile', [path.join(home, 'nope.txt'), 'x']);
    expect(res.error).toContain("mode 'read-only' permits no writes");
  });

  test('sandboxReport states mode, roots, and real enforcement for HELLO', () => {
    const report = sandboxReport(buildSandboxPolicy(undefined, env), backend);
    expect(report.mode).toBe('workspace-write');
    expect(report.backend).toBe(backend);
    expect(report.enforced).toEqual(
      backend === 'bwrap' ? { filesystem: true, network: true }
        : backend === 'unshare' ? { filesystem: false, network: true }
          : { filesystem: false, network: false },
    );
  });

  test('annotateDenial appends escalation on enforced EROFS, never on success', () => {
    const policy = buildSandboxPolicy(undefined, env);
    const annotated = annotateDenial(policy, { filesystem: true, network: true }, 1, 'touch: Read-only file system');
    expect(annotated).toContain('sandbox_escalation');
    expect(annotateDenial(policy, { filesystem: true, network: true }, 0, 'Read-only file system')).not.toContain('sandbox_escalation');
    expect(annotateDenial(policy, { filesystem: false, network: false }, 1, 'Read-only file system')).not.toContain('sandbox_escalation');
  });

  test('isPathWritable: traversal cannot escape, relative fails closed', () => {
    const p = buildSandboxPolicy(undefined, env);
    expect(isPathWritable(p, home + '/sub/file')).toBe(true);
    expect(isPathWritable(p, home + '/../etc/passwd')).toBe(false);
    expect(isPathWritable(p, 'relative.txt')).toBe(false);
  });

  test('full mode never wraps; none warns', () => {
    expect(buildSandboxedArgv({ mode: 'full', writableRoots: [], network: true }, 'bwrap', 'x').argv).toEqual(['/bin/sh', '-c', 'x']);
    const none = buildSandboxedArgv(buildSandboxPolicy(undefined, env), 'none', 'x');
    expect(none.warning).toContain('UNSANDBOXED');
  });
});

describe.skipIf(!hasBwrap)('device exec enforcement (REAL bwrap on this host)', () => {
  const handler = createHandler({ rawConfig: undefined, backend, env });

  test('exec write outside $HOME workspace fails with escalation', async () => {
    const res = await call(handler, 'exec', ['touch /etc/proteus-daemon-blocked']);
    expect(res.result.exitCode).not.toBe(0);
    expect(res.result.stderr).toContain('Read-only file system');
    expect(res.result.stderr).toContain('"kind":"sandbox_escalation"');
    expect(fs.existsSync('/etc/proteus-daemon-blocked')).toBe(false);
  });

  test('exec write inside the device workspace succeeds', async () => {
    const res = await call(handler, 'exec', [`echo hi > ${home}/exec-ok.txt && cat ${home}/exec-ok.txt`]);
    expect(res.result.exitCode).toBe(0);
    expect(res.result.stdout.trim()).toBe('hi');
  });

  test('per-call read-only override blocks a write the base policy allows', async () => {
    const res = await call(handler, 'exec', [`touch ${home}/should-block.txt`, { mode: 'read-only' }]);
    expect(res.result.exitCode).not.toBe(0);
    expect(res.result.stderr).toContain('"mode":"read-only"');
    expect(fs.existsSync(path.join(home, 'should-block.txt'))).toBe(false);
  });

  test('per-call full request is clamped back to workspace-write', async () => {
    const res = await call(handler, 'exec', ['touch /etc/proteus-daemon-clamped', { mode: 'full' }]);
    expect(res.result.exitCode).not.toBe(0);
    expect(fs.existsSync('/etc/proteus-daemon-clamped')).toBe(false);
  });
});
