/**
 * One repository over git's smart HTTP protocol: a hosted `git clone` is always a network clone.
 * isomorphic-git demuxes upload-pack as side-band frames whatever it negotiated, so `side-band-64k`.
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const GIT_REPO_PATH = '/fixture-repo.git';

export const GIT_FILE = 'README.md';

export const GIT_FILE_CONTENT = 'fixture content\n';

export const GIT_COMMIT_MESSAGE = 'fixture commit';

export const GIT_BRANCH = 'main';

interface GitObject {
  readonly kind: 'blob' | 'tree' | 'commit';
  readonly body: Uint8Array;
  readonly oid: string;
}

const encoder = new TextEncoder();

function object(kind: GitObject['kind'], body: Uint8Array): GitObject {
  const header = encoder.encode(`${kind} ${String(body.length)}\0`);
  const framed = new Uint8Array(header.length + body.length);

  framed.set(header);
  framed.set(body, header.length);

  return { kind, body, oid: createHash('sha1').update(framed).digest('hex') };
}

/** The repository: a blob, the tree naming it, and the root commit. */
const REPO = (() => {
  const blob = object('blob', encoder.encode(GIT_FILE_CONTENT));
  const entry = encoder.encode(`100644 ${GIT_FILE}\0`);
  const treeBody = new Uint8Array(entry.length + 20);

  treeBody.set(entry);
  treeBody.set(Uint8Array.from(Buffer.from(blob.oid, 'hex')), entry.length);
  const tree = object('tree', treeBody);

  // Fixed instant, so the commit id is stable across runs.
  const stamp = '1758412800 +0000';

  const commit = object('commit', encoder.encode([
    `tree ${tree.oid}`,
    `author Fixture <fixture@nimbus.invalid> ${stamp}`,
    `committer Fixture <fixture@nimbus.invalid> ${stamp}`,
    '',
    `${GIT_COMMIT_MESSAGE}\n`,
  ].join('\n')));

  return { blob, tree, commit };
})();

export const GIT_COMMIT_OID = REPO.commit.oid;

function pkt(bytes: Uint8Array): Uint8Array {
  const length = encoder.encode((bytes.length + 4).toString(16).padStart(4, '0'));
  const out = new Uint8Array(length.length + bytes.length);

  out.set(length);
  out.set(bytes, length.length);

  return out;
}

const FLUSH = encoder.encode('0000');

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;

  for (const part of parts) { out.set(part, offset); offset += part.length; }

  return out;
}

const PACKFILE = (() => {
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);

  header.set(encoder.encode('PACK'));
  view.setUint32(4, 2);
  view.setUint32(8, 3);
  const typeOf: Record<GitObject['kind'], number> = { commit: 1, tree: 2, blob: 3 };
  const entries: Uint8Array[] = [];

  for (const held of [REPO.commit, REPO.tree, REPO.blob]) {
    // Type and low four size bits in the first byte, then seven size bits per byte, little end first.
    const bytes: number[] = [];
    let size = held.body.length;
    let first = (typeOf[held.kind] << 4) | (size & 0x0f);

    size >>= 4;

    while (size > 0) {
      bytes.push(first | 0x80);
      first = size & 0x7f;
      size >>= 7;
    }

    bytes.push(first);
    entries.push(Uint8Array.from(bytes), new Uint8Array(deflateSync(held.body)));
  }

  const body = concat([header, ...entries]);
  const digest = Uint8Array.from(createHash('sha1').update(body).digest());

  return concat([body, digest]);
})();

/** NAK, then the pack in side-band channel 1, in frames a pkt-line length can carry. */
const UPLOAD_PACK = (() => {
  const frames: Uint8Array[] = [pkt(encoder.encode('NAK\n'))];
  const band = 65_515;

  for (let offset = 0; offset < PACKFILE.length; offset += band) {
    const chunk = PACKFILE.subarray(offset, offset + band);
    const framed = new Uint8Array(chunk.length + 1);

    framed[0] = 1;
    framed.set(chunk, 1);
    frames.push(pkt(framed));
  }

  frames.push(FLUSH);

  return concat(frames);
})();

const ADVERTISEMENT = concat([
  pkt(encoder.encode('# service=git-upload-pack\n')),
  FLUSH,
  pkt(encoder.encode(`${GIT_COMMIT_OID} HEAD\0side-band-64k shallow symref=HEAD:refs/heads/${GIT_BRANCH} agent=nimbus-fixture\n`)),
  pkt(encoder.encode(`${GIT_COMMIT_OID} refs/heads/${GIT_BRANCH}\n`)),
  FLUSH,
]);

/** Null for other paths: the npm registry fixture shares this origin. */
export function gitRepositoryRoute(request: Request, pathname: string): Response | null {
  if (pathname === `${GIT_REPO_PATH}/info/refs`) {
    return new Response(ADVERTISEMENT, {
      headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
    });
  }

  if (pathname === `${GIT_REPO_PATH}/git-upload-pack` && request.method === 'POST') {
    return new Response(UPLOAD_PACK, {
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
    });
  }

  return null;
}
