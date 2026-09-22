// A checkout whose node_modules points at another tree runs green on the wrong source. Relative import on purpose.
import { test } from 'bun:test';
import { assertWorkspaceResolution } from '../../test-utils/src/workspace-resolution';

test('@kinu.run/* resolves inside this checkout', () => {
  assertWorkspaceResolution(import.meta.dir);
});
