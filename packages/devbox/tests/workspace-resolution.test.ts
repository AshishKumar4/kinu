// Guards a silent failure: node_modules pointing at another checkout runs green on its source.
// Imported by relative path on purpose; see the guard's own header.
import { test } from 'bun:test';
import { assertWorkspaceResolution } from '../../test-utils/src/workspace-resolution';

test('@kinu.run/* resolves inside this checkout', () => {
  assertWorkspaceResolution(import.meta.dir);
});
