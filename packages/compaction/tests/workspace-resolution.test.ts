// Catches a node_modules pointing at another checkout, which otherwise runs green against the wrong source.
import { test } from 'bun:test';
import { assertWorkspaceResolution } from '../../test-utils/src/workspace-resolution';

test('@kinu.run/* resolves inside this checkout', () => {
  assertWorkspaceResolution(import.meta.dir);
});
