// The vitest suites' entry, named by the `setupFiles` of `evals/vitest.config.ts`
// and `vitest.first-run.config.ts`.
//
// The twin of `./test-preload.ts`, and it exists because `afterAll` is a
// different function in each runner: `bun:test`'s throws `Cannot use afterAll()
// outside of the test runner` when vitest is the one running, which once failed a
// vitest tier at collection — no tests, one failed suite — and blocked a deploy.
// Everything real is shared through `./test-scratch-home.ts`; the only thing
// that differs between the two runners is this import.
import { afterAll } from 'vitest';

import { release } from './test-scratch-home';

afterAll(release);
