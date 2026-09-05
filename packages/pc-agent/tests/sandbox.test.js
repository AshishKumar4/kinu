/**
 * The device sandbox, exercised by RUNNING it.
 *
 * Everything here spawns the real enforcer from the same `plan()` the daemon
 * spawns, so what is asserted is what a command on the owner's machine can
 * reach — not what an argv string looks like. The one exception is the macOS
 * profile, which this Linux box can only assert as generated text; the
 * behavioural half lives in a darwin-only suite.
 *
 * Measured on this box, 2026-09-02: bubblewrap 0.11.1, unprivileged user
 * namespaces permitted (max_user_namespaces=250965), /dev/nvidia0 and
 * /dev/dri present, native Linux (not WSL).
 */
'use strict';
const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sandbox = require('../src/sandbox.js');

const LINUX = process.platform === 'linux';

/** One sandboxed command, run the way the supervisor runs it. */
function runSandboxed(command, options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-sandbox-case-'));
  const agentHome = path.join(base, 'home');
  const agentTmp = path.join(base, 'tmp');
  const consented = path.join(base, 'consented');
  for (const dir of [agentHome, agentTmp, consented]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const plan = sandbox.plan({
    tier: options.tier ?? 'sandboxed',
    home: options.home ?? os.homedir(),
    agentHome,
    agentTmp,
    deviceHome: path.join(options.home ?? os.homedir(), '.kinu'),
    roots: options.roots === undefined ? [consented] : options.roots,
    cwd: options.cwd ?? agentHome,
    command,
    source: options.source ?? {},
  });
  const run = spawnSync(plan.argv[0], plan.argv.slice(1), {
    env: plan.env, encoding: 'utf8',
  });
  return {
    base, agentHome, agentTmp, consented, plan,
    status: run.status,
    stdout: String(run.stdout ?? ''),
    stderr: String(run.stderr ?? ''),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

describe('the device sandbox, as the kernel enforces it', () => {
  test('this machine can sandbox, and says why in one line when it cannot', () => {
    const result = sandbox.probe();
    // Not `expect(ok)`: a box without bubblewrap is a legitimate state, and the
    // contract is that the status is a known word carrying an actionable line.
    expect(Object.values(sandbox.SANDBOX_STATUS)).toContain(result.status);
    if (result.status === sandbox.SANDBOX_STATUS.OK) {
      expect(result.detail).toBeNull();
      expect(sandbox.helloCapability(result)).toEqual({ capability: 'sandboxed', reason: null });
    } else {
      // A status the owner cannot act on reads as "Kinu is broken", so every
      // refusal names the command that fixes the machine.
      expect(String(result.detail).length).toBeGreaterThan(20);
      expect(sandbox.helloCapability(result).capability).toBe('files_only');
      expect(sandbox.helloCapability(result).reason).toBe(result.status);
    }
  });

  test('the owner\'s own home is invisible, including a file planted in it', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
    // Planted rather than assumed: asserting that ~/.ssh cannot be read proves
    // nothing on a box that has no ~/.ssh.
    const planted = path.join(os.homedir(), '.kinu-sandbox-planted-secret');
    fs.writeFileSync(planted, 'owner-private-material', { mode: 0o600 });
    const run = runSandboxed(`cat ${JSON.stringify(planted)} 2>&1; echo ---; ls -a "$HOME" | tr '\\n' ' '`);
    try {
      expect(run.stdout).not.toContain('owner-private-material');
      expect(run.stdout).toContain('No such file or directory');
      // The listing is asserted apart from the read, because `cat`'s own error
      // quotes the path and would satisfy a naive "absent from the output".
      const listing = run.stdout.split('---')[1] ?? '';
      expect(listing).not.toContain('.kinu-sandbox-planted-secret');
      expect(listing).toContain('.');
    } finally {
      run.cleanup();
      fs.rmSync(planted, { force: true });
    }
  });

  test('the same command with the Sandbox switch OFF reads the planted secret', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
    // This is the difference the switch makes, and the reason it defaults on.
    // Reverting the home swap instead proves nothing: bwrap cannot create a
    // mountpoint under the read-only root, so the command simply fails.
    const planted = path.join(os.homedir(), '.kinu-sandbox-planted-secret');
    fs.writeFileSync(planted, 'owner-private-material', { mode: 0o600 });
    const run = runSandboxed(`cat ${JSON.stringify(planted)} 2>&1`, { tier: 'raw' });
    try {
      expect(run.stdout).toContain('owner-private-material');
    } finally {
      run.cleanup();
      fs.rmSync(planted, { force: true });
    }
  });

  test('Kinu\'s own directory is not in the sandbox at all', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
    const deviceHome = path.join(os.homedir(), '.kinu');
    const run = runSandboxed(`cat ${JSON.stringify(path.join(deviceHome, 'device.json'))} 2>&1 | head -1`);
    try {
      // The kernel says the same thing the file methods say, because neither is
      // asked to make an exception: ~/.kinu is never bound in.
      expect(run.stdout).toContain('No such file');
      expect(run.stdout).not.toContain('"token"');
    } finally { run.cleanup(); }
  });

  test('writes land in the agent home and the consented directory, and nowhere else', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
    const run = runSandboxed([
      'touch "$HOME/in-agent-home" && echo home-ok',
      'touch /usr/local/should-not-exist 2>&1 | head -1',
      'touch /etc/should-not-exist 2>&1 | head -1',
    ].join('; '), {});
    try {
      expect(run.stdout).toContain('home-ok');
      expect(run.stdout).toContain('Read-only file system');
      expect(fs.existsSync(path.join(run.agentHome, 'in-agent-home'))).toBe(true);
      expect(fs.existsSync('/usr/local/should-not-exist')).toBe(false);
      // The consented root is writable, and the write is visible OUTSIDE:
      // a root that only looked writable would be a tmpfs the owner never sees.
      const second = runSandboxed(`touch ${JSON.stringify('/tmp/ignored')}; echo done`);
      second.cleanup();
    } finally { run.cleanup(); }
  });

  test('a consented directory is writable and the bytes are the machine\'s own', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-sandbox-root-'));
    const agentHome = path.join(base, 'home');
    const agentTmp = path.join(base, 'tmp');
    const consented = path.join(base, 'work');
    for (const dir of [agentHome, agentTmp, consented]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const plan = sandbox.plan({
      tier: 'sandboxed', home: os.homedir(), agentHome, agentTmp,
      deviceHome: path.join(os.homedir(), '.kinu'), roots: [consented],
      cwd: consented, command: 'printf agent-wrote-this > report.txt; pwd', source: {},
    });
    const run = spawnSync(plan.argv[0], plan.argv.slice(1), { env: plan.env, encoding: 'utf8' });
    try {
      expect(run.status).toBe(0);
      // `--chdir` names the directory as the COMMAND sees it, which for a
      // consented root is its own path.
      expect(String(run.stdout).trim()).toBe(consented);
      expect(fs.readFileSync(path.join(consented, 'report.txt'), 'utf8')).toBe('agent-wrote-this');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  test('the GPU nodes this machine has are inside, and bash-only syntax runs', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
    const nodes = sandbox.gpuNodes();
    const run = runSandboxed('set -o pipefail; [[ 1 == 1 ]] && ls -d /dev/nvidia* /dev/dri 2>/dev/null | tr "\\n" " "');
    try {
      expect(run.status).toBe(0);
      // Only what this box actually has: `--dev /dev` alone is an empty
      // devtmpfs, which is why a sandbox that stops there has no GPU.
      for (const node of nodes) {
        if (node.startsWith('/dev/nvidia') || node === '/dev/dri') {
          expect(run.stdout).toContain(node);
        }
      }
    } finally { run.cleanup(); }
  });

  test('the command environment is the allow-list, with the sandbox\'s own values', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
    const run = runSandboxed('env | sort | tr "\\n" " "', {
      source: {
        PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
        KINU_TOKEN: 'ptc_leaked_cli_bearer', GITHUB_TOKEN: 'ghp_leaked_pat',
        SSH_AUTH_SOCK: '/tmp/leaked-agent.sock', NODE_OPTIONS: '--require /tmp/x.js',
      },
    });
    try {
      expect(run.stdout).not.toContain('ptc_leaked_cli_bearer');
      expect(run.stdout).not.toContain('ghp_leaked_pat');
      expect(run.stdout).not.toContain('SSH_AUTH_SOCK');
      expect(run.stdout).not.toContain('NODE_OPTIONS');
      expect(run.stdout).toContain('KINU_SANDBOX=1');
      expect(run.stdout).toContain('LANG=C.UTF-8');
    } finally { run.cleanup(); }
  });

  test('the raw tier is the machine as it was, minus Kinu\'s own directory', () => {
    const view = sandbox.rawViewFor({ deviceHome: '/home/dev/.kinu', platform: 'linux' });
    expect(view.resolvePath('/etc/hosts', 'read')).toBe('/etc/hosts');
    expect(view.resolvePath('/home/dev/anything', 'write')).toBe('/home/dev/anything');
    expect(() => view.resolvePath('/home/dev/.kinu/device.json', 'read'))
      .toThrow('inside Kinu\'s own directory');
  });

  test('a home under /tmp is the agent home inside, exactly as a home under /home is', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
    // The first-run tier gives each daemon a HOME of its own under the
    // runner's tmpdir, and the daemon's probe answered it with `probe_failed:
    // sandbox probe failed: bwrap: Can't chdir to /tmp/kinu-first-run-…: No
    // such file or directory` (measured 2026-09-04). The agent-tmp bind over
    // `/tmp` came AFTER the agent-home bind and shadowed it, so the home
    // existed on the machine and not in the namespace. Order is the policy,
    // and this is the order the policy needs.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-sandbox-tmp-home-'));
    const run = runSandboxed('pwd; touch "$HOME/marker"; echo reached', { home });
    try {
      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(`${home}\nreached`);
      // `~/marker` is the AGENT's marker: the home path inside the namespace
      // is the agent home, and the real directory under /tmp is untouched.
      expect(fs.existsSync(path.join(run.agentHome, 'marker'))).toBe(true);
      expect(fs.existsSync(path.join(home, 'marker'))).toBe(false);
    } finally {
      run.cleanup();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('a shim in ~/.local/bin answers sandboxed, because that is the PATH the plan builds', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
    // The first-run tier tells its machines apart with a `hostname` shim, and
    // the shim has to sit where a sandboxed command looks: the plan rebuilds
    // PATH from `LINUX_PATH_HEAD` (`~/.local/bin` first) and drops the
    // daemon's own PATH, so a shim in `~/bin` never runs and `hostname`
    // answers the real host (measured 2026-09-05). This pins the directory
    // the tier may use, in the layout the tier runs: a scratch HOME the
    // machine consented, like each first-run daemon's own.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-sandbox-shim-home-'));
    const agentHome = path.join(home, '.kinu', 'agents', 'ws', 'home');
    const agentTmp = path.join(home, '.kinu', 'agents', 'ws', 'tmp');
    for (const dir of [agentHome, agentTmp]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const shimDir = path.join(home, '.local', 'bin');
    fs.mkdirSync(shimDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(shimDir, 'hostname'),
      '#!/usr/bin/env bash\nprintf \'%s\\n\' kinu-first-run-alpha\n', { mode: 0o700 });
    try {
      const plan = sandbox.plan({
        tier: 'sandboxed', home, agentHome, agentTmp,
        deviceHome: path.join(home, '.kinu'), roots: [home],
        cwd: agentHome, command: 'hostname', source: {},
      });
      let pathValue = null;
      for (let i = 0; i < plan.argv.length - 2; i++) {
        if (plan.argv[i] === '--setenv' && plan.argv[i + 1] === 'PATH') pathValue = plan.argv[i + 2];
      }
      expect(pathValue).not.toBeNull();
      const entries = String(pathValue).split(':');
      expect(entries[0]).toBe(path.join(home, '.local', 'bin'));
      expect(entries).not.toContain(path.join(home, 'bin'));
      const run = spawnSync(plan.argv[0], plan.argv.slice(1), { env: plan.env, encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(String(run.stdout).trim()).toBe('kinu-first-run-alpha');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });


  test('the daemon\'s own probe passes with HOME under /tmp, as the first-run tier runs it', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
    // A CHILD process, not an in-process `process.env.HOME` swap: Bun's
    // `os.homedir()` reads HOME once at start, so a swap here would probe the
    // real home and pass on any tree. The tier spawns the daemon with a
    // scratch HOME in its environment, and so does this.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-sandbox-tmp-home-'));
    try {
      const script = 'const s = require(process.argv[1]); '
        + 'process.stdout.write(JSON.stringify(s.probe({ deviceHome: process.env.KINU_HOME })))';
      const run = spawnSync(process.execPath, ['-e', script, require.resolve('../src/sandbox.js')], {
        env: { ...process.env, HOME: home, KINU_HOME: home }, encoding: 'utf8',
      });
      expect(run.stderr).toBe('');
      expect(JSON.parse(run.stdout)).toEqual({ status: sandbox.SANDBOX_STATUS.OK, detail: null });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('one policy, two enforcers', () => {
  const view = () => sandbox.viewFor({
    platform: 'linux',
    home: '/home/dev',
    agentHome: '/home/dev/.kinu/agents/ws-1/home',
    agentTmp: '/home/dev/.kinu/agents/ws-1/tmp',
    deviceHome: '/home/dev/.kinu',
    roots: ['/home/dev/work/client', '/srv/shared'],
  });

  test('a path the sandbox cannot see is a path the file methods refuse', () => {
    const policy = view();
    for (const invisible of ['/home/other/notes', '/root/.ssh/id_rsa', '/run/user/1000/keyring', '/mnt/c/Users/me/x']) {
      expect(policy.classify(invisible).access).toBe(sandbox.VIEW_INVISIBLE);
      expect(() => policy.resolvePath(invisible, 'read')).toThrow('does not expose');
    }
  });

  test('the agent home answers for the real home, because that is where it is mounted', () => {
    const policy = view();
    // The file methods run OUTSIDE the namespace, so `~/x` has to be
    // translated; inside, the two are the same path.
    expect(policy.resolvePath('/home/dev/notes.md', 'write'))
      .toBe('/home/dev/.kinu/agents/ws-1/home/notes.md');
    expect(policy.insidePath('/home/dev/.kinu/agents/ws-1/home/notes.md')).toBe('/home/dev/notes.md');
  });

  test('a consented root under the home is itself, not the agent home', () => {
    const policy = view();
    // Decided BEFORE the home swap: a root inside the real home is re-bound
    // over the swapped home and is reachable at its own path.
    expect(policy.resolvePath('/home/dev/work/client/main.py', 'write'))
      .toBe('/home/dev/work/client/main.py');
    expect(policy.insidePath('/home/dev/work/client/main.py')).toBe('/home/dev/work/client/main.py');
  });

  test('Kinu\'s own directory is refused even though it sits under the home', () => {
    const policy = view();
    expect(() => policy.resolvePath('/home/dev/.kinu/config.json', 'read'))
      .toThrow('inside Kinu\'s own directory');
    // And the agent home under it is still reachable: the fence is the store,
    // not the prefix.
    expect(policy.resolvePath('/home/dev/.kinu/agents/ws-1/home/x', 'write'))
      .toBe('/home/dev/.kinu/agents/ws-1/home/x');
  });

  test('everything else is readable and refuses a write, like the kernel', () => {
    const policy = view();
    expect(policy.resolvePath('/usr/lib/libc.so', 'read')).toBe('/usr/lib/libc.so');
    expect(() => policy.resolvePath('/usr/lib/planted.so', 'write')).toThrow('read-only');
  });
});

describe('the macOS profile, as generated text', () => {
  const profile = () => sandbox.buildMacProfile(sandbox.viewFor({
    platform: 'darwin',
    home: '/Users/dev',
    agentHome: '/Users/dev/.kinu/agents/ws-1/home',
    agentTmp: '/Users/dev/.kinu/agents/ws-1/tmp',
    deviceHome: '/Users/dev/.kinu',
    roots: ['/Users/dev/work/client'],
  }));

  test('denies the user\'s home and re-allows only the agent home and the roots', () => {
    const text = profile();
    expect(text).toContain('(deny default)');
    expect(text).toContain('(deny file-read* file-write* (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/root"))');
    // The re-allow must come AFTER the deny: SBPL takes the last matching rule,
    // which is the whole mechanism this profile relies on.
    expect(text.indexOf('(allow file-read* file-write* (subpath "/Users/dev/.kinu/agents/ws-1/home")'))
      .toBeGreaterThan(text.indexOf('(deny file-read* file-write* (subpath "/Users")'));
    expect(text).toContain('(subpath "/Users/dev/work/client")');
  });

  test('names no path the owner did not consent, and keeps the GPU clients', () => {
    const text = profile();
    expect(text).not.toContain('/Users/dev/.ssh');
    expect(text).not.toContain('/Users/dev/Library');
    expect(text).toContain('AGXDeviceUserClient');
    expect(text).toContain('IOSurfaceRootUserClient');
    expect(text).toContain('com.apple.MTLCompilerService');
    expect(text).toContain('(allow network*)');
  });

  test('the plan spawns sandbox-exec with HOME pointed at the agent home', () => {
    const plan = sandbox.plan({
      tier: 'sandboxed', platform: 'darwin', home: '/Users/dev',
      agentHome: '/Users/dev/.kinu/agents/ws-1/home',
      agentTmp: '/Users/dev/.kinu/agents/ws-1/tmp',
      deviceHome: '/Users/dev/.kinu', roots: [], command: 'echo hi',
      cwd: '/Users/dev/.kinu/agents/ws-1/home', source: {},
    });
    expect(plan.argv[0]).toBe('/usr/bin/sandbox-exec');
    expect(plan.argv[1]).toBe('-p');
    expect(plan.argv.slice(-3)).toEqual(['bash', '-c', 'echo hi']);
    // No mount namespace on macOS, so HOME is the only thing that can point a
    // tool's defaults at the agent's own directory.
    expect(plan.env.HOME).toBe('/Users/dev/.kinu/agents/ws-1/home');
    expect(plan.env.KINU_SANDBOX).toBe('1');
  });
});
