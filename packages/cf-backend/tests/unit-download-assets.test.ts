/**
 * The static-asset bundle is served with `not_found_handling:
 * "single-page-application"`, so an asset that was never published comes back
 * as 200 + the SPA shell. Production once shipped that way: the CLI tarball,
 * its checksum, and the version JSON all served index.html under their
 * configured content-types, and every fresh install died on an unexplained
 * checksum mismatch while the site looked healthy.
 *
 * So the download routes must hard-404 anything that is not the asset, and
 * /api/health must report the deployed build stamp — one GET that says whether
 * the asset half of a deploy landed.
 */
import { describe, expect, test } from 'bun:test';
import { handleCliRequest } from '../src/cli/routes.js';
import { handleHealthRequest } from '../src/health-route.js';

const ORIGIN = 'https://proteus.example.com';
const SPA_SHELL = '<!doctype html>\n<html lang="en"><head><title>Proteus</title></head><body></body></html>';

const STAMP = { version: '0.1.0+abc1234', sha: 'abc1234', builtAt: '2026-08-07T00:00:00.000Z' };

/** An ASSETS binding that publishes `files` and answers everything else the
 *  way the real single-page-application fallback does. */
function envWithAssets(files: Record<string, { body: string; contentType: string }>): Env {
  return {
    ASSETS: {
      async fetch(request: Request): Promise<Response> {
        const { pathname } = new URL(request.url);
        const file = files[pathname];
        if (file) {
          return new Response(file.body, { status: 200, headers: { 'content-type': file.contentType } });
        }
        return new Response(SPA_SHELL, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      },
    },
  } as unknown as Env;
}

const PUBLISHED = {
  '/downloads/proteus-source.tar.gz': { body: 'TARBALL-BYTES', contentType: 'application/gzip' },
  '/downloads/proteus-source.tar.gz.sha256': { body: 'deadbeef  proteus-source.tar.gz\n', contentType: 'text/plain' },
  '/downloads/proteus-version.json': { body: JSON.stringify(STAMP), contentType: 'application/json' },
};

const DOWNLOAD_PATHS = Object.keys(PUBLISHED);

describe('CLI download assets', () => {
  test('serve the published asset with the declared content-type', async () => {
    const env = envWithAssets(PUBLISHED);
    for (const path of DOWNLOAD_PATHS) {
      const res = await handleCliRequest(new Request(`${ORIGIN}${path}`), env);
      expect(res?.status).toBe(200);
      expect(await res!.text()).toBe(PUBLISHED[path as keyof typeof PUBLISHED].body);
      expect(res!.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  test('404 instead of letting the SPA shell impersonate a download', async () => {
    const env = envWithAssets({});
    for (const path of DOWNLOAD_PATHS) {
      const res = await handleCliRequest(new Request(`${ORIGIN}${path}`), env);
      expect(res?.status).toBe(404);
      const body = await res!.text();
      expect(body).not.toContain('<!doctype html>');
      expect(body).toContain('Deployment incomplete');
      expect(res!.headers.get('content-type')).toStartWith('text/plain');
    }
  });

  test('404 when the asset worker itself errors', async () => {
    const env = {
      ASSETS: { async fetch() { return new Response('boom', { status: 500 }); } },
    } as unknown as Env;
    for (const path of DOWNLOAD_PATHS) {
      const res = await handleCliRequest(new Request(`${ORIGIN}${path}`), env);
      expect(res?.status).toBe(404);
    }
  });

  test('HEAD mirrors GET status with no body', async () => {
    const published = await handleCliRequest(
      new Request(`${ORIGIN}${DOWNLOAD_PATHS[0]}`, { method: 'HEAD' }),
      envWithAssets(PUBLISHED),
    );
    expect(published?.status).toBe(200);
    expect(published!.body).toBeNull();

    const missing = await handleCliRequest(
      new Request(`${ORIGIN}${DOWNLOAD_PATHS[0]}`, { method: 'HEAD' }),
      envWithAssets({}),
    );
    expect(missing?.status).toBe(404);
    expect(missing!.body).toBeNull();
  });
});

describe('GET /api/health build stamp', () => {
  test('reports the deployed build and is ok', async () => {
    const res = await handleHealthRequest(new Request(`${ORIGIN}/api/health`), envWithAssets(PUBLISHED));
    const body = await res!.json() as { ok: boolean; build: typeof STAMP | null };
    expect(body.ok).toBe(true);
    expect(body.build).toEqual(STAMP);
  });

  test('is not ok when the deploy shipped no build stamp', async () => {
    const res = await handleHealthRequest(new Request(`${ORIGIN}/api/health`), envWithAssets({}));
    const body = await res!.json() as { ok: boolean; build: unknown };
    expect(body.ok).toBe(false);
    expect(body.build).toBeNull();
  });

  test('rejects a stamp that is not the expected shape', async () => {
    for (const malformed of ['not json at all', '[]', '{"version":"0.1.0"}', '{"version":"","sha":"a","builtAt":"b"}']) {
      const env = envWithAssets({
        '/downloads/proteus-version.json': { body: malformed, contentType: 'application/json' },
      });
      const res = await handleHealthRequest(new Request(`${ORIGIN}/api/health`), env);
      const body = await res!.json() as { ok: boolean; build: unknown };
      expect(body.ok).toBe(false);
      expect(body.build).toBeNull();
    }
  });

  test('ignores non-health paths and non-GET methods', async () => {
    const env = envWithAssets(PUBLISHED);
    expect(await handleHealthRequest(new Request(`${ORIGIN}/api/other`), env)).toBeNull();
    expect(await handleHealthRequest(new Request(`${ORIGIN}/api/health`, { method: 'POST' }), env)).toBeNull();
  });
});
