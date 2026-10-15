// An editor names a shared slate's files as plain relative paths inside it, never its dependencies or history; reading
// them runs in Plan, and changing them does not.
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { requireSlateWorkMode, SlateFileChangeSchema, SlateOperationSchema } from '../src/slates/rpc';

test('a change names files inside the slate: no climbing out, no absolute path, no dependencies, no history', () => {
  expect(v.is(SlateFileChangeSchema, { 'server.ts': 'x', 'src/board.ts': 'y', '.env.example': 'z', 'old.ts': null })).toBe(true);

  for (const path of ['../other/server.ts', '/slates/other/server.ts', 'src/../../x', './server.ts', 'node_modules/x/index.js', '.git/config', 'a//b', '']) {
    expect(v.is(SlateFileChangeSchema, { [path]: 'x' })).toBe(false);
  }

  expect(v.is(SlateFileChangeSchema, {})).toBe(false);
});

test('reading a shared slate runs in Plan; changing it does not', () => {
  const read = v.parse(SlateOperationSchema, { op: 'sharedFiles', workspace: 'sam', slate: 'board' });
  const edit = v.parse(SlateOperationSchema, { op: 'sharedEdit', workspace: 'sam', slate: 'board', files: { 'server.ts': 'x' } });

  expect(() => { requireSlateWorkMode(read, 'plan'); }).not.toThrow();
  expect(() => { requireSlateWorkMode(edit, 'plan'); }).toThrow();
  expect(() => { requireSlateWorkMode(edit, 'build'); }).not.toThrow();
});
