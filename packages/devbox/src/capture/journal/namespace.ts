import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import * as v from 'valibot';
import { sha256Hex } from '../../cas/hash';
import { MerklePackError } from '../../candidates/merkle-pack/errors';
import { BeneathRoot } from '../../native-openat2';
import type { JournalFence } from './client';

const Decimal = v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d*)$/u));
const Digest = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));
const Page = v.strictObject({
  number: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(0xffff_ffff)),
  offset: Decimal,
  sha256: Digest,
});
const NamespaceManifestSchema = v.pipe(v.strictObject({
  format: v.literal('sqlite-inodes/v2'),
  cut: Decimal,
  generation: Decimal,
  revision: Decimal,
  pageBytes: v.literal(4096),
  byteLength: Decimal,
  file: v.string(),
  pages: v.array(Page),
}), v.check((value) => {
  const length = Number(value.byteLength);
  if (!Number.isSafeInteger(length) || length <= 0 || length % value.pageBytes !== 0) return false;
  return value.pages.every((page, at) => page.number <= length / value.pageBytes
    && page.offset === String(at * value.pageBytes)
    && (at === 0 || value.pages[at - 1].number < page.number));
}, 'Namespace pages must be ordered, unique and within their declared image'));

type NamespaceManifest = v.InferOutput<typeof NamespaceManifestSchema>;
export interface NamespaceDelta {
  readonly manifest: NamespaceManifest;
  readonly manifestSha256: string;
  readPage(number: number): Uint8Array;
  close(): void;
}

/** The namespace and data manifests must name the same native fence. */
export async function readNamespaceDelta(fence: JournalFence): Promise<NamespaceDelta> {
  const bytes = await readFile(`${fence.manifestPath}.namespace`);
  const manifest = v.parse(NamespaceManifestSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (manifest.cut !== String(fence.cut) || manifest.generation !== String(fence.generation)) {
    throw new MerklePackError('invalid-parameter', 'namespace snapshot belongs to another fence');
  }
  const directory = dirname(resolve(fence.manifestPath));
  const file = resolve(manifest.file);
  const name = basename(file);
  if (dirname(file) !== directory || !name.startsWith(`namespace-c${manifest.cut}-g${manifest.generation}-`)) {
    throw new MerklePackError('hostile-path', 'namespace frames are outside their fence directory');
  }
  const root = new BeneathRoot(directory);
  const pages = new Map(manifest.pages.map((page) => [page.number, page]));
  return {
    manifest,
    manifestSha256: sha256Hex(bytes),
    readPage(number) {
      const page = pages.get(number);
      if (page === undefined) throw new MerklePackError('invalid-range', `namespace delta has no page ${number}`);
      const contents = root.readRange(name, Number(page.offset), manifest.pageBytes);
      if (contents.byteLength !== manifest.pageBytes || sha256Hex(contents) !== page.sha256) {
        throw new MerklePackError('chunk-digest-mismatch', `namespace page ${number} changed after its fence`);
      }
      return contents;
    },
    close() { root.close(); },
  };
}
