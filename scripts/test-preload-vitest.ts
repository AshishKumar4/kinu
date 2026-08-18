// The behavioural eval tier's entry, named by `vitest.evals.config.ts`'s
// `setupFiles`.
//
// The twin of `./test-preload.ts`, and it exists because `afterAll` is a
// different function in each runner: `bun:test`'s throws `Cannot use afterAll()
// outside of the test runner` when vitest is the one running, which failed the
// eval tier at collection — no tests, one failed suite — and blocked a deploy.
// Everything real is shared through `./test-scratch-home.ts`; the only thing
// that differs between the two runners is this import.
import { afterAll } from 'vitest';

import { release } from './test-scratch-home.ts';

afterAll(release);
