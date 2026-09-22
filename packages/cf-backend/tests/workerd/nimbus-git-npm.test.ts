/**
 * Git and npm in the hosted workspace, over the supervisor boundary a facet
 * crosses.
 *
 * Every program Nimbus runs outside the object — the git network facet, the
 * npm resolver, a peer shard — reaches the filesystem through
 * `SupervisorRPC`, which resolves the workspace object out of the composed
 * `OrchestratorAgent` namespace and calls `supervisorOp`. Half of the
 * operations it can carry are filesystem ops a bare workspace answers; the
 * other half are HOST ops, served only by the composed hosted runtime
 * (`@nimbus-sh/core/dist/workspace/supervisor-op.js:279-285`). The resolver's
 * wide layers go further: they open SIBLING objects of the same namespace by
 * name (`nbf:npm-resolve-fanout:<doId>:<shard>`,
 * `@nimbus-sh/fabric/dist/fanout.js:150-156`) and send them `fanoutExecute`,
 * so a sibling must answer with a hosted runtime too.
 *
 * MEASURED here on 2026-09-21, worker 0.10.0 / core 0.12.0, this box:
 *   - With `workspace-host.ts` answering from `bundle.session()`, the bare
 *     workspace: 3 pass, 1 fail. "npm install resolves a wide layer through
 *     sibling objects" fails with `resolver-fanout failed at layer 0: peer
 *     shard nbf:npm-resolve-fanout:9d8e18eb2375:3 ... supervisor op:
 *     'fanoutExecute' is a host op, and this handler is a bare workspace's`.
 *   - With it answering from the composed runtime: 4 pass.
 *
 * The CLONE cases pass on both, and the reason is upstream rather than here.
 * Worker 0.9.0 minted a facet's supervisor binding with props
 * `{ doId, pid, mutationOwner }` (`dist/git/network-facet.js:410`) and the
 * entrypoint read the host namespace off its own isolate
 * (`dist/session/supervisor-rpc.js:88`), which holds no composition in the
 * isolate workerd serves an entrypoint from — the `env.NIMBUS_SESSION`
 * refusal a clone met on 2026-09-21. 0.10.0 mints `route: hostRoute()` into
 * those props and resolves the namespace from the route. Every operation the
 * clone facet then performs is a filesystem op, which a bare workspace also
 * answers, so the clone is green either way. It stays because it is the
 * end-to-end proof that a facet reaches this object at all.
 *
 * `git clone` of a LOCAL path cannot pass on worker 0.10.0 and is asserted
 * here as the refusal it is: every clone is delegated to the network facet
 * (`dist/git/commands.js:385`) and the facet's isomorphic-git registers
 * `http` and `https` transports only (`GitRemoteManager.getRemoteHelperFor`
 * in `dist/git-bundle.generated.js`), so a bare path never parses as a URL.
 * The clone this suite proves is therefore an HTTP one, against the fixture
 * origin the probe worker's outbound service serves.
 *
 * WHY `bun test` CANNOT HOST IT. The facets are Worker Loader isolates and
 * the resolver's shards are Durable Objects addressed by name; neither exists
 * outside workerd.
 */
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { GIT_BRANCH, GIT_COMMIT_MESSAGE, GIT_FILE, GIT_FILE_CONTENT, GIT_REPO_PATH } from './git-http-fake';
import { REGISTRY_ENTRY, REGISTRY_FANOUT_PKGS, REGISTRY_HOST, REGISTRY_MANIFEST, REGISTRY_PKG } from './npm-registry-fake';

const subject = (name: string) => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName(name));

/** A seed repository the workspace's own git makes: one commit over one file. */
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

  // The facet ran and reported the transport it has no helper for. A host the
  // facet could not reach answers differently — `SupervisorRPC: env.* must be
  // the Durable Object namespace configured by composeFabric`, or a host op
  // refused — and this workspace must never say that.
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

  // Six roots: one layer wider than the coordinator resolves alone, so the
  // resolver opens siblings of this workspace's namespace and every one of
  // them answers `fanoutExecute` from a hosted runtime.
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
