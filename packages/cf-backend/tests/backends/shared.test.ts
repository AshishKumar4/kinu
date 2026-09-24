/**
 * One suite, the backend as configuration: every shared case runs against each backend
 * `KINU_TEST_BACKEND` selects (both when unset). `bun test --timeout=0 ./tests/backends/` is the command.
 */
import { describe, test } from 'bun:test';
import { openBackend, testBackends } from './backend';
import { SHARED_CASES } from './cases';

for (const name of testBackends()) {
  describe(`${name} backend`, () => {
    for (const shared of SHARED_CASES) {
      test(shared.title, () => shared.run(openBackend(name)));
    }
  });
}
