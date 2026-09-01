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
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { BUILTIN_TOOLS, NAMED_SWARM_PRESETS, SWARM_PRESETS } from '@kinu.run/core';
import { handleCliRequest } from '../src/cli/routes';
import { handleHealthRequest } from '../src/health-route';
import { CLI_DIST_PATHS } from '../src/lib/deployed-assets';

const ORIGIN = 'https://kinu.example.com';
const SPA_SHELL = '<!doctype html>\n<html lang="en"><head><title>Kinu</title></head><body></body></html>';

const STAMP = { version: '0.1.0+abc1234', sha: 'abc1234', builtAt: '2026-08-07T00:00:00.000Z' };

interface PublishedAsset {
  body: string;
  contentType: string;
}

const HealthResponseSchema = v.object({
  ok: v.boolean(),
  build: v.nullable(v.object({
    version: v.string(),
    sha: v.string(),
    builtAt: v.string(),
  })),
  features: v.object({
    builtinTools: v.number(),
    swarmPresets: v.number(),
    namedSearches: v.number(),
  }),
});

function requiredResponse(response: Response | null): Response {
  if (!response) throw new Error('expected route to return a response');
  return response;
}

function testEnv(assets: Pick<Env['ASSETS'], 'fetch'>): Env {
  const partialEnv: Partial<Env> = {
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };
  // SAFETY: The CLI and health asset paths call only ASSETS.fetch, which this fixture constructs.
  partialEnv.ASSETS = assets as Env['ASSETS'];
  // SAFETY: These route tests provide every Env binding their exercised paths read.
  return partialEnv as Env;
}

/** An ASSETS binding that publishes `files` and answers everything else the
 *  way the real single-page-application fallback does. */
function envWithAssets(files: ReadonlyMap<string, PublishedAsset>): Env {
  return testEnv({
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      const file = files.get(pathname);
      if (file) {
        return new Response(file.body, { status: 200, headers: { 'content-type': file.contentType } });
      }
      return new Response(SPA_SHELL, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
}

const PUBLISHED = new Map<string, PublishedAsset>([
  ...CLI_DIST_PATHS.flatMap((path): [string, PublishedAsset][] => [
    [path, { body: `TARBALL-BYTES ${path}`, contentType: 'application/gzip' }],
    [`${path}.sha256`, { body: `deadbeef  ${path.split('/').pop() ?? ''}\n`, contentType: 'text/plain' }],
  ]),
  ['/downloads/kinu-version.json', { body: JSON.stringify(STAMP), contentType: 'application/json' }],
]);

const DOWNLOAD_PATHS = [...PUBLISHED.keys()];

describe('CLI download assets', () => {
  test('serve the published asset with the declared content-type', async () => {
    const env = envWithAssets(PUBLISHED);
    for (const path of DOWNLOAD_PATHS) {
      const response = requiredResponse(await handleCliRequest(new Request(`${ORIGIN}${path}`), env));
      const asset = PUBLISHED.get(path);
      if (!asset) throw new Error(`missing published fixture for ${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(asset.body);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  test('404 instead of letting the SPA shell impersonate a download', async () => {
    const env = envWithAssets(new Map());
    for (const path of DOWNLOAD_PATHS) {
      const response = requiredResponse(await handleCliRequest(new Request(`${ORIGIN}${path}`), env));
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).not.toContain('<!doctype html>');
      expect(body).toContain('Deployment incomplete');
      expect(response.headers.get('content-type')).toStartWith('text/plain');
    }
  });

  test('404 when the asset worker itself errors', async () => {
    const env = testEnv({ async fetch() { return new Response('boom', { status: 500 }); } });
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
    const publishedResponse = requiredResponse(published);
    expect(publishedResponse.status).toBe(200);
    expect(publishedResponse.body).toBeNull();

    const missing = await handleCliRequest(
      new Request(`${ORIGIN}${DOWNLOAD_PATHS[0]}`, { method: 'HEAD' }),
      envWithAssets(new Map()),
    );
    const missingResponse = requiredResponse(missing);
    expect(missingResponse.status).toBe(404);
    expect(missingResponse.body).toBeNull();
  });
});

describe('GET /api/health build stamp', () => {
  test('reports the deployed build and is ok', async () => {
    const response = requiredResponse(await handleHealthRequest(new Request(`${ORIGIN}/api/health`), envWithAssets(PUBLISHED)));
    const body = v.parse(HealthResponseSchema, await response.json());
    expect(body.ok).toBe(true);
    expect(body.build).toEqual(STAMP);
  });

  test('is not ok when the deploy shipped no build stamp', async () => {
    const response = requiredResponse(await handleHealthRequest(
      new Request(`${ORIGIN}/api/health`),
      envWithAssets(new Map()),
    ));
    const body = v.parse(HealthResponseSchema, await response.json());
    expect(body.ok).toBe(false);
    expect(body.build).toBeNull();
  });

  test('rejects a stamp that is not the expected shape', async () => {
    for (const malformed of ['not json at all', '[]', '{"version":"0.1.0"}', '{"version":"","sha":"a","builtAt":"b"}']) {
      const env = envWithAssets(new Map([
        ['/downloads/kinu-version.json', { body: malformed, contentType: 'application/json' }],
      ]));
      const response = requiredResponse(await handleHealthRequest(new Request(`${ORIGIN}/api/health`), env));
      const body = v.parse(HealthResponseSchema, await response.json());
      expect(body.ok).toBe(false);
      expect(body.build).toBeNull();
    }
  });

  test('ignores non-health paths and non-GET methods', async () => {
    const env = envWithAssets(PUBLISHED);
    expect(await handleHealthRequest(new Request(`${ORIGIN}/api/other`), env)).toBeNull();
    expect(await handleHealthRequest(new Request(`${ORIGIN}/api/health`, { method: 'POST' }), env)).toBeNull();
  });

  test('the feature counts are read out of the registries, not declared by hand', async () => {
    const response = requiredResponse(await handleHealthRequest(new Request(`${ORIGIN}/api/health`), envWithAssets(PUBLISHED)));
    const body = v.parse(HealthResponseSchema, await response.json());
    // Compared against the registries themselves: a hand-listed number passes
    // today and lies at the next registry edit, so the endpoint is held to the
    // same source the compiler holds BUILTIN_TOOLS to.
    expect(body.features).toEqual({
      builtinTools: BUILTIN_TOOLS.length,
      swarmPresets: SWARM_PRESETS.length,
      namedSearches: NAMED_SWARM_PRESETS.length,
    });
  });
});
