/**
 * The v2 sidecar over the real journal daemon. Runs INSIDE the privileged
 * container `sidecar-real-daemon.test.ts` starts, with the repository mounted
 * read-only at its own path, and prints one `REPORT` line for the host.
 *
 * The modeled daemon in the unit suites answers the same port; this is the
 * one place the shipped `SidecarCore` meets the FUSE mount, the control
 * socket and the staged delta the C daemon writes. Everything remote stays in
 * memory: the daemon boundary is the thing under test, not the store.
 */

import { existsSync, readFileSync } from 'node:fs';
import { link, lstat, mkdir, open, readdir, readFile, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { SidecarCore } from '../bench/sidecar/core';
import { SidecarDaemonClient, readWalProgress } from '../bench/sidecar/daemon-client';
import type { NodeEntry } from '../src/capture/model';
import { openMerkleV2 } from '../src/candidates/merkle-pack/view-v2';
import type { MerkleV2View } from '../src/candidates/merkle-pack/view-v2';

import {
  MemoryEnvelopeStoreV2,
  MemoryPayloadStore,
  candidateRunControlV2,
  readTree,
} from './support/sidecar-fixture';
import { MemoryControlStore } from './support/candidate-control';
import { compareTrees, describeMismatches, sortedByPath } from './support/tree-model';
import type { TreeProperty } from './support/tree-model';

const DAEMON = '/usr/local/bin/kinu-journal-daemon';
const WORK = '/work/sidecar';

interface Check {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface Workspace {
  readonly root: string;
  readonly mount: string;
  readonly state: string;
  readonly socket: string;
}

interface Daemon {
  readonly process: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
}

const checks: Check[] = [];
const facts: Record<string, number | string> = {};

function assert(name: string, ok: boolean, detail: string): void {
  checks.push({ check: name, ok, detail });
  if (!ok) throw new Error(`${name}: ${detail}`);
}

async function workspace(): Promise<Workspace> {
  await rm(WORK, { recursive: true, force: true });
  const space = {
    root: join(WORK, 'root'),
    mount: join(WORK, 'mnt'),
    state: join(WORK, 'state'),
    socket: join(WORK, 'state', 'control.sock'),
  };
  for (const path of [space.root, space.mount, space.state]) await mkdir(path, { recursive: true });
  return space;
}

function mounted(path: string): boolean {
  return readFileSync('/proc/self/mountinfo', 'utf8').split('\n').some((line) => line.split(' ')[4] === path);
}

async function startDaemon(space: Workspace): Promise<Daemon> {
  const process = Bun.spawn({
    cmd: [DAEMON, '--root', space.root, '--mount', space.mount, '--state', space.state, '--socket', space.socket],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const started = Date.now();
  while (!(existsSync(space.socket) && mounted(space.mount))) {
    if (process.exitCode !== null) {
      throw new Error(`daemon exited ${process.exitCode} before serving: ${await new Response(process.stderr).text()}`);
    }
    if (Date.now() - started > 20_000) throw new Error('daemon did not mount and open its control socket in 20 s');
    await Bun.sleep(20);
  }
  return { process };
}

async function killDaemon(space: Workspace, daemon: Daemon): Promise<void> {
  daemon.process.kill('SIGKILL');
  await daemon.process.exited;
  // The kernel drops the session with the process; the lazy unmount clears
  // the dead mount point so the restarted daemon mounts over an empty one.
  await Bun.spawn({ cmd: ['fusermount3', '-u', '-z', space.mount], stdout: 'ignore', stderr: 'ignore' }).exited;
  while (mounted(space.mount)) await Bun.sleep(20);
}

async function stopDaemon(daemon: Daemon): Promise<number> {
  daemon.process.kill('SIGTERM');
  return await daemon.process.exited;
}

/** `ok`, or the errno name a system call answered. Anything that is not an
 *  errno failure is a defect and propagates. */
async function errnoOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return 'ok';
  } catch (error) {
    if (error instanceof Error && 'code' in error) return String(error.code);
    throw error;
  }
}

/** A positional read on a held descriptor: what `pread(2)` answers, so the
 *  descriptor's own offset never decides what the check sees. */
async function readAt(handle: FileHandle, position: number, length: number): Promise<string> {
  const buffer = new Uint8Array(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return new TextDecoder().decode(buffer.subarray(0, bytesRead));
}

/** The tree on the daemon's backing root, as capture-model entries. Times and
 *  xattrs are not compared: reading a file for its bytes moves its atime. */
async function diskTree(root: string): Promise<NodeEntry[]> {
  const entries: NodeEntry[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(join(root, dir))).sort()) {
      const path = dir === '' ? name : `${dir}/${name}`;
      const facts = await lstat(join(root, path), { bigint: true });
      const metadata = { uid: Number(facts.uid), gid: Number(facts.gid), atimeNs: '0', mtimeNs: '0', ctimeNs: '0', xattrs: {} };
      const mode = Number(facts.mode & 0o7777n);
      const ino = Number(facts.ino);
      if (facts.isDirectory()) {
        entries.push({ path, kind: 'dir', mode, ino, metadata });
        await walk(path);
      } else if (facts.isSymbolicLink()) {
        entries.push({ path, kind: 'symlink', mode, ino, metadata, target: await readlink(join(root, path)) });
      } else if (facts.isFile()) {
        entries.push({ path, kind: 'file', mode, ino, metadata, content: { kind: 'dense', bytes: new Uint8Array(await readFile(join(root, path))) } });
      }
    }
  };
  await walk('');
  return entries;
}

const NOT_COMPARED: ReadonlySet<TreeProperty> = new Set(['times', 'xattrs']);

function expectSameTree(name: string, expected: readonly NodeEntry[], served: readonly NodeEntry[]): void {
  const mismatches = compareTrees(sortedByPath(expected), sortedByPath(served), NOT_COMPARED);
  assert(name, mismatches.length === 0, `${expected.length} entries; ${mismatches.length} mismatches: ${describeMismatches(mismatches).slice(0, 800)}`);
}

interface Stores {
  readonly payload: MemoryPayloadStore;
  readonly envelopes: MemoryEnvelopeStoreV2;
  readonly control: MemoryControlStore;
}

function openCore(space: Workspace, stores: Stores, bootId: string, now: () => number): SidecarCore {
  return new SidecarCore({
    boxId: 'box-real-daemon',
    bootId,
    snapshot: async () => await candidateRunControlV2(stores.control, stores.envelopes),
    head: { control: stores.control, envelopes: stores.envelopes },
    payload: stores.payload,
    daemon: new SidecarDaemonClient(space.socket),
    now,
    graceMs: 10_000,
    maxPackBytes: 256 * 1024,
  });
}

async function publish(core: SidecarCore, what: string): Promise<string> {
  const outcome = await core.seal('quiesce');
  if (outcome.kind !== 'published') {
    throw new Error(`${what} did not publish: ${outcome.kind}${'reason' in outcome ? ` (${outcome.reason})` : ''}`);
  }
  return outcome.generation;
}

async function servedTree(stores: Stores, bootId: string): Promise<{ tree: NodeEntry[]; view: MerkleV2View; reads: number }> {
  const control = await candidateRunControlV2(stores.control, stores.envelopes);
  if (control.head === null) throw new Error('no published head');
  const before = stores.payload.ops.length;
  const view = await openMerkleV2(control.head.envelope.rootObject, stores.payload, {
    operationId: `served-${bootId}`,
    attemptId: `served-${bootId}`,
    boxId: 'box-real-daemon',
    epoch: '1',
    expiresAt: '9999999999999',
  });
  const tree = await readTree(view);
  return { tree, view, reads: stores.payload.ops.length - before };
}

function putOps(stores: Stores, since: number) {
  const ops = stores.payload.ops.slice(since).filter((op) => op.op === 'put');
  return { puts: ops.length, bytes: ops.reduce((sum, op) => sum + op.bytes, 0) };
}

async function main(): Promise<void> {
  let now = 1_000;
  const clock = (): number => now;
  const space = await workspace();
  const stores: Stores = {
    payload: new MemoryPayloadStore(),
    envelopes: new MemoryEnvelopeStoreV2(),
    control: new MemoryControlStore(),
  };
  let daemon = await startDaemon(space);
  try {
    // ── the tree: one wide directory, nesting, a symlink, a hardlink, a 3 MiB file
    const mount = space.mount;
    let plantedBytes = 0;
    const plant = async (path: string, bytes: Uint8Array): Promise<void> => {
      await writeFile(join(mount, path), bytes);
      plantedBytes += bytes.byteLength;
    };
    const utf8 = new TextEncoder();
    await mkdir(join(mount, 'wide'));
    for (let i = 0; i < 300; i += 1) await plant(join('wide', `f${String(i).padStart(4, '0')}.txt`), utf8.encode(`entry ${i}\n`));
    await mkdir(join(mount, 'src', 'lib'), { recursive: true });
    await plant(join('src', 'lib', 'a.ts'), utf8.encode('export const a = 1;\n'));
    await plant(join('src', 'index.ts'), utf8.encode('import { a } from "./lib/a";\n'));
    await symlink('src/index.ts', join(mount, 'entry'));
    await link(join(mount, 'src', 'lib', 'a.ts'), join(mount, 'src', 'lib', 'a-link.ts'));
    const big = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 7 + (i >> 12)) & 0xff;
    await plant('big.bin', big);
    // The seal cadence's byte trigger reads the WAL the daemon wrote.
    const progress = await readWalProgress(join(space.state, 'wal.log'), 0);
    facts.walDirtyBytes = progress.dirtyBytes;
    assert('wal-progress-counts-the-bytes-written', progress.dirtyBytes === plantedBytes,
      `wal=${progress.dirtyBytes} written=${plantedBytes}`);

    const first = openCore(space, stores, 'boot-1', clock);
    await first.attach();
    const base = stores.payload.ops.length;
    const generation1 = await publish(first, 'the first seal');
    const firstPut = putOps(stores, base);
    facts.firstSealPuts = firstPut.puts;
    facts.firstSealBytes = firstPut.bytes;
    facts.firstSealDirPagesWritten = first.status().work.seal.nodesRewritten;
    assert('first-seal-publishes-generation-1', generation1 === '1', `generation=${generation1}`);
    const disk1 = await diskTree(space.root);
    const served1 = await servedTree(stores, 'g1');
    expectSameTree('generation-1-serves-the-mounted-tree', disk1, served1.tree);
    facts.generation1Entries = disk1.length;
    const wideRecord = await served1.view.record('wide');
    assert('wide-directory-is-paged', wideRecord?.node.kind === 'dir' && wideRecord.node.entries.kind === 'paged',
      `entries=${wideRecord?.node.kind === 'dir' ? wideRecord.node.entries.kind : 'none'}`);
    const lookupStart = stores.payload.ops.length;
    await served1.view.stat('wide/f0100.txt');
    facts.wideLookupReads = stores.payload.ops.length - lookupStart;

    // ── an already-open descriptor keeps its inode across rename, unlink and
    //    replacement, and across a publish that seals those operations.
    const held = await open(join(mount, 'src', 'index.ts'), 'r');
    const originalIndex = 'import { a } from "./lib/a";\n';
    await rename(join(mount, 'src', 'index.ts'), join(mount, 'src', 'main.ts'));
    const afterRename = await readAt(held, 0, originalIndex.length);
    assert('open-descriptor-follows-inode-across-rename', afterRename === originalIndex, JSON.stringify(afterRename));
    await unlink(join(mount, 'src', 'main.ts'));
    await writeFile(join(mount, 'src', 'index.ts'), 'export {};\n');
    const afterReplace = await readAt(held, 0, originalIndex.length);
    assert('open-descriptor-keeps-unlinked-inode-after-replacement', afterReplace === originalIndex, JSON.stringify(afterReplace));
    const heldStat = await held.stat();
    assert('open-descriptor-answers-fstat-after-unlink', heldStat.size === originalIndex.length && heldStat.nlink === 0,
      `size=${heldStat.size} nlink=${heldStat.nlink}`);
    const backingNames = await readdir(join(space.root, 'src'));
    assert('unlinked-name-is-gone-while-the-descriptor-is-open', !backingNames.includes('main.ts'), backingNames.join(','));
    // A nameless inode still takes writes, fsync and truncate on its descriptor.
    const writable = await open(join(mount, 'src', 'scratch.ts'), 'w+');
    await writable.write('scratch\n', 0);
    await unlink(join(mount, 'src', 'scratch.ts'));
    await writable.write('nameless write\n', 0);
    await writable.sync();
    await writable.truncate(8);
    const namelessStat = await writable.stat();
    // The kernel serves this fstat from the attributes the truncate reply
    // cached, so nlink is reported rather than asserted here.
    assert('nameless-descriptor-accepts-write-fsync-truncate', namelessStat.size === 8,
      `size=${namelessStat.size} nlink=${namelessStat.nlink}`);
    await writable.close();
    // A hardlink twin that this generation never touched: the bytes written
    // through the unlinked name belong to the twin at the cut.
    await writeFile(join(mount, 'twin-a.txt'), 'twin before\n');
    await link(join(mount, 'twin-a.txt'), join(mount, 'twin-b.txt'));
    await publish(first, 'the twin base');
    await writeFile(join(mount, 'twin-a.txt'), 'twin after\n');
    await unlink(join(mount, 'twin-a.txt'));
    await writeFile(join(mount, 'wide', 'f0100.txt'), 'rewritten entry\n');
    await unlink(join(mount, 'wide', 'f0299.txt'));
    await writeFile(join(mount, 'wide', 'f0300.txt'), 'entry 300\n');
    const bigHandle = await open(join(mount, 'big.bin'), 'r+');
    await bigHandle.write(new Uint8Array(4096).fill(0xee), 0, 4096, 1024 * 1024 + 512);
    await bigHandle.close();
    const beforeSecond = stores.payload.ops.length;
    const generation2 = await publish(first, 'the second seal');
    const secondPut = putOps(stores, beforeSecond);
    facts.secondSealPuts = secondPut.puts;
    facts.secondSealBytes = secondPut.bytes;
    assert('second-seal-publishes-generation-3', generation2 === '3', `generation=${generation2}`);
    const afterPublish = await readAt(held, 0, originalIndex.length);
    assert('open-descriptor-survives-a-publish', afterPublish === originalIndex, JSON.stringify(afterPublish));
    // The head sealed while the descriptor was open: the caller's unlink is
    // what it records, and libfuse's hidden name reaches neither the head nor
    // the backing tree once the descriptor closes.
    const sealedOpen = (await servedTree(stores, 'g2')).tree;
    assert('head-sealed-with-an-open-unlinked-inode-carries-no-hidden-name',
      sealedOpen.every((entry) => entry.path !== 'src/main.ts' && !entry.path.includes('.fuse_hidden')),
      sealedOpen.filter((entry) => entry.path.startsWith('src/')).map((entry) => entry.path).join(','));
    await held.close();
    const closedNames = await readdir(join(space.root, 'src'));
    assert('release-removes-the-hidden-name-from-the-backing-tree',
      !closedNames.some((name) => name.startsWith('.fuse_hidden')), closedNames.join(','));
    const disk2 = await diskTree(space.root);
    expectSameTree('generation-3-serves-the-mutated-tree', disk2, sealedOpen);
    const twin = (await servedTree(stores, 'g2c')).tree.find((entry) => entry.path === 'twin-b.txt');
    const twinBytes = twin?.content?.kind === 'dense' ? new TextDecoder().decode(twin.content.bytes) : '<absent>';
    assert('untouched-hardlink-twin-carries-bytes-written-through-the-unlinked-name',
      twinBytes === 'twin after\n', JSON.stringify(twinBytes));
    // A write through one name of a published hardlink, the other untouched:
    // both names serve the new bytes and stay one inode.
    await writeFile(join(mount, 'src', 'lib', 'a.ts'), 'export const a = 2;\n');
    const linkSealStarted = performance.now();
    await publish(first, 'the hardlink write');
    facts.hardlinkSealMs = Math.round(performance.now() - linkSealStarted);
    await writeFile(join(mount, 'src', 'plain.ts'), 'export const plain = 1;\n');
    const plainSealStarted = performance.now();
    await publish(first, 'the plain write');
    facts.plainSealMs = Math.round(performance.now() - plainSealStarted);
    const linked = (await servedTree(stores, 'g4')).tree;
    const linkA = linked.find((entry) => entry.path === 'src/lib/a.ts');
    const linkB = linked.find((entry) => entry.path === 'src/lib/a-link.ts');
    const linkText = (entry: NodeEntry | undefined): string =>
      entry?.content?.kind === 'dense' ? new TextDecoder().decode(entry.content.bytes) : '<absent>';
    assert('published-hardlink-twin-follows-a-write-through-one-name',
      linkText(linkA) === 'export const a = 2;\n' && linkText(linkB) === 'export const a = 2;\n'
      && linkA !== undefined && linkB !== undefined && linkA.ino === linkB.ino,
      `a=${JSON.stringify(linkText(linkA))} link=${JSON.stringify(linkText(linkB))} sameInode=${linkA?.ino === linkB?.ino}`);

    // ── compaction and GC on the real tree, then a fresh boot serves it.
    for (let round = 0; round < 3; round += 1) {
      const churn = new Uint8Array(512 * 1024);
      for (let i = 0; i < churn.length; i += 1) churn[i] = (i * (round + 3)) & 0xff;
      await writeFile(join(mount, 'churn.bin'), churn);
      await publish(first, `churn ${round}`);
    }
    const compacted = await first.compact();
    facts.compacted = compacted ? 1 : 0;
    now += 10_001;
    const swept = await first.collectGarbage();
    facts.gcDeletes = swept.deletes;
    const disk3 = await diskTree(space.root);
    const second = openCore(space, stores, 'boot-2', clock);
    const attachStart = stores.payload.ops.length;
    const attached = await second.attach();
    facts.freshAttachReads = stores.payload.ops.length - attachStart;
    assert('fresh-boot-attaches', attached.kind === 'attached', attached.kind);
    expectSameTree('fresh-boot-serves-the-compacted-tree', disk3, (await servedTree(stores, 'g5')).tree);

    // ── a caller's own file shaped like a libfuse hide is ordinary data: it
    //    is published, and its unlink is published, because the daemon tracks
    //    the hides it performed rather than a name prefix.
    const callerName = '.fuse_hidden0000abcd0000ef01';
    await writeFile(join(mount, 'src', callerName), 'mine, not libfuse\'s\n');
    await publish(first, 'the shaped-name write');
    const callerHideName = (await servedTree(stores, 'g4b')).tree.find((entry) => entry.path === `src/${callerName}`);
    assert('a-caller-file-shaped-like-a-hide-is-published',
      callerHideName?.content?.kind === 'dense' && new TextDecoder().decode(callerHideName.content.bytes) === 'mine, not libfuse\'s\n',
      callerHideName === undefined ? 'absent' : 'present');
    await unlink(join(mount, 'src', callerName));
    await publish(first, 'the shaped-name unlink');
    assert('a-caller-unlink-of-a-hide-shaped-name-is-published',
      (await servedTree(stores, 'g4c')).tree.every((entry) => entry.path !== `src/${callerName}`), callerName);

    // ── the daemon dies with unsealed writes, an open descriptor and a hidden
    //    name outstanding; the restarted daemon recovers the writes, removes
    //    the hidden name, and the next seal continues the published chain.
    await writeFile(join(mount, 'src', 'after-kill.ts'), 'export const recovered = true;\n');
    const surviving = await open(join(mount, 'src', 'lib', 'a.ts'), 'r');
    const ghost = await open(join(mount, 'src', 'ghost.txt'), 'w+');
    await ghost.write('held open, then unlinked\n', 0);
    await unlink(join(mount, 'src', 'ghost.txt'));
    const hiddenBeforeKill = (await readdir(join(space.root, 'src'))).filter((name) => name.startsWith('.fuse_hidden'));
    assert('a-hide-is-outstanding-before-the-kill', hiddenBeforeKill.length === 1, hiddenBeforeKill.join(','));
    await killDaemon(space, daemon);
    daemon = await startDaemon(space);
    const hiddenAfterRestart = (await readdir(join(space.root, 'src'))).filter((name) => name.startsWith('.fuse_hidden'));
    assert('restart-removes-the-hidden-name-the-dead-daemon-left', hiddenAfterRestart.length === 0, hiddenAfterRestart.join(','));
    // A descriptor on the dead mount is dead; a fresh open on the new mount
    // serves the bytes the old daemon wrote through before it died.
    const deadRead = await errnoOf(surviving.read(new Uint8Array(8), 0, 8, 0));
    assert('a-descriptor-on-the-dead-mount-answers-an-error', deadRead !== 'ok', deadRead);
    facts.deadDescriptorRead = deadRead;
    facts.deadDescriptorClose = `${await errnoOf(surviving.close())},${await errnoOf(ghost.close())}`;
    assert('a-fresh-open-after-restart-serves-the-durable-bytes',
      (await readFile(join(mount, 'src', 'after-kill.ts'), 'utf8')) === 'export const recovered = true;\n', 'src/after-kill.ts');
    await writeFile(join(mount, 'src', 'after-restart.ts'), 'export const restarted = true;\n');
    const third = openCore(space, stores, 'boot-3', clock);
    await third.attach();
    const generationAfterKill = await publish(third, 'the seal after a daemon kill');
    facts.generationAfterKill = generationAfterKill;
    const disk4 = await diskTree(space.root);
    const served4 = await servedTree(stores, 'g6');
    expectSameTree('seal-after-daemon-kill-serves-the-recovered-tree', disk4, served4.tree);
    assert('unsealed-write-before-the-kill-is-published',
      served4.tree.some((entry) => entry.path === 'src/after-kill.ts')
      && served4.tree.every((entry) => entry.path !== 'src/ghost.txt' && !entry.path.includes('.fuse_hidden')),
      served4.tree.filter((entry) => entry.path.startsWith('src/')).map((entry) => entry.path).join(','));
    const control = await candidateRunControlV2(stores.control, stores.envelopes);
    assert('published-chain-is-unbroken', control.head !== null
      && control.head.envelope.parentRootId !== null, `head=${control.head?.pointer.rootEnvelopeId}`);

    const exit = await stopDaemon(daemon);
    assert('daemon-stops-cleanly', exit === 0, `exit=${exit}`);
  } finally {
    if (daemon.process.exitCode === null) await killDaemon(space, daemon);
  }
}

let error: string | undefined;
try {
  await main();
} catch (failure) {
  error = failure instanceof Error ? `${failure.message}\n${failure.stack ?? ''}` : String(failure);
}
const ok = error === undefined && checks.every((check) => check.ok);
console.log(`REPORT ${JSON.stringify({ ok, error, checks, facts })}`);
process.exit(ok ? 0 : 1);
