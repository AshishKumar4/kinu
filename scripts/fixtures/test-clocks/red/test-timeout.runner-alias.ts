// A first-run case registered through a name bound to the runner, handed twelve minutes.
import { test } from 'vitest';

const PLAN = process.env.KINU_EVAL_ORIGIN;

const liveTest = test.skipIf(PLAN === undefined);

const measured = liveTest;

measured('MEASURED: a case', { timeout: 12 * 60_000 }, async () => { await Promise.resolve(); });
