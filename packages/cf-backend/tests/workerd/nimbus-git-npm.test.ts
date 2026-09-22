/**
 * Defends: a resolver fanout shard (a sibling DO) answering `fanoutExecute` from a bare workspace.
 * Measured 2026-09-21 under workerd, worker 0.10.0 / core 0.12.0: bare host 3 pass, 1 fail
 * ("'fanoutExecute' is a host op"); composed runtime 4 pass. Local-path `git clone` is refused on
 * 0.10.0 (the facet registers http/https transports only), so the clone case is HTTP.
 */
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { GIT_BRANCH, GIT_COMMIT_MESSAGE, GIT_FILE, GIT_FILE_CONTENT, GIT_REPO_PATH } from './git-http-fake';
import { REGISTRY_ENTRY, REGISTRY_FANOUT_PKGS, REGISTRY_HOST, REGISTRY_MANIFEST, REGISTRY_PKG } from './npm-registry-fake';

const subject = (name: string) => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName(name));

const seedRepo = (dir: string) => [
  `mkdir -p ${dir}`,
  `cd ${dir}`,
  'git init',
  'echo seed-content > README.md',
  'git add README.md',
  'git commit -m "seed commit"',
].join(' && ');

it('git makes a repository in the workspace and -C reads it from outside', async () => {
  const probe = subject('nimbus-git');
  const workspace = 'nimbus-git-seed';

  await probe.openWorkspace(workspace, 'nimbus-git-owner');

  const seeded = await probe.runInWorkspace(workspace, seedRepo('/home/user/seed'));

  expect(seeded.exitCode, seeded.stdout).toBe(0);

  const log = await probe.runInWorkspace(workspace, 'git -C /home/user/seed log --oneline');

  expect(log.exitCode, log.stdout).toBe(0);
  expect(log.stdout).toContain('seed commit');

  const branch = await probe.runInWorkspace(workspace, 'git -C /home/user/seed branch --show-current');

  expect(branch.exitCode, branch.stdout).toBe(0);
  expect(branch.stdout.trim()).not.toBe('');
});

it('git clone of a workspace path is refused for what it is, never for a missing host', async () => {
  const probe = subject('nimbus-git-clone');
  const workspace = 'nimbus-git-clone';

  await probe.openWorkspace(workspace, 'nimbus-git-owner');

  const seeded = await probe.runInWorkspace(workspace, seedRepo('/home/user/seed'));

  expect(seeded.exitCode, seeded.stdout).toBe(0);

  const cloned = await probe.runInWorkspace(workspace, 'cd /home/user && git clone -q seed copy');

  // A host the facet could not reach answers `SupervisorRPC: env.* must be the Durable Object
  // namespace ...` or refuses a host op; this workspace must never say that.
  expect(cloned.stdout).not.toContain('composeFabric');
  expect(cloned.stdout).not.toContain('is a host op');
  expect(cloned.stdout).toContain('clone failed');
});

it('git clone lands the commit, and -C reads the clone from outside it', async () => {
  const probe = subject('nimbus-git-http');
  const workspace = 'nimbus-git-http';

  await probe.openWorkspace(workspace, 'nimbus-git-owner');

  const cloned = await probe.runInWorkspace(workspace,
    `cd /home/user && git clone -q http://${REGISTRY_HOST}${GIT_REPO_PATH} repo`);

  expect(cloned.exitCode, cloned.stdout).toBe(0);

  const log = await probe.runInWorkspace(workspace, 'git -C /home/user/repo log --oneline');

  expect(log.exitCode, log.stdout).toBe(0);
  expect(log.stdout).toContain(GIT_COMMIT_MESSAGE);

  const branch = await probe.runInWorkspace(workspace, 'git -C /home/user/repo branch --show-current');

  expect(branch.stdout.trim()).toBe(GIT_BRANCH);
  expect(await probe.readWorkspaceFile(workspace, `/home/user/repo/${GIT_FILE}`)).toBe(GIT_FILE_CONTENT);
});

it('npm install resolves a wide layer through sibling objects', async () => {
  const probe = subject('nimbus-npm');
  const workspace = 'nimbus-npm-fanout';

  await probe.openWorkspace(workspace, 'nimbus-npm-owner');

  const made = await probe.runInWorkspace(workspace, 'mkdir -p /home/user/fanout');

  expect(made.exitCode, made.stdout).toBe(0);

  // Six roots: one layer wider than the coordinator resolves alone, so siblings are opened.
  const install = await probe.runInWorkspace(workspace,
    `cd /home/user/fanout && NPM_REGISTRY=http://${REGISTRY_HOST} npm install ${REGISTRY_FANOUT_PKGS.join(' ')}`);

  expect(install.exitCode, install.stdout).toBe(0);
  expect(await probe.readWorkspaceFile(workspace, `/home/user/fanout/node_modules/${REGISTRY_PKG}/package.json`))
    .toBe(REGISTRY_MANIFEST);

  for (const name of REGISTRY_FANOUT_PKGS) {
    expect(await probe.readWorkspaceFile(workspace, `/home/user/fanout/node_modules/${name}/lib/index.js`))
      .toBe(REGISTRY_ENTRY);
  }
});
