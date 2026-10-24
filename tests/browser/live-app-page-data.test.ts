import { afterAll, beforeAll, expect, test } from 'bun:test';
import { liveRows } from '../../scripts/live-app-rows';

const { observed, verdictOf, boot } = liveRows('live-app-page-data', ['page-data']);

beforeAll(boot);

afterAll(() => {
  if (observed.bootFailure !== null) throw new Error(observed.bootFailure);
});

// 1023-ac, end to end against the real worker: an answer's page keeps notes in workspace.db, typed and in SQL, each
// read back after each write; its block's server answers, and pushes to it.
test("an answer's page keeps its notes, typed and in SQL, and hears its server", () => {
  const { opened, added } = verdictOf(observed.pageData, 'page-data');

  expect(opened).toEqual({ typed: '0', sql: '[{"n":0}]', served: 'HELLO', pinged: '', pushed: '' });
  expect(added).toEqual({ typed: '2', sql: '[{"n":2}]', served: 'HELLO', pinged: 'sent', pushed: '{"n":7}' });
});

// Saved, the page is a slate of the workspace with its server and the same data; its server pushes to an answer's page
// alone, as a slate's own page asks its class.
test('saved, it is a slate with its server and its data, and a reload still knows it was saved', () => {
  const { saved, kept, keptAdded, reloaded, stillSaved } = verdictOf(observed.pageData, 'page-data');

  expect(saved).not.toBe('');
  expect(kept).toEqual({ typed: '2', sql: '[{"n":2}]', served: 'HELLO', pinged: '', pushed: '' });
  expect({ ...keptAdded, pinged: keptAdded.pinged.startsWith('refused: ') }).toEqual({ typed: '4', sql: '[{"n":4}]', served: 'HELLO', pinged: true, pushed: '' });
  expect(reloaded).toEqual({ typed: '4', sql: '[{"n":4}]', served: 'HELLO', pinged: '', pushed: '' });
  expect(stillSaved).toBe(saved);
});
