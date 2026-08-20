// Every package's suite asserts it, because the failure it catches is silent:
// a checkout whose node_modules points at another one runs green while testing
// the other tree's source. Imported by relative path on purpose — see the
// guard's own header.
import { test } from 'bun:test';
import { assertWorkspaceResolution } from '../../test-utils/src/workspace-resolution';

test('@kinu/* resolves inside this checkout', () => {
  assertWorkspaceResolution(import.meta.dir);
});
