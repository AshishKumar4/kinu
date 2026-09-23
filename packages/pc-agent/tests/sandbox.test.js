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

const { scratchDir } = require('../../test-utils/src/scratch');

const { describe, expect, test } = require('bun:test');

const fs = require('node:fs');

const os = require('node:os');

const path = require('node:path');

const { spawnSync } = require('node:child_process');

const sandbox = require('../src/sandbox.js');

const LINUX = process.platform === 'linux';

/** One sandboxed command, run the way the supervisor runs it. */
function runSandboxed(command, options = {}) {
  const base = scratchDir('sandbox-case');
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

  return { base, agentHome, agentTmp, consented, plan, status: run.status, stdout: String(run.stdout ?? ''), stderr: String(run.stderr ?? '') };
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

      fs.rmSync(planted, { force: true });
    }
  });

  test('Kinu\'s own directory is not in the sandbox at all', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
    const deviceHome = path.join(os.homedir(), '.kinu');
    const run = runSandboxed(`cat ${JSON.stringify(path.join(deviceHome, 'device.json'))} 2>&1 | head -1`);

    // The kernel says the same thing the file methods say, because neither is
    // asked to make an exception: ~/.kinu is never bound in.
    expect(run.stdout).toContain('No such file');
    expect(run.stdout).not.toContain('"token"');
  });

  test('writes land in the agent home and the consented directory, and nowhere else', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;

    const run = runSandboxed([
      'touch "$HOME/in-agent-home" && echo home-ok',
      'touch /usr/local/should-not-exist 2>&1 | head -1',
      'touch /etc/should-not-exist 2>&1 | head -1',
    ].join('; '), {});

    expect(run.stdout).toContain('home-ok');
    expect(run.stdout).toContain('Read-only file system');
    expect(fs.existsSync(path.join(run.agentHome, 'in-agent-home'))).toBe(true);
    expect(fs.existsSync('/usr/local/should-not-exist')).toBe(false);
    // The consented root is writable, and the write is visible OUTSIDE:
    // a root that only looked writable would be a tmpfs the owner never sees.
    runSandboxed(`touch ${JSON.stringify('/tmp/ignored')}; echo done`);

  });

  test('a consented directory is writable and the bytes are the machine\'s own', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
    const base = scratchDir('sandbox-root');
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

    expect(run.status).toBe(0);
    // `--chdir` names the directory as the COMMAND sees it, which for a
    // consented root is its own path.
    expect(String(run.stdout).trim()).toBe(consented);
    expect(fs.readFileSync(path.join(consented, 'report.txt'), 'utf8')).toBe('agent-wrote-this');
  });

  test('the GPU nodes this machine has are inside, and bash-only syntax runs', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
    const nodes = sandbox.gpuNodes();
    const run = runSandboxed('set -o pipefail; [[ 1 == 1 ]] && ls -d /dev/nvidia* /dev/dri 2>/dev/null | tr "\\n" " "');

    expect(run.status).toBe(0);

    // Only what this box actually has: `--dev /dev` alone is an empty
    // devtmpfs, which is why a sandbox that stops there has no GPU.
    for (const node of nodes) {
      if (node.startsWith('/dev/nvidia') || node === '/dev/dri') {
        expect(run.stdout).toContain(node);
      }
    }
  });

  test('the command environment is the allow-list, with the sandbox\'s own values', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;

    const run = runSandboxed('env | sort | tr "\\n" " "', {
      source: {
        PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_TIME: 'en_GB.UTF-8', TZ: 'Asia/Kolkata', COLORTERM: 'truecolor',
        HTTPS_PROXY: 'http://proxy.corp:3128', no_proxy: 'localhost',
        KINU_TOKEN: 'ptc_leaked_cli_bearer', GITHUB_TOKEN: 'ghp_leaked_pat', AWS_SECRET_ACCESS_KEY: 'leaked-aws-key',
        SSH_AUTH_SOCK: '/tmp/leaked-agent.sock', NODE_OPTIONS: '--require /tmp/x.js',
      },
    });

    // The sandbox hides ~/.aws and ~/.ssh; the environment must not hand the same secrets over.
    expect(run.stdout).not.toContain('ptc_leaked_cli_bearer');
    expect(run.stdout).not.toContain('ghp_leaked_pat');
    expect(run.stdout).not.toContain('leaked-aws-key');
    expect(run.stdout).not.toContain('SSH_AUTH_SOCK');
    expect(run.stdout).not.toContain('NODE_OPTIONS');
    expect(run.stdout).toContain('KINU_SANDBOX=1');

    // What a command needs to read its clock, its locale, its colours and its network.
    for (const kept of ['LANG=C.UTF-8', 'LC_TIME=en_GB.UTF-8', 'TZ=Asia/Kolkata', 'COLORTERM=truecolor',
      'HTTPS_PROXY=http://proxy.corp:3128', 'no_proxy=localhost']) {
      expect(run.stdout).toContain(kept);
    }
  });

  test('with the Sandbox switch off a command gets the owner\'s environment, less Kinu\'s credentials', () => {
    const owner = { PATH: '/usr/bin', GITHUB_TOKEN: 'ghp_owner_pat', SSH_AUTH_SOCK: '/tmp/owner-agent.sock', TZ: 'UTC', DISPLAY: ':0' };
    const withheld = Object.fromEntries(sandbox.WITHHELD_ENV.map((name) => [name, `planted:${name}`]));

    const { env } = sandbox.plan({ tier: 'raw', deviceHome: '/home/dev/.kinu', command: 'env', cwd: '/home/dev', source: { ...owner, ...withheld } });

    expect(env).toEqual(owner);
  });

  test('what a dotenv file put into the daemon at launch reaches no command, in either tier', () => {
    const project = scratchDir('launch-dotenv');
    fs.writeFileSync(path.join(project, '.env'), 'PROJECT_DB_URL=postgres://app:secret@db/app\nSHARED=from-dotenv\n');
    fs.writeFileSync(path.join(project, '.env.local'), 'LOCAL_ONLY=local-secret\n');
    fs.writeFileSync(path.join(project, '.env.test.local'), 'TEST_LOCAL=test-secret\n');
    fs.writeFileSync(path.join(project, '.dev.vars'), 'HTTPS_PROXY=http://user:pass@proxy:3128\n');

    const source = {
      PATH: '/usr/bin', PROJECT_DB_URL: 'postgres://app:secret@db/app', LOCAL_ONLY: 'local-secret',
      TEST_LOCAL: 'test-secret', HTTPS_PROXY: 'http://user:pass@proxy:3128',
      // The owner's shell set this name to its own value; only the file's value is the project's.
      SHARED: 'from-the-shell',
    };

    const dotenv = sandbox.launchDotenv(project, 'test');

    // Under NODE_ENV=test Bun skips `.env.local`, so its value came from somewhere else.
    expect(sandbox.rawEnvironment(source, dotenv)).toEqual({ PATH: '/usr/bin', LOCAL_ONLY: 'local-secret', SHARED: 'from-the-shell' });
    expect(sandbox.sandboxEnvironment(source, {}, dotenv)).toEqual({ PATH: '/usr/bin' });
    expect(sandbox.rawEnvironment(source, sandbox.launchDotenv(project, 'development'))).toEqual({
      PATH: '/usr/bin', TEST_LOCAL: 'test-secret', SHARED: 'from-the-shell',
    });
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
    const home = scratchDir('sandbox-tmp-home');
    const run = runSandboxed('pwd; touch "$HOME/marker"; echo reached', { home });

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`${home}\nreached`);
    // `~/marker` is the AGENT's marker: the home path inside the namespace
    // is the agent home, and the real directory under /tmp is untouched.
    expect(fs.existsSync(path.join(run.agentHome, 'marker'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'marker'))).toBe(false);
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
    const home = scratchDir('sandbox-shim-home');
    const agentHome = path.join(home, '.kinu', 'agents', 'ws', 'home');
    const agentTmp = path.join(home, '.kinu', 'agents', 'ws', 'tmp');

    for (const dir of [agentHome, agentTmp]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const shimDir = path.join(home, '.local', 'bin');
    fs.mkdirSync(shimDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(shimDir, 'hostname'),
      '#!/usr/bin/env bash\nprintf \'%s\\n\' kinu-first-run-alpha\n', { mode: 0o700 });

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
  });

  test('the daemon\'s own probe passes with HOME under /tmp, as the first-run tier runs it', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
    // A CHILD process, not an in-process `process.env.HOME` swap: Bun's
    // `os.homedir()` reads HOME once at start, so a swap here would probe the
    // real home and pass on any tree. The tier spawns the daemon with a
    // scratch HOME in its environment, and so does this.
    const home = scratchDir('sandbox-tmp-home');

    const script = 'const s = require(process.argv[1]); '
      + 'process.stdout.write(JSON.stringify(s.probe({ deviceHome: process.env.KINU_HOME })))';

    const run = spawnSync(process.execPath, ['-e', script, require.resolve('../src/sandbox.js')], {
      env: { ...process.env, HOME: home, KINU_HOME: home }, encoding: 'utf8',
    });

    expect(run.stderr).toBe('');
    expect(JSON.parse(run.stdout)).toEqual({ status: sandbox.SANDBOX_STATUS.OK, detail: null });
  });
});

/**
 * What a command may READ, run on this machine: the system trees a program
 * needs, its own home and tmp, and the directories the owner shared. A file a
 * person keeps anywhere else is outside the sandbox even when no home holds it.
 */
describe('a sandboxed command reads only the system and what the owner shared', () => {
  /** A file outside every home and every consented directory: `/var/tmp` is on
   *  every Linux, world-writable, and no home or root holds it. */
  function plantOutsideEveryHome(label) {
    const planted = path.join('/var/tmp', `kinu-sandbox-${label}-${process.pid}`);
    fs.writeFileSync(planted, 'outside-every-root', { mode: 0o600 });

    return planted;
  }

  test('a file outside the homes and the consented directory is invisible, however it is spelled', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
    const planted = plantOutsideEveryHome('outside');
    const base = scratchDir('sandbox-outside');
    const consented = path.join(base, 'consented');
    fs.mkdirSync(consented, { recursive: true });
    fs.symlinkSync(planted, path.join(consented, 'escape'));

    try {
      const run = runSandboxed(
        `cat ${JSON.stringify(planted)} 2>&1; cat ${JSON.stringify(path.join(consented, 'escape'))} 2>&1; echo done`,
        { roots: [consented] },
      );

      expect(run.stdout).not.toContain('outside-every-root');
      expect(run.stdout).toContain('done');
    } finally {
      fs.rmSync(planted, { force: true });
    }
  });

  test('Kinu\'s own directory stays hidden inside a consented directory that holds it', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
    // `kinu connect` run in the home makes the home the consented directory,
    // and ~/.kinu holds this machine's token and the owner's CLI bearer.
    const home = scratchDir('sandbox-root-home');
    const deviceHome = path.join(home, '.kinu');
    const agentHome = path.join(deviceHome, 'agents', 'ws', 'home');
    const agentTmp = path.join(deviceHome, 'agents', 'ws', 'tmp');

    for (const dir of [agentHome, agentTmp]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(deviceHome, 'device.json'), '{"token":"pdt_machine_secret"}', { mode: 0o600 });
    fs.writeFileSync(path.join(home, 'shared.txt'), 'shared-with-the-agent');

    const plan = sandbox.plan({
      tier: 'sandboxed', home, agentHome, agentTmp, deviceHome, roots: [home],
      cwd: home, command: `cat ${JSON.stringify(path.join(deviceHome, 'device.json'))} ${JSON.stringify(path.join(home, 'shared.txt'))} 2>&1`, source: {},
    });

    const run = spawnSync(plan.argv[0], plan.argv.slice(1), { env: plan.env, encoding: 'utf8' });

    expect(run.stdout).not.toContain('pdt_machine_secret');
    expect(run.stdout).toContain('shared-with-the-agent');
  });

  test('/var/tmp is the agent\'s own temp, as /tmp is', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
    const run = runSandboxed('printf agent-temp > /var/tmp/kinu-agent-temp && cat /tmp/kinu-agent-temp');

    expect(run.stdout).toBe('agent-temp');
    expect(fs.readFileSync(path.join(run.agentTmp, 'kinu-agent-temp'), 'utf8')).toBe('agent-temp');
  });

  test('a GPU job sees the same GPUs inside the sandbox as outside', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
    const outside = spawnSync('nvidia-smi', ['-L'], { encoding: 'utf8' });

    // A machine with no NVIDIA driver has no GPU job to keep.
    if (outside.error || outside.status !== 0) return;
    // NVML reads /sys to find the devices; a sandbox without it answers
    // "GPU access blocked by the operating system" (measured 2026-09-22,
    // driver 595.84, RTX 4080).
    const inside = runSandboxed('nvidia-smi -L');

    expect(inside.stderr).toBe('');
    expect(inside.stdout).toBe(outside.stdout);
  });

  test('a toolchain under /opt is there inside the sandbox, byte for byte and executable', () => {
    if (!LINUX || sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
    // ROCm, Arch's CUDA and conda install a GPU job's runtime under /opt.
    const found = spawnSync('find', ['/opt', '-maxdepth', '4', '-type', 'f', '-perm', '-u+x', '-print', '-quit'], { encoding: 'utf8' });
    const tool = found.stdout.trim();

    // A machine with nothing installed under /opt has no such job to keep.
    if (tool === '') return;
    const probe = `test -x ${JSON.stringify(tool)} && sha256sum ${JSON.stringify(tool)}`;
    const outside = spawnSync('bash', ['-c', probe], { encoding: 'utf8' });
    const inside = runSandboxed(probe);

    expect(inside.stderr).toBe('');
    expect(inside.stdout).toBe(outside.stdout);
  });

  test('/opt is readable and read-only to the file methods, as to the shell', () => {
    if (!LINUX || !fs.existsSync('/opt')) return;
    const home = scratchDir('view-opt');

    const policy = sandbox.viewFor({
      platform: 'linux', home, agentHome: path.join(home, '.kinu', 'agents', 'ws', 'home'),
      agentTmp: path.join(home, '.kinu', 'agents', 'ws', 'tmp'), deviceHome: path.join(home, '.kinu'), roots: [],
    });

    expect(policy.resolvePath('/opt/rocm/bin/rocminfo', 'read')).toBe('/opt/rocm/bin/rocminfo');
    expect(() => policy.resolvePath('/opt/rocm/bin/planted', 'write')).toThrow('read-only');
  });

  test('the command environment never names Kinu\'s own directory', () => {
    const env = sandbox.sandboxEnvironment({ PATH: '/usr/bin', KINU_HOME: '/var/lib/kinu' }, {});

    expect(env.PATH).toBe('/usr/bin');
    expect(Object.values(env)).not.toContain('/var/lib/kinu');
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

  const writablePaths = [
    {
      // The file methods run OUTSIDE the namespace, so `~/x` has to be
      // translated; inside, the two are the same path.
      name: 'the agent home answers for the real home, because that is where it is mounted',
      asked: '/home/dev/notes.md',
      outside: '/home/dev/.kinu/agents/ws-1/home/notes.md',
    },
    {
      // Decided BEFORE the home swap: a root inside the real home is re-bound
      // over the swapped home and is reachable at its own path.
      name: 'a consented root under the home is itself, not the agent home',
      asked: '/home/dev/work/client/main.py',
      outside: '/home/dev/work/client/main.py',
    },
  ];

  for (const writable of writablePaths) {
    test(writable.name, () => {
      const policy = view();
      expect(policy.resolvePath(writable.asked, 'write')).toBe(writable.outside);
      expect(policy.insidePath(writable.outside)).toBe(writable.asked);
    });
  }

  test('Kinu\'s own directory is refused by its own path, and ~/.kinu is the agent\'s own', () => {
    const elsewhere = sandbox.viewFor({
      platform: 'linux',
      home: '/home/dev',
      agentHome: '/var/lib/kinu/agents/ws-1/home',
      agentTmp: '/var/lib/kinu/agents/ws-1/tmp',
      deviceHome: '/var/lib/kinu',
      roots: [],
    });

    expect(() => elsewhere.resolvePath('/var/lib/kinu/config.json', 'read')).toThrow('inside Kinu\'s own directory');
    // The agent home under it is still reachable: the fence is the store, not
    // the prefix.
    expect(elsewhere.resolvePath('/var/lib/kinu/agents/ws-1/home/x', 'write')).toBe('/var/lib/kinu/agents/ws-1/home/x');
    // Under the home, `~/.kinu` inside the namespace is the agent home's own
    // `.kinu`, because the agent home is mounted over the home.
    expect(view().resolvePath('/home/dev/.kinu/config.json', 'read')).toBe('/home/dev/.kinu/agents/ws-1/home/.kinu/config.json');
  });

  test('the system trees are readable and refuse a write, like the kernel', () => {
    const policy = view();
    expect(policy.resolvePath('/usr/lib/libc.so', 'read')).toBe('/usr/lib/libc.so');
    expect(() => policy.resolvePath('/usr/lib/planted.so', 'write')).toThrow('read-only');
  });
});

describe('the file methods read what the command reads', () => {
  const home = scratchDir('view-home');
  const deviceHome = path.join(home, '.kinu');
  const agentHome = path.join(deviceHome, 'agents', 'ws-1', 'home');
  const agentTmp = path.join(deviceHome, 'agents', 'ws-1', 'tmp');
  const consented = path.join(home, 'work');

  for (const dir of [agentHome, agentTmp, consented]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const view = () => sandbox.viewFor({ platform: 'linux', home, agentHome, agentTmp, deviceHome, roots: [consented] });

  test('a file outside the system trees and the shared directories is refused, even for a read', () => {
    // /dev/shm: outside every home, every temp root and every system tree, and
    // writable on every Linux, so the refusal cannot be a missing file.
    const planted = path.join('/dev/shm', `kinu-view-outside-${process.pid}`);
    const climb = `${consented}/${'../'.repeat(consented.split('/').filter(Boolean).length)}${planted.slice(1)}`;
    fs.writeFileSync(planted, 'outside-every-root', { mode: 0o600 });

    try {
      expect(() => view().resolvePath(planted, 'read')).toThrow('does not expose');
      expect(() => view().resolvePath(climb, 'read')).toThrow('does not expose');
    } finally {
      fs.rmSync(planted, { force: true });
    }
  });

  test('a link the agent planted in its own home is judged by where it lands', () => {
    const secret = path.join(home, 'owner-secret.txt');
    fs.writeFileSync(secret, 'owner-private-material', { mode: 0o600 });
    fs.symlinkSync(secret, path.join(agentHome, 'escape'));

    // `~/escape` is the agent's own entry, and the entry points at the owner's
    // real file: serving it would read what the shell never sees.
    expect(() => view().resolvePath(path.join(home, 'escape'), 'read')).toThrow('does not expose');
  });

  test('the system trees stay readable and the agent\'s temp answers for /var/tmp', () => {
    expect(view().resolvePath('/etc/hostname', 'read')).toBe('/etc/hostname');
    expect(() => view().resolvePath('/etc/kinu-planted', 'write')).toThrow('read-only');
    expect(view().resolvePath('/var/tmp/scratch.txt', 'write')).toBe(path.join(agentTmp, 'scratch.txt'));
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

  test('a consented home still denies Kinu\'s own directory, then re-allows the agent\'s', () => {
    const text = sandbox.buildMacProfile(sandbox.viewFor({
      platform: 'darwin',
      home: '/Users/dev',
      agentHome: '/Users/dev/.kinu/agents/ws-1/home',
      agentTmp: '/Users/dev/.kinu/agents/ws-1/tmp',
      deviceHome: '/Users/dev/.kinu',
      roots: ['/Users/dev'],
    }));

    const rootAllowed = text.indexOf('(subpath "/Users/dev")');
    const kinuDenied = text.indexOf('(deny file-read* file-write* (subpath "/Users/dev/.kinu"))');

    // Last match wins: the deny must follow the root that holds ~/.kinu, and
    // the agent's own directories inside it must follow the deny.
    expect(kinuDenied).toBeGreaterThan(rootAllowed);
    expect(text.lastIndexOf('(subpath "/Users/dev/.kinu/agents/ws-1/home")')).toBeGreaterThan(kinuDenied);
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
