import { gzipSync } from 'node:zlib';
import { gitRepositoryRoute } from './git-http-fake';

/** One package a hosted `npm install` can fetch: its metadata and its tarball. */
export const REGISTRY_HOST = 'npm-registry.invalid';

export const REGISTRY_PKG = 'host-fixture';

/**
 * A family wide enough to route the resolver off the coordinator.
 *
 * Nimbus resolves a layer of fewer than five packages in the calling object's
 * own loaders and shards a wider one across sibling Durable Objects
 * (`@nimbus-sh/fabric/dist/fanout.js:29`, `IN_DO_THRESHOLD = 5`). Six names
 * therefore make one install prove the sibling leg, which a single-package
 * install never reaches.
 */
export const REGISTRY_FANOUT_PKGS = [
  REGISTRY_PKG, 'host-fixture-b', 'host-fixture-c', 'host-fixture-d', 'host-fixture-e', 'host-fixture-f',
] as const;

export const REGISTRY_VERSION = '1.0.0';

export const REGISTRY_MANIFEST = `{"name":"${REGISTRY_PKG}","version":"${REGISTRY_VERSION}","main":"lib/index.js"}`;

export const REGISTRY_ENTRY = 'module.exports = 1;\n';

/** One USTAR file entry: a 512-byte header plus padded content. */
function tarFile(name: string, data: string): Uint8Array[] {
  const bytes = new TextEncoder().encode(data);
  const header = new Uint8Array(512);

  const octal = (value: number, width: number): string =>
    value.toString(8).padStart(width - 1, '0') + '\0';

  const write = (offset: number, value: string, width: number): void => {
    header.set(new TextEncoder().encode(value).subarray(0, width), offset);
  };

  write(0, name, 100);
  write(100, octal(0o644, 8), 8);
  write(108, octal(0, 8), 8);
  write(116, octal(0, 8), 8);
  write(124, octal(bytes.length, 12), 12);
  write(136, octal(0, 12), 12);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  write(257, 'ustar\0', 6);
  write(263, '00', 2);
  write(148, octal(header.reduce((sum, byte) => sum + byte, 0), 8), 8);
  const padded = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
  padded.set(bytes);

  return [header, padded];
}

// package.json FIRST in the archive, as npm ships it. The streaming writer
// holds the manifest back and lands it last, so a tree without one is a tree
// the next install re-extracts rather than trusts.
const REGISTRY_PACKAGES: Record<string, { manifest: string; tarball: Uint8Array }> =
  Object.fromEntries(REGISTRY_FANOUT_PKGS.map((name) => {
    const manifest = `{"name":"${name}","version":"${REGISTRY_VERSION}","main":"lib/index.js"}`;
    const parts = [
      ...tarFile('package/package.json', manifest),
      ...tarFile('package/lib/index.js', REGISTRY_ENTRY),
      new Uint8Array(1024),
    ];

    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;

    for (const part of parts) { out.set(part, offset); offset += part.length; }

    return [name, { manifest, tarball: new Uint8Array(gzipSync(out)) }];
  }));

/**
 * The only network a hosted `npm install` may reach under test is this
 * registry; every other origin is refused.
 */
export async function registryOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.host !== REGISTRY_HOST) {
    return new Response(`Unmatched test egress is disabled: ${request.url}`, { status: 502 });
  }

  const repository = gitRepositoryRoute(request, url.pathname);

  if (repository !== null) return repository;

  const [name] = url.pathname.replace(/^\//, '').split('/');
  const held = name === undefined ? undefined : REGISTRY_PACKAGES[name];

  if (held === undefined) return new Response('not found', { status: 404 });

  const tarball = `http://${REGISTRY_HOST}/${name}/-/${name}-${REGISTRY_VERSION}.tgz`;
  const manifest = { name, version: REGISTRY_VERSION, main: 'lib/index.js', dist: { tarball } };

  if (url.pathname === `/${name}`) {
    return Response.json({
      name,
      'dist-tags': { latest: REGISTRY_VERSION },
      versions: { [REGISTRY_VERSION]: manifest },
    });
  }

  if (url.pathname === `/${name}/latest` || url.pathname === `/${name}/${REGISTRY_VERSION}`) {
    return Response.json(manifest);
  }

  if (url.pathname === `/${name}/-/${name}-${REGISTRY_VERSION}.tgz`) {
    return new Response(held.tarball, { headers: { 'Content-Type': 'application/octet-stream' } });
  }

  return new Response('not found', { status: 404 });
}
