import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scratchDir } from '../packages/test-utils/src/scratch';
import { adoptDownloads, artifactDigest } from './promote';

/** A build's dist, as Vite and the release scripts leave it. */
function dist(files: Readonly<Record<string, string>>): string {
  const root = scratchDir('promote-dist');

  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }

  return root;
}

const BUILD = {
  'kinu/index.js': 'export default {}',
  'kinu/wrangler.json': '{"name":"kinu"}',
  'client/index.html': '<html></html>',
  'client/downloads/kinu-version.json': '{"sha":"abc"}',
};

describe('the artifact digest', () => {
  test('is the Worker and client, not the environment\'s config nor the downloads promotion copies', () => {
    const production = artifactDigest(dist(BUILD));

    expect(artifactDigest(dist({ ...BUILD, 'kinu/wrangler.json': '{"name":"kinu-staging"}' }))).toBe(production);
    expect(artifactDigest(dist({ ...BUILD, 'client/downloads/kinu-version.json': '{"sha":"def"}' }))).toBe(production);
    expect(artifactDigest(dist({ ...BUILD, 'kinu/index.js': 'export default { fetch() {} }' }))).not.toBe(production);
    expect(artifactDigest(dist({ ...BUILD, 'client/landing.html': '' }))).not.toBe(production);
  });
});

describe('staging\'s downloads, adopted', () => {
  const stops: (() => Promise<void>)[] = [];

  afterEach(async () => { await Promise.all(stops.splice(0).map(async (stop) => stop())); });

  const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

  /** A staging deployment serving `files` under /downloads, with a stamp signing `signed`. */
  function staging(signed: Readonly<Record<string, string>>, served: Readonly<Record<string, string>> = signed, sha = 'abc'): string {
    const checksums = Object.fromEntries(Object.entries(signed).map(([name, text]) => [`/downloads/${name}`, sha256(text)]));

    const files = new Map(Object.entries({
      'kinu-version.json': JSON.stringify({ sha, checksums: { ...checksums, '/downloads/kinu-worker-1+abc.tar.gz': 'f'.repeat(64) } }),
      'release.json': '{"sha":"abc"}',
      'kinu-worker-1+abc.tar.gz.sha256': `${'f'.repeat(64)}  kinu-worker-1+abc.tar.gz\n`,
      ...Object.fromEntries(Object.entries(served).flatMap(([name, text]) => [[name, text], [`${name}.sha256`, `${sha256(text)}  ${name}\n`]])),
    }));

    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const text = files.get(new URL(request.url).pathname.replace('/downloads/', ''));

        return text === undefined ? new Response('missing', { status: 404 }) : new Response(text);
      },
    });

    stops.push(async () => server.stop(true));

    return `http://127.0.0.1:${String(server.port)}`;
  }

  test('every signed file is kept beside its checksum, and the worker tarball is named for R2', async () => {
    const dir = join(scratchDir('promote-downloads'), 'downloads');
    const tarball = await adoptDownloads(staging({ 'kinu-cli-linux-x64.tar.gz': 'cli bytes' }), 'abc', dir);

    expect(tarball).toBe('kinu-worker-1+abc.tar.gz');
    expect(readFileSync(join(dir, 'kinu-cli-linux-x64.tar.gz'), 'utf8')).toBe('cli bytes');

    for (const name of ['kinu-version.json', 'release.json', 'kinu-cli-linux-x64.tar.gz.sha256', 'kinu-worker-1+abc.tar.gz.sha256']) {
      expect(existsSync(join(dir, name))).toBe(true);
    }
  });

  test('a download that does not hash as the stamp signed is refused, and nothing is kept', async () => {
    const dir = join(scratchDir('promote-downloads'), 'downloads');
    const origin = staging({ 'kinu-cli-linux-x64.tar.gz': 'cli bytes' }, { 'kinu-cli-linux-x64.tar.gz': 'other bytes' });

    await expect(adoptDownloads(origin, 'abc', dir)).rejects.toThrow(/does not hash as the signed stamp says/);
    expect(existsSync(dir)).toBe(false);
  });

  test('downloads of another commit are refused', async () => {
    const origin = staging({}, {}, 'def');

    await expect(adoptDownloads(origin, 'abc', join(scratchDir('promote-downloads'), 'downloads'))).rejects.toThrow(/serves the downloads of def, not abc/);
  });
});
