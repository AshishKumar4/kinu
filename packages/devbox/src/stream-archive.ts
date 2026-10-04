// The container's publisher (D57): mksquashfs streams each layer to the store as it builds it.
import { DEVBOX_RUNTIME_DIR } from './storage';

const MIB = 1024 * 1024;

export function shellPath(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** Parts, parts in flight, and the most of an archive the disk holds while it streams (a soft bound). */
export interface StreamProfile {
  readonly partBytes: number;
  readonly partsInFlight: number;
  readonly windowBytes: number;
}

/** Four 5 MiB parts held a 10 GiB base to about 13 MiB/s a box (D57); D53's E′ shape (D58). */
export const DISK_STREAM: StreamProfile = { partBytes: 16 * MIB, partsInFlight: 16, windowBytes: 512 * MIB };

/** Publishes the archive as it grows (D57), past the mount (D15). Exits: 1 the store, 2 usage, 3 the
 *  store's account of the object, 4 the archiver or its input, 5 no archive. */
const STREAM_SCRIPT = `// devbox-stream-v1
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, rmSync, statSync } from 'node:fs';

const [url, partArg, inFlightArg, windowArg, archive, separator, ...rest] = process.argv.slice(2);
// \`--input <argv>\`: what the archiver reads as stdin.
const cut = rest.indexOf('--input');
const archiver = cut === -1 ? rest : rest.slice(0, cut);
const input = cut === -1 ? [] : rest.slice(cut + 1);
const partBytes = Number(partArg);
const inFlight = Number(inFlightArg);
const windowBytes = Number(windowArg);

function refuse(code, message) {
  process.stderr.write(message + '\\n');
  process.exit(code);
}

if (url === undefined || archive === undefined || separator !== '--' || archiver.length === 0 || (cut !== -1 && input.length === 0) || !Number.isSafeInteger(partBytes) || partBytes <= 0
  || !Number.isSafeInteger(inFlight) || inFlight <= 0 || !Number.isSafeInteger(windowBytes) || windowBytes < 2 * partBytes) {
  refuse(2, 'usage: stream.mjs <url> <partBytes> <partsInFlight> <windowBytes> <archive> -- <archiver argv> [--input <producer argv>]');
}

async function answered(label, response) {
  if (response.ok) return response;
  const body = (await response.text()).slice(0, 300);
  throw new Error(label + ' answered ' + response.status + ': ' + body);
}

function tag(text, name) {
  const found = new RegExp('<' + name + '>([^<]*)</' + name + '>').exec(text);

  return found === null ? '' : found[1];
}

/** A part is final once the archiver has written a little past it. */
const MARGIN = 1024 * 1024;
const md5 = (bytes) => createHash('md5').update(bytes).digest();
/** The store's digest of what it holds: R2 answers each part, and each whole object, with an MD5 etag. */
const etagOf = (response) => (response.headers.get('etag') ?? '').replaceAll('"', '').toLowerCase();

function read(number, size) {
  const length = Math.min(partBytes, size - (number - 1) * partBytes);
  const bytes = new Uint8Array(length);
  const fd = openSync(archive, 'r');

  try {
    for (let done = 0; done < length;) done += readSync(fd, bytes, done, length - done, (number - 1) * partBytes + done);
  } finally {
    closeSync(fd);
  }

  return bytes;
}

// mksquashfs writes in order, then once to the superblock at 0: a part is final once the file grows past
// it, so the first uploads last. Stored parts are punched out of the disk.
// Each side of the FIFO execs into its own pid, so a stop or a kill reaches the process itself.
const fifo = archive + '.in';
let producer;
let inputWords = '';
let inputExit;
let produced = Promise.resolve();

if (input.length > 0) {
  rmSync(fifo, { force: true });
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });

  if (made.status !== 0) refuse(2, 'mkfifo ' + fifo + ': ' + made.stderr);
  producer = spawn('sh', ['-c', 'exec "$@" > "$0"', fifo, ...input], { stdio: ['ignore', 'ignore', 'pipe'] });
  producer.stderr.on('data', (chunk) => { inputWords += chunk; });
  produced = new Promise((resolve) => { producer.on('close', (code, signal) => { inputExit = code ?? signal ?? 'unknown'; resolve(); }); });
}

const child = input.length > 0
  ? spawn('sh', ['-c', 'exec "$@" < "$0"', fifo, ...archiver], { stdio: ['ignore', 'ignore', 'pipe'] })
  : spawn(archiver[0], archiver.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] });
let archiverWords = '';
child.stderr.on('data', (chunk) => { archiverWords += chunk; });
let exit;
const exited = new Promise((resolve) => { child.on('close', (code, signal) => { exit = code ?? signal ?? 'unknown'; resolve(); }); });
// A failed input may never open the FIFO the archiver waits on.
void produced.then(() => { if (inputExit !== undefined && inputExit !== 0 && exit === undefined) child.kill('SIGKILL'); });

/** Its producer cannot finish without it. */
async function settleInput() {
  if (exit !== 0 && inputExit === undefined) producer?.kill('SIGKILL');
  await produced;
  rmSync(fifo, { force: true });
}

function archiverFailure() {
  const own = 'mksquashfs exited ' + exit + ': ' + (archiverWords.trim() || 'no output');

  return inputExit !== undefined && inputExit !== 0 ? 'its input exited ' + inputExit + ': ' + (inputWords.trim() || 'no output') + '; ' + own : own;
}
const digests = [];
const pending = new Set();
const freed = new Set();
let freedThrough = 1;
let uploadId;
let next = 2;
let stopped = false;
let failure;

async function open() {
  const opened = await answered('POST ?uploads', await fetch(url + '?uploads=', { method: 'POST' }));
  const id = tag(await opened.text(), 'UploadId');

  if (id.length === 0) throw new Error('the multipart upload was opened without an id');
  uploadId = encodeURIComponent(id);
}

async function send(number, size) {
  const bytes = read(number, size);
  const digest = md5(bytes);
  const part = await answered('PUT part ' + number, await fetch(url + '?partNumber=' + number + '&uploadId=' + uploadId, {
    method: 'PUT', headers: { 'content-length': String(bytes.length) }, body: bytes,
  }));

  if (etagOf(part) !== digest.toString('hex')) throw new Error('the store holds part ' + number + ' as ' + etagOf(part) + ', not ' + digest.toString('hex'));

  if (number > 1 && !md5(read(number, size)).equals(digest)) throw new Error('part ' + number + ' changed after it was uploaded');
  pace();
  digests[number - 1] = digest;

  // Punching a range waits for its pages to be written, so it runs beside the loop, never in it.
  if (number > 1 && exit === undefined) {
    const punched = await new Promise((resolve) => {
      const freeing = spawn('fallocate', ['-p', '-o', String((number - 1) * partBytes), '-l', String(partBytes), archive], { stdio: ['ignore', 'ignore', 'pipe'] });
      let words = '';
      freeing.stderr.on('data', (chunk) => { words += chunk; });
      freeing.on('close', (code) => resolve({ code, words }));
    });

    if (punched.code !== 0) throw new Error('fallocate could not free part ' + number + ': ' + punched.words);
    freed.add(number);

    while (freed.has(freedThrough + 1)) freedThrough += 1;
  }
}

function start(number, size) {
  const job = send(number, size).catch((error) => { failure ??= error; });
  pending.add(job);
  void job.finally(() => pending.delete(job));
}

function sizeNow() {
  try {
    return statSync(archive).size;
  } catch {
    return 0;
  }
}

/** At most a window waits on the disk. The archiver writes up to 7 GB/s, so this runs often; never once the loop ended. */
function pace() {
  if (exit !== undefined || failure !== undefined) return;
  const waiting = sizeNow() - freedThrough * partBytes + partBytes;

  if (waiting > windowBytes && !stopped) stopped = child.kill('SIGSTOP');
  else if (waiting <= windowBytes / 2 && stopped) stopped = !child.kill('SIGCONT');
}

async function abort(error) {
  const archiverFailed = exit !== undefined && exit !== 0;

  if (exit === undefined) child.kill('SIGKILL');
  await exited;
  await settleInput();
  rmSync(archive, { force: true });

  if (archiverFailed) {
    if (uploadId !== undefined) await fetch(url + '?uploadId=' + uploadId, { method: 'DELETE' }).catch(() => undefined);
    refuse(4, archiverFailure());
  }

  if (uploadId !== undefined) {
    const aborted = await fetch(url + '?uploadId=' + uploadId, { method: 'DELETE' }).catch(() => ({ ok: false, status: 'unreachable' }));
    refuse(1, String(error && error.message ? error.message : error) + '; multipart ' + decodeURIComponent(uploadId) + (aborted.ok ? ' aborted' : ' NOT aborted (' + aborted.status + ')'));
  }

  refuse(1, String(error && error.message ? error.message : error));
}

try {
  while (exit === undefined && failure === undefined) {
    const size = sizeNow();

    pace();

    while (pending.size < inFlight && next * partBytes + MARGIN <= size) {
      if (uploadId === undefined) await open();
      start(next++, size);
      pace();
    }

    await Promise.race([exited, new Promise((resolve) => { setTimeout(resolve, 5); }), ...pending]);
  }

  if (stopped) child.kill('SIGCONT');
  await exited;
  await settleInput();
  await Promise.all(pending);

  if (failure !== undefined) throw failure;
} catch (error) {
  await abort(error);
}

if (exit !== 0 || (inputExit !== undefined && inputExit !== 0)) {
  rmSync(archive, { force: true });

  if (uploadId !== undefined) await fetch(url + '?uploadId=' + uploadId, { method: 'DELETE' }).catch(() => undefined);
  refuse(4, archiverFailure());
}

const size = sizeNow();

if (size <= 0) {
  rmSync(archive, { force: true });
  refuse(5, 'mksquashfs reported success but ' + archive + ' is empty: ' + (archiverWords.trim() || 'the archiver left no diagnostics'));
}

let etag;

try {
  // A part rewritten after its bytes were freed would hold data again where only a hole should be.
  if (freed.size > 0) {
    const ranges = [...freed].map((number) => String((number - 1) * partBytes) + ' ' + String(number * partBytes)).join('\\n');
    const holes = spawnSync('python3', ['-c', 'import os,sys\\nfd=os.open(sys.argv[1],os.O_RDONLY)\\nfor line in sys.stdin:\\n'
      + '  lo,hi=map(int,line.split())\\n  try:\\n    at=os.lseek(fd,lo,os.SEEK_DATA)\\n  except OSError:\\n    continue\\n'
      + '  if at<hi: print(lo)', archive], { encoding: 'utf8', input: ranges });

    if (holes.status !== 0 || holes.stdout.trim() !== '') {
      throw new Error('the archive was written again where its uploaded parts were freed: ' + (holes.stderr || holes.stdout).trim());
    }
  }

  const count = Math.ceil(size / partBytes);

  if (count === 1) {
    const bytes = read(1, size);
    const put = await answered('PUT', await fetch(url, { method: 'PUT', body: bytes }));
    etag = etagOf(put);

    if (etag !== md5(bytes).toString('hex')) throw new Error('the store holds ' + url + ' as ' + etag + ', not ' + md5(bytes).toString('hex'));
  } else {
    if (uploadId === undefined) await open();

    for (let number = next; number <= count; number += 1) {
      while (pending.size >= inFlight) await Promise.race(pending);
      start(number, size);
    }

    start(1, size);
    await Promise.all(pending);

    if (failure !== undefined) throw failure;
    const parts = digests.map((digest, index) => '<Part><PartNumber>' + (index + 1) + '</PartNumber><ETag>"' + digest.toString('hex') + '"</ETag></Part>');
    await answered('POST ?uploadId', await fetch(url + '?uploadId=' + uploadId, {
      method: 'POST', body: '<CompleteMultipartUpload>' + parts.join('') + '</CompleteMultipartUpload>',
    }));
    etag = createHash('md5').update(Buffer.concat(digests)).digest('hex') + '-' + count;
  }
} catch (error) {
  await abort(error);
}

rmSync(archive, { force: true });
// The store's own account of the whole object: its length, and the digest of the parts it joined, in order.
const head = await answered('HEAD', await fetch(url, { method: 'HEAD' }));
const landed = Number(head.headers.get('content-length'));

if (landed !== size) refuse(3, 'the store reports ' + landed + ' bytes for ' + url + ' where ' + size + ' were sent');

if (etagOf(head) !== etag) refuse(3, 'the store reports ' + url + ' as ' + etagOf(head) + ' where the parts sent make ' + etag);
process.stdout.write(size + ' ' + etag);
`;

/** Base64, so no byte of it can become shell syntax. */
const STREAM_SCRIPT_B64 = btoa(STREAM_SCRIPT);

/** Mirrors `@cloudflare/sandbox` `BackupService` normalisation exactly: a different one would
 *  exclude a different file set from the same policy; null means the pattern matches nothing. */
export function normalizeArchiveExclude(pattern: string): string | null {
  let normalized = pattern;

  while (normalized.startsWith('**/')) normalized = normalized.slice(3);

  while (normalized.includes('/**/')) normalized = normalized.replaceAll('/**/', '/');

  if (normalized.endsWith('/**')) normalized = normalized.slice(0, -3);

  if (normalized === '' || normalized === '**') return null;

  return normalized;
}

/** Two lines per pattern: mksquashfs anchors an exclude to the source dir unless prefixed `... `;
 *  with `-wildcards`, both lines exclude the pattern at every depth. */
function archiveExcludeFile(patterns: readonly string[]): string {
  const lines: string[] = [];

  for (const pattern of patterns) {
    const normalized = normalizeArchiveExclude(pattern);

    if (normalized === null) continue;
    lines.push(normalized, `... ${normalized}`);
  }

  return lines.map(line => `${line}\n`).join('');
}

/** `tar`: a command that prints an uncompressed tar. */
export type ArchiveSource =
  | { readonly sourceDir: string; readonly excludeFile: string; readonly excludes: readonly string[] }
  | { readonly tar: string };

type ArchiveInput = ArchiveSource & { readonly archivePath: string };

const ARCHIVER = '/usr/bin/nice -n 10 /usr/bin/mksquashfs';

const ARCHIVE_FLAGS = '-noappend -no-duplicates -comp zstd -Xcompression-level 1 -no-progress';

/** Patterns travel as base64 so none becomes shell syntax; `-ef` carries non-anchored lines.
 *  `nice` lets the script stop the archiver (D57); `-no-duplicates`: copies read back are holes. */
function archiverParts(input: ArchiveInput) {
  const parent = input.archivePath.slice(0, input.archivePath.lastIndexOf('/'));
  const clear = `mkdir -p ${shellPath(parent)} && rm -f ${shellPath(input.archivePath)}`;

  if ('tar' in input) {
    return { prepare: clear, archiver: `${ARCHIVER} - ${shellPath(input.archivePath)} -tar ${ARCHIVE_FLAGS} --input ${input.tar}` };
  }

  let bytes = '';

  for (const byte of new TextEncoder().encode(archiveExcludeFile(input.excludes))) {
    bytes += String.fromCharCode(byte);
  }

  return {
    prepare: `${clear} && printf %s ${shellPath(btoa(bytes))} | base64 -d > ${shellPath(input.excludeFile)}`,
    archiver: `${ARCHIVER} ${shellPath(input.sourceDir)} ${shellPath(input.archivePath)} ${ARCHIVE_FLAGS} -wildcards -ef ${shellPath(input.excludeFile)}`,
  };
}

/** One command: a spot container can be replaced between execs. Prints `<rc> <bytes> <etag>`. */
export function streamCommand(input: ArchiveInput & { readonly objectUrl: string; readonly profile: StreamProfile }): string {
  const script = `${DEVBOX_RUNTIME_DIR}/devbox-stream.mjs`;
  const { prepare, archiver } = archiverParts(input);

  return `${prepare} && printf %s ${shellPath(STREAM_SCRIPT_B64)} | base64 -d > ${shellPath(script)}; `
    + `out=$(bun ${shellPath(script)} ${shellPath(input.objectUrl)} ${String(input.profile.partBytes)} ${String(input.profile.partsInFlight)} `
    + `${String(input.profile.windowBytes)} ${shellPath(input.archivePath)} -- ${archiver}); `
    + `rc=$?; printf '%s %s' "$rc" "$out"`;
}
