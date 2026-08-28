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
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, chmod, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import * as v from 'valibot';
import { join } from 'node:path';

import type {
  Check,
  ExitFacts,
  JournalRecord,
  Manifest,
  MatrixFacts,
  ProbeEvent,
  ProbeLine,
  FenceReply,
  ScenarioReport,
  SealedContent,
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
  readonly startedAt: number;
  readonly endedAt: number;
}

interface SealedFence {
  readonly manifest: Manifest;
  readonly files: number;
  readonly extents: number;
  readonly bytes: number;
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

async function verifyExtents(manifest: Manifest, path: string, content: SealedContent): Promise<number> {
  let end = 0;
  let verified = 0;
  for (const extent of content.extents) {
    if (extent.offset < end || extent.length <= 0 || extent.length > MAX_EXTENT_BYTES ||
      extent.offset + extent.length > content.size || !/^[a-f0-9]{64}$/.test(extent.sha256)) {
      throw new Error(`entry '${path}' has an invalid extent at ${extent.offset}`);
    }
    const staged = Bun.file(join(manifest.stageRoot, content.sourceId));
    const slice = await staged.slice(extent.offset, extent.offset + extent.length).arrayBuffer();
    if (slice.byteLength !== extent.length) throw new Error(`the stage is short for '${path}'`);
    if (createHash('sha256').update(new Uint8Array(slice)).digest('hex') !== extent.sha256) {
      throw new Error(`staged bytes for '${path}' do not match the manifest digest`);
    }
    end = extent.offset + extent.length;
    verified++;
  }
  return verified;
}

/* Rejects anything the production capture model would reject, and proves every
 * sealed extent against the bytes actually lying in the stage. */
async function verifyManifest(sealed: Fence): Promise<SealedFence> {
  const manifest: Manifest = JSON.parse(await readFile(sealed.manifestPath, 'utf8'));
  if (manifest.cut !== sealed.cut || manifest.generation !== sealed.generation) {
    throw new Error(`manifest ${manifest.cut}/${manifest.generation} is not the fenced ${sealed.cut}/${sealed.generation}`);
  }
  if (!manifest.stageRoot.startsWith('/') || manifest.entries.length === 0) throw new Error('manifest has no sealed tree');
  const kinds = new Map<string, string>();
  let files = 0;
  let extents = 0;
  let bytes = 0;
  for (const entry of manifest.entries) {
    if (entry.path === '' || entry.path.startsWith('/') || entry.path.endsWith('/')) {
      throw new Error(`non-canonical manifest path '${entry.path}'`);
    }
    for (const segment of entry.path.split('/')) {
      if (segment === '' || segment === '.' || segment === '..') throw new Error(`non-canonical path '${entry.path}'`);
    }
    if (kinds.has(entry.path)) throw new Error(`duplicate manifest path '${entry.path}'`);
    if (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || !Number.isSafeInteger(entry.ino) || entry.ino <= 0) {
      throw new Error(`entry '${entry.path}' carries no real identity`);
    }
    const metadata = entry.metadata;
    if (!Number.isSafeInteger(metadata.uid) || metadata.uid < 0 || !Number.isSafeInteger(metadata.gid) || metadata.gid < 0
      || !/^(?:0|[1-9]\d*)$/.test(metadata.atimeNs) || !/^(?:0|[1-9]\d*)$/.test(metadata.mtimeNs)
      || !/^(?:0|[1-9]\d*)$/.test(metadata.ctimeNs)
      || Object.values(metadata.xattrs).some((value) => !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))) {
      throw new Error(`entry '${entry.path}' carries invalid POSIX metadata`);
    }
    if ((entry.kind === 'symlink') !== (entry.target !== undefined)) {
      throw new Error(`entry '${entry.path}' has inconsistent symlink metadata`);
    }
    if ((entry.kind === 'file') !== (entry.content !== undefined)) {
      throw new Error(`entry '${entry.path}' has inconsistent content metadata`);
    }
    kinds.set(entry.path, entry.kind);
    if (entry.content === undefined) continue;
    if (entry.content.kind !== 'sealed' || entry.content.sourceId.length === 0) {
      throw new Error(`entry '${entry.path}' has invalid sealed content`);
    }
    files++;
    bytes += entry.content.size;
    extents += await verifyExtents(manifest, entry.path, entry.content);
  }
  for (const path of kinds.keys()) {
    for (let ancestor = parentOf(path); ancestor !== ''; ancestor = parentOf(ancestor)) {
      if (kinds.get(ancestor) !== 'dir') throw new Error(`ancestor '${ancestor}' of '${path}' is not a staged directory`);
    }
  }
  return { manifest, files, extents, bytes };
}

function entryContent(manifest: Manifest, path: string): SealedContent {
  const entry = manifest.entries.find((candidate) => candidate.path === path);
  if (entry?.content === undefined) throw new Error(`manifest has no staged file ${path}`);
  return entry.content;
}

async function stagedBytes(manifest: Manifest, path: string, length: number): Promise<Buffer> {
  const staged = Bun.file(join(manifest.stageRoot, entryContent(manifest, path).sourceId));
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
  try {
    await body(facts, checks);
    reports.push({ name, ok: checks.every((check) => check.ok) && checks.length > 0, facts, checks });
  } catch (error) {
    reports.push({ name, ok: false, facts, checks, error: error instanceof Error ? error.message : String(error) });
  }
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
      facts.firstFence = {
        cut: first.cut,
        generation: first.generation,
        entries: sealed.manifest.entries.length,
        files: sealed.files,
        extents: sealed.extents,
        stagedBytes: sealed.bytes,
      };
      assert(checks, 'fence-reply-matches-its-manifest',
        sealed.manifest.generation === first.generation && sealed.manifest.cut === first.cut,
        `manifest=${sealed.manifest.cut}/${sealed.manifest.generation} reply=${first.cut}/${first.generation}`);

      const text = (await stagedBytes(sealed.manifest, 'posix/create.txt', 20)).toString('utf8');
      assert(checks, 'sealed-content-verifies', text === 'hello sealed journal', `text=${text}`);

      const holey = entryContent(sealed.manifest, 'posix/sparse-keep.bin');
      assert(checks, 'sealed-sparse-extents',
        holey.size === 4 * 1024 * 1024 && holey.extents.length === 2 &&
        holey.extents.every((extent) => extent.length === 4096) &&
        holey.extents[0]?.offset === 0 && holey.extents[1]?.offset === 3 * 1024 * 1024,
        `extents=${JSON.stringify(holey.extents.map((extent) => [extent.offset, extent.length]))}`);

      const bulky = entryContent(sealed.manifest, 'posix/big.bin');
      assert(checks, 'sealed-extent-cap',
        bulky.extents.length === 3 && bulky.extents.every((extent) => extent.length === MAX_EXTENT_BYTES),
        `extents=${bulky.extents.map((extent) => extent.length).join(',')}`);

      const outside = sealed.manifest.entries.find((entry) => entry.path === 'posix/outside-link');
      assert(checks, 'sealed-symlink-is-not-followed', outside?.kind === 'symlink' && outside.target === '/etc',
        `kind=${outside?.kind ?? 'absent'} target=${outside?.target ?? 'none'}`);
      const hardlinks = sealed.manifest.entries.filter((entry) => entry.path === 'posix/link-first' || entry.path === 'posix/link-second');
      assert(checks, 'hardlink-atime-is-preserved',
        hardlinks.length === 2 && hardlinks[0]?.metadata.atimeNs === '1000000123456789'
        && hardlinks[0]?.metadata.atimeNs === hardlinks[1]?.metadata.atimeNs
        && hardlinks[0]?.metadata.mtimeNs === hardlinks[1]?.metadata.mtimeNs,
        `metadata=${JSON.stringify(hardlinks.map((entry) => entry.metadata))}`);

      const hostile = sealed.manifest.entries.filter((entry) => entry.path.includes('\t'));
      assert(checks, 'hostile-name-round-trips', hostile.length === 1 && hostile[0]?.kind === 'file',
        `paths=${JSON.stringify(hostile.map((entry) => entry.path))}`);

      const manifestBytes = (await readFile(first.manifestPath)).byteLength;
      facts.manifestBytes = manifestBytes;
      assert(checks, 'manifest-carries-no-payload', manifestBytes * 8 < sealed.bytes,
        `manifestBytes=${manifestBytes} stagedBytes=${sealed.bytes}`);

      assert(checks, 'no-post-cut-entry', !sealed.manifest.entries.some((entry) => entry.path === 'after-cut.txt'),
        'after-cut.txt is absent from the sealed manifest');

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

      const second = await fence(space);
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
      const marker = records.filter((record) => record.path === '/after-cut.txt');
      assert(checks, 'cut-covers-the-drained-prefix',
        beyond.length === 0 && published.at(-1)?.sequence === second.cut,
        `beyond=${beyond.length} lastPublished=${published.at(-1)?.sequence ?? -1} cut=${second.cut}`);
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
      };
      assert(checks, 'group-commit-shares-one-fsync-per-batch', snapshot.records > snapshot.batches,
        `records=${snapshot.records} batches=${snapshot.batches}`);

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
    let before = Buffer.alloc(0);
    let attempts = 0;
    while (torn.length === 0 && attempts < 5) {
      attempts++;
      const victim = await startDaemon(space);
      const load = startProbe(['load', join(space.mount, `load-${attempts}`), '8', '5']);
      await Bun.sleep(500 + attempts * 400);
      victim.process.kill(9);
      await victim.process.exited;
      load.process.kill(9);
      await load.finished;
      await releaseMount(space);
      before = await readFile(space.journal);
      const records = parseJournal(before);
      torn = unmatchedIntents(records);
      results = records.filter((record) => record.kind === 'RESULT').length;
    }
    facts.attempts = attempts;
    facts.tornIntents = torn.length;
    facts.durableResults = results;
    assert(checks, 'kill-after-intent-observed', torn.length > 0, `torn=${torn.length} attempts=${attempts}`);
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

      const highest = Math.max(...parseJournal(before).map((record) => record.sequence));
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
       * both: traffic that never ran would leave the shutdown racing nothing. */
      const traffic = (async (): Promise<{ rounds: number; refusal: string }> => {
        let rounds = 0;
        while (serving) {
          const refusal = await writeFile(join(space.mount, `busy-${rounds % 4}.txt`), `round ${rounds}`)
            .then(() => '', (cause: NodeJS.ErrnoException) => cause.code ?? cause.message);
          if (refusal.length > 0) return { rounds, refusal };
          rounds++;
        }
        return { rounds, refusal: '' };
      })();
      try {
        await writeFile(join(space.mount, 'settled.txt'), 'the mount serves');
        if (entry === 'fence-stop') await fence(space);
        const exit = entry === 'sigterm' ? await terminateDaemon(daemon) : await stopDaemon(daemon);
        raced[entry] = exit;
        serving = false;
        const load = await traffic;
        const report = await raceReport(space);
        assert(checks, `${entry}-races-nothing`,
          exit.code === 0 && exit.unmounted && exit.ms < EXIT_LIMIT_MS && load.rounds > 0 &&
          report.announced && report.races.length === 0,
          `code=${exit.code} unmounted=${exit.unmounted} ms=${exit.ms} rounds=${load.rounds} ` +
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
