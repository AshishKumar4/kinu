/**
 * Every slate runs in its room (src/slates/room.ts): its page is the room's, entered through the app's frame route, and
 * its server is a facet of the room whose storage outlives each activation and each build. Workerd-only: `ctx.facets`,
 * `ctx.storage`, the loader.
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { expect, it } from 'vitest';
import * as v from 'valibot';
import { REGISTRY_ENTRY, REGISTRY_HOST, REGISTRY_MANIFEST, REGISTRY_PKG } from '../npm-registry-fake';

it('a slate survives eviction on its own page', async () => {
  // A stub held across the reset is broken by it; the id survives, so re-acquire.
  const subject = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('survives'));

  const boot = await subject().serveSlate({
    workspace: 'durability-keep', owner: 'durability-owner', id: 'keeper', body: 'keeper-body',
  });

  // Answers before the eviction too: the later 200 is the room starting it again, not a cold-only slate.
  expect(await subject().drivePreview(boot.url)).toEqual({ status: 200, body: 'keeper-body' });

  await abortAllDurableObjects();

  expect(await subject().drivePreview(boot.url)).toEqual({ status: 200, body: 'keeper-body' });
});

// The exposure review (2026-10-14): an unshared slate's preview URL served anyone who held it, its calls running as the
// owner. The page's address names no one; the slate's own host serves only a session its room let in.
it("a slate's host serves no one who holds only its address: a page load and a script are both refused", async () => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('stranger'));
  const boot = await subject.serveSlate({ workspace: 'durability-stranger', owner: 'd'.repeat(32), id: 'ledger', body: 'ledger-body' });
  const page = await subject.visitPreview(boot.url, { 'sec-fetch-mode': 'navigate', accept: 'text/html' });
  const script = await subject.visitPreview(boot.url, { 'sec-fetch-mode': 'cors', accept: '*/*' });

  expect(new URL(boot.url).pathname).toBe('/api/rooms/durability-stranger/ledger/frame');
  expect([page.status, page.body.includes('ledger-body')]).toEqual([403, false]);
  expect([script.status, script.body.includes('ledger-body')]).toEqual([403, false]);
});

it("a slate's page opens for its owner; anyone else is told it isn't shared with them, a forged session too", async () => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('owner-only'));
  const owner = 'e'.repeat(32);
  const stranger = 'f'.repeat(32);
  const boot = await subject.serveSlate({ workspace: 'durability-owner-only', owner, id: 'ledger', body: 'ledger-body' });

  // The owner goes through the app's frame route and the host's exchange.
  expect(await subject.visitPreviewAs(boot.url, owner)).toEqual({ entry: 303, status: 200, body: 'ledger-body' });
  expect(await subject.drivePreview(boot.url)).toEqual({ status: 200, body: 'ledger-body' });
  // The room refuses a stranger before any ticket; a well-signed cookie naming them is no session the room holds.
  expect(await subject.visitPreviewAs(boot.url, stranger)).toEqual({ entry: 403, status: 403, body: '' });
  expect((await subject.visitPreviewWithCookieOf(boot.url, stranger)).status).toBe(403);
});

it('a slate is listed once in the work surface, under its title, in this activation and the next', async () => {
  const subject = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('titled'));

  await subject().serveSlate({ workspace: 'durability-titled', owner: 'durability-owner', id: 'tally', body: 'tally-body' });
  const tabs = await subject().previewTabs('durability-titled');

  // It holds no port of the workspace's: it runs in its room, so the strip draws it once, as itself.
  expect(tabs.ports.filter((port) => port.name === 'tally')).toEqual([]);
  expect(tabs.slates).toEqual([{ id: 'tally', title: 'tally', port: null }]);

  await abortAllDurableObjects();
  expect((await subject().previewTabs('durability-titled')).slates).toEqual([{ id: 'tally', title: 'tally', port: null }]);
});

it('an edit that breaks a slate\'s build ships nothing: the agent is told where, and the slate keeps its last working version across an eviction', async () => {
  const subject = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('lilt'));
  const at = { workspace: 'durability-lilt', owner: 'durability-owner' };

  const good = await subject().slateBuild({ ...at, phase: 'good' });

  expect(good.wrote).toContain('The slate lilt builds.');
  expect([good.preview, good.serves, good.told]).toEqual(['builds', 'lilt-good', []]);

  // The write that breaks it answers with the compiler's file and line, and the user is still served the build before it.
  const broken = await subject().slateBuild({ ...at, phase: 'broken' });

  expect(broken.wrote).toMatch(/does not build[\s\S]*client\.tsx:\d+:\d+[\s\S]*Adjacent JSX elements/);
  expect(broken.preview).toContain('Adjacent JSX elements');
  expect(broken.serves).toBe('lilt-good');
  expect(broken.told).toEqual([expect.stringMatching(/^lilt: [\s\S]*Adjacent JSX elements/)]);

  // A new activation, which never ran it, serves the same last working version and still tells the agent why.
  await abortAllDurableObjects();
  const served = await subject().slateBuild({ ...at, phase: 'served' });

  expect([served.serves, served.told]).toEqual(['lilt-good', [expect.stringContaining('Adjacent JSX elements')]]);

  const fixed = await subject().slateBuild({ ...at, phase: 'fixed' });

  expect([fixed.preview, fixed.serves, fixed.told]).toEqual(['builds', 'lilt-fixed', []]);
});

it('a slate is rebuilt when a file it imports from outside its own tree changes', async () => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('imports'));
  const at = { workspace: 'durability-imports', owner: 'durability-owner' };

  expect(await subject.slateImport({ ...at, word: 'alpha', first: true })).toBe('alpha');
  expect(await subject.slateImport({ ...at, word: 'beta', first: false })).toBe('beta');
});

it('a slate is rebuilt when a package it imports switches the entry its package.json exports', async () => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('exports'));
  const at = { workspace: 'durability-exports', owner: 'durability-owner' };

  expect(await subject.slateExports({ ...at, entry: 'a.js', first: true })).toBe('alpha');
  expect(await subject.slateExports({ ...at, entry: 'b.js', first: false })).toBe('beta');
});

it('a slate refused for what it imports is built again once a directory above that is replaced, or its mode repaired', async () => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('repairs'));
  const at = { workspace: 'durability-repairs', owner: 'durability-owner' };

  // The directory the import names is renamed away and a fixed copy renamed in: two events, neither at the file.
  const replaced = await subject.slateRepair({
    ...at, id: 'replaced', imports: '/home/main/replaced/deps/lib.ts',
    setup: 'mkdir -p /home/main/replaced/deps /home/main/replaced/fixed'
      + ' && echo \'export const word = ;\' > /home/main/replaced/deps/lib.ts'
      + ' && echo \'export const word = "replaced";\' > /home/main/replaced/fixed/lib.ts',
    repair: 'mv /home/main/replaced/deps /home/main/replaced/broken && mv /home/main/replaced/fixed /home/main/replaced/deps',
  });

  expect(replaced).toEqual({ before: 'bad_input', after: 'builds', says: 'replaced' });

  // A directory above the import that its owner may not enter, then may: one event, at that directory.
  const unlocked = await subject.slateRepair({
    ...at, id: 'unlocked', imports: '/home/main/locked/deps/lib.ts',
    setup: 'mkdir -p /home/main/locked/deps && echo \'export const word = "unlocked";\' > /home/main/locked/deps/lib.ts && chmod 000 /home/main/locked',
    repair: 'chmod 700 /home/main/locked',
  });

  expect(unlocked).toEqual({ before: 'bad_input', after: 'builds', says: 'unlocked' });
});

// The slate's own lib.ts is a link out of its tree: what it resolves to is what is built, and a repair out there,
// wherever along the links it lands, builds it again.
it.each([
  ['the link\'s target is fixed', 'mkdir -p /home/main/linked && echo \'export const word = ;\' > /home/main/linked/lib.ts'
    + ' && ln -s /home/main/linked/lib.ts /slates/linked/lib.ts',
  'echo \'export const word = "linked";\' > /home/main/linked/lib.ts', 'linked'],
  ['the link\'s target is written', 'ln -s /home/main/dangling/lib.ts /slates/dangling/lib.ts',
    'mkdir -p /home/main/dangling && echo \'export const word = "dangling";\' > /home/main/dangling/lib.ts', 'dangling'],
  ['a second link\'s target is written', 'mkdir -p /home/main/chained && ln -s /home/main/chained/alias.ts /slates/chained/lib.ts'
    + ' && ln -s /home/main/chained/future/lib.ts /home/main/chained/alias.ts',
  'mkdir -p /home/main/chained/future && echo \'export const word = "chained";\' > /home/main/chained/future/lib.ts', 'chained'],
  ['a second link is pointed elsewhere', 'mkdir -p /home/main/alias && ln -s /home/main/alias/alias.ts /slates/alias/lib.ts'
    + ' && ln -s /home/main/alias/future.ts /home/main/alias/alias.ts',
  'echo \'export const word = "alias";\' > /home/main/alias/real.ts && rm /home/main/alias/alias.ts'
    + ' && ln -s /home/main/alias/real.ts /home/main/alias/alias.ts', 'alias'],
  ['a file where a directory belongs is replaced', 'mkdir -p /home/main/obstruct && echo blocked > /home/main/obstruct/block'
    + ' && ln -s /home/main/obstruct/block/lib.ts /slates/obstruction/lib.ts',
  'rm /home/main/obstruct/block && mkdir /home/main/obstruct/block && echo \'export const word = "obstruction";\' > /home/main/obstruct/block/lib.ts',
  'obstruction'],
  ['a link loop is broken', 'mkdir -p /home/main/loop && ln -s /home/main/loop/b /home/main/loop/a && ln -s /home/main/loop/a /home/main/loop/b'
    + ' && ln -s /home/main/loop/a/lib.ts /slates/loop/lib.ts',
  'rm /home/main/loop/a && mkdir /home/main/loop/a && echo \'export const word = "loop";\' > /home/main/loop/a/lib.ts', 'loop'],
])('a slate whose lib.ts links out of its tree is built again once %s', async (_how, setup, repair, id) => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName(`links-${id}`));
  const seen = await subject.slateRepair({ workspace: `durability-links-${id}`, owner: 'durability-owner', id, imports: './lib.ts', setup, repair });

  expect(seen).toEqual({ before: 'bad_input', after: 'builds', says: id });
});

// Nimbus ask 41: a slate that built through a second link out of its tree is built again when that link is pointed
// elsewhere. The build records every link its lookups took, not only the file each found.
it('a slate that built through a second link out of its tree is built again once that link is pointed elsewhere', async () => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('links-hop'));

  const seen = await subject.slateRepair({
    workspace: 'durability-links-hop', owner: 'durability-owner', id: 'hop', imports: './lib.ts',
    setup: 'mkdir -p /home/main/hop && echo \'export const word = "first";\' > /home/main/hop/first.ts'
      + ' && echo \'export const word = "hop";\' > /home/main/hop/second.ts'
      + ' && ln -s /home/main/hop/first.ts /home/main/hop/alias.ts && ln -s /home/main/hop/alias.ts /slates/hop/lib.ts',
    repair: 'rm /home/main/hop/alias.ts && ln -s /home/main/hop/second.ts /home/main/hop/alias.ts',
  });

  expect(seen).toEqual({ before: 'builds', after: 'builds', says: 'hop' });
});

it('a removed slate’s page is gone, and a new slate under its name is a new room', async () => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('removed'));

  const boot = await subject.serveSlate({
    workspace: 'durability-remove', owner: 'durability-owner', id: 'keeper', body: 'keeper-body',
  });

  expect(await subject.rpcPreview(boot.url, 'ping')).toEqual({ ok: true, value: '{"rows":1}' });
  // It held no application of the workspace's: removal answers so, and ends its room.
  expect(await subject.removeSlate('durability-remove', 'keeper')).toEqual({ ok: false, port: null });
  // The room kept nothing: its page lets no one in, the owner included.
  expect(await subject.drivePreview(boot.url)).toEqual({ status: 403, body: '' });

  // Made again under the same name, the slate starts with none of the removed one's state.
  const again = await subject.serveSlate({
    workspace: 'durability-remove', owner: 'durability-owner', id: 'keeper', body: 'again-body',
  });

  expect(await subject.drivePreview(again.url)).toEqual({ status: 200, body: 'again-body' });
  expect(await subject.rpcPreview(again.url, 'ping')).toEqual({ ok: true, value: '{"rows":1}' });
});

it('a removed slate’s picture goes with it, and its neighbour’s stays', async () => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('pictures'));
  await subject.serveSlate({ workspace: 'durability-pictures', owner: 'durability-owner', id: 'keeper', body: 'keeper-body' });
  await subject.putPicture('durability-pictures', 'keeper', 'a'.repeat(64));
  await subject.putPicture('durability-pictures', 'neighbour', 'b'.repeat(64));
  const [neighbour] = (await subject.pictureKeys('durability-pictures')).filter((key) => key.includes('/neighbour/'));

  expect(await subject.pictureKeys('durability-pictures')).toHaveLength(2);
  expect(await subject.removeSlate('durability-pictures', 'keeper')).toEqual({ ok: false, port: null });
  expect(await subject.pictureKeys('durability-pictures')).toEqual([neighbour]);
});

it("the slate's methods answer its page after eviction, and its storage is kept", async () => {
  const subject = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('rpc'));

  const boot = await subject().serveSlate({
    workspace: 'durability-rpc', owner: 'durability-owner', id: 'keeper', body: 'keeper-body',
  });

  // 2 means the room's server facet's this.sql survived.
  expect(await subject().rpcPreview(boot.url, 'ping')).toEqual({ ok: true, value: '{"rows":1}' });

  await abortAllDurableObjects();

  expect(await subject().rpcPreview(boot.url, 'ping')).toEqual({ ok: true, value: '{"rows":2}' });
});

it("a slate's room starts its server once, for its build and for cold requests that arrive together", async () => {
  const subject = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('cold-once'));

  const boot = await subject().serveSlate({
    workspace: 'durability-cold', owner: 'durability-owner', id: 'keeper', body: 'keeper-body',
  });

  // Its build started it; a request finds that same server, not a second one.
  const spawned = await subject().rpcPreview(boot.url, 'evaluation');

  expect(spawned.ok).toBe(true);
  expect(await subject().rpcPreview(boot.url, 'evaluation')).toEqual(spawned);
  await abortAllDurableObjects();

  // Cold: two calls and a page at once all reach one server.
  const [first, second, page] = await Promise.all([
    subject().rpcPreview(boot.url, 'evaluation'), subject().rpcPreview(boot.url, 'evaluation'), subject().drivePreview(boot.url),
  ]);

  expect(first.ok).toBe(true);
  expect(second).toEqual(first);
  expect(page).toEqual({ status: 200, body: 'keeper-body' });
});

// #26, as the room has it: a build replaces the running server, not the storage under it. Each publish of a new image
// ends the old server facet; the next call starts the new one on the same storage.
it('a new build runs its own server, not the one before it, on the storage the one before it kept', async () => {
  const subject = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('next-activation'));

  const boot = await subject().serveSlate({
    workspace: 'durability-next', owner: 'durability-owner', id: 'keeper', body: 'keeper-body',
  });

  expect(await subject().rpcPreview(boot.url, 'ping')).toEqual({ ok: true, value: '{"rows":1}' });
  const before = await subject().rpcPreview(boot.url, 'evaluation');

  expect(before.ok).toBe(true);
  await subject().rebuildSlate({ workspace: 'durability-next', id: 'keeper', body: 'rebuilt-body' });

  const after = await subject().rpcPreview(boot.url, 'evaluation');

  expect(after.ok).toBe(true);
  expect(after).not.toEqual(before);
  expect(await subject().drivePreview(boot.url)).toEqual({ status: 200, body: 'rebuilt-body' });
  // A new server, not new storage: the rows the first build's server wrote are still there.
  expect(await subject().rpcPreview(boot.url, 'ping')).toEqual({ ok: true, value: '{"rows":2}' });
});

it('a slate keeps answering its page while a workspace process runs beside it', async () => {
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

/** A call's answer as text: what it printed, or a refusal's whole outcome. */
const AnswerTextSchema = v.union([v.string(), v.pipe(v.unknown(), v.transform((outcome) => JSON.stringify(outcome)))]);

// Staging, 2026-10-02 (live sandbox hang): the agent's one durable shell queued an `echo` behind a `find`, and a `cd`
// from one call steered every later one.
it('the shell tool starts each unnamed call fresh at its cwd; a name keeps its directory and exports, past `exit 3`', async () => {
  const subject = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('shells'));
  const home = '/home/main';

  const [first, second, third, failed, named, other] = (await subject().shellCalls('durability-shells', 'durability-owner', [
    { command: `mkdir -p ${home}/sub && cd ${home}/sub && export LEFT=1 && pwd` },
    { command: 'pwd; echo "left=$LEFT"' },
    { command: 'pwd', cwd: 'sub' },
    { command: `cd ${home}/sub && export TOKEN=s3 && exit 3`, name: 'build' },
    { command: 'pwd; echo "token=$TOKEN"', name: 'build' },
    { command: 'pwd; echo "token=$TOKEN"', name: 'other' },
  ])).map((answer) => v.parse(AnswerTextSchema, JSON.parse(answer)));

  // The `cd` and `export` of the first call did not reach the second.
  expect(first).toBe(`cwd: ${home}\n${home}/sub\n`);
  expect(second).toBe(`cwd: ${home}\n${home}\nleft=\n`);
  expect(third).toBe(`cwd: ${home}/sub\n${home}/sub\n`);
  expect(failed).toContain('exit 3');
  expect(named).toBe(`cwd: ${home}/sub\n${home}/sub\ntoken=s3\n`);
  expect(other).toBe(`cwd: ${home}\n${home}\ntoken=\n`);
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

  // A pane that attaches after the first left is shown the screen, then told the terminal is ready.
  const again = await subject().reattachTerminal(workspace);

  expect(again.output).toContain('shell-23');
  expect(again.frames.at(-1)).toBe('ready');
  expect(again.frames).not.toContain('other');

  // A frame that is no terminal frame closes its socket as a policy violation; the shell never runs it.
  for (const frame of [JSON.stringify({ type: 'rpc', id: '1', method: 'exportWorkspaceArchive' }), 'not json']) {
    const refused = await subject().refusedTerminalFrame(workspace, frame);

    expect(refused.code).toBe(1008);
    expect(refused.reason).toContain('terminal frame refused');
  }
});

/** What a person reads of a screen: the shell's semantic marks (OSC 133, ended by BEL) dropped, line ends as one. */
function readable(screen: string): string {
  const mark = '\u001b]133;';
  let out = '';
  let at = 0;

  for (let start = screen.indexOf(mark); start >= 0; start = screen.indexOf(mark, at)) {
    out += screen.slice(at, start);
    const end = screen.indexOf('\u0007', start);

    at = end < 0 ? screen.length : end + 1;
  }

  return (out + screen.slice(at)).replaceAll('\r\n', '\n');
}

// Production (the owner, 2026-10-14; Nimbus ask 57): each reattach recorded its own replay and a new prompt into the
// scrollback, so the prompts on screen doubled per attach (2, 4 … 128 on staging 0e094da7d) and a resume's notice repeated.
/** A workspace's terminal, a line run in it, and the screen a pane attaching then is shown. */
async function settledTerminal(name: string) {
  const subject = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName(name));
  const workspace = `durability-${name}`;

  await subject().serveSlate({ workspace, owner: 'durability-owner', id: `beside-${name}`, body: 'served' });
  await subject().typeToPrompt(workspace, 'echo ready-$((40+2))', 'ready-42');

  return { subject, workspace };
}

it('a terminal attached again and again with no input shows the same screen, byte for byte', async () => {
  const { subject, workspace } = await settledTerminal('reattach-same');
  const screens: string[] = [];

  for (let attach = 0; attach < 4; attach += 1) screens.push((await subject().reattachTerminal(workspace)).output);
  expect(new Set(screens).size, screens.map((screen) => JSON.stringify(screen.slice(-160))).join('\n')).toBe(1);
});

it('a line typed between attaches adds exactly itself, its output and one prompt', async () => {
  const { subject, workspace } = await settledTerminal('reattach-typed');
  const before = (await subject().reattachTerminal(workspace)).output;
  const lastPrompt = before.slice(before.lastIndexOf('\u001b]133;A\u0007'));

  await subject().typeToPrompt(workspace, 'echo hi', 'hi\r\n');
  const after = (await subject().reattachTerminal(workspace)).output;
  const added = after.slice(before.length);
  const ran = added.indexOf('\u001b]133;C\u0007');
  const ended = added.indexOf('\u001b]133;D');

  expect(after.startsWith(before)).toBe(true);
  // The line as typed (the line editor redraws it in place, on the prompt it sits on), then one command's run.
  expect(added.slice(0, ran)).toContain('echo hi');
  expect([added.split('\u001b]133;A').length - 1, added.split('\u001b]133;C').length - 1]).toEqual([1, 1]);
  // Its output, then one prompt and nothing after it.
  expect(added.slice(ran + '\u001b]133;C\u0007'.length, ended)).toBe('hi\r\n');
  expect(readable(added.slice(ended))).toBe(readable(lastPrompt));
});

it("after its object restarts, a terminal's notice is said once however often a pane attaches", async () => {
  const { subject, workspace } = await settledTerminal('reattach-notice');

  await abortAllDurableObjects();

  for (let attach = 0; attach < 4; attach += 1) {
    const screen = (await subject().reattachTerminal(workspace)).output;

    expect(screen.split('Runtime resumed').length - 1, `attach ${String(attach + 1)}`).toBe(1);
  }
});

// Staging 2026-10-08: a 20 MB print failed its row's write (SQLITE_TOOBIG) as an uncaught rejection.
it('a print past the row limit runs, and its row keeps the head a reader shows with the length printed', async () => {
  const subject = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('clip'));
  const workspace = 'durability-clip';
  const printed = 3_000_000;
  await subject().serveSlate({ workspace, owner: 'durability-owner', id: 'beside-clip', body: 'served' });

  expect((await subject().runInWorkspace(workspace, `node -e "process.stdout.write('x'.repeat(${String(printed)}))"`)).exitCode).toBe(0);
  const [row] = await subject().executorOutputs(workspace);

  expect(row?.stdout_len).toBe(printed);
  expect(row?.stdout).toBe('x'.repeat(16 * 1024));

  // A print that reads like a clip note is output, not metadata: its length is its own.
  const lookalike = 'ok\n[kinu: clipped from 9999999 chars]';
  expect((await subject().runInWorkspace(workspace, `node -e "process.stdout.write('ok\\n[kinu: clipped from 9999999 chars]')"`)).exitCode).toBe(0);
  const [plain] = await subject().executorOutputs(workspace);

  expect(plain).toEqual({ stdout: lookalike, stdout_len: lookalike.length });
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
