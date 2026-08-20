/**
 * Measure a corpus's own DISPERSION by comparing one arm against itself.
 *
 * ψ (`PowerParams.dispersion`) is the mean squared per-task difference — the
 * null variance one pair contributes. `preRegister` assumes ψ = 0.5 because
 * before any data exists there is nothing better to assume, and its own comment
 * says "a measured run replaces it". This is that replacement, and it must come
 * from two runs of the SAME arm: a difference between two different arms is the
 * effect, not the noise, and using it as ψ would size the design against the
 * thing the design is trying to detect.
 *
 * The number it prints is a property of the CORPUS, not of the agent. ψ = 0
 * means the two runs agreed on every task, which means no effect of any size is
 * resolvable on this corpus — `minimumDetectableEffect` returns Infinity — and
 * that is a verdict on the tasks.
 */
import {
  minimumDetectableEffect, requiredPairs, minimumPairsForSignificance, fmtPp,
} from '@kinu/core';
import { compareRuns, readRunRecord } from '@kinu/test-utils';

function usage(): never {
  console.error('usage: bun scripts/eval-dispersion.ts <runA.json> <runB.json> [--target-pp N]');
  process.exit(2);
}

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
if (files.length !== 2) usage();
const targetIdx = args.indexOf('--target-pp');
const targetPp = targetIdx === -1 ? 20 : Number(args[targetIdx + 1]);
const [fileA, fileB] = files;
if (fileA === undefined || fileB === undefined) usage();
const a = readRunRecord(fileA);
const b = readRunRecord(fileB);
if (a.arm.evolution !== b.arm.evolution || a.arm.settle !== b.arm.settle) {
  console.error(
    'REFUSED: these are different arms, so their difference is an EFFECT and not this '
    + `corpus's noise (A evolution=${String(a.arm.evolution)} settle=${a.arm.settle}, `
    + `B evolution=${String(b.arm.evolution)} settle=${b.arm.settle}). `
    + 'Dispersion must be measured by running ONE arm twice.',
  );
  process.exit(1);
}

const comparison = compareRuns(a, b);
if (!comparison.comparable) {
  console.error('REFUSED: the two runs are not comparable, so they measure no dispersion:');
  for (const r of comparison.refusals) console.error(`  ${r.field}: ${r.detail}`);
  process.exit(1);
}

// psi comes STRAIGHT off the comparator. `PairedBinaryStats.dispersion` is
// already "mean squared per-task rate difference" (bench/stats.ts:202-204),
// computed after repeats were collapsed to a per-task rate — the
// pseudoreplication firewall. Recomputing it here would be a second statistics
// implementation, which is exactly what `packages/core/src/bench/stats.ts` is
// the one home for.
const psi = comparison.headline.dispersion;
const tasks = comparison.headline.pairs;
console.log('\n── corpus dispersion (one arm, twice) ──────────────────');
console.log(`runs:      ${a.runId} vs ${b.runId}`);
console.log(`arm:       evolution ${a.arm.evolution ? 'ON' : 'OFF'}, settle ${a.arm.settle}, `
  + `${String(a.arm.tools.length)} tools`);
console.log(`model:     ${a.modelId}`);
console.log(`tasks:     ${String(tasks)} paired, ${String(a.repeats)} repeats each`);
console.log(`differing: ${String(comparison.headline.discordant)} of ${String(tasks)} tasks`);
console.log(`\nMEASURED psi = ${psi.toFixed(4)}  (mean squared per-task difference)`);

const floorPairs = minimumPairsForSignificance();
if (psi === 0) {
  console.log(
    `\nMDE: UNRESOLVABLE. psi = 0 means the two runs of the SAME arm agreed on every one of\n`
    + `     the ${String(tasks)} tasks. A corpus with no run-to-run variation has no variation for an\n`
    + `     effect to exceed either: minimumDetectableEffect returns Infinity at every n, so\n`
    + `     NO effect of any size can be resolved on this corpus. That is a verdict on the\n`
    + `     tasks, not on the agent, and it is why a pass@1 of 1.000 -> 1.000 ranked nothing.`,
  );
  console.log(`\n     The floor still needs ${String(floorPairs)} DIFFERING pairs; this corpus offers 0.`);
} else {
  const mde = minimumDetectableEffect({ pairs: tasks, dispersion: psi });
  const needed = requiredPairs(targetPp / 100, { dispersion: psi });
  console.log(`\nMDE at n=${String(tasks)}: ${fmtPp(mde)} — the smallest effect this corpus resolves`);
  console.log(`             at alpha=0.05, power=0.8.`);
  console.log(`resolving ${String(targetPp)}pp needs ${String(needed)} tasks; `
    + `the significance floor needs ${String(floorPairs)} DIFFERING pairs.`);
}
console.log('───────────────────────────────────────────────────────\n');
