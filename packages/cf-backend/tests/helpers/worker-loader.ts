/**
 * The Worker Loader binding (`env.LOADER`) for bun-run suites: a loaded worker's code, run in this
 * process. It keeps the loader's contract (modules in, the default entrypoint's methods out) and none
 * of its isolate: a loaded worker shares this process's network and timers, so egress, limits and
 * isolation belong to the workerd tier (tests/workerd).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import type { JsonObject } from '@kinu.run/core';
import { scratchDir } from '@kinu.run/test-utils';

const ModuleSourceSchema = v.union([
  v.string(),
  v.pipe(v.object({ js: v.string() }), v.transform((module) => module.js)),
  v.pipe(v.object({ esModule: v.string() }), v.transform((module) => module.esModule)),
]);

const WorkerCodeSchema = v.looseObject({
  mainModule: v.string(),
  modules: v.record(v.string(), ModuleSourceSchema),
});

/** What workerd hands an entrypoint it constructs: the props its binding was given. */
interface EntrypointContext {
  readonly props: JsonObject;
}

/** A loaded worker's default export: the entrypoint class workerd constructs with `(ctx, env)`. */
const EntrypointModuleSchema = v.object({
  default: v.custom<new (ctx: EntrypointContext, env: WorkerLoaderWorkerCode['env']) => object>(
    (value) => v.is(v.function(), value) && v.is(v.looseObject({}), value.prototype),
    'the worker module exports no entrypoint class',
  ),
});

/** A constructed entrypoint; its methods live on its class. */
type Entrypoint = InstanceType<v.InferOutput<typeof EntrypointModuleSchema>['default']>;

/** The timer a loaded worker's global scope arms: a test's own, to move a worker's time without waiting. */
export interface WorkerTimers {
  readonly setTimeout: (run: () => void, ms: number) => void;
}

/** Each loader's timers, where the worker scope below reads them. */
const TIMERS = Symbol.for('kinu.test.worker-timers');

const timersByLoader = new Map<string, WorkerTimers>();

Object.assign(globalThis, { [TIMERS]: timersByLoader });

/**
 * What a worker's own global scope holds that it may reassign: the executor module rebinds
 * `console.*` to collect its logs, and its race timer must not hold this process open. With
 * `timers`, the scope arms those instead.
 */
function workerScope(timers: WorkerTimers | undefined): string {
  const console = 'const console = Object.create(globalThis.console);\n';

  if (timers === undefined) {
    return `${console}const setTimeout = (run, ms) => { const timer = globalThis.setTimeout(run, ms); timer.unref?.(); return timer; };\n`;
  }

  const id = crypto.randomUUID();

  timersByLoader.set(id, timers);

  return `${console}const { setTimeout } = globalThis[Symbol.for('kinu.test.worker-timers')].get(${JSON.stringify(id)});\n`;
}

/** One loaded worker: its modules written where an import reads them, its entrypoint constructed. */
async function instantiate(code: WorkerLoaderWorkerCode, timers: WorkerTimers | undefined): Promise<Entrypoint> {
  const worker = v.parse(WorkerCodeSchema, code);
  const dir = scratchDir('worker-loader');

  for (const [name, source] of Object.entries(worker.modules)) {
    writeFileSync(join(dir, name), name.endsWith('.js') ? `${workerScope(timers)}${source}` : source);
  }

  // The module path exists only once the worker is loaded, so no static import can name it.
  const { default: Loaded } = v.parse(EntrypointModuleSchema, await import(join(dir, worker.mainModule)));

  return new Loaded({ props: {} }, code.env ?? {});
}

/** The method `name` the entrypoint's class declares, bound to the entrypoint. */
function methodOf(entrypoint: Entrypoint, name: string) {
  for (let owner = Object.getPrototypeOf(entrypoint); owner !== null; owner = Object.getPrototypeOf(owner)) {
    const method = v.safeParse(v.function(), Object.getOwnPropertyDescriptor(owner, name)?.value);

    if (method.success) return method.output.bind(entrypoint);
  }

  throw new Error(`The loaded worker's entrypoint has no method "${name}".`);
}

/** A worker stub: every string-named call reaches the entrypoint once it is constructed. */
function stubOver(entrypoint: Promise<Entrypoint>) {
  const methods = new Proxy({}, {
    get: (_target, name) => {
      if (!v.is(v.string(), name) || name === 'then') return undefined;

      return async (...args: never[]) => methodOf(await entrypoint, name)(...args);
    },
  });

  return { getEntrypoint: () => methods };
}

/** `env.LOADER`, with the two ways a binding hands out a worker; its workers arm `timers` when given. */
export function inProcessWorkerLoader(timers?: WorkerTimers) {
  return {
    get: (_id: string | null, getCode: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>) =>
      stubOver(Promise.resolve().then(getCode).then((code) => instantiate(code, timers))),
    load: (code: WorkerLoaderWorkerCode) => stubOver(instantiate(code, timers)),
  };
}
