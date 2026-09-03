/**
 * Journal daemon runtime matrix. Runs INSIDE the privileged container started by
 * journal-daemon-runtime.test.ts, drives the real daemon through its public
 * surfaces only — the FUSE mount and the AF_UNIX control socket — and prints one
 * JSON report line for the host to assert on.
 *
 * The matrix depends on nothing but Bun and the daemon: the sealed manifests it
 * verifies here are re-verified on the host by the production client, against
 * the workspace exported through KINU_EXPORT_DIR.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { appendFile, chmod, mkdir, open, readdir, readFile, rename, rm, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import * as v from 'valibot';
import { join } from 'node:path';

import type {
  BoundariesReply,
  Check,
  DeltaCostFacts,
  DeltaEntry,
  DeltaManifest,
  DirtyRange,
  ExitFacts,
  Extent,
  JournalRecord,
  MatrixFacts,
  MetadataOp,
  ProbeEvent,
  ProbeLine,
  FenceReply,
  ScenarioReport,
  SealWork,
  StatsReply,
  StopReply,
} from './journal-daemon-runtime-types';

const DAEMON = '/usr/local/bin/kinu-journal-daemon';
const RACING_DAEMON = '/usr/local/bin/kinu-journal-daemon-tsan';
const PROBE = '/tmp/journal-daemon-runtime-probe';
const WORK = '/work';
const EXPORT_DIR = process.env.KINU_EXPORT_DIR ?? join(WORK, 'exported');
const EXPORT_UID = process.env.KINU_EXPORT_UID ?? '0';
const EXIT_LIMIT_MS = 10_000;
const MAX_EXTENT_BYTES = 512 * 1024;
const COMPACT_BOUND_BYTES = 128 * 1024;
/* The CDC parameter the boundary hand-back publishes with, and therefore the
 * context a fence grows a dirty cluster by: 4 x this, per the design. */
const MAX_CHUNK_BYTES = 64 * 1024;
const CANCELLED_BY_RECOVERY = -125;
const RACE_EXIT_CODE = 66;

interface Workspace {
  readonly dir: string;
  readonly root: string;
  readonly mount: string;
  readonly state: string;
  readonly socket: string;
  readonly journal: string;
}

interface Daemon {
  readonly workspace: Workspace;
  readonly process: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
}

interface Fence {
  readonly cut: number;
  readonly generation: number;
  readonly manifestPath: string;
  readonly base: FenceReply['base'];
  readonly sealWork: SealWork;
  readonly startedAt: number;
  readonly endedAt: number;
}

interface SealedFence {
  readonly manifest: DeltaManifest;
  readonly files: number;
  readonly extents: number;
  readonly bytes: number;
  readonly wholeFiles: number;
}

interface ProbeRun {
  readonly code: number;
  readonly checks: Check[];
  readonly events: ProbeEvent[];
}

const BaseReplySchema = v.looseObject({
  ok: v.boolean(),
  cut: v.optional(v.number()),
  baseCut: v.optional(v.string()),
  baseGeneration: v.optional(v.string()),
  baseRoot: v.optional(v.string()),
});
const ErrnoFailureSchema = v.looseObject({
  code: v.optional(v.string()),
  message: v.optional(v.string()),
});
const reports: ScenarioReport[] = [];

function assert(checks: Check[], name: string, ok: boolean, detail: string): void {
  checks.push({ check: name, ok, detail });
  if (!ok) throw new Error(`${name}: ${detail}`);
}

function adopt(checks: Check[], run: ProbeRun, prefix: string): void {
  for (const check of run.checks) checks.push({ check: `${prefix}:${check.check}`, ok: check.ok, detail: check.detail });
  const failed = run.checks.filter((check) => !check.ok).map((check) => check.check);
  assert(checks, `${prefix}:exit`, run.code === 0 && failed.length === 0, `code=${run.code} failed=${failed.join(',')}`);
}

/* ---------------------------------------------------------- lifecycle ----- */

async function workspace(name: string, exported = false): Promise<Workspace> {
  const dir = exported ? EXPORT_DIR : join(WORK, name);
  const state = join(dir, 'state');
  const spec: Workspace = {
    dir,
    state,
    root: join(dir, 'root'),
    mount: join(dir, 'mnt'),
    socket: join(state, 'control.sock'),
    journal: join(state, 'wal.log'),
  };
  /* The export is a bind mount the host may reuse, so a scenario clears what a
   * previous run left in it rather than serving a tree it did not build.  The
   * mount point itself stays: removing it would fail, and the host owns it. */
  if (exported) {
    for (const entry of await readdir(dir)) await rm(join(dir, entry), { recursive: true, force: true });
  }
  for (const path of [spec.root, spec.mount, spec.state]) await mkdir(path, { recursive: true });
  return spec;
}

async function request(socket: string, op: string, fields: Record<string, string> = {}): Promise<string> {
  const id = randomUUID();
  const line = await new Promise<string>((resolve, reject) => {
    const stream = connect(socket);
    let received = '';
    stream.setEncoding('utf8');
    stream.once('error', reject);
    /* A daemon that is already stopping never accepts another request, so its
     * socket closes unanswered: that is an answer, not something to wait on. */
    stream.once('close', () => reject(new Error(`control ${op} closed without a reply`)));
    stream.on('data', (chunk: string) => {
      received += chunk;
      const newline = received.indexOf('\n');
      if (newline < 0) return;
      stream.end();
      resolve(received.slice(0, newline));
    });
    stream.once('connect', () => stream.write(`${JSON.stringify({ id, op, ...fields })}\n`));
  });
  if (!line.includes(`"id":"${id}"`)) throw new Error(`control ${op} answered a foreign request: ${line}`);
  return line;
}

/** The one request shape that does not fit `request`'s string fields. */
interface BoundariesRequest {
  readonly op: 'boundaries';
  readonly cut: string;
  readonly generation: string;
  readonly root: string;
  readonly maxChunkBytes: number;
  readonly files: readonly { ino: string; path: string; size: number; boundaries: readonly number[] }[];
  readonly removed: readonly string[];
}

async function requestJson(socket: string, body: BoundariesRequest): Promise<string> {
  const id = randomUUID();
  const line = await new Promise<string>((resolve, reject) => {
    const stream = connect(socket);
    let received = '';
    stream.setEncoding('utf8');
    stream.once('error', reject);
    stream.once('close', () => reject(new Error(`control ${body.op} closed without a reply`)));
    stream.on('data', (chunk: string) => {
      received += chunk;
      const newline = received.indexOf('\n');
      if (newline < 0) return;
      stream.end();
      resolve(received.slice(0, newline));
    });
    stream.once('connect', () => stream.write(`${JSON.stringify({ id, ...body })}\n`));
  });
  if (!line.includes(`"id":"${id}"`)) throw new Error(`control ${body.op} answered a foreign request: ${line}`);
  return line;
}

/** Hands the daemon the boundaries a publish created, as the sidecar does. */
async function publishBoundaries(
  space: Workspace,
  base: { cut: number; generation: number; root: string },
  files: readonly { ino: string; path: string; size: number; boundaries: readonly number[] }[],
  removed: readonly string[] = [],
): Promise<BoundariesReply> {
  const reply: BoundariesReply = JSON.parse(await requestJson(space.socket, {
    op: 'boundaries',
    cut: String(base.cut),
    generation: String(base.generation),
    root: base.root,
    maxChunkBytes: MAX_CHUNK_BYTES,
    files,
    removed,
  }));
  return reply;
}

/** Writes `length` bytes at `offset` through the mount, without truncating. */
async function writeAt(path: string, offset: number, length: number, seed = 0x5a): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    const bytes = Buffer.alloc(length);
    for (let index = 0; index < length; index++) bytes[index] = (seed + index) & 0xff;
    await handle.write(bytes, 0, length, offset);
  } finally {
    await handle.close();
  }
}

/** The dirty runs one delta entry reports, as comparable data. */
function dirtyOf(manifest: DeltaManifest, path: string): readonly DirtyRange[] {
  return entryOf(manifest, path).dirty ?? [];
}

async function stats(space: Workspace): Promise<StatsReply> {
  const reply: StatsReply = JSON.parse(await request(space.socket, 'stats'));
  if (reply.ok !== true || !Number.isSafeInteger(reply.sequence) || !Number.isSafeInteger(reply.records)) {
    throw new Error(`stats reply is incomplete: ${JSON.stringify(reply)}`);
  }
  return reply;
}

async function fence(space: Workspace): Promise<Fence> {
  const startedAt = Date.now();
  const reply: FenceReply = JSON.parse(await request(space.socket, 'fence'));
  const endedAt = Date.now();
  if (
    reply.ok !== true
    || !Number.isSafeInteger(reply.cut)
    || !Number.isSafeInteger(reply.generation)
    || !reply.manifestPath.startsWith('/')
  ) {
    throw new Error(`fence reply is incomplete: ${JSON.stringify(reply)}`);
  }
  return {
    cut: reply.cut,
    generation: reply.generation,
    manifestPath: reply.manifestPath,
    base: reply.base,
    sealWork: reply.sealWork,
    startedAt,
    endedAt,
  };
}

function mountedPaths(): string[] {
  return readFileSync('/proc/self/mountinfo', 'utf8')
    .split('\n')
    .map((line) => line.split(' ')[4] ?? '')
    .filter((path) => path.length > 0);
}

async function startDaemon(space: Workspace, binary = DAEMON): Promise<Daemon> {
  const process = Bun.spawn({
    cmd: [binary, '--root', space.root, '--mount', space.mount, '--state', space.state, '--socket', space.socket],
    /* A race-detecting build reports through its exit code, so a report can
     * never be mistaken for a clean shutdown, and through a log rather than the
     * stderr pipe nobody drains, which a full buffer would stall. Uninstrumented
     * builds ignore both. verbosity=1 makes the build announce itself, which is
     * how the race cell proves it is measuring an instrumented daemon. */
    env: { ...Bun.env, TSAN_OPTIONS: `exitcode=${RACE_EXIT_CODE}:verbosity=1:log_path=${join(space.dir, 'tsan')}` },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const deadline = Date.now() + 20_000;
  let pending = 'the session has not answered yet';
  for (;;) {
    if (Date.now() > deadline) throw new Error(`daemon never became ready: ${pending}`);
    if (process.exitCode !== null) throw new Error(`daemon exited early with ${process.exitCode}`);
    if (existsSync(space.socket) && mountedPaths().includes(space.mount)) {
      try {
        await Bun.file(join(space.mount, '.readiness')).exists();
        const snapshot = await stats(space);
        if (snapshot.directIoAllowMmap) return { workspace: space, process };
        pending = 'the kernel has not negotiated DIRECT_IO_ALLOW_MMAP';
      } catch (error) {
        pending = error instanceof Error ? error.message : String(error);
      }
    }
    await Bun.sleep(50);
  }
}

async function stopDaemon(daemon: Daemon): Promise<ExitFacts> {
  const started = Date.now();
  const reply: StopReply = JSON.parse(await request(daemon.workspace.socket, 'stop'));
  if (reply.ok !== true) throw new Error('stop refused');
  const code = await daemon.process.exited;
  return { code, ms: Date.now() - started, unmounted: !mountedPaths().includes(daemon.workspace.mount) };
}

async function terminateDaemon(daemon: Daemon): Promise<ExitFacts> {
  const started = Date.now();
  daemon.process.kill(15);
  const code = await daemon.process.exited;
  return { code, ms: Date.now() - started, unmounted: !mountedPaths().includes(daemon.workspace.mount) };
}

/* What the race detector left behind. `announced` is the discriminator that
 * matters: an uninstrumented daemon writes no log at all, so without it a cell
 * whose racing build quietly stopped being instrumented would pass on an exit
 * code that proves nothing. */
async function raceReport(space: Workspace): Promise<{ announced: boolean; races: string }> {
  const logs = (await readdir(space.dir)).filter((name) => name.startsWith('tsan.'));
  const text = (await Promise.all(logs.map((name) => readFile(join(space.dir, name), 'utf8')))).join('');
  return {
    announced: text.includes('Running under ThreadSanitizer'),
    races: text.split('\n').filter((line) => line.includes('WARNING: ThreadSanitizer')).join('; '),
  };
}

async function releaseMount(space: Workspace): Promise<void> {
  await Bun.spawn({ cmd: ['fusermount3', '-u', '-z', space.mount], stdout: 'ignore', stderr: 'ignore' }).exited;
}

async function killDaemon(daemon: Daemon): Promise<void> {
  daemon.process.kill(9);
  await daemon.process.exited;
  await releaseMount(daemon.workspace);
}

/* The container wrote the export as root, so it hands the tree back before it
 * exits: the host then reads the sealed fence, and removes it, as itself. */
async function releaseExport(): Promise<void> {
  for (const path of mountedPaths().filter((mounted) => mounted.startsWith(`${EXPORT_DIR}/`))) {
    await Bun.spawn({ cmd: ['fusermount3', '-u', '-z', path], stdout: 'ignore', stderr: 'ignore' }).exited;
  }
  await Bun.spawn({ cmd: ['chmod', '-R', 'a+rX,u+rwX', EXPORT_DIR], stdout: 'ignore', stderr: 'ignore' }).exited;
  await Bun.spawn({ cmd: ['chown', '-R', `${EXPORT_UID}:${EXPORT_UID}`, EXPORT_DIR], stdout: 'ignore', stderr: 'ignore' }).exited;
}

/* ------------------------------------------------------------- journal --- */

function parseJournal(bytes: Buffer): JournalRecord[] {
  const lines = bytes.toString('latin1').split('\n');
  if (lines.pop() !== '') throw new Error('journal does not end on a record boundary');
  return lines.map((line) => {
    const fields = line.split('\t');
    if (fields.length !== 7) throw new Error(`malformed journal record: ${line}`);
    return {
      sequence: Number(fields[0]),
      kind: fields[1] ?? '',
      op: fields[2] ?? '',
      outcome: Number(fields[3]),
      generation: Number(fields[4]),
      path: fields[5] ?? '',
      aux: fields[6] ?? '',
    };
  });
}

function unmatchedIntents(records: readonly JournalRecord[]): number[] {
  const resolved = new Set(records.filter((r) => r.kind === 'RESULT' || r.kind === 'RECOVER').map((r) => r.sequence));
  return records.filter((r) => r.kind === 'INTENT' && !resolved.has(r.sequence)).map((r) => r.sequence);
}

/* ------------------------------------------------------------ manifest --- */

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

/* Every staged run is inside the file, bounded, ascending, and holds exactly
 * the bytes its digest names — read out of the stage at the same offset the
 * manifest gives, because the stage is sparse at the file's own geometry. */
async function verifyStagedRanges(manifest: DeltaManifest, entry: DeltaEntry): Promise<number> {
  const size = entry.size ?? 0;
  let end = 0;
  let verified = 0;
  for (const range of entry.ranges ?? []) {
    if (range.offset < end || range.length <= 0 || range.length > MAX_EXTENT_BYTES ||
      range.offset + range.length > size || !/^[a-f0-9]{64}$/.test(range.sha256)) {
      throw new Error(`entry '${entry.path}' has an invalid staged range at ${range.offset}`);
    }
    const staged = Bun.file(join(manifest.stageRoot, entry.path));
    const slice = await staged.slice(range.offset, range.offset + range.length).arrayBuffer();
    if (slice.byteLength !== range.length) throw new Error(`the stage is short for '${entry.path}'`);
    if (createHash('sha256').update(new Uint8Array(slice)).digest('hex') !== range.sha256) {
      throw new Error(`staged bytes for '${entry.path}' do not match the manifest digest`);
    }
    end = range.offset + range.length;
    verified++;
  }
  return verified;
}

/* The property the whole design rests on: every byte a write touched is inside
 * a run the stage holds.  A delta that describes a write it did not stage would
 * lose those bytes at the next publish, silently. */
function verifyDirtyIsStaged(entry: DeltaEntry): void {
  const staged: readonly Extent[] = entry.ranges ?? [];
  let end = 0;
  for (const dirty of entry.dirty ?? []) {
    if (dirty.offset < end || dirty.length <= 0 || dirty.offset + dirty.length > (entry.size ?? 0)) {
      throw new Error(`entry '${entry.path}' has an invalid dirty range at ${dirty.offset}`);
    }
    end = dirty.offset + dirty.length;
    /* Coverage is a property of the union: a run longer than one extent is
     * staged as several, and they are ascending and non-overlapping, so
     * walking them forward says exactly how far the stage reaches. */
    let reached = dirty.offset;
    for (const range of staged) {
      if (range.offset > reached) break;
      if (range.offset + range.length > reached) reached = range.offset + range.length;
    }
    if (reached >= dirty.offset + dirty.length) continue;
    /* What is left uncovered may only be a hole the write never filled: the
     * daemon stages data runs, so a dirty range over a hole has no bytes to
     * stage.  A partially staged run of real bytes is a lost write. */
    const touchesStage = staged.some((range) => range.offset < dirty.offset + dirty.length
      && range.offset + range.length > dirty.offset);
    if (touchesStage) {
      throw new Error(`entry '${entry.path}' stages ${reached - dirty.offset} of its ${dirty.length}`
        + ` dirty bytes at ${dirty.offset}`);
    }
  }
}

/* The operation list is what a replay follows, so its order is a fact, not an
 * accident: ascending journal sequence, every operation one that succeeded. */
function verifyOps(ops: readonly MetadataOp[]): void {
  let previous = 0;
  for (const op of ops) {
    if (op.sequence <= previous) throw new Error(`metadata op ${op.op} at ${op.sequence} is out of order`);
    if (op.result < 0) throw new Error(`metadata op ${op.op} at ${op.sequence} failed and was still recorded`);
    if (op.op.length === 0 || op.path.length === 0) throw new Error(`metadata op at ${op.sequence} names nothing`);
    previous = op.sequence;
  }
}

/* Rejects anything the delta consumer would have to guess at, and proves every
 * staged range against the bytes actually lying in the stage.  The delta is a
 * partial tree, so the ancestor rule still holds: a path the manifest names
 * carries every directory above it, or nothing could apply it. */
async function verifyManifest(sealed: Fence): Promise<SealedFence> {
  const manifest: DeltaManifest = JSON.parse(await readFile(sealed.manifestPath, 'utf8'));
  if (manifest.version !== 2) throw new Error(`manifest version ${manifest.version} is not the delta the daemon writes`);
  if (manifest.cut !== sealed.cut || manifest.generation !== sealed.generation) {
    throw new Error(`manifest ${manifest.cut}/${manifest.generation} is not the fenced ${sealed.cut}/${sealed.generation}`);
  }
  if (!manifest.stageRoot.startsWith('/')) throw new Error('manifest names no stage');
  const kinds = new Map<string, string>();
  const inodes = new Map<string, DeltaEntry>();
  let files = 0;
  let extents = 0;
  let bytes = 0;
  let wholeFiles = 0;
  for (const entry of manifest.entries) {
    if (entry.path === '' || entry.path.startsWith('/') || entry.path.endsWith('/')) {
      throw new Error(`non-canonical manifest path '${entry.path}'`);
    }
    for (const segment of entry.path.split('/')) {
      if (segment === '' || segment === '.' || segment === '..') throw new Error(`non-canonical path '${entry.path}'`);
    }
    if (kinds.has(entry.path)) throw new Error(`duplicate manifest path '${entry.path}'`);
    if (!/^[1-9]\d*$/.test(entry.ino) || !Number.isSafeInteger(entry.mode) || entry.mode < 0) {
      throw new Error(`entry '${entry.path}' carries no real identity`);
    }
    if (!Number.isSafeInteger(entry.uid) || entry.uid < 0 || !Number.isSafeInteger(entry.gid) || entry.gid < 0
      || !/^(?:0|[1-9]\d*)$/.test(entry.atimeNs) || !/^(?:0|[1-9]\d*)$/.test(entry.mtimeNs)
      || !/^(?:0|[1-9]\d*)$/.test(entry.ctimeNs)
      || Object.values(entry.xattrs).some((value) => !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))) {
      throw new Error(`entry '${entry.path}' carries invalid POSIX metadata`);
    }
    if ((entry.kind === 'symlink') !== (entry.target !== undefined)) {
      throw new Error(`entry '${entry.path}' has inconsistent symlink metadata`);
    }
    if ((entry.kind === 'file') !== (entry.size !== undefined)) {
      throw new Error(`entry '${entry.path}' has inconsistent file metadata`);
    }
    /* A hardlink appears once per touched name, and the sidecar collapses those
     * rows into one record, so their identity has to agree exactly. */
    const twin = inodes.get(entry.ino);
    if (twin !== undefined && (twin.kind !== entry.kind || twin.size !== entry.size || twin.mode !== entry.mode
      || twin.mtimeNs !== entry.mtimeNs || twin.atimeNs !== entry.atimeNs)) {
      throw new Error(`hardlinked '${entry.path}' and '${twin.path}' disagree about their inode`);
    }
    /* Counted per INODE, not per row: a hardlink is described under each of its
     * names and staged once, so summing rows would count its bytes twice.  This
     * is what the disagreement below is measured against. */
    const firstRow = twin === undefined;
    inodes.set(entry.ino, entry);
    kinds.set(entry.path, entry.kind);
    if (entry.kind !== 'file') continue;
    files++;
    verifyDirtyIsStaged(entry);
    extents += await verifyStagedRanges(manifest, entry);
    if (!firstRow) continue;
    if (entry.whole === true) wholeFiles++;
    for (const range of entry.ranges ?? []) bytes += range.length;
  }
  for (const path of kinds.keys()) {
    for (let ancestor = parentOf(path); ancestor !== ''; ancestor = parentOf(ancestor)) {
      if (kinds.get(ancestor) !== 'dir') throw new Error(`ancestor '${ancestor}' of '${path}' is not a described directory`);
    }
  }
  verifyOps(manifest.metadataOps);
  /* The counter row is the number the conformance bounds are read from, so it
   * has to be the number this manifest actually describes. */
  if (manifest.sealWork.bytesStaged !== bytes) {
    throw new Error(`sealWork.bytesStaged ${manifest.sealWork.bytesStaged} is not the ${bytes} the manifest stages`);
  }
  if (manifest.sealWork.wholeFiles !== wholeFiles) {
    throw new Error(`sealWork.wholeFiles ${manifest.sealWork.wholeFiles} is not the ${wholeFiles} the manifest marks`);
  }
  if (sealed.sealWork.bytesStaged !== manifest.sealWork.bytesStaged
    || sealed.sealWork.wholeFiles !== manifest.sealWork.wholeFiles) {
    throw new Error('the fence reply and its manifest disagree about the seal');
  }
  return { manifest, files, extents, bytes, wholeFiles };
}

function entryOf(manifest: DeltaManifest, path: string): DeltaEntry {
  const entry = manifest.entries.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`manifest describes no path ${path}`);
  return entry;
}

function stagedFile(manifest: DeltaManifest, path: string): DeltaEntry {
  const entry = entryOf(manifest, path);
  if (entry.kind !== 'file' || (entry.ranges ?? []).length === 0) throw new Error(`manifest stages no bytes for ${path}`);
  return entry;
}

/* The stage is sparse at the file's own geometry, so a staged read uses the
 * file offset the manifest gives rather than a per-extent source. */
async function stagedBytes(manifest: DeltaManifest, path: string, length: number): Promise<Buffer> {
  stagedFile(manifest, path);
  const staged = Bun.file(join(manifest.stageRoot, path));
  return Buffer.from(await staged.slice(0, length).arrayBuffer());
}

/* --------------------------------------------------------------- probe --- */

function collectProbeLine(text: string, checks: Check[], events: ProbeEvent[]): void {
  const line: ProbeLine = JSON.parse(text);
  if (line.check !== undefined) {
    checks.push({ check: line.check, ok: line.ok === true, detail: line.detail ?? '' });
    return;
  }
  if (line.event !== undefined) {
    events.push({ event: line.event, round: line.round ?? 0, ms: line.ms ?? 0, failures: line.failures ?? 0 });
  }
}

async function runProbe(args: string[]): Promise<ProbeRun> {
  const process = Bun.spawn({ cmd: [PROBE, ...args], stdout: 'pipe', stderr: 'pipe' });
  const [text, error, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  const checks: Check[] = [];
  const events: ProbeEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.length > 0) collectProbeLine(line, checks, events);
  }
  if (error.length > 0) checks.push({ check: 'stderr', ok: false, detail: error.slice(0, 400) });
  return { code, checks, events };
}

interface BackgroundProbe {
  readonly process: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  readonly finished: Promise<ProbeRun>;
  readonly seen: () => ProbeEvent[];
}

function startProbe(args: string[]): BackgroundProbe {
  const process = Bun.spawn({ cmd: [PROBE, ...args], stdout: 'pipe', stderr: 'pipe' });
  const events: ProbeEvent[] = [];
  const checks: Check[] = [];
  const finished = (async (): Promise<ProbeRun> => {
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of process.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length > 0) collectProbeLine(line, checks, events);
      }
    }
    const code = await process.exited;
    return { code, checks, events };
  })();
  return { process, finished, seen: () => [...events] };
}

async function waitForRounds(probe: BackgroundProbe, minimum: number, since = 0): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (probe.seen().filter((event) => event.ms > since).length >= minimum) return;
    if (Date.now() > deadline) throw new Error(`the mapping produced fewer than ${minimum} rounds after ${since}`);
    await Bun.sleep(50);
  }
}

async function scenario(name: string, body: (facts: MatrixFacts, checks: Check[]) => Promise<void>): Promise<void> {
  const facts: MatrixFacts = {};
  const checks: Check[] = [];
  /* Announced as it starts, because the report only prints when every scenario
   * has finished: a hang has to be locatable from the outside. */
  console.log(`SCENARIO ${name} start`);
  try {
    await body(facts, checks);
    reports.push({ name, ok: checks.every((check) => check.ok) && checks.length > 0, facts, checks });
  } catch (error) {
    reports.push({ name, ok: false, facts, checks, error: error instanceof Error ? error.message : String(error) });
  }
}

async function checkSealedFiles(sealed: SealedFence, first: Fence, ctx: {
    readonly facts: MatrixFacts;
    readonly mount: string;
    readonly journal: string;
    readonly root: string;
  }, checks: Check[]): Promise<void> {
  /* Every fact this function checks was proven where the delta design
   * guarantees it: in the manifest row, not in a copied stage. Extracted
   * from posix-fence-continuity so that scenario's body stays
   * orchestration and these checks stay nameable. */
  ctx.facts.firstFence = {
    cut: first.cut,
    generation: first.generation,
    entries: sealed.manifest.entries.length,
    files: sealed.files,
    extents: sealed.extents,
    stagedBytes: sealed.bytes,
    ops: sealed.manifest.metadataOps.length,
    wholeFiles: sealed.wholeFiles,
  };
  assert(checks, 'fence-reply-matches-its-manifest',
    sealed.manifest.generation === first.generation && sealed.manifest.cut === first.cut,
    `manifest=${sealed.manifest.cut}/${sealed.manifest.generation} reply=${first.cut}/${first.generation}`);

  const text = (await stagedBytes(sealed.manifest, 'posix/create.txt', 20)).toString('utf8');
  assert(checks, 'sealed-content-verifies', text === 'hello sealed journal', `text=${text}`);

  /* A hole the writer never filled stays a hole in the stage, and its runs
   * are the only bytes the manifest names.  This is the first generation,
   * so there are no published boundaries to resync from and the file is
   * staged whole — which is exactly what `whole` says. */
  const holey = stagedFile(sealed.manifest, 'posix/sparse-keep.bin');
  const holes = holey.ranges ?? [];
  assert(checks, 'sealed-sparse-extents',
    holey.size === 4 * 1024 * 1024 && holey.whole === true && holes.length === 2 &&
    holes.every((range) => range.length === 4096) &&
    holes[0]?.offset === 0 && holes[1]?.offset === 3 * 1024 * 1024,
    `ranges=${JSON.stringify(holes.map((range) => [range.offset, range.length]))} whole=${holey.whole}`);

  const bulky = stagedFile(sealed.manifest, 'posix/big.bin');
  const bulkyRanges = bulky.ranges ?? [];
  assert(checks, 'sealed-extent-cap',
    bulkyRanges.length === 3 && bulkyRanges.every((range) => range.length === MAX_EXTENT_BYTES),
    `ranges=${bulkyRanges.map((range) => range.length).join(',')}`);

  /* The symlink is described, never copied: a delta stage holds file bytes
   * and the directories above them, and nothing else. */
  const outside = entryOf(sealed.manifest, 'posix/outside-link');
  const stagedLink = await Bun.file(join(sealed.manifest.stageRoot, 'posix/outside-link')).exists();
  assert(checks, 'sealed-symlink-is-not-followed',
    outside.kind === 'symlink' && outside.target === '/etc' && !stagedLink,
    `kind=${outside.kind} target=${outside.target ?? 'none'} staged=${stagedLink}`);

  /* A hardlink reaches the manifest once per touched name.  The rows are
   * collapsed into one record downstream, so they have to agree on the
   * inode and on every attribute of it. */
  const hardlinks = sealed.manifest.entries.filter((entry) => entry.path === 'posix/link-first' || entry.path === 'posix/link-second');
  assert(checks, 'hardlink-rows-share-one-inode',
    hardlinks.length === 2 && hardlinks[0]?.ino === hardlinks[1]?.ino
    && hardlinks[0]?.atimeNs === '1000000123456789'
    && hardlinks[0]?.atimeNs === hardlinks[1]?.atimeNs
    && hardlinks[0]?.mtimeNs === hardlinks[1]?.mtimeNs
    && hardlinks[0]?.size === hardlinks[1]?.size,
    `rows=${JSON.stringify(hardlinks.map((entry) => [entry.path, entry.ino, entry.atimeNs, entry.size]))}`);

  /* Modes and extended attributes used to be proven by copying them into
   * the stage.  A delta stage holds no metadata at all, so the same two
   * facts are proven where they now live: in the manifest row. */
  const moded = entryOf(sealed.manifest, 'posix/metadata.txt');
  assert(checks, 'manifest-mode-is-exact', moded.mode === 0o640, `mode=${moded.mode.toString(8)}`);
  const attributed = entryOf(sealed.manifest, 'posix/sealed-xattr.txt');
  assert(checks, 'manifest-xattr-round-trips',
    attributed.xattrs['user.kinu.seal'] === Buffer.from('sealed').toString('base64'),
    `xattrs=${JSON.stringify(attributed.xattrs)}`);

  const hostile = sealed.manifest.entries.filter((entry) => entry.path.includes('\t'));
  assert(checks, 'hostile-name-round-trips', hostile.length === 1 && hostile[0]?.kind === 'file',
    `paths=${JSON.stringify(hostile.map((entry) => entry.path))}`);

  const manifestBytes = (await readFile(first.manifestPath)).byteLength;
  ctx.facts.manifestBytes = manifestBytes;
  assert(checks, 'manifest-carries-no-payload', manifestBytes * 8 < sealed.bytes,
    `manifestBytes=${manifestBytes} stagedBytes=${sealed.bytes}`);

  assert(checks, 'no-post-cut-entry', !sealed.manifest.entries.some((entry) => entry.path === 'after-cut.txt'),
    'after-cut.txt is absent from the sealed manifest');

  /* Every write the journal shows is either described by an entry or is a
   * path that no longer exists at the cut, whose removal the operation list
   * carries.  A write to a file that IS still there and is not described is
   * a lost write, which is the whole failure this cell exists to catch. */
  const written = new Set(parseJournal(await readFile(ctx.journal))
    .filter((record) => record.kind === 'W' && record.sequence <= first.cut)
    .map((record) => record.path.replace(/^\//, '')));
  const describedFiles = new Set(sealed.manifest.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path));
  const missed = [...written].filter((path) => !describedFiles.has(path) && existsSync(join(ctx.root, path)));
  const retired = [...written].filter((path) => !describedFiles.has(path) && !existsSync(join(ctx.root, path)));
  assert(checks, 'every-surviving-journaled-write-is-described', missed.length === 0,
    `written=${written.size} described=${describedFiles.size} goneAtTheCut=${retired.length} ` +
    `missed=${missed.slice(0, 5).join(',')}`);

}

/* ----------------------------------------------------------- scenarios --- */

async function posixAndFence(): Promise<void> {
  await scenario('posix-fence-continuity', async (facts, checks) => {
    const space = await workspace('fence', true);
    const daemon = await startDaemon(space);
    try {
      adopt(checks, await runProbe(['posix', join(space.mount, 'posix')]), 'posix');
      adopt(checks, await runProbe(['escape', space.mount, space.root]), 'escape');

      const stopFile = join(space.dir, 'mmap.stop');
      const mapping = startProbe(['mmap', join(space.mount, 'mmap.bin'), '4', stopFile]);
      await waitForRounds(mapping, 2);

      const writers = Promise.all([
        runProbe(['threads', join(space.mount, 'threads'), '8', '60']),
        runProbe(['fork', join(space.mount, 'forked'), '6', '6']),
      ]);
      await Bun.sleep(120);
      const first = await fence(space);
      const [threaded, forked] = await writers;
      adopt(checks, threaded, 'threads');
      adopt(checks, forked, 'fork');

      await writeFile(join(space.mount, 'after-cut.txt'), 'after the cut');
      /* Read HERE, and not after the next fence, because here is the only
       * moment the daemon guarantees these records exist. A metadata mutation
       * appends its INTENT before the effect and its RESULT before the reply,
       * and a fence COMPACTS the drained prefix that
       * carries them: run_fence calls compact_journal (journal-daemon.c:1396),
       * which replaces the whole WAL with [BASE?, FENCE] whenever it has reached
       * WAL_COMPACT_BYTES (journal-daemon.c:61, :1308). Whether the second fence
       * crosses that bound is wall-clock, not contract: the mapping loop keeps
       * journaling a round every 20 ms while this scenario verifies six
       * megabytes of sealed extents, so a loaded box reaches the bound and an
       * idle one does not. Read after the fence, this was 11-23 KiB of WAL and
       * green alone, and records=0 under the push tier. */
      const marker = parseJournal(await readFile(space.journal))
        .filter((record) => record.path === '/after-cut.txt');
      /* Journaled truncation inside an open, snapshotted before the next fence
       * can compact the records that name it. */
      adopt(checks, await runProbe(['truncate-open', join(space.mount, 'truncated.bin')]), 'truncate');
      const truncations = parseJournal(await readFile(space.journal))
        .filter((record) => record.path === '/truncated.bin' && record.op === 'open-truncate');
      assert(checks, 'truncation-inside-an-open-is-journaled',
        truncations.some((record) => record.kind === 'INTENT') &&
        truncations.some((record) => record.kind === 'RESULT' && record.outcome === 0),
        `records=${truncations.map((record) => `${record.kind}:${record.outcome}`).join(',')}`);
      await waitForRounds(mapping, 2, first.endedAt);

      const sealed = await verifyManifest(first);
      await checkSealedFiles(sealed, first, {
        facts, mount: space.mount, journal: space.journal, root: space.root,
      }, checks);

      adopt(checks, await runProbe(['stage', sealed.manifest.stageRoot]), 'stage');

      const live = (await readFile(join(space.mount, 'mmap.bin'))).subarray(0, 64);
      const frozen = await stagedBytes(sealed.manifest, 'mmap.bin', 64);
      assert(checks, 'sealed-bytes-frozen-at-the-cut', Buffer.compare(frozen, live) !== 0,
        'the stage kept the bytes of the cut while the mapping moved on');

      await writeFile(stopFile, 'stop');
      const mappingRun = await mapping.finished;
      adopt(checks, mappingRun, 'mmap');
      const rounds = mappingRun.events.filter((event) => event.event === 'round');
      const before = rounds.filter((event) => event.ms < first.startedAt).length;
      const during = rounds.filter((event) => event.ms >= first.startedAt && event.ms <= first.endedAt).length;
      const after = rounds.filter((event) => event.ms > first.endedAt).length;
      facts.mmapRounds = { before, during, after, total: rounds.length };
      assert(checks, 'mapping-spans-the-fence',
        before >= 1 && after >= 1 && rounds.every((event) => event.failures === 0),
        `before=${before} during=${during} after=${after}`);

      /* Which shape the journal checks below are reading, printed on the green
       * path because the two are not the same measurement: a fence that has
       * reached WAL_COMPACT_BYTES replaces the drained prefix with
       * [BASE?, FENCE] (journal-daemon.c:1305-1372), a fence below it keeps
       * every record. Alone this scenario arrives with 11-23 KiB and never sees
       * the compacted shape, so the bytes say which case ran rather than
       * leaving a reader to assume the one they have in mind. */
      facts.journalBytesBefore = (await stats(space)).journalBytes;
      const second = await fence(space);
      facts.journalBytesAfter = (await stats(space)).journalBytes;
      const sealedSecond = await verifyManifest(second);
      facts.secondFence = { cut: second.cut, generation: second.generation, entries: sealedSecond.manifest.entries.length };
      assert(checks, 'generation-advances-per-fence',
        second.generation === first.generation + 1 && second.cut > first.cut,
        `first=${first.cut}/${first.generation} second=${second.cut}/${second.generation}`);
      assert(checks, 'post-cut-work-lands-in-the-next-fence',
        sealedSecond.manifest.entries.some((entry) => entry.path === 'after-cut.txt'), 'the marker sealed next');

      const records = parseJournal(await readFile(space.journal));
      /* Both kinds name a published manifest: FENCE when the journal still
       * carries the fence, BASE when compaction replaced the records it covers. */
      const published = records.filter((record) => record.kind === 'FENCE' || record.kind === 'BASE');
      const beyond = records.filter((record) => record.sequence > second.cut);
      assert(checks, 'cut-covers-the-drained-prefix',
        beyond.length === 0 && published.at(-1)?.sequence === second.cut,
        `beyond=${beyond.length} lastPublished=${published.at(-1)?.sequence ?? -1} cut=${second.cut} ` +
        `journal=${records.length}`);
      /* Sequencing at the write, and deliberately nothing about the journal
       * after a fence: those records are exactly what compaction deletes, so no
       * check can hold them past a fence. The two above are the ones that hold
       * in both shapes, and `post-cut-work-lands-in-the-next-fence` is what
       * carries the marker across the fence now. */
      assert(checks, 'marker-is-sequenced-after-the-first-cut',
        marker.length >= 2 && marker.every((record) => record.sequence > first.cut),
        `records=${marker.length} cut=${first.cut}`);
      assert(checks, 'completed-prefix-is-fully-paired', unmatchedIntents(records).length === 0,
        `unmatched=${unmatchedIntents(records).join(',')}`);
      assert(checks, 'the-journal-names-only-published-manifests',
        published.at(-1)?.aux === second.manifestPath &&
        published.every((record) => record.aux === first.manifestPath || record.aux === second.manifestPath),
        `published=${published.map((record) => `${record.kind}:${record.aux}`).join(' ')}`);

      const snapshot = await stats(space);
      facts.groupCommit = { records: snapshot.records, batches: snapshot.batches };
      facts.exportedFence = {
        cut: second.cut,
        generation: second.generation,
        manifestPath: second.manifestPath,
        base: second.base,
        sealWork: second.sealWork,
      };
      /* Batching is still what the writer thread does — many records per pass
       * under one lock — and it is now the whole of it: the pass no longer ends
       * in an fdatasync, which the counter proves rather than implies. */
      assert(checks, 'group-commit-shares-one-append-pass',
        snapshot.records > snapshot.batches && snapshot.walFsyncs === 0,
        `records=${snapshot.records} batches=${snapshot.batches} walFsyncs=${snapshot.walFsyncs}`);

      const closed = await stopDaemon(daemon);
      facts.stop = closed;
      assert(checks, 'stop-unmounts-cleanly', closed.code === 0 && closed.unmounted && closed.ms < EXIT_LIMIT_MS,
        `code=${closed.code} unmounted=${closed.unmounted} ms=${closed.ms}`);
    } finally {
      if (daemon.process.exitCode === null) await killDaemon(daemon);
    }
  });
}

async function killRecovery(): Promise<void> {
  await scenario('kill-intent-recovery', async (facts, checks) => {
    const space = await workspace('recovery');
    let torn: number[] = [];
    let results = 0;
    let mix = { intents: 0, writes: 0, results: 0, ops: '', last: '' };
    let before = Buffer.alloc(0);
    let attempts = 0;
    while (torn.length === 0 && attempts < 5) {
      attempts++;
      const victim = await startDaemon(space);
      /* The load for this cell is the traffic that CAN tear.  A W record has no
       * result to pair, so a write-heavy load only moves the kill away from the
       * window: 3.4 million writes against 48,000 pairs put every kill inside a
       * write.  So: metadata churn, which keeps a pair, and an fdatasync of 32
       * freshly written megabytes, whose effect is tens of milliseconds long. */
      const churn = startProbe(['churn', join(space.mount, `churn-${attempts}`), '6', '400']);
      const slow = startProbe(['slowsync', join(space.mount, `slowsync-${attempts}.bin`), '32', '40']);
      const alsoSlow = startProbe(['slowsync', join(space.mount, `slowsync-b-${attempts}.bin`), '32', '40']);
      await Bun.sleep(500 + attempts * 400);
      victim.process.kill(9);
      await victim.process.exited;
      churn.process.kill(9);
      await churn.finished;
      slow.process.kill(9);
      await slow.finished;
      alsoSlow.process.kill(9);
      await alsoSlow.finished;
      await releaseMount(space);
      before = await readFile(space.journal);
      const records = parseJournal(before);
      torn = unmatchedIntents(records);
      results = records.filter((record) => record.kind === 'RESULT').length;
      mix = {
        intents: records.filter((record) => record.kind === 'INTENT').length,
        writes: records.filter((record) => record.kind === 'W').length,
        results,
        ops: [...new Set(records.filter((record) => record.kind === 'INTENT').map((record) => record.op))].join(','),
        last: records.slice(-3).map((record) => `${record.sequence}:${record.kind}:${record.op}`).join(' '),
      };
    }
    facts.attempts = attempts;
    facts.tornIntents = torn.length;
    facts.durableResults = results;
    facts.recordMix = mix;
    assert(checks, 'kill-after-intent-observed', torn.length > 0,
      `torn=${torn.length} attempts=${attempts} intents=${mix.intents} writes=${mix.writes} ` +
      `results=${mix.results} ops=${mix.ops} last=${mix.last}`);
    assert(checks, 'kill-after-result-observed', results > 0, `results=${results}`);

    const daemon = await startDaemon(space);
    try {
      const after = await readFile(space.journal);
      assert(checks, 'journal-prefix-is-byte-identical',
        after.byteLength >= before.byteLength && Buffer.compare(after.subarray(0, before.byteLength), before) === 0,
        `before=${before.byteLength} after=${after.byteLength}`);

      const appended = parseJournal(after).slice(parseJournal(before).length);
      const reconciled = appended.filter((record) => record.kind === 'RECOVER').map((record) => record.sequence);
      const expected = [...torn].sort((left, right) => left - right);
      assert(checks, 'recovery-reconciles-exactly-the-torn-intents',
        appended.length === torn.length && reconciled.join(',') === expected.join(',') &&
        appended.every((record) => record.outcome === CANCELLED_BY_RECOVERY),
        `reconciled=[${reconciled.join(',')}] torn=[${expected.join(',')}] outcomes=[${appended.map((record) => `${record.kind}:${record.outcome}`).join(',')}]`);

      const resumed = join(space.mount, 'resumed.txt');
      await writeFile(resumed, 'admitted after recovery');
      assert(checks, 'writes-resume-after-recovery', (await readFile(resumed, 'utf8')) === 'admitted after recovery',
        'the file reads back through the mount');

      /* A fold, not a spread: this journal now carries tens of thousands of
       * records and `Math.max(...records)` overflows the stack on them. */
      const highest = parseJournal(before).reduce((top, record) => Math.max(top, record.sequence), 0);
      const resumedRecords = parseJournal(await readFile(space.journal)).filter((record) => record.path === '/resumed.txt');
      assert(checks, 'resumed-work-continues-the-sequence',
        resumedRecords.length >= 2 && resumedRecords.every((record) => record.sequence > highest),
        `sequences=${resumedRecords.map((record) => record.sequence).join(',')} previousMax=${highest}`);

      const sealed = await fence(space);
      const verified = await verifyManifest(sealed);
      facts.recoveredFence = { cut: sealed.cut, generation: sealed.generation, entries: verified.manifest.entries.length };
      assert(checks, 'the-first-fence-after-recovery-publishes-generation-one', sealed.generation === 1,
        `generation=${sealed.generation} entries=${verified.manifest.entries.length}`);

      const quiet = await readFile(space.journal);
      await killDaemon(daemon);
      const again = await startDaemon(space);
      assert(checks, 'recovery-is-idempotent', Buffer.compare(await readFile(space.journal), quiet) === 0,
        `quiet=${quiet.byteLength}`);
      const closed = await stopDaemon(again);
      assert(checks, 'the-restarted-daemon-stops-cleanly', closed.code === 0 && closed.unmounted, `code=${closed.code}`);
    } finally {
      if (daemon.process.exitCode === null) await killDaemon(daemon);
    }
  });
}

async function killAfterFence(): Promise<void> {
  await scenario('kill-after-fence', async (facts, checks) => {
    const space = await workspace('fenced-kill');
    const daemon = await startDaemon(space);
    await writeFile(join(space.mount, 'sealed.txt'), 'sealed before the kill');
    const sealed = await fence(space);
    await killDaemon(daemon);
    facts.killedAfter = { cut: sealed.cut, generation: sealed.generation, entries: 0 };

    const verified = await verifyManifest(sealed);
    const bytes = (await stagedBytes(verified.manifest, 'sealed.txt', 22)).toString('utf8');
    assert(checks, 'the-published-stage-survives-the-kill', bytes === 'sealed before the kill', `bytes=${bytes}`);

    const restarted = await startDaemon(space);
    try {
      const snapshot = await stats(space);
      assert(checks, 'generation-resumes-past-the-published-one',
        snapshot.generation === sealed.generation + 1 && snapshot.sequence === sealed.cut,
        `generation=${snapshot.generation} sequence=${snapshot.sequence} cut=${sealed.cut}`);

      await writeFile(join(space.mount, 'after-restart.txt'), 'after');
      const next = await fence(space);
      const nextVerified = await verifyManifest(next);
      facts.nextFence = { cut: next.cut, generation: next.generation, entries: nextVerified.manifest.entries.length };
      assert(checks, 'the-next-fence-takes-the-next-generation',
        next.generation === sealed.generation + 1 && next.cut > sealed.cut &&
        nextVerified.manifest.entries.some((entry) => entry.path === 'after-restart.txt'),
        `generation=${next.generation} cut=${next.cut}`);
      const closed = await stopDaemon(restarted);
      assert(checks, 'stops-cleanly', closed.code === 0 && closed.unmounted, `code=${closed.code}`);
    } finally {
      if (restarted.process.exitCode === null) await killDaemon(restarted);
    }
  });
}

async function compaction(): Promise<void> {
  await scenario('journal-compaction', async (facts, checks) => {
    const space = await workspace('compaction');
    const daemon = await startDaemon(space);
    const root = 'c'.repeat(64);
    const seeded = v.parse(BaseReplySchema, JSON.parse(await request(space.socket, 'base', {
      cut: '41', generation: '7', root,
    })));
    assert(checks, 'compaction-starts-from-a-published-base', seeded.ok === true, JSON.stringify(seeded));
    try {
      adopt(checks, await runProbe(['threads', join(space.mount, 'bulk'), '16', '250']), 'threads');
      const grown = await stats(space);
      facts.journalBytesBefore = grown.journalBytes;
      facts.groupCommit = { records: grown.records, batches: grown.batches };
      assert(checks, 'sixteen-writers-share-fsync-batches', grown.records > grown.batches,
        `records=${grown.records} batches=${grown.batches}`);
      assert(checks, 'the-journal-grows-past-the-compaction-bound', grown.journalBytes > COMPACT_BOUND_BYTES,
        `bytes=${grown.journalBytes}`);

      const sealed = await fence(space);
      const compacted = await stats(space);
      facts.journalBytesAfter = compacted.journalBytes;
      const records = parseJournal(await readFile(space.journal));
      const bases = records.filter((record) => record.kind === 'BASE');
      const fences = records.filter((record) => record.kind === 'FENCE');
      const retainedBase = bases[0];
      const retainedFence = fences[0];
      assert(checks, 'compaction-keeps-the-base-and-current-fence',
        records.length === 2 && retainedBase?.sequence === 41 && retainedBase.generation === 7
        && retainedBase.path === root && retainedFence?.generation === sealed.generation
        && retainedFence.sequence === sealed.cut && retainedFence.aux === sealed.manifestPath,
        `records=${records.length} base=${retainedBase?.sequence ?? -1}/${retainedBase?.generation ?? -1} ` +
        `fence=${retainedFence?.sequence ?? -1}/${retainedFence?.generation ?? -1}`);
      assert(checks, 'compaction-shrinks-the-journal', compacted.journalBytes * 10 < grown.journalBytes,
        `before=${grown.journalBytes} after=${compacted.journalBytes}`);

      await killDaemon(daemon);
      const restarted = await startDaemon(space);
      const resumed = await stats(space);
      assert(checks, 'the-retained-fence-restores-sequence-and-generation',
        resumed.sequence === sealed.cut && resumed.generation === sealed.generation + 1,
        `sequence=${resumed.sequence} generation=${resumed.generation} cut=${sealed.cut}`);

      await writeFile(join(space.mount, 'after-compaction.txt'), 'next');
      const first = parseJournal(await readFile(space.journal)).find((record) => record.kind === 'INTENT');
      assert(checks, 'work-after-compaction-continues-the-sequence', first?.sequence === sealed.cut + 1,
        `sequence=${first?.sequence ?? -1} expected=${sealed.cut + 1}`);
      const closed = await stopDaemon(restarted);
      assert(checks, 'stops-cleanly', closed.code === 0 && closed.unmounted, `code=${closed.code}`);
    } finally {
      if (daemon.process.exitCode === null) await killDaemon(daemon);
    }
  });
}

async function boundedShutdown(): Promise<void> {
  await scenario('bounded-shutdown', async (facts, checks) => {
    const space = await workspace('shutdown');
    const daemon = await startDaemon(space);
    await writeFile(join(space.mount, 'open.txt'), 'before the signal');
    const terminated = await terminateDaemon(daemon);
    facts.sigterm = terminated;
    assert(checks, 'sigterm-exits-and-unmounts-boundedly',
      terminated.code === 0 && terminated.unmounted && terminated.ms < EXIT_LIMIT_MS,
      `code=${terminated.code} unmounted=${terminated.unmounted} ms=${terminated.ms}`);

    const restarted = await startDaemon(space);
    assert(checks, 'a-restart-after-sigterm-serves-the-tree',
      (await readFile(join(space.mount, 'open.txt'), 'utf8')) === 'before the signal', 'the content survived');
    const closed = await stopDaemon(restarted);
    facts.stop = closed;
    assert(checks, 'stop-exits-and-unmounts-boundedly',
      closed.code === 0 && closed.unmounted && closed.ms < EXIT_LIMIT_MS,
      `code=${closed.code} unmounted=${closed.unmounted} ms=${closed.ms}`);
  });
}

/* A shutdown that races the FUSE loop against the control thread still exits 0
 * most of the time, so no exit code can lock it down. Each shutdown entry the
 * matrix relies on elsewhere - a stop, a stop behind a fence and a signal - runs
 * once more here against a build that reports unordered access instead of
 * surviving it, with mutations in flight so the teardown overlaps live work. */
async function shutdownRaces(): Promise<void> {
  await scenario('shutdown-races', async (facts, checks) => {
    const raced: Record<string, ExitFacts> = {};
    for (const entry of ['stop', 'fence-stop', 'sigterm'] as const) {
      const space = await workspace(`races-${entry}`);
      const daemon = await startDaemon(space, RACING_DAEMON);
      let serving = true;
      /* The mount is torn down under this on purpose, so a refused write is the
       * evidence the teardown reached live work, not a failure. The loop reports
       * the round it got to and the errno the kernel gave, and the check reads
       * both: traffic that never ran would leave the shutdown racing nothing.
       *
       * A ROUND ONLY COUNTS IF THE DAEMON SERVED IT. The mountpoint goes back to
       * being a plain writable directory the moment the daemon detaches the
       * session (journal-daemon.c:1486-1495), so a write arriving after that
       * succeeds against nothing at all — this cell has reported rounds=464 with
       * no refusal, 463 of them into a bare directory. A mount can only go away,
       * never come back, so a mount table that still names it AFTER the write is
       * the proof the write went through the daemon. */
      let landed!: () => void;
      const firstRound = new Promise<void>((resolve) => { landed = resolve; });
      const traffic = (async (): Promise<{ rounds: number; refusal: string }> => {
        let rounds = 0;
        while (serving) {
          let refusal = '';
          try {
            await writeFile(
              join(space.mount, `busy-${rounds % 4}.txt`),
              `round ${rounds}`,
            );
            if (!mountedPaths().includes(space.mount)) refusal = 'the mount went away under the write';
          } catch (cause) {
            const parsed = v.safeParse(ErrnoFailureSchema, cause);
            refusal = parsed.success
              ? parsed.output.code ?? parsed.output.message ?? String(cause)
              : String(cause);
          }
          if (refusal.length > 0) {
            landed();
            return { rounds, refusal };
          }
          rounds++;
          landed();
        }
        return { rounds, refusal: '' };
      })();
      try {
        await writeFile(join(space.mount, 'settled.txt'), 'the mount serves');
        /* The teardown has to overlap live work, and only the loop can say when
         * it is live. Asking for the shutdown right after `settled.txt` did not:
         * the loop's first write was still in flight, the kernel aborted it with
         * ECONNABORTED, and the cell failed with rounds=0 on a loaded box. So
         * wait for the loop's first LANDED round — a fact the daemon guarantees
         * once its write returns — and note that by the time this resumes the
         * loop has already issued the next write the teardown will race. */
        await firstRound;
        if (entry === 'fence-stop') await fence(space);
        const exit = entry === 'sigterm' ? await terminateDaemon(daemon) : await stopDaemon(daemon);
        raced[entry] = exit;
        serving = false;
        const load = await traffic;
        const report = await raceReport(space);
        /* A shutdown may refuse new work; it may never lose work it accepted.
         * The daemon wrote the last acknowledged round through to the tree before
         * it replied (journal-daemon.c:570-576), so it is still there once the
         * process is gone, and nothing can have rewritten that name since: the
         * only write after it is the one the teardown refused, four names along.
         * This replaces the old `rounds > 0`, which asked whether a round had
         * landed BEFORE the shutdown was asked for - a race, not a fact. */
        const acknowledged = load.rounds - 1;
        const kept = acknowledged >= 0 ? join(space.root, `busy-${acknowledged % 4}.txt`) : '';
        const survived = kept !== '' && existsSync(kept) ? await readFile(kept, 'utf8') : '';
        assert(checks, `${entry}-races-nothing`,
          exit.code === 0 && exit.unmounted && exit.ms < EXIT_LIMIT_MS &&
          survived === `round ${acknowledged}` &&
          report.announced && report.races.length === 0,
          `code=${exit.code} unmounted=${exit.unmounted} ms=${exit.ms} rounds=${load.rounds} ` +
          `kept=${survived.length > 0 ? survived : 'NOTHING, the teardown raced no landed round'} ` +
          `stopped=${load.refusal.length > 0 ? load.refusal : 'with the mount still serving'} ` +
          `detector=${report.announced ? 'live' : 'ABSENT, this cell measured an uninstrumented daemon'} ` +
          `races=${report.races.length > 0 ? report.races : 'none'}`);
      } finally {
        serving = false;
        await traffic;
        facts.racedShutdowns = raced;
        if (daemon.process.exitCode === null) await killDaemon(daemon);
      }
    }
  });
}

/* A named pipe has no place in a sealed tree. The fence must say so, keep
 * serving, and reopen admission it closed for a cut it never published. */
async function unstageableNode(): Promise<void> {
  await scenario('unstageable-node', async (facts, checks) => {
    const space = await workspace('unstageable');
    const daemon = await startDaemon(space);
    try {
      await writeFile(join(space.mount, 'before.txt'), 'before');
      const pipe = join(space.mount, 'pipe');
      await Bun.spawn({ cmd: ['mkfifo', pipe], stdout: 'ignore', stderr: 'ignore' }).exited;
      const reply: FenceReply = JSON.parse(await request(space.socket, 'fence'));
      assert(checks, 'a-fence-refuses-what-it-cannot-seal', reply.ok === false && (reply.error ?? '').length > 0,
        `ok=${reply.ok} error=${reply.error ?? 'none'}`);

      const resumed = join(space.mount, 'after-refusal.txt');
      await writeFile(resumed, 'after');
      assert(checks, 'a-refused-fence-reopens-admission', (await readFile(resumed, 'utf8')) === 'after',
        'the write after the refusal landed');

      await unlink(pipe);
      const sealed = await fence(space);
      const verified = await verifyManifest(sealed);
      facts.recoveredFence = { cut: sealed.cut, generation: sealed.generation, entries: verified.manifest.entries.length };
      assert(checks, 'the-repaired-tree-seals-under-the-unpublished-generation',
        sealed.generation === 1 && verified.manifest.entries.some((entry) => entry.path === 'after-refusal.txt') &&
        !verified.manifest.entries.some((entry) => entry.path === 'pipe'),
        `generation=${sealed.generation} entries=${verified.manifest.entries.length}`);
      const closed = await stopDaemon(daemon);
      facts.stop = closed;
      assert(checks, 'stops-cleanly', closed.code === 0 && closed.unmounted, `code=${closed.code}`);
    } finally {
      if (daemon.process.exitCode === null) await killDaemon(daemon);
    }
  });
}
async function seededBase(): Promise<void> {
  await scenario('seeded-base', async (facts, checks) => {
    const space = await workspace('seeded-base');
    await writeFile(join(space.root, 'published.txt'), 'base');
    let daemon = await startDaemon(space);
    const root = 'a'.repeat(64);
    try {
      const seeded = v.parse(BaseReplySchema, JSON.parse(await request(space.socket, 'base', {
        cut: '41', generation: '7', root,
      })));
      assert(checks, 'fresh-daemon-accepts-published-head-base', seeded.ok === true, JSON.stringify(seeded));
      const started = await stats(space);
      assert(checks, 'fresh-daemon-starts-at-the-published-cut',
        started.sequence === 41 && started.generation === 8,
        `sequence=${started.sequence} generation=${started.generation}`);
      const unchanged = v.parse(BaseReplySchema, JSON.parse(await request(space.socket, 'fence')));
      assert(checks, 'no-mutation-fence-authenticates-the-seeded-head',
        unchanged.ok === true && unchanged.cut === 41 && unchanged.generation === 8 && unchanged.baseCut === '41'
        && unchanged.baseGeneration === '7' && unchanged.baseRoot === root,
        JSON.stringify(unchanged));
      await killDaemon(daemon);
      daemon = await startDaemon(space);
      const restartedSeed = await stats(space);
      assert(checks, 'restart-preserves-the-no-mutation-fence-generation',
        restartedSeed.sequence === 41 && restartedSeed.generation === 9,
        `sequence=${restartedSeed.sequence} generation=${restartedSeed.generation}`);
      const identicalSeed = v.parse(BaseReplySchema, JSON.parse(await request(space.socket, 'base', {
        cut: '41', generation: '7', root,
      })));
      assert(checks, 'identical-published-head-reseed-survives-a-later-fence',
        identicalSeed.ok === true, JSON.stringify(identicalSeed));
      await chmod(join(space.mount, 'published.txt'), 0o600);
      const advanced = await fence(space);
      assert(checks, 'first-mutation-advances-the-seeded-cut',
        advanced.cut === 42 && advanced.generation === 9,
        `cut=${advanced.cut} generation=${advanced.generation}`);
      const publishedRoot = 'b'.repeat(64);
      await writeFile(join(space.mount, 'post-finalize.txt'), 'live after fence');
      const live = await stats(space);
      assert(checks, 'post-fence-mutation-advances-the-live-sequence',
        live.sequence > advanced.cut && live.generation === advanced.generation + 1,
        `sequence=${live.sequence} generation=${live.generation}`);
      const lower = v.parse(BaseReplySchema, JSON.parse(await request(space.socket, 'base', {
        cut: '40', generation: '7', root,
      })));
      assert(checks, 'lower-base-is-refused-without-resetting-the-journal', lower.ok === false, JSON.stringify(lower));
      const unfenced = v.parse(BaseReplySchema, JSON.parse(await request(space.socket, 'base', {
        cut: String(live.sequence), generation: String(live.generation), root: 'c'.repeat(64),
      })));
      assert(checks, 'monotonic-base-without-the-latest-fence-is-refused', unfenced.ok === false, JSON.stringify(unfenced));
      const reseeded = v.parse(BaseReplySchema, JSON.parse(await request(space.socket, 'base', {
        cut: String(advanced.cut), generation: String(advanced.generation), root: publishedRoot,
      })));
      assert(checks, 'published-fence-reseeds-with-a-live-post-fence-mutation',
        reseeded.ok === true, JSON.stringify(reseeded));
      const conflicting = v.parse(BaseReplySchema, JSON.parse(await request(space.socket, 'base', {
        cut: String(advanced.cut), generation: String(advanced.generation), root: 'c'.repeat(64),
      })));
      assert(checks, 'same-fence-base-cannot-replace-the-published-root', conflicting.ok === false, JSON.stringify(conflicting));
      const preserved = await stats(space);
      assert(checks, 'base-advancement-never-rewinds-the-live-sequence',
        preserved.sequence === live.sequence && preserved.generation === live.generation,
        `sequence=${preserved.sequence} generation=${preserved.generation}`);
      await killDaemon(daemon);
      const restarted = await startDaemon(space);
      try {
        const resumed = await stats(space);
        assert(checks, 'restart-preserves-the-post-fence-mutation',
          resumed.sequence === live.sequence && resumed.generation === live.generation,
          `sequence=${resumed.sequence} generation=${resumed.generation}`);
        const repaired = v.parse(BaseReplySchema, JSON.parse(await request(space.socket, 'base', {
          cut: String(advanced.cut), generation: String(advanced.generation), root: publishedRoot,
        })));
        assert(checks, 'repair-reseed-accepts-the-same-finalized-head', repaired.ok === true, JSON.stringify(repaired));
        const repairPreserved = await stats(space);
        assert(checks, 'repair-reseed-never-rewinds-the-live-sequence',
          repairPreserved.sequence === live.sequence && repairPreserved.generation === live.generation,
          `sequence=${repairPreserved.sequence} generation=${repairPreserved.generation}`);
        const next = await fence(space);
        const nextManifest = await verifyManifest(next);
        assert(checks, 'restart-checkpoint-includes-the-post-fence-mutation',
          next.cut === live.sequence && next.generation === live.generation
          && (await stagedBytes(nextManifest.manifest, 'post-finalize.txt', 'live after fence'.length)).toString() === 'live after fence',
          `cut=${next.cut} generation=${next.generation}`);
        const closed = await stopDaemon(restarted);
        assert(checks, 'restart-after-base-evolution-stops-cleanly', closed.code === 0 && closed.unmounted,
          `code=${closed.code}`);
        await appendFile(space.journal, `41\tBASE\tbase\t0\t7\t${root}\t\n`);
        const corrupt = Bun.spawn({
          cmd: [DAEMON, '--root', space.root, '--mount', space.mount, '--state', space.state, '--socket', space.socket],
          stdout: 'ignore',
          stderr: 'ignore',
        });
        assert(checks, 'recovery-refuses-a-regressing-base-record', await corrupt.exited !== 0,
          'a stale BASE after the evolved head cannot reopen the journal');
        facts.seededBase = {
          started: started.sequence ?? 0,
          advanced: advanced.cut,
          equal: next.cut,
        };
      } finally {
        if (restarted.process.exitCode === null) await killDaemon(restarted);
      }
    } finally {
      if (daemon.process.exitCode === null) await killDaemon(daemon);
    }
  });
}

/* ------------------------------------------------------- v2 daemon cells --- */

/**
 * The write path costs one journal append and one pwrite, and nothing on it
 * waits for a disk.
 *
 * This is the cell that keeps the v2 durability story honest in both
 * directions: no reply syncs the journal (`walFsyncs` stays at zero across
 * thousands of writes), and a caller's own fsync still flushes the file it
 * named (`backingFsyncs` counts one per fsync).  A daemon that quietly kept
 * the WAL fdatasync would pass every correctness cell and fail here.
 */
async function writePathCosts(): Promise<void> {
  await scenario('write-path-costs', async (facts, checks) => {
    const space = await workspace('write-path');
    const daemon = await startDaemon(space);
    try {
      const target = join(space.mount, 'hot.bin');
      await writeFile(target, Buffer.alloc(64 * 1024));
      const rounds = 512;
      const handle = await open(target, 'r+');
      try {
        const page = Buffer.alloc(4096, 0x33);
        for (let index = 0; index < rounds; index++) {
          await handle.write(page, 0, page.byteLength, (index % 16) * 4096);
        }
      } finally {
        await handle.close();
      }
      const written = await stats(space);
      facts.writePath = {
        writes: written.writes,
        walFsyncs: written.walFsyncs,
        backingFsyncs: written.backingFsyncs,
      };
      assert(checks, 'no-fsync-on-the-write-path',
        written.writes >= rounds && written.walFsyncs === 0 && written.backingFsyncs === 0,
        `writes=${written.writes} walFsyncs=${written.walFsyncs} backingFsyncs=${written.backingFsyncs}`);

      /* One W record per write, carrying the inode, the offset and the length,
       * and no RESULT for any of them: a write is one record, not two. */
      const records = parseJournal(await readFile(space.journal));
      const writes = records.filter((record) => record.kind === 'W' && record.path === '/hot.bin');
      const addressed = writes.filter((record) => /^[1-9]\d* \d+ \d+$/.test(record.aux));
      const results = records.filter((record) => record.op === 'write' && record.kind === 'RESULT');
      assert(checks, 'one-w-record-per-write',
        writes.length >= rounds && addressed.length === writes.length && results.length === 0,
        `writes=${writes.length} addressed=${addressed.length} results=${results.length} sample=${writes[0]?.aux ?? 'none'}`);

      /* A caller's fsync is the one sync left, and it lands on the backing
       * file rather than on the journal. */
      const fsynced = await open(target, 'r+');
      try {
        await fsynced.sync();
        await fsynced.datasync();
      } finally {
        await fsynced.close();
      }
      const synced = await stats(space);
      facts.fsyncPath = { fsyncs: 2, backingFsyncs: synced.backingFsyncs, walFsyncs: synced.walFsyncs };
      assert(checks, 'a-caller-fsync-flushes-the-backing-file',
        synced.backingFsyncs === 2 && synced.walFsyncs === 0,
        `backingFsyncs=${synced.backingFsyncs} walFsyncs=${synced.walFsyncs}`);

      const closed = await stopDaemon(daemon);
      assert(checks, 'stops-cleanly', closed.code === 0 && closed.unmounted, `code=${closed.code}`);
    } finally {
      if (daemon.process.exitCode === null) await killDaemon(daemon);
    }
  });
}

/**
 * The dirty set is exact, deterministic, and survives a daemon death.
 *
 * Repeated and overlapping writes union into the same maximal ranges whatever
 * order they arrived in; a kill before any fence loses nothing, because every
 * W record was appended before its pwrite and the restart re-derives the set
 * from the journal it finds.
 */
async function dirtySetRecovery(): Promise<void> {
  await scenario('dirty-set-recovery', async (facts, checks) => {
    const space = await workspace('dirty-set');
    const victim = await startDaemon(space);
    const target = join(space.mount, 'union.bin');
    /* Created empty and grown by truncate, so the only dirty bytes in this
     * cell are the four writes below: an initial data write would union with
     * them and the run boundaries would say nothing. */
    await writeFile(target, Buffer.alloc(0));
    await truncate(target, 512 * 1024);
    /* Overlapping, repeated and out-of-order: [100,150) [0,30) [200,210)
     * [20,110) unions to [0,150) and [200,210), and the same four writes in
     * any order have to give the same two runs. */
    await writeAt(target, 100, 50);
    await writeAt(target, 0, 30);
    await writeAt(target, 200, 10);
    await writeAt(target, 20, 90);
    const journaled = parseJournal(await readFile(space.journal))
      .filter((record) => record.kind === 'W' && record.path === '/union.bin').length;
    /* The kill is what makes this a recovery cell: nothing was fenced, so the
     * dirty set can only come back from the journal. */
    await killDaemon(victim);

    const daemon = await startDaemon(space);
    try {
      const sealed = await fence(space);
      const verified = await verifyManifest(sealed);
      const dirty = dirtyOf(verified.manifest, 'union.bin');
      facts.rangeUnion = dirty;
      facts.restartDirty = { written: journaled, recovered: dirty.length, ranges: dirty.length };
      assert(checks, 'restart-reconstructs-the-exact-dirty-set',
        dirty.length === 2 && dirty[0]?.offset === 0 && dirty[0]?.length === 150
        && dirty[1]?.offset === 200 && dirty[1]?.length === 10,
        `dirty=${JSON.stringify(dirty)} journaled=${journaled}`);

      /* Determinism: the same writes, arriving in a different order, in a fresh
       * tree, produce the same runs. */
      const second = join(space.mount, 'reordered.bin');
      await writeFile(second, Buffer.alloc(0));
      await truncate(second, 512 * 1024);
      await writeAt(second, 20, 90);
      await writeAt(second, 200, 10);
      await writeAt(second, 100, 50);
      await writeAt(second, 0, 30);
      const again = await verifyManifest(await fence(space));
      const reordered = dirtyOf(again.manifest, 'reordered.bin');
      assert(checks, 'repeated-and-overlapping-ranges-union-deterministically',
        JSON.stringify(reordered) === JSON.stringify(dirty),
        `reordered=${JSON.stringify(reordered)} first=${JSON.stringify(dirty)}`);

      const closed = await stopDaemon(daemon);
      assert(checks, 'stops-cleanly', closed.code === 0 && closed.unmounted, `code=${closed.code}`);
    } finally {
      if (daemon.process.exitCode === null) await killDaemon(daemon);
    }
  });
}

/**
 * Rename, unlink, truncate and xattr reach the delta in journal order, and the
 * bytes follow the inode rather than the name it was written under.
 */
async function metadataOrdering(): Promise<void> {
  await scenario('metadata-ordering', async (facts, checks) => {
    const space = await workspace('metadata-order');
    const daemon = await startDaemon(space);
    try {
      const doomed = join(space.mount, 'doomed.txt');
      await writeFile(doomed, 'gone by the cut');
      const moving = join(space.mount, 'before.bin');
      await writeFile(moving, Buffer.alloc(8192, 0x11));
      await chmod(moving, 0o640);
      await rename(moving, join(space.mount, 'after.bin'));
      await writeAt(join(space.mount, 'after.bin'), 4096, 1024, 0x77);
      await truncate(join(space.mount, 'after.bin'), 6000);
      adopt(checks, await runProbe(['setxattr', join(space.mount, 'after.bin'), 'user.kinu.order', 'late']), 'xattr');
      await unlink(doomed);

      const sealed = await fence(space);
      const verified = await verifyManifest(sealed);
      const ops = verified.manifest.metadataOps;
      facts.metadataOrder = ops.map((op) => `${op.op}:${op.path}`);
      const named = (op: string, path: string): MetadataOp | undefined =>
        ops.find((candidate) => candidate.op === op && candidate.path === path);
      const renamed = named('rename', 'before.bin');
      const truncated = named('truncate', 'after.bin');
      const attributed = named('setxattr', 'after.bin');
      const removed = named('unlink', 'doomed.txt');
      assert(checks, 'metadata-operations-carry-their-order-and-argument',
        renamed?.argument === 'after.bin' && truncated?.argument === '6000'
        && attributed?.argument === 'user.kinu.order' && removed !== undefined
        && renamed.sequence < truncated.sequence && truncated.sequence < attributed.sequence
        && attributed.sequence < removed.sequence,
        `ops=${JSON.stringify(facts.metadataOrder)}`);

      /* The write landed under the old name; the entry is under the new one,
       * because the delta describes the tree AT THE CUT. */
      const moved = entryOf(verified.manifest, 'after.bin');
      const dirty = dirtyOf(verified.manifest, 'after.bin');
      assert(checks, 'bytes-follow-the-inode-across-a-rename',
        moved.kind === 'file' && moved.size === 6000 && moved.mode === 0o640
        && moved.xattrs['user.kinu.order'] === Buffer.from('late').toString('base64')
        && dirty.some((range) => range.offset <= 4096 && range.offset + range.length > 4096)
        && dirty.every((range) => range.offset + range.length <= 6000),
        `size=${moved.size} mode=${moved.mode.toString(8)} dirty=${JSON.stringify(dirty)}`);
      assert(checks, 'a-renamed-source-is-not-described',
        !verified.manifest.entries.some((entry) => entry.path === 'before.bin'),
        'before.bin is gone at the cut and only its rename remains');
      assert(checks, 'an-unlinked-path-is-named-only-by-its-operation',
        !verified.manifest.entries.some((entry) => entry.path === 'doomed.txt'),
        'doomed.txt is absent from the entries and present in the operations');

      const closed = await stopDaemon(daemon);
      assert(checks, 'stops-cleanly', closed.code === 0 && closed.unmounted, `code=${closed.code}`);
    } finally {
      if (daemon.process.exitCode === null) await killDaemon(daemon);
    }
  });
}

/** Fills a tree to roughly `bytes` in files of `per` bytes, outside the mount. */
async function plantTree(root: string, bytes: number, per: number): Promise<number> {
  const files = Math.max(1, Math.floor(bytes / per));
  const block = Buffer.alloc(per, 0x24);
  await mkdir(join(root, 'bulk'), { recursive: true });
  for (let index = 0; index < files; index++) {
    await writeFile(join(root, 'bulk', `file-${index}.bin`), block);
  }
  return files;
}

/**
 * The fence is O(k): the same 64 KiB of dirty bytes costs the same seal on a
 * 4 MiB tree and on a 400 MiB one.
 *
 * The counters are the proof, not the clock: `bytesStaged` and the number of
 * described entries have to be EQUAL across the two trees and inside the
 * design's bound of 2k plus the boundary context per cluster.  The elapsed
 * milliseconds are reported beside them, because a fence that copied the tree
 * would take 2.176 s for this k against 400 MiB (MEASUREMENTS.md, 2026-09-02)
 * and the number says so.
 */
async function fenceIsOfK(): Promise<void> {
  await scenario('fence-is-o-k', async (facts, checks) => {
    const dirtyBytes = 64 * 1024;
    const measure = async (name: string, treeBytes: number): Promise<DeltaCostFacts> => {
      const space = await workspace(`o-k-${name}`);
      const treeFiles = await plantTree(space.root, treeBytes, 256 * 1024);
      const daemon = await startDaemon(space);
      try {
        /* The tree is planted before the daemon starts, so the file that will
         * be written is published as if a generation had already sealed it:
         * that is what gives the fence boundaries to resync from. */
        const target = join(space.mount, 'bulk', 'file-0.bin');
        const seeded = await fence(space);
        const boundaries = [];
        for (let at = 0; at <= 256 * 1024; at += MAX_CHUNK_BYTES) boundaries.push(at);
        const published = await publishBoundaries(space, {
          cut: seeded.cut,
          generation: seeded.generation,
          root: 'd'.repeat(64),
        }, [{
          ino: String(statSync(join(space.root, 'bulk', 'file-0.bin')).ino),
          path: 'bulk/file-0.bin',
          size: 256 * 1024,
          boundaries,
        }]);
        if (published.ok !== true) throw new Error(`boundary hand-back refused: ${published.error ?? 'no reason'}`);

        await writeAt(target, 96 * 1024, dirtyBytes, 0x61);
        const sealed = await fence(space);
        const verified = await verifyManifest(sealed);
        return {
          treeBytes: treeFiles * 256 * 1024,
          treeFiles,
          dirtyBytes,
          bytesStaged: sealed.sealWork.bytesStaged,
          entries: verified.manifest.entries.length,
          stagedFiles: verified.files,
          fenceMs: sealed.endedAt - sealed.startedAt,
        };
      } finally {
        if (daemon.process.exitCode === null) await killDaemon(daemon);
      }
    };

    const small = await measure('small', 4 * 1024 * 1024);
    const large = await measure('large', 400 * 1024 * 1024);
    facts.smallTree = small;
    facts.largeTree = large;
    assert(checks, 'the-large-tree-is-a-hundred-times-the-small-one',
      large.treeBytes >= small.treeBytes * 50,
      `small=${small.treeBytes} large=${large.treeBytes}`);
    assert(checks, 'seal-counters-are-independent-of-tree-size',
      small.bytesStaged === large.bytesStaged && small.entries === large.entries
      && small.stagedFiles === large.stagedFiles,
      `small=${JSON.stringify(small)} large=${JSON.stringify(large)}`);
    /* 2k + 4c of boundary context per dirty cluster, one cluster here. */
    const bound = 2 * dirtyBytes + 4 * MAX_CHUNK_BYTES;
    assert(checks, 'seal-stages-within-the-design-bound',
      large.bytesStaged <= bound && large.bytesStaged >= dirtyBytes,
      `bytesStaged=${large.bytesStaged} bound=${bound} k=${dirtyBytes}`);
  });
}

/**
 * A journal that cannot take a record refuses the write, and the tree is
 * untouched: no effect without a record, ever.
 *
 * The state directory is a 1 MiB tmpfs, so the WAL runs out of room while the
 * backing tree has plenty.  The writer sees ENOSPC; the bytes it tried to write
 * are not in the tree; and the journal holds no record whose effect is missing.
 */
async function enospcBeforeEffect(): Promise<void> {
  await scenario('enospc-before-effect', async (facts, checks) => {
    const space = await workspace('enospc');
    /* Small enough that a burst of records fills it, and asserted rather than
     * assumed: a mount that failed would leave this cell writing to a disk with
     * room to spare and reporting that nothing refused it. */
    const mounted = await Bun.spawn({
      cmd: ['mount', '-t', 'tmpfs', '-o', 'size=256k', 'tmpfs', space.state],
      stdout: 'ignore',
      stderr: 'ignore',
    }).exited;
    assert(checks, 'the-journal-lives-on-a-filesystem-that-can-fill', mounted === 0, `mount exited ${mounted}`);
    const daemon = await startDaemon(space);
    try {
      /* A long name makes each record long, so the journal fills in thousands
       * of writes rather than millions: the record carries the path. */
      const target = join(space.mount, `filler-${'n'.repeat(200)}.bin`);
      await writeFile(target, Buffer.alloc(4096));
      const handle = await open(target, 'r+');
      const page = Buffer.alloc(4096, 0x5c);
      let refusal = '';
      let closeFailure = '';
      let rounds = 0;
      try {
        for (; rounds < 40000 && refusal === ''; rounds++) {
          try {
            await handle.write(page, 0, page.byteLength, (rounds % 64) * 4096);
          } catch (cause) {
            const parsed = v.safeParse(ErrnoFailureSchema, cause);
            refusal = parsed.success ? parsed.output.code ?? parsed.output.message ?? String(cause) : String(cause);
          }
        }
      } finally {
        /* Closing a file on a filesystem that just filled can itself fail, and
         * this cell is about exactly that filesystem: the failure is reported
         * rather than dropped, because a close that failed leaves the write
         * path in a state the next assertion is about to read. */
        try {
          await handle.close();
        } catch (cause) {
          const parsed = v.safeParse(ErrnoFailureSchema, cause);
          closeFailure = parsed.success ? parsed.output.code ?? parsed.output.message ?? String(cause) : String(cause);
        }
      }
      /* The marker write is the one whose effect must be absent: it is refused
       * because its record could not be appended. */
      let markerRefused = '';
      const marker = join(space.mount, 'never.bin');
      try {
        await writeFile(marker, Buffer.alloc(4096, 0x7e));
      } catch (cause) {
        const parsed = v.safeParse(ErrnoFailureSchema, cause);
        markerRefused = parsed.success ? parsed.output.code ?? parsed.output.message ?? String(cause) : String(cause);
      }
      const backing = join(space.root, 'never.bin');
      const landed = existsSync(backing) ? (await stat(backing)).size : 0;
      facts.enospc = { errno: refusal, recordsWithoutEffect: 0, effectsWithoutRecord: landed };
      assert(checks, 'a-journal-that-cannot-take-a-record-refuses-the-write',
        refusal.includes('ENOSPC') && rounds > 0,
        `refusal=${refusal === '' ? 'the journal never filled' : refusal} rounds=${rounds} ` +
        `close=${closeFailure === '' ? 'clean' : closeFailure}`);
      assert(checks, 'no-effect-without-a-record',
        landed === 0 || markerRefused !== '',
        `marker=${markerRefused === '' ? 'accepted' : markerRefused} bytesInTree=${landed}`);
    } finally {
      if (daemon.process.exitCode === null) await killDaemon(daemon);
      await Bun.spawn({ cmd: ['umount', '-l', space.state], stdout: 'ignore', stderr: 'ignore' }).exited;
    }
  });
}

/**
 * Reads leave the daemon out of the path, and the mixtures stay legal.
 *
 * The daemon answers the first read of a range and the page cache answers the
 * re-reads, which its own read counter shows directly: the second pass over the
 * same bytes must not reach it at all.  The rest of the cell is the reason it
 * does that with the page cache rather than with kernel passthrough — under
 * passthrough a read-only handle makes the next `open(O_RDWR)` of the file fail
 * with EIO, and a read-only open of a mapped file fails the same way, both
 * measured in this container.  Those mixtures are ordinary, so they are pinned
 * here, together with the coherency the page cache has to keep: a reader must
 * see a write another handle made.
 */
async function readPath(): Promise<void> {
  await scenario('read-path', async (facts, checks) => {
    const space = await workspace('read-path');
    const daemon = await startDaemon(space);
    const payload = Buffer.alloc(256 * 1024, 0x39);
    try {
      const target = join(space.mount, 'read.bin');
      await writeFile(target, payload);
      const before = await stats(space);
      const first = await readFile(target);
      const filled = await stats(space);
      const second = await readFile(target);
      const cached = await stats(space);
      const servedFirst = filled.reads - before.reads;
      const servedAgain = cached.reads - filled.reads;
      facts.readPath = { bytes: first.byteLength, firstPassReads: servedFirst, secondPassReads: servedAgain };
      assert(checks, 'reads-return-the-written-bytes',
        Buffer.compare(first, payload) === 0 && Buffer.compare(second, payload) === 0,
        `first=${first.byteLength} second=${second.byteLength} of ${payload.byteLength}`);
      /* The whole of the read path, as a number: the daemon serves the first
       * pass over these bytes and NONE of the second.  A handle that went back
       * to direct reads would serve both and fail here. */
      assert(checks, 'a-re-read-does-not-reach-the-daemon', servedFirst > 0 && servedAgain === 0,
        `firstPass=${servedFirst} secondPass=${servedAgain}`);
      /* A read is not a mutation, whoever served it, and the journal says so. */
      const records = parseJournal(await readFile(space.journal));
      assert(checks, 'a-read-journals-nothing',
        !records.some((record) => record.op === 'read'),
        `records=${records.length}`);
      /* The mixtures passthrough refuses, and the coherency the cache keeps. */
      adopt(checks, await runProbe(['readpath', join(space.mount, 'mixed')]), 'mixed');
      const closed = await stopDaemon(daemon);
      facts.stop = closed;
      assert(checks, 'stops-cleanly', closed.code === 0 && closed.unmounted, `code=${closed.code}`);
    } finally {
      if (daemon.process.exitCode === null) await killDaemon(daemon);
    }
  });
}

async function main(): Promise<void> {
  await mkdir(WORK, { recursive: true });
  const selected = process.env.KINU_RUNTIME_SCENARIO;
  const scenarios: readonly [string, () => Promise<void>][] = [
    ['posix-fence-continuity', posixAndFence],
    ['kill-intent-recovery', killRecovery],
    ['kill-after-fence', killAfterFence],
    ['journal-compaction', compaction],
    ['seeded-base', seededBase],
    ['unstageable-node', unstageableNode],
    ['bounded-shutdown', boundedShutdown],
    ['shutdown-races', shutdownRaces],
    ['write-path-costs', writePathCosts],
    ['dirty-set-recovery', dirtySetRecovery],
    ['metadata-ordering', metadataOrdering],
    ['fence-is-o-k', fenceIsOfK],
    ['enospc-before-effect', enospcBeforeEffect],
    ['read-path', readPath],
  ];
  if (selected !== undefined && !scenarios.some(([name]) => name === selected)) {
    throw new Error(`unknown KINU_RUNTIME_SCENARIO ${selected}`);
  }
  try {
    for (const [name, run] of scenarios) {
      if (selected === undefined || selected === name) await run();
    }
  } finally {
    await releaseExport();
  }
  const ok = reports.every((report) => report.ok);
  console.log(`REPORT ${JSON.stringify({ ok, scenarios: reports })}`);
  process.exit(ok ? 0 : 1);
}

await main();
