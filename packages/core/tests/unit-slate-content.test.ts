import { expect, test } from 'bun:test';
import { ByteRange } from '@agent-core/core/content';
import { CHUNK_SIZE } from '@nimbus-sh/core/constants.js';
import { SqliteSlateContentStore } from '../src/slates/content';
import { createTestWorkspace, makeSqlExec } from './helpers';

test('Slate content retains exact bytes across SQLite chunks and reopens', async () => {
  const ws = createTestWorkspace();
  try {
    const content = new SqliteSlateContentStore(makeSqlExec(ws.db), (body) => ws.db.transaction(body)());
    const bytes = Uint8Array.from({ length: CHUNK_SIZE + 7 }, (_, index) => index % 251);
    const stored = await content.put(bytes);
    bytes.fill(0);
    const reopened = new SqliteSlateContentStore(makeSqlExec(ws.db), (body) => ws.db.transaction(body)());
    const expected = Uint8Array.from({ length: CHUNK_SIZE + 7 }, (_, index) => index % 251);
    expect(await reopened.get(stored.ref)).toEqual(expected);
    expect(await reopened.get(stored.ref, ByteRange.slice(CHUNK_SIZE - 3, 8))).toEqual(expected.slice(CHUNK_SIZE - 3, CHUNK_SIZE + 5));
    expect((await reopened.put(expected)).ref.value).toBe(stored.ref.value);
    expect((await reopened.stat(stored.ref))?.size).toBe(expected.length);
    await expect(reopened.get(stored.ref, ByteRange.slice(expected.length, 1))).rejects.toThrow();
  } finally {
    ws.db.close();
  }
});
