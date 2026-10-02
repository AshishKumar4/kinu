import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Vitest cannot infer SELF's Worker inputs through its virtual module. The changed-test ladder
 * supplies its existing input closure; the native trigger reruns the pool when those inputs move. */
export function workerSourceTriggers(): string[] | undefined {
  const inputs = process.env.KINU_WORKER_SOURCE_INPUTS;

  if (inputs === undefined) return undefined;

  return v.parse(v.array(v.string()), JSON.parse(inputs)).map((file) => resolve(root, file));
}
