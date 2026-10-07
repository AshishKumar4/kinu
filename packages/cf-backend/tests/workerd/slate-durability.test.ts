/**
 * A slate's preview URL is minted from a reservation in DO storage; after `abortAllDurableObjects()`
 * a request re-drives the process rather than 404ing. Workerd-only: `ctx.facets`, `ctx.storage`.
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { REGISTRY_ENTRY, REGISTRY_HOST, REGISTRY_MANIFEST, REGISTRY_PKG } from './npm-registry-fake';

it('a slate survives eviction on its own URL', async () => {
  // A stub held across the reset is broken by it; the id survives, so re-acquire.
  const subject = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('survives'));

  const boot = await subject().serveSlate({
    workspace: 'durability-keep', owner: 'durability-owner', id: 'keeper', body: 'keeper-body',
  });

  // Answers before the eviction too: the later 200 is the re-drive, not a cold-only slate.
  expect(await subject().drivePreview(boot.url)).toEqual({ status: 200, body: 'keeper-body' });
  expect(boot.reservations).toEqual([
    { port: boot.port, owner: 'keeper', capability: boot.capability },
  ]);

  await abortAllDurableObjects();

  // Same URL, same reservation row (port and capability).
  expect(await subject().portReservations('durability-keep')).toEqual([
    { port: boot.port, owner: 'keeper', capability: boot.capability },
  ]);
});

it('a removed slate’s URL is dead even when a new app claims its port', async () => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('removed'));

  const boot = await subject.serveSlate({
    workspace: 'durability-remove', owner: 'durability-owner', id: 'keeper', body: 'keeper-body',
  });

  expect(await subject.removeSlate('durability-remove', 'keeper'))
    .toEqual({ ok: true, port: boot.port });

  // The squatter's URL serves, so the old URL's 404 is the retired capability refusing.
  const squatter = await subject.serveSlate({
    workspace: 'durability-remove', owner: 'durability-owner', id: 'squatter',
    body: 'squatter-body', preferredPort: boot.port,
  });

  expect(squatter.port).toBe(boot.port);
  expect(squatter.url).not.toBe(boot.url);
  expect(await subject.drivePreview(squatter.url)).toEqual({ status: 200, body: 'squatter-body' });
  expect(await subject.drivePreview(boot.url)).toMatchObject({ status: 404 });
});

it('a removed slate’s picture goes with it, and its neighbour’s stays', async () => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('pictures'));
  await subject.serveSlate({ workspace: 'durability-pictures', owner: 'durability-owner', id: 'keeper', body: 'keeper-body' });
  await subject.putPicture('durability-pictures', 'keeper', 'a'.repeat(64));
  await subject.putPicture('durability-pictures', 'neighbour', 'b'.repeat(64));
  const [neighbour] = (await subject.pictureKeys('durability-pictures')).filter((key) => key.includes('/neighbour/'));

  expect(await subject.pictureKeys('durability-pictures')).toHaveLength(2);
  expect(await subject.removeSlate('durability-pictures', 'keeper')).toMatchObject({ ok: true });
  expect(await subject.pictureKeys('durability-pictures')).toEqual([neighbour]);
});

it('the /__rpc surface answers over the durable URL after eviction', async () => {
  const subject = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('rpc'));

  const boot = await subject().serveSlate({
    workspace: 'durability-rpc', owner: 'durability-owner', id: 'keeper', body: 'keeper-body',
  });

  // 2 means the retained facet's this.sql survived.
  expect(await subject().rpcPreview(boot.url, 'ping')).toEqual({ ok: true, value: '{"rows":1}' });

  await abortAllDurableObjects();

  expect(await subject().rpcPreview(boot.url, 'ping')).toEqual({ ok: true, value: '{"rows":2}' });
});

it('a slate URL starts its application once, for a spawn and for cold requests that arrive together', async () => {
  const subject = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('cold-once'));

  const boot = await subject().serveSlate({
    workspace: 'durability-cold', owner: 'durability-owner', id: 'keeper', body: 'keeper-body',
  });

  // Its spawn started it; a request finds that same application, not a second one.
  const spawned = await subject().rpcPreview(boot.url, 'evaluation');

  expect(spawned.ok).toBe(true);
  expect(await subject().rpcPreview(boot.url, 'evaluation')).toEqual(spawned);
  await abortAllDurableObjects();

  // Cold: two RPC calls and a page at once all reach one application.
  const [first, second, page] = await Promise.all([
    subject().rpcPreview(boot.url, 'evaluation'), subject().rpcPreview(boot.url, 'evaluation'), subject().drivePreview(boot.url),
  ]);

  expect(first.ok).toBe(true);
  expect(second).toEqual(first);
  expect(page).toEqual({ status: 200, body: 'keeper-body' });
});

// #26. The platform can end an activation and keep its facets. The next activation launches the
// application again under the same facet name with a class of its own, and a running facet does not
// take a new class: on the platform the object resets ("code was updated"), and here the old
// facet answers.
it('the next activation runs its own application, not the one an ended activation left running', async () => {
  const subject = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('next-activation'));

  const boot = await subject().serveSlate({
    workspace: 'durability-next', owner: 'durability-owner', id: 'keeper', body: 'keeper-body',
  });

  expect(await subject().rpcPreview(boot.url, 'ping')).toEqual({ ok: true, value: '{"rows":1}' });
  const before = await subject().rpcPreview(boot.url, 'evaluation');

  expect(before.ok).toBe(true);
  await subject().forgetActivation('durability-next');

  const after = await subject().rpcPreview(boot.url, 'evaluation');

  expect(after.ok).toBe(true);
  expect(after).not.toEqual(before);
  // A restart, not a new application: the rows the first process wrote are still there.
  expect(await subject().rpcPreview(boot.url, 'ping')).toEqual({ ok: true, value: '{"rows":2}' });
});

it('a slate keeps answering its URL while a workspace process runs beside it', async () => {
  const subject = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('beside-a-process'));

  const boot = await subject().serveSlate({
    workspace: 'durability-beside', owner: 'durability-owner', id: 'keeper', body: 'keeper-body',
  });

  expect(await subject().drivePreview(boot.url)).toEqual({ status: 200, body: 'keeper-body' });

  const running = subject().runInWorkspace('durability-beside', 'sleep 6');

  await new Promise((resolve) => { setTimeout(resolve, 1500); });
  expect(await subject().drivePreview(boot.url)).toEqual({ status: 200, body: 'keeper-body' });

  const finished = await running;

  expect(finished.exitCode).toBe(0);
  expect(await subject().drivePreview(boot.url)).toEqual({ status: 200, body: 'keeper-body' });
});

it('npm install streams a package off the registry into the hosted workspace', async () => {
  const subject = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('npm'));
  const workspace = 'durability-npm';
  await subject().serveSlate({ workspace, owner: 'durability-owner', id: 'beside-npm', body: 'served' });
  const made = await subject().runInWorkspace(workspace, 'mkdir -p /home/main/proj');
  expect(made.exitCode).toBe(0);

  const install = await subject().runInWorkspace(workspace,
    `cd /home/main/proj && NPM_REGISTRY=http://${REGISTRY_HOST} npm install ${REGISTRY_PKG}`);

  expect(install.exitCode, install.stdout).toBe(0);
  expect(await subject().readWorkspaceFile(workspace, `/home/main/proj/node_modules/${REGISTRY_PKG}/package.json`)).toBe(REGISTRY_MANIFEST);
  expect(await subject().readWorkspaceFile(workspace, `/home/main/proj/node_modules/${REGISTRY_PKG}/lib/index.js`)).toBe(REGISTRY_ENTRY);
});

it('the workspace terminal is the runtime shell: a typed line runs and its output comes back as frames', async () => {
  const subject = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('terminal'));
  const workspace = 'durability-terminal';
  await subject().serveSlate({ workspace, owner: 'durability-owner', id: 'beside-terminal', body: 'served' });

  const drive = await subject().driveTerminal(workspace, 'echo shell-$((20+3))', 'shell-23');

  expect(drive.ok, drive.ok ? '' : drive.error).toBe(true);

  if (!drive.ok) return;
  // Nothing of the actor protocol reached the pane's socket.
  expect(drive.frames).toContain('ready');
  expect(drive.frames).not.toContain('other');
  expect(drive.output).toContain('shell-23');
});

it('a node run leaves its log janitor as an alarm the object sleeps on, not a timer it stays awake for', async () => {
  const subject = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('janitor'));
  const workspace = 'durability-janitor';
  await subject().serveSlate({ workspace, owner: 'durability-owner', id: 'beside-janitor', body: 'served' });
  const before = Date.now();

  expect(await subject().runInWorkspace(workspace, 'node -e "console.log(1)"')).toEqual({ exitCode: 0, stdout: '1\n' });

  // Nimbus drops an exited process's logs 10 minutes on.
  const pending = await subject().pendingNimbusTasks(workspace);
  const janitor = pending.tasks.find((task) => task.id === 'log-janitor');

  expect(janitor?.time).toBeGreaterThanOrEqual(before + 9 * 60_000);
  expect(pending.alarm).not.toBeNull();
  expect(pending.alarm).toBeLessThanOrEqual(janitor?.time ?? 0);
});
