// The container's publisher as `streamCommand` ships it (D50, D57), run on this host with the real mksquashfs against
// a store that answers as R2 does: each part's etag is its MD5, a completed object's is the MD5 of those, `-<parts>`.
import { afterAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { streamCommand, type StreamProfile } from '../src/stream-archive';
import { DEVBOX_RUNTIME_DIR } from '../src/storage';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';
import { runToExit } from '../../test-utils/src/spawn';

const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}stream-`));

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const md5 = (bytes: Uint8Array): Buffer => createHash('md5').update(bytes).digest();

const md5Hex = (bytes: Uint8Array): string => createHash('md5').update(bytes).digest('hex');

/** What a reader of the stored object recomputes: the SHA-256 of each part's SHA-256, in order. */
function layerDigest(bytes: Uint8Array, partBytes: number): string {
  const parts = createHash('sha256');

  for (let at = 0; at < bytes.byteLength; at += partBytes) parts.update(createHash('sha256').update(bytes.subarray(at, at + partBytes)).digest());

  return parts.digest('hex');
}

/** A multipart store. It answers the first part only once a second has arrived, so a publisher with one part in
 *  flight never finishes. `corruptPart` stores that
 *  part with one byte changed; `arrived` hears of each part as it lands. */
function r2LikeStore(corruptPart?: number, arrived?: () => void) {
  const parts = new Map<number, Uint8Array>();
  let firstWaiting: (() => void) | undefined;
  let partsAtOnce = false;
  let aborted = false;
  let object: { bytes: Uint8Array; etag: string } | undefined;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const part = url.searchParams.get('partNumber');

      if (request.method === 'POST' && url.searchParams.has('uploads')) {
        return new Response('<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>');
      }

      if (request.method === 'PUT' && part !== null) {
        const bytes = new Uint8Array(await request.arrayBuffer());

        if (Number(part) === corruptPart) bytes[0] = (bytes[0] ?? 0) ^ 1;
        parts.set(Number(part), bytes);
        arrived?.();

        if (firstWaiting !== undefined) {
          partsAtOnce = true;
          firstWaiting();
          firstWaiting = undefined;
        } else if (!partsAtOnce && parts.size === 1) {
          await new Promise<void>((resolve) => { firstWaiting = resolve; });
        }

        return new Response(null, { headers: { etag: `"${md5Hex(bytes)}"` } });
      }

      if (request.method === 'POST' && url.searchParams.has('uploadId')) {
        const numbers = [...parts.keys()].sort((a, b) => a - b);
        const listed = numbers.map((number) => `<Part><PartNumber>${String(number)}</PartNumber><ETag>"${md5Hex(parts.get(number) ?? new Uint8Array())}"</ETag></Part>`);

        if (await request.text() === `<CompleteMultipartUpload>${listed.join('')}</CompleteMultipartUpload>`) {
          const etag = `${createHash('md5').update(Buffer.concat(numbers.map((number) => md5(parts.get(number) ?? new Uint8Array())))).digest('hex')}-${String(numbers.length)}`;
          object = { bytes: Buffer.concat(numbers.map((number) => parts.get(number) ?? new Uint8Array())), etag };
        }

        return new Response(`<CompleteMultipartUploadResult><ETag>&quot;${object?.etag ?? ''}&quot;</ETag></CompleteMultipartUploadResult>`);
      }

      if (request.method === 'DELETE') {
        aborted = true;

        return new Response(null, { status: 204 });
      }

      if (request.method === 'PUT') {
        const bytes = new Uint8Array(await request.arrayBuffer());
        object = { bytes, etag: md5Hex(bytes) };

        return new Response(null, { headers: { etag: `"${object.etag}"` } });
      }

      if (request.method === 'HEAD') {
        return object === undefined
          ? new Response(null, { status: 404 })
          : new Response(null, { headers: { 'content-length': String(object.bytes.byteLength), etag: `"${object.etag}"` } });
      }

      return new Response(null, { status: 501 });
    },
  });

  return {
    url: `http://127.0.0.1:${String(server.port)}/BUCKET/boxes/test/data.sqsh`,
    partsAtOnce: () => partsAtOnce,
    aborted: () => aborted,
    object: () => object?.bytes,
    stop: () => server.stop(true),
  };
}

const archive = join(root, 'stage', 'layer.sqsh');

/** Small enough that a test archive is many windows long; the product's profiles only scale it. */
const SMALL: StreamProfile = { partBytes: 5 * 1024 * 1024, partsInFlight: 4, windowBytes: 40 * 1024 * 1024 };

/** Runs the shipped command with its script written under this test's root rather than the box's runtime directory. */
async function stream(source: string, url: string, archiver?: string) {
  let command = streamCommand({ sourceDir: source, archivePath: archive, excludeFile: join(root, 'stage', 'excludes.txt'), excludes: [], objectUrl: url, profile: SMALL })
    .replaceAll(`'${DEVBOX_RUNTIME_DIR}/devbox-stream.mjs'`, `'${join(root, 'devbox-stream.mjs')}'`);

  if (archiver !== undefined) command = command.replace(/ -- [^)]*\)/, ` -- ${archiver})`);
  const child = Bun.spawn(['bash', '-c', command], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

  return { stdout, stderr };
}

function tree(name: string, files: number, bytes: number): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'small'), { recursive: true });

  for (let at = 0; at < files; at += 1) writeFileSync(join(dir, `part-${String(at)}.bin`), randomBytes(bytes));

  for (let at = 0; at < 200; at += 1) writeFileSync(join(dir, 'small', `s-${String(at)}.txt`), `small ${String(at)}\n`);

  return dir;
}

async function listing(squashfs: Uint8Array | undefined, label: string): Promise<string> {
  if (squashfs === undefined) return 'no object';
  const path = join(root, `${label}.sqsh`);
  writeFileSync(path, squashfs);
  const listed = await runToExit(['unsquashfs', '-lls', path]);

  return listed.exitCode === 0 ? listed.stdout.split('\n').filter((line) => line.includes('squashfs-root')).map((line) => line.replace(/^\S+ \S+ +/, '')).sort().join('\n') : listed.stderr;
}

test('an archive many times the window streams in concurrent parts and the store holds exactly it', async () => {
  const store = r2LikeStore();
  const source = tree('large', 20, 32 * 1024 * 1024);
  const { stdout, stderr } = await stream(source, store.url);
  await store.stop();
  const landed = store.object();
  const direct = join(root, 'direct.sqsh');
  await runToExit(['mksquashfs', source, direct, '-noappend', '-comp', 'zstd', '-no-progress']);
  const [code, size, , digest] = stdout.split(' ');

  expect({ code, stderr, partsAtOnce: store.partsAtOnce(), tree: await listing(landed, 'landed') })
    .toEqual({ code: '0', stderr: '', partsAtOnce: true, tree: await listing(Bun.file(direct).size > 0 ? new Uint8Array(await Bun.file(direct).arrayBuffer()) : undefined, 'direct') });
  expect(Number(size)).toBe(landed?.byteLength ?? -1);
  // The parts went up out of order, the first last; the digest is of the object as stored.
  expect(digest).toBe(layerDigest(landed ?? new Uint8Array(), SMALL.partBytes));
});

test('a small archive is one PUT whose digest the store confirms', async () => {
  const store = r2LikeStore();
  const source = tree('small', 0, 0);
  const { stdout, stderr } = await stream(source, store.url);
  await store.stop();
  const landed = store.object();

  expect({ stdout, stderr, multipart: store.partsAtOnce() }).toEqual({
    stdout: `0 ${String(landed?.byteLength)} ${md5Hex(landed ?? new Uint8Array())} ${layerDigest(landed ?? new Uint8Array(), SMALL.partBytes)}`, stderr: '', multipart: false,
  });
});

test('a part the store holds as other bytes refuses the publication and aborts the upload', async () => {
  const store = r2LikeStore(3);
  const { stdout } = await stream(tree('corrupt', 4, 8 * 1024 * 1024), store.url);
  await store.stop();

  expect({ code: stdout.split(' ')[0], stored: store.object() !== undefined, aborted: store.aborted() }).toEqual({ code: '1', stored: false, aborted: true });
});

test('an archiver that writes again into a part already uploaded is refused', async () => {
  const store = r2LikeStore();

  // Writes 40 MiB in order, waits for the parts to upload, then writes into the second part again.
  const archiver = `python3 -c 'import os,sys,time
f=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT,0o644)
for i in range(40): os.write(f,os.urandom(1048576))
time.sleep(3)
os.pwrite(f,b"again",6*1048576)' '${join(root, 'stage', 'layer.sqsh')}'`;

  const { stdout } = await stream(tree('rewrite', 0, 0), store.url, archiver);
  await store.stop();

  expect({ code: stdout.split(' ')[0], stored: store.object() !== undefined }).toEqual({ code: '1', stored: false });
});

// 2026-10-04, under load: the archiver ended while one part was in flight, and the rest waited for it, so the store
// never had two parts at once and the publisher's fetch timed out after 300 s.
test('the parts left when the archiver ends go up beside the one still in flight', async () => {
  const go = join(root, 'stage', 'go');
  mkdirSync(join(root, 'stage'), { recursive: true });
  rmSync(go, { force: true });
  expect((await runToExit(['mkfifo', go])).exitCode).toBe(0);
  let told = false;

  const store = r2LikeStore(undefined, () => {
    if (!told) writeFileSync(go, 'x');
    told = true;
  });

  // Two parts and some: the publisher starts the second, and the archiver ends once that one has reached the store.
  const archiver = `python3 -c 'import os,sys
f=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT,0o644)
os.write(f,os.urandom(12*1048576))
open(sys.argv[2]).read(1)' '${archive}' '${go}'`;

  const { stdout, stderr } = await stream(tree('tail', 0, 0), store.url, archiver);
  await store.stop();

  expect({ stdout, stderr, landed: store.object()?.byteLength }).toEqual({ stdout: expect.stringMatching(/^0 12582912 [0-9a-f]{32}-3 [0-9a-f]{64}$/), stderr: '', landed: 12582912 });
});

test('an archiver failure refuses the publication with exit 4', async () => {
  const store = r2LikeStore();
  const { stdout } = await stream(join(root, 'absent'), store.url);
  await store.stop();

  expect(stdout.split(' ')[0]).toBe('4');
  expect(store.object()).toBeUndefined();
});
