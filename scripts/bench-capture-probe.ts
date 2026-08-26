#!/usr/bin/env bun
/**
 * CaptureSound probe driver.
 *
 * DEFAULT MODE IS AUTONOMOUS. With no flags the driver raises an EPHEMERAL
 * deployed fixture — a unique Worker plus one cloudflare/sandbox:0.12.8
 * container under a per-run bearer token — runs
 * scripts/fixtures/capture-probe/probe.ts INSIDE that real container, parses
 * its capability report, decides, then destroys everything it created and
 * proves the teardown idempotent. No operator command is part of the
 * acceptance path. Cleanup is not optional: any cleanup failure in either
 * teardown pass exits nonzero even when the measurement succeeded, because an
 * account that is not provably clean is a failed run.
 *
 *   bun scripts/bench-capture-probe.ts
 *     The full autonomous live run described above.
 *
 *   bun scripts/bench-capture-probe.ts --plan
 *     Diagnostic only: print which capabilities gate which mechanism. Takes
 *     no resources and touches nothing.
 *
 *   bun scripts/bench-capture-probe.ts --report report.json
 *     Diagnostic only: decide from a saved probe report. Provisions nothing.
 *
 * Exit codes for every mode: 0 capable or plan, 2 typed no-go, 1 unusable run
 * (deployment failure, schema violation, CLEANUP FAILURE).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as v from 'valibot';

import {
  CAPTURE_CAPABILITIES,
  CaptureCapabilityReportSchema,
  decideCaptureMechanism,
} from '../packages/devbox/src/capture/index';
import type { CaptureCapabilityReport } from '../packages/devbox/src/capture/index';
import {
  LiveProbeError,
  lastNonEmptyLine,
  parseProbeReply,
  runLiveCaptureProbe,
  type ProbeVerdict,
} from './fixtures/capture-probe/live-run';
import { runWrangler } from './fixtures/r2-bench/deploy-substrate';

const EXIT_OK = 0;
const EXIT_INPUT = 1;
const EXIT_NO_GO = 2;
const REPO_ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const FIXTURE_DIR = join(REPO_ROOT, 'scripts', 'fixtures', 'capture-probe');
const WORKER_ENTRY = join(FIXTURE_DIR, 'worker.ts');
const PROBE_SOURCE = join(FIXTURE_DIR, 'probe.ts');

/** Which capability gates which mechanism, for `--plan`. */
export const MECHANISM_GATES = [
  {
    mechanism: 'freeze-drain',
    cutSemantics: 'freeze-barrier',
    requires: ['pid-namespace', 'process-freeze', 'cgroup-freezer', 'fork-proof-window'],
    degradesWithout: ['syncfs -> per-file fsync caveat'],
  },
  {
    mechanism: 'mutation-journal',
    cutSemantics: 'journal-seq',
    requires: ['(fuse-mount | fanotify-cap-sys-admin)'],
    degradesWithout: [],
  },
] as const;

export function renderPlan(): string {
  const lines = [
    'CaptureSound mechanism gates (all requirements must measure present;',
    'unknown counts as absent):',
    '',
  ];
  for (const gate of MECHANISM_GATES) {
    lines.push(`  ${gate.mechanism} [cut = ${gate.cutSemantics}]`);
    for (const requirement of gate.requires) lines.push(`    requires: ${requirement}`);
    for (const degradation of gate.degradesWithout) lines.push(`    degrades: ${degradation}`);
  }
  lines.push('');
  lines.push(`Measured capability ids: ${CAPTURE_CAPABILITIES.join(', ')}`);
  return lines.join('\n');
}

export function parseReport(raw: string): CaptureCapabilityReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('probe output is not JSON', { cause: error });
  }
  return v.parse(CaptureCapabilityReportSchema, parsed);
}

function decideFromReport(report: CaptureCapabilityReport): ProbeVerdict {
  const decision = decideCaptureMechanism(report);
  console.log(JSON.stringify({ report, decision }, null, 2));
  return { verdict: decision.verdict === 'no-go' ? 'no-go' : 'capable' };
}

/** The one deployment seam: substrate-run wrangler for a generated config. */
export function deployPlan(plan: { configPath: string; token: string }): string {
  return runWrangler(
    REPO_ROOT,
    ['deploy', '--config', plan.configPath, '--var', `CAPTURE_PROBE_TOKEN:${plan.token}`],
  );
}

async function live(): Promise<number> {
  try {
    const result = await runLiveCaptureProbe({
      repoRoot: REPO_ROOT,
      workerEntry: WORKER_ENTRY,
      probeSourcePath: PROBE_SOURCE,
      readProbeSource: () => readFileSync(PROBE_SOURCE, 'utf8'),
      decide: decideFromReport,
      deploy: deployPlan,
      log: (message) => console.error(`[capture-probe] ${message}`),
    });
    if (result.cleanupFailures.length > 0) {
      console.error(`CLEANUP NOT PROVEN: ${result.cleanupFailures.join(' | ')}`);
      return EXIT_INPUT;
    }
    if (result.verdict.verdict === 'invalid') {
      console.error(`invalid deployed probe report: ${result.verdict.detail}`);
      return EXIT_INPUT;
    }
    return result.verdict.verdict === 'no-go' ? EXIT_NO_GO : EXIT_OK;
  } catch (error) {
    const failures = error instanceof LiveProbeError ? error.cleanupFailures : [];
    console.error(`live capture-probe run failed: ${error instanceof Error ? error.message : String(error)}`);
    if (failures.length > 0) console.error(`CLEANUP NOT PROVEN: ${failures.join(' | ')}`);
    return EXIT_INPUT;
  }
}

function usage(): never {
  console.error('usage: bench-capture-probe.ts [--plan | --report <file|->]   # default: autonomous live run');
  process.exit(EXIT_INPUT);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv.includes('--plan')) {
    console.log(renderPlan());
    return EXIT_OK;
  }

  const reportFlag = argv.indexOf('--report');
  if (reportFlag !== -1) {
    const target = argv[reportFlag + 1];
    if (!target) usage();
    const raw = target === '-' ? readFileSync(0, 'utf8') : readFileSync(target, 'utf8');
    const decision = decideFromReport(parseReport(raw));
    return decision.verdict === 'no-go' ? EXIT_NO_GO : EXIT_OK;
  }

  if (argv.some((flag) => flag.startsWith('--'))) usage();
  return live();
}

if (import.meta.main) process.exitCode = await main();

// Re-exported so the offline tests can pin the reply contract without any
// deployment; the live path consumes them inside fixtures/capture-probe/live-run.
export { parseProbeReply, lastNonEmptyLine };
