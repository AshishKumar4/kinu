// How the publisher (D57) meets its archiver failing, with the hybrid's 10 GB base as the case: it failed as an
// ENOENT on the archive, and the archiver's own words were "FATAL ERROR: zstd uncompress failed" (sbs10031227nr610).
import { afterAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DEVBOX_RUNTIME_DIR } from '../src/storage';
import { type StreamProfile, streamCommand } from '../src/stream-archive';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';

const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}archiver-`));

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const archive = join(root, 'stage', 'layer.sqsh');

const PROFILE: StreamProfile = { partBytes: 5 * 1024 * 1024, partsInFlight: 4, windowBytes: 40 * 1024 * 1024 };

const md5Hex = (bytes: Uint8Array): string => createHash('md5').update(bytes).digest('hex');

/** A multipart store whose part PUTs answer once `release` settles; it keeps the object a completion names. */
function store(release: Promise<void>) {
  const parts = new Map<number, Uint8Array>();
  let object: Uint8Array | undefined;
  let etag = '';

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const part = Number(url.searchParams.get('partNumber'));

      if (request.method === 'POST' && url.searchParams.has('uploads')) return new Response('<InitiateMultipartUploadResult><UploadId>u</UploadId></InitiateMultipartUploadResult>');

      if (request.method === 'PUT' && part > 0) {
        const bytes = new Uint8Array(await request.arrayBuffer());

        parts.set(part, bytes);
        await release;

        return new Response(null, { headers: { etag: `"${md5Hex(bytes)}"` } });
      }

      if (request.method === 'POST') {
        const numbers = [...parts.keys()].sort((a, b) => a - b);
        object = Buffer.concat(numbers.map((number) => parts.get(number) ?? new Uint8Array()));
        etag = `${createHash('md5').update(Buffer.concat(numbers.map((number) => createHash('md5').update(parts.get(number) ?? new Uint8Array()).digest()))).digest('hex')}-${String(numbers.length)}`;

        return new Response(`<CompleteMultipartUploadResult><ETag>&quot;${etag}&quot;</ETag></CompleteMultipartUploadResult>`);
      }

      if (request.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(object?.byteLength ?? 0), etag: `"${etag}"` } });

      return new Response(null, { status: 204 });
    },
  });

  return { url: `http://127.0.0.1:${String(server.port)}/b/layer.sqsh`, object: () => object, stop: () => server.stop(true) };
}

/** The shipped command, its script under this test's root, with `archiver` given the product's archiver argv. */
async function publish(source: string, url: string, archiver: (product: string) => string) {
  const command = streamCommand({ sourceDir: source, archivePath: archive, excludeFile: join(root, 'stage', 'excludes.txt'), excludes: [], objectUrl: url, profile: PROFILE })
    .replaceAll(`'${DEVBOX_RUNTIME_DIR}/devbox-stream.mjs'`, `'${join(root, 'devbox-stream.mjs')}'`)
    .replace(/ -- ([^)]*)\)/, (_whole, product: string) => ` -- ${archiver(product)})`);

  const child = Bun.spawn(['bash', '-c', command], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

  return { code: stdout.split(' ')[0], stderr };
}

function listing(squashfs: Uint8Array | undefined, label: string): string {
  if (squashfs === undefined) return 'no object';
  const path = join(root, `${label}.sqsh`);
  writeFileSync(path, squashfs);
  const listed = Bun.spawnSync(['unsquashfs', '-lls', path]);

  return listed.stdout.toString().split('\n').filter((line) => line.includes('squashfs-root')).map((line) => line.replace(/^\S+ \S+ +/, '')).sort().join('\n');
}

test('an archiver that fails mid-stream and removes its output is reported in its own words, not the upload\'s', async () => {
  // mksquashfs unlinks its output on a fatal error; each PUT here answers once the archive is gone.
  mkdirSync(dirname(archive), { recursive: true });
  mkdirSync(join(root, 'vanish'), { recursive: true });

  const gone = new Promise<void>((resolve) => {
    const watcher = watch(dirname(archive), (_event, name) => {
      if (name === basename(archive) && statSync(archive, { throwIfNoEntry: false }) === undefined) {
        watcher.close();
        resolve();
      }
    });
  });

  const target = store(gone);

  const failing = () => `python3 -c 'import os,sys,time
f = open(sys.argv[1], "wb"); f.write(os.urandom(20 * 1024 * 1024)); f.flush(); time.sleep(1)
os.unlink(sys.argv[1]); sys.stderr.write("FATAL ERROR: Failed to write to output filesystem\\n"); sys.exit(1)' ${archive}`;

  const published = await publish(join(root, 'vanish'), target.url, failing);

  await target.stop();

  expect({ code: published.code, words: published.stderr.includes('FATAL ERROR: Failed to write to output filesystem') }).toEqual({ code: '4', words: true });
});

test('small files that duplicate ones already uploaded stream like any others', async () => {
  // A duplicate's first copy is read back once mksquashfs's cache lets it go, punched by then; a small cache (-mem)
  // and 8,000 fragments between stand for the 10 GB base.
  const source = join(root, 'duplicates');
  const texts = Array.from({ length: 64 }, (_, at) => Buffer.from(`${String(at)} ${Buffer.from(randomBytes(6 * 1024)).toString('base64')}\n`));

  for (const dir of ['b-first', 'c-between', 'd-again']) mkdirSync(join(source, dir), { recursive: true });
  writeFileSync(join(source, 'a-fill.bin'), randomBytes(10 * 1024 * 1024));

  for (const [at, text] of texts.entries()) writeFileSync(join(source, 'b-first', `t-${String(at)}.txt`), text);

  for (let at = 0; at < 8_000; at += 1) writeFileSync(join(source, 'c-between', `f-${String(at)}.bin`), randomBytes(16 * 1024));

  for (const [at, text] of texts.entries()) writeFileSync(join(source, 'd-again', `t-${String(at)}.txt`), text);

  const target = store(Promise.resolve());
  const published = await publish(source, target.url, (product) => `${product} -mem 128M`);

  await target.stop();

  const direct = join(root, 'duplicates-direct.sqsh');
  Bun.spawnSync(['mksquashfs', source, direct, '-noappend', '-comp', 'zstd', '-no-progress']);

  expect({ ...published, tree: listing(target.object(), 'duplicates') })
    .toEqual({ code: '0', stderr: '', tree: listing(new Uint8Array(await Bun.file(direct).arrayBuffer()), 'duplicates-direct') });
});
