// Silent failure: node_modules pointing at another checkout runs green against its source. Relative import on
// purpose (see the guard's header).
import { test } from 'bun:test';
import { assertWorkspaceResolution } from '../../test-utils/src/workspace-resolution';

test('@kinu.run/* resolves inside this checkout', () => {
  assertWorkspaceResolution(import.meta.dir);
});
