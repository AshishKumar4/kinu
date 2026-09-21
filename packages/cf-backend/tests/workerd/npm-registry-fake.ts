import { gzipSync } from 'node:zlib';

/** One package a hosted `npm install` can fetch: its metadata and its tarball. */
export const REGISTRY_HOST = 'npm-registry.invalid';

export const REGISTRY_PKG = 'host-fixture';

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
const REGISTRY_TARBALL = (() => {
  const parts = [
    ...tarFile('package/package.json', REGISTRY_MANIFEST),
    ...tarFile('package/lib/index.js', REGISTRY_ENTRY),
    new Uint8Array(1024),
  ];

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) { out.set(part, offset); offset += part.length; }

  return new Uint8Array(gzipSync(out));
})();

/**
 * The only network a hosted `npm install` may reach under test is this
 * registry; every other origin is refused.
 */
export async function registryOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.host !== REGISTRY_HOST) {
    return new Response(`Unmatched test egress is disabled: ${request.url}`, { status: 502 });
  }

  const tarball = `http://${REGISTRY_HOST}/${REGISTRY_PKG}/-/${REGISTRY_PKG}-${REGISTRY_VERSION}.tgz`;
  const manifest = { name: REGISTRY_PKG, version: REGISTRY_VERSION, main: 'lib/index.js', dist: { tarball } };

  if (url.pathname === `/${REGISTRY_PKG}`) {
    return Response.json({
      name: REGISTRY_PKG,
      'dist-tags': { latest: REGISTRY_VERSION },
      versions: { [REGISTRY_VERSION]: manifest },
    });
  }

  if (url.pathname === `/${REGISTRY_PKG}/latest` || url.pathname === `/${REGISTRY_PKG}/${REGISTRY_VERSION}`) {
    return Response.json(manifest);
  }

  if (url.pathname === `/${REGISTRY_PKG}/-/${REGISTRY_PKG}-${REGISTRY_VERSION}.tgz`) {
    return new Response(REGISTRY_TARBALL, { headers: { 'Content-Type': 'application/octet-stream' } });
  }

  return new Response('not found', { status: 404 });
}
