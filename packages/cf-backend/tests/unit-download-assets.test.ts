/**
 * ASSETS serves `not_found_handling: "single-page-application"`, so an unpublished asset is 200 + the SPA shell;
 * defends fresh installs dying on a checksum of index.html: downloads hard-404, /api/health reports the build stamp.
 */
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { BUILTIN_TOOLS, NAMED_SWARM_PRESETS, SWARM_PRESETS } from '@kinu.run/core';
import { handleCliRequest, type CliRoutesEnv } from '../src/cli/routes';
import { unreachableKv, unreachableNamespace } from './helpers/bindings';
import { handleHealthRequest, type AssetFetcher } from '@kinu.run/core';
import { HealthAnswerSchema } from '@kinu.run/core/deploy';
import { CLI_DIST_PATHS } from '@kinu.run/core';

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

/** A download answers from ASSETS alone; the objects and device-code KV are refusals here. */
function testEnv(ASSETS: AssetFetcher): CliRoutesEnv<string> {
  return {
    ASSETS,
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    AUTH_KV: unreachableKv('AUTH_KV'),
    UserDO: unreachableNamespace('UserDO'),
    OrchestratorAgent: unreachableNamespace('OrchestratorAgent'),
  };
}

/** Answers unpublished paths as the real single-page-application fallback does. */
function envWithAssets(files: ReadonlyMap<string, PublishedAsset>): CliRoutesEnv<string> {
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
  // A self-updating deployment reads these with no session (the tarball comes from R2).
  ['/downloads/release.json', { body: '{"version":"0.2.0+abc"}', contentType: 'application/json' }],
  ['/downloads/kinu-worker-0.2.0+abc.tar.gz.sha256', { body: 'cafebabe  kinu-worker-0.2.0+abc.tar.gz\n', contentType: 'text/plain' }],
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

  // The deploy smoke's proof that its version override reached the staged version.
  test('names the Worker version that answered, in the shape the deploy smoke reads', async () => {
    const env = { ...envWithAssets(PUBLISHED), CF_VERSION_METADATA: { id: 'version-7' } };
    const response = requiredResponse(await handleHealthRequest(new Request(`${ORIGIN}/api/health`), env));

    expect(v.parse(HealthAnswerSchema, await response.json()).versionId).toBe('version-7');
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
    // Held to the registries themselves: a hand-listed number lies at the next registry edit.
    expect(body.features).toEqual({
      builtinTools: BUILTIN_TOOLS.length,
      swarmPresets: SWARM_PRESETS.length,
      namedSearches: NAMED_SWARM_PRESETS.length,
    });
  });
});
