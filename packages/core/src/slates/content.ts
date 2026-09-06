import { AgentCoreError, ContentRef, Digest } from '@agent-core/core';
import { ByteRange, ContentStat, ContentStore, MediaHint, type ContentPutResult } from '@agent-core/core/content';
import { CHUNK_SIZE } from '@nimbus-sh/core/constants.js';
import * as v from 'valibot';
import type { SqlExec } from '../types/primitives';

const Metadata = v.object({ size: v.number(), hint: v.nullable(v.string()) });
const Chunk = v.object({ bytes: v.instance(ArrayBuffer) });

export class SqliteSlateContentStore extends ContentStore {
  constructor(private readonly db: SqlExec, private readonly atomic: <Result>(operation: () => Result) => Result) {
    super();
  }

  async put(bytes: Uint8Array, hint?: MediaHint): Promise<ContentPutResult> {
    return this.retain(bytes, hint);
  }

  retain(bytes: Uint8Array, hint?: MediaHint): ContentPutResult {
    const digest = Digest.sha256(bytes);
    const ref = ContentRef.fromDigest(digest);
    this.atomic(() => {
      if (this.describe(ref) !== undefined) return;
      this.db.exec('INSERT INTO slate_content (digest, size, hint) VALUES (?, ?, ?)', ref.value, bytes.length, hint?.mediaType ?? null);
      for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
        this.db.exec('INSERT INTO slate_content_chunks (digest, offset, bytes) VALUES (?, ?, ?)',
          ref.value, offset, bytes.slice(offset, offset + CHUNK_SIZE).buffer);
      }
    });
    return { digest, ref };
  }

  async get(ref: ContentRef, range = ByteRange.all()): Promise<Uint8Array> {
    return this.read(ref, range);
  }

  read(ref: ContentRef, range = ByteRange.all()): Uint8Array {
    const stat = this.describe(ref);
    if (stat === undefined) throw new AgentCoreError('content.not-found', `Slate content not found: ${ref.value}`);
    const window = range.resolve(stat.size);
    const output = new Uint8Array(window.length);
    const end = window.offset + window.length;
    for (let offset = Math.floor(window.offset / CHUNK_SIZE) * CHUNK_SIZE; offset < end; offset += CHUNK_SIZE) {
      const row = this.db.exec('SELECT bytes FROM slate_content_chunks WHERE digest = ? AND offset = ?', ref.value, offset).toArray()[0];
      if (row === undefined) throw new AgentCoreError('content.not-found', `Slate content chunk not found: ${ref.value}@${String(offset)}`);
      const bytes = new Uint8Array(v.parse(Chunk, row).bytes);
      if (bytes.length !== Math.min(CHUNK_SIZE, stat.size - offset)) throw new AgentCoreError('codec.invalid', 'Slate content chunk size differs from its record');
      const start = Math.max(offset, window.offset);
      output.set(bytes.subarray(start - offset, Math.min(bytes.length, end - offset)), start - window.offset);
    }
    return output;
  }

  async stat(ref: ContentRef): Promise<ContentStat | undefined> {
    return this.describe(ref);
  }

  private describe(ref: ContentRef): ContentStat | undefined {
    const row = this.db.exec('SELECT size, hint FROM slate_content WHERE digest = ?', ref.value).toArray()[0];
    if (row === undefined) return undefined;
    const record = v.parse(Metadata, row);
    return new ContentStat(ref, ref.digest, record.size, record.hint === null ? undefined : new MediaHint(record.hint));
  }
}
