// The failure is silent: a node_modules pointing at another checkout runs green against that tree's source.
// Imported by relative path on purpose; see the guard's header.
import { test } from 'bun:test';
import { assertWorkspaceResolution } from '../../test-utils/src/workspace-resolution';

test('@kinu.run/* resolves inside this checkout', () => {
  assertWorkspaceResolution(import.meta.dir);
});
