/**
 * Tracing wiring gate. Three invariants in one script, because they are one
 * question — does an instrumented span actually get recorded, and can the
 * recorder hurt us — and splitting them would leave the config half and the
 * runtime half in different places to remember.
 *
 * WHY IT EXISTS. Custom spans are INERT unless something collects them.
 * Measured, real workerd via Miniflare 4.20260601.0, compat 2025-12-01 +
 * nodejs_compat:
 *
 *     no tail consumer   -> {"outer":false,"inner":false}
 *     tail consumer      -> {"outer":true,"inner":true}
 *
 * So a whole tracing investment can be correct in source, wired at every call
 * site, and record nothing. `tsc`, oxlint and every unit test are blind to it
 * simultaneously: they read source, and the fact lives in a config key and a
 * runtime collector.
 *
 * A1 RUNTIME — the shipped `createWorkersTracer` runs under real workerd and
 *   every span it opens must report `isTraced === true` with a sink attached AND
 *   `false` without one. BOTH directions, on purpose: a gate that checks only
 *   the positive direction passes just as happily against a tracer that
 *   hardcodes `true`, and would then be green forever over a tracer that records
 *   nothing. The negative run is the non-vacuity witness — evidence that the
 *   antecedent is reachable and that this gate can tell the difference.
 *
 * A2 CONFIG — traces have a SEPARATE switch from logs, and `observability` is
 *   NOT inherited into named environments. A deployment can therefore enable
 *   traces in production and silently leave them off in the environment used for
 *   testing, which is worse than off everywhere: the preview reports success
 *   while measuring a different system.
 *
 * A3 RE-ENTRANCY — no worker may name itself in `tail_consumers`. Measured
 *   amplification, one inbound request, `tails: [kCurrentWorker]` plus a single
 *   `env.SELF.fetch()` inside `tail()`:
 *
 *     separate bindingless sink    0,  0,  0 tail invocations at 300/1000/3000 ms
 *     self tail                   51, 52, 53
 *
 *   51 within 300 ms of ONE request, still climbing at 3 s, and 51 only because
 *   the probe carried an `if (n > 50) return` breaker. The general form, with
 *   three recorded production instances in this codebase's lineage: AN
 *   OBSERVABILITY MECHANISM THAT RE-ENTERS THE OBSERVED SYSTEM IS A LOAD
 *   GENERATOR. A gate rather than a comment, because the next person to build
 *   tail-based verification will otherwise rediscover it with a hung deploy.
 *
 * NOT ASSERTED HERE, and deliberately absent rather than faked: the span TREE's
 * SHAPE. `tailStream` — the only handler carrying `spanOpen`/`spanClose` — is
 * not dispatched by workerd locally AND not by the deployed Cloudflare runtime
 * (verified deployed 2026-08-17 with a sink exporting only `tailStream`: five
 * throws of `Handler does not export a tail() function.`, once per traced
 * invocation, while the observed worker returned HTTP 200 with isTraced true
 * throughout). The legacy `TraceItem` has no `spans` field. Shape is readable
 * only from Cloudflare's own ingestion, which needs an API token scope this
 * account's wrangler session does not hold — so that assertion is `blocked()`,
 * non-zero by default, in `scripts/tracing-shape-gate.ts`.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, NoOpLog, type WorkerOptions } from 'miniflare';
import * as v from 'valibot';
import { assertMeasured, finding } from './gate-ratchet';
import { parseJsonc } from './jsonc';

const REPO = new URL('..', import.meta.url).pathname;

/** Every wrangler config a deploy can use. Read from disk; the environment list
 *  inside each one is DERIVED, never enumerated here, because an enumerated
 *  environment list is the thing that drifts when someone adds a third. */
const WRANGLER_CONFIGS = ['packages/cf-backend/wrangler.jsonc'] as const;

/** Files that may construct a tracer. The census the config assertion is
 *  conditioned on. If none of them uses the factory, traces being off is not a
 *  defect and the gate says so rather than inventing one.
 *
 *  `actor-agent.ts` and `exploration.ts` are the PRODUCTION call sites. Until
 *  `actor-agent.ts` was listed here this gate's config assertion was vacuous by
 *  its own design: the factory was used only by itself and by this gate's
 *  fixture, so `instrumentedCount` counted two files that ship no span and
 *  `observability.traces` could have been absent from every environment without
 *  a finding. That is the shape the whole gate warns about. Correct, wired,
 *  dead. Reproduced one level up, in the gate. */
const TRACER_SOURCES = [
  'packages/cf-backend/src/obs/cf-tracer.ts',
  'packages/cf-backend/src/actor-agent.ts',
  'packages/cf-backend/src/exploration.ts',
  'packages/cf-backend/tests/fixtures/tracing-gate-worker.ts',
] as const;

const FIXTURE_ENTRY = 'packages/cf-backend/tests/fixtures/tracing-gate-worker.ts';
const TRACER_FACTORY = 'createWorkersTracer';

export interface EnvironmentConfig {
  /** `<config>` for the top level, `<config>#<envName>` for a named one. */
  readonly label: string;
  readonly workerName: string;
  readonly tracesEnabled: boolean;
  readonly tailConsumers: readonly string[];
}

/** Only the keys this gate reads: `v.object` ignores the rest of the config, and
 *  each one is optional BECAUSE absent is the defect the gate reports rather
 *  than a malformed input. Present but wrongly shaped fails the parse instead,
 *  since a config the gate cannot read is not a config the gate may pass. */
const EnvironmentSchema = v.object({
  name: v.optional(v.string()),
  observability: v.optional(v.object({
    traces: v.optional(v.object({ enabled: v.optional(v.boolean()) })),
  })),
  tail_consumers: v.optional(v.array(v.object({ service: v.string() }))),
});

/** Named environments carry the same keys and are deliberately NOT merged with
 *  the top level — see `environmentsOf`. */
const WranglerConfigSchema = v.object({
  ...EnvironmentSchema.entries,
  env: v.optional(v.record(v.string(), EnvironmentSchema)),
});

type WranglerEnvironment = v.InferOutput<typeof EnvironmentSchema>;

/** Top level and named environment build identically: they carry the same two
 *  keys, and the only difference is that the named one does not inherit them. */
function environmentRow(
  label: string,
  workerName: string,
  environment: WranglerEnvironment,
): EnvironmentConfig {
  return {
    label,
    workerName,
    tracesEnabled: environment.observability?.traces?.enabled === true,
    tailConsumers: (environment.tail_consumers ?? []).map((consumer) => consumer.service),
  };
}

/** One row per deployable environment. Named environments are separate rows
 *  BECAUSE wrangler does not inherit `observability` or `tail_consumers` into
 *  them — the two keys this gate is about are exactly the two that do not
 *  propagate, which is why a single top-level check would be a vacuous pass for
 *  every named environment. */
export function environmentsOf(configPath: string): readonly EnvironmentConfig[] {
  const source = readFileSync(join(REPO, configPath), 'utf8');
  const config = parseJsonc(source, WranglerConfigSchema, configPath);
  const topName = config.name ?? basename(dirname(configPath));
  return [
    environmentRow(configPath, topName, config),
    ...Object.entries(config.env ?? {}).map(([envName, env]) => environmentRow(
      `${configPath}#${envName}`,
      env.name ?? `${topName}-${envName}`,
      env,
    )),
  ];
}

/** Derived, not listed: the files that actually construct a tracer. */
export function tracerCallSites(files: readonly string[]): readonly string[] {
  return files.filter((file) => readFileSync(join(REPO, file), 'utf8').includes(`${TRACER_FACTORY}(`));
}

export interface RuntimeObservation {
  readonly name: string;
  readonly isTraced: boolean;
}

export interface SpanObservations {
  readonly withSink: readonly RuntimeObservation[];
  readonly withoutSink: readonly RuntimeObservation[];
}

/** The fixture's response body. A row that is not `{ name, isTraced: boolean }`
 *  fails the parse rather than degrading to `isTraced: false`, which would read
 *  as a genuine observation of an inert span and pass the negative run. */
const FixtureRowsSchema = v.array(v.object({ name: v.string(), isTraced: v.boolean() }));

/**
 * Runs the shipped tracer under real workerd twice — with a bindingless tail
 * sink and without — so the caller asserts the DISCRIMINATION rather than one
 * polarity.
 *
 * Bundled rather than handed to the runtime as TypeScript, because anything
 * crossing an isolate boundary must be tested as the bundle: esbuild's
 * `keepNames` emitting `__name(fn,"fn")` into a serialized function has twice
 * taken out production capabilities where un-bundled parity tests saw nothing.
 */
export async function observeSpans(): Promise<SpanObservations> {
  const bundled = await build({
    entryPoints: [join(REPO, FIXTURE_ENTRY)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    external: ['cloudflare:workers'],
  });
  const script = bundled.outputFiles[0]?.text ?? '';
  if (script.length === 0) {
    throw new Error(`${FIXTURE_ENTRY}: bundled to nothing — the gate would measure an empty worker`);
  }

  // The sink is bindingless BY CONSTRUCTION, which is what makes A3 a property
  // rather than a rule: with no bindings there is nothing a tail handler could
  // call, so it cannot re-enter the worker it observes.
  const sinkScript = 'export default { tail() {} };';

  // miniflare 5: a worker is `{ config }` with compat + modules per worker
  // (`manifest`), and a tail attachment is `tailConsumers: [{ worker }]`
  // (`workerName` until miniflare 5.20260903).
  const worker = (name: string, code: string, tailConsumers?: { worker: string }[]): WorkerOptions => {
    const options: WorkerOptions = {
      config: {
        name,
        type: 'worker',
        compatibilityDate: '2025-12-01',
        compatibilityFlags: ['nodejs_compat'],
        manifest: {
          mainModule: 'index.mjs',
          modulesRoot: '/',
          modules: { 'index.mjs': { type: 'esm', contents: code } },
        },
      },
    };
    if (tailConsumers) options.config.tailConsumers = tailConsumers;
    return options;
  };
  const run = async (attachSink: boolean): Promise<readonly RuntimeObservation[]> => {
    const workers: WorkerOptions[] = attachSink
      ? [worker('traced', script, [{ worker: 'sink' }]), worker('sink', sinkScript)]
      : [worker('traced', script)];
    const mf = new Miniflare({
      log: new NoOpLog(),
      workers,
    });
    try {
      const response = await mf.dispatchFetch('https://tracing-gate.example/');
      if (!response.ok) throw new Error(`tracing fixture answered HTTP ${String(response.status)}`);
      const body: unknown = await response.json();
      const rows = v.safeParse(FixtureRowsSchema, body);
      if (!rows.success) {
        throw new Error(
          `${FIXTURE_ENTRY}: response is not [{ name, isTraced }] rows — ${v.summarize(rows.issues)}`,
        );
      }
      return rows.output;
    } finally {
      await mf.dispose();
    }
  };

  return { withSink: await run(true), withoutSink: await run(false) };
}

/** Pure: the findings implied by a census and a pair of observation sets. Split
 *  out so the self-test drives every branch without booting workerd four times. */
export function auditTracing(
  environments: readonly EnvironmentConfig[],
  instrumentedCount: number,
  observations: SpanObservations,
): readonly string[] {
  const findings: string[] = [];
  for (const env of environments) {
    if (instrumentedCount > 0 && !env.tracesEnabled) {
      findings.push(finding({
        invariant: 'observability.traces.enabled === true in every deployable environment',
        at: env.label,
        found: 'traces absent or not enabled, while the tracer factory is used in src',
        silently: 'every custom span is created, reports isTraced false and is never recorded — '
          + 'the worker returns 200 and nothing anywhere says the trace was dropped',
        fix: 'add "traces": { "enabled": true, "head_sampling_rate": 1 } to THIS environment\'s '
          + '"observability" block; wrangler does not inherit it from the top level',
      }));
    }
    for (const consumer of env.tailConsumers) {
      if (consumer === env.workerName) {
        findings.push(finding({
          invariant: 'no worker names itself in tail_consumers',
          at: `${env.label} tail_consumers`,
          found: `names its own worker ${JSON.stringify(consumer)}`,
          silently: 'each traced invocation emits a trace event that re-invokes the tail handler; '
            + 'measured at 51 self-invocations within 300 ms of ONE request, still climbing at 3 s, '
            + 'bounded only by a breaker inside the probe',
          fix: 'point tail_consumers at a SEPARATE worker with no bindings, so re-entry cannot happen',
        }));
      }
    }
  }
  for (const span of observations.withSink) {
    if (!span.isTraced) {
      findings.push(finding({
        invariant: 'every span the shipped tracer opens reports isTraced true with a sink attached',
        at: `${FIXTURE_ENTRY} span ${JSON.stringify(span.name)}`,
        found: 'isTraced false with a tail consumer attached',
        silently: 'the span exists in source and at the call site and records nothing; no test, '
          + 'typecheck or lint can see the difference',
        fix: 'check the tracer reaches tracing.enterSpan imported from cloudflare:workers — '
          + 'ctx.tracing is undefined and only the module import works',
      }));
    }
  }
  for (const span of observations.withoutSink) {
    if (span.isTraced) {
      findings.push(finding({
        invariant: 'a span reports isTraced FALSE when nothing is collecting',
        at: `${FIXTURE_ENTRY} span ${JSON.stringify(span.name)}`,
        found: 'isTraced true with no trace consumer attached',
        silently: 'this gate loses its discriminating power and would stay green against a tracer '
          + 'that hardcodes isTraced — i.e. green over a tracer that records nothing',
        fix: 'the fixture is not reading the native span\'s isTraced; make it read the real one',
      }));
    }
  }
  return findings;
}

async function main(): Promise<number> {
  const gate = 'tracing';
  const environments = WRANGLER_CONFIGS.flatMap((config) => environmentsOf(config));
  const instrumented = tracerCallSites(TRACER_SOURCES);
  const observations = await observeSpans();
  const findings = auditTracing(environments, instrumented.length, observations);

  const measured = assertMeasured(gate, [
    ['deployable environments parsed', environments.length],
    ['tracer call sites', instrumented.length],
    ['spans recorded with a sink', observations.withSink.filter((s) => s.isTraced).length],
    ['spans inert without a sink', observations.withoutSink.filter((s) => !s.isTraced).length],
  ]);

  if (findings.length > 0) {
    console.error(`${gate}: ${String(findings.length)} violation(s)\n`);
    for (const entry of findings) console.error(entry);
    console.error(`\n${gate}: measured ${measured}`);
    return 1;
  }
  console.log(`${gate}: ok — ${measured}`);
  console.log('  blind: the span tree shape. tailStream is not dispatched locally or on the deployed runtime, so shape is readable only from Cloudflare ingestion');
  console.log('  blind: the file list is hand kept. A new production call site outside TRACER_SOURCES is uncounted until the list gains it');
  return 0;
}

if (import.meta.main) process.exit(await main());
