// An editor names a shared slate's files as plain relative paths inside it, never its dependencies or history; reading
// them runs in Plan, and changing them does not.
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { requireSlateWorkMode, SlateFileChangeSchema, SlateOperationSchema, type SlateOperation } from '../src/slates/rpc';
import { KinuError } from '../src/obs';
import type { WorkMode } from '../src/types/turn';
import { parseSlateProject } from '../src/slates/project';

test('a change names files inside the slate: no climbing out, no absolute path, no dependencies, no history', () => {
  expect(v.is(SlateFileChangeSchema, { 'server.ts': 'x', 'src/board.ts': 'y', '.env.example': 'z', 'old.ts': null })).toBe(true);

  for (const path of ['../other/server.ts', '/slates/other/server.ts', 'src/../../x', './server.ts', 'node_modules/x/index.js', '.git/config', 'a//b', '']) {
    expect(v.is(SlateFileChangeSchema, { [path]: 'x' })).toBe(false);
  }

  expect(v.is(SlateFileChangeSchema, {})).toBe(false);
});

/** What the work-mode gate says of an operation in a mode: nothing when it may run, its refusal when not. */
function gate(operation: SlateOperation, mode: WorkMode): string | null {
  try {
    requireSlateWorkMode(operation, mode);

    return null;
  } catch (error) {
    return error instanceof KinuError ? `${error.code}: ${error.message}` : String(error);
  }
}

test('reading a shared slate runs in Plan; changing it does not', () => {
  const read = v.parse(SlateOperationSchema, { op: 'sharedFiles', workspace: 'sam', slate: 'board' });
  const edit = v.parse(SlateOperationSchema, { op: 'sharedEdit', workspace: 'sam', slate: 'board', files: { 'server.ts': 'x' } });

  expect([gate(read, 'plan'), gate(edit, 'plan'), gate(edit, 'build')])
    .toEqual([null, 'denied: workspace.slates.$sharedEdit has no Plan-safe execution capability', null]);
});

test('a slate declares each function\'s input contract in its package.json, as a codec', () => {
  const project = parseSlateProject({ main: 'server.ts', slate: { title: 'Board', functions: { deploy: { input: { kind: 'integer', min: 1, max: 52 } } } } });

  expect(project.slate.functions).toEqual({ deploy: { input: { kind: 'integer', min: 1, max: 52 } } });
  expect(() => parseSlateProject({ main: 'server.ts', slate: { functions: { deploy: { input: { kind: 'anything' } } } } })).toThrow();
});
