/**
 * The rendered report. Markdown only — the JSON artifact is the machine
 * record, this is the human one, and the two are generated from the same
 * validated artifact so they cannot disagree.
 *
 * Three sentences appear in EVERY report verbatim: the unverified SDK
 * throughput claim, the unknown loopback residency, and the unknown CPU
 * accounting. They are the honesty contract of the instrument; a report that
 * loses them is overclaiming.
 */

import { ARM_SPECS } from './arms';
import {
  CPU_ACCOUNTING_NOTE,
  LOOPBACK_RESIDENCY_NOTE,
  SDK_THROUGHPUT_CLAIM_NOTE,
} from './decision';
import type { Artifact, Cell } from './schema';

/**
 * Where each arm's clock ran. The base64 arm is DRIVEN by the owning DO (the
 * container is the passive source of its bytes), so its window covers the
 * DO-side SDK calls the other arms do not pay. Arms 2–4 are clocked inside
 * the container around the transfer itself.
 */
export const OWNER_TIMED_NOTE =
  'Timing placement differs by arm and is labelled per cell: the do-base64 '
  + 'arm is timed at the owning Durable Object around its readFile/writeFile '
  + 'SDK calls; every other arm is timed INSIDE the container around its own '
  + 'transfer. A wall-clock at the driver would have measured nothing but the '
  + 'driver\'s own connection.';

export const NOTES = [
  SDK_THROUGHPUT_CLAIM_NOTE,
  LOOPBACK_RESIDENCY_NOTE,
  CPU_ACCOUNTING_NOTE,
  OWNER_TIMED_NOTE,
];


const armLabel = (id: string): string => ARM_SPECS.find((spec) => spec.id === id)?.label ?? id;

function availabilitySection(artifact: Artifact): string[] {
  const lines = ['## Arm availability', ''];
  for (const row of artifact.availability) {
    lines.push(row.available
      ? `- **${armLabel(row.arm)}** — available.`
      : `- **${armLabel(row.arm)}** — UNAVAILABLE: ${row.reason ?? 'no reason recorded'}`);
  }
  lines.push('');
  lines.push('Unavailable arms are excluded from every ranking below. They are '
    + 'never approximated by another transport.');
  lines.push('');
  return lines;
}

function cellLine(cell: Cell): string {
  if (cell.status !== 'ok') return `| ${cell.op} | ${cell.status} | ${cell.reason ?? ''} |`;
  return `| ${cell.op} | ok | ${cell.wallMs!.toFixed(0)} ms |`;
}

function tierSection(artifact: Artifact, sizeMiB: number): string[] {
  const lines = [`## ${sizeMiB} MiB tier`, ''];
  const verdict = artifact.verdicts.find((entry) =>
    entry.sizeMiB === sizeMiB);
  if (verdict === undefined) return [...lines, '_No cells ran at this tier._', ''];

  if (verdict.kind === 'no-ranking') {
    lines.push(`**No ranking:** ${verdict.reason}`);
  } else {
    lines.push('| rank | transport | worst-leg median |');
    lines.push('|---|---|---|');
    for (const [index, row] of verdict.ranked.entries()) {
      lines.push(`| ${index + 1} | ${armLabel(row.arm)} | ${row.medianMiBs.toFixed(2)} MiB/s |`);
    }
  }
  if (verdict.exclusions.length > 0) {
    lines.push('');
    lines.push('Excluded from this ranking:');
    for (const exclusion of verdict.exclusions) {
      lines.push(`- ${armLabel(exclusion.arm)}: ${exclusion.reason}`);
    }
  }

  lines.push('');
  lines.push('<details><summary>per-repetition cells</summary>');
  lines.push('');
  for (const arm of ARM_SPECS) {
    const own = artifact.cells.filter((cell) => cell.arm === arm.id && cell.sizeMiB === sizeMiB);
    if (own.length === 0) continue;
    lines.push(`**${armLabel(arm.id)}**`);
    lines.push('');
    lines.push('| dir | status | wall |');
    lines.push('|---|---|---|');
    for (const cell of own) lines.push(cellLine(cell));
    lines.push('');
  }
  lines.push('</details>');
  lines.push('');
  return lines;
}

function controlRpcSection(artifact: Artifact): string[] {
  const lines = ['## Owning-DO control RPC latency', ''];
  const idle = artifact.controlRpc.find((sample) => sample.phase === 'idle');
  if (idle !== undefined && idle.latency.n > 0) {
    lines.push(`Idle: p50 ${idle.latency.p50.toFixed(1)} ms, `
      + `p95 ${idle.latency.p95.toFixed(1)} ms over ${idle.latency.n} calls.`);
  }
  for (const sample of artifact.controlRpc.filter((entry) => entry.phase === 'loaded')) {
    if (sample.latency.n === 0) continue;
    lines.push(`During concurrent transfers (${sample.arm}): p50 `
      + `${sample.latency.p50.toFixed(1)} ms, p95 ${sample.latency.p95.toFixed(1)} ms`
      + ` over ${sample.latency.n} calls.`);
  }
  if (artifact.controlRpc.every((sample) => sample.latency.n === 0)) {
    lines.push('_No control-RPC samples were collected._');
  }
  lines.push('');
  return lines;
}

function concurrencySection(artifact: Artifact): string[] {
  if (artifact.concurrency.length === 0) return [];
  const lines = ['## Concurrent transfers', ''];
  lines.push('| transport | wall | aggregate | status |');
  lines.push('|---|---|---|---|');
  for (const row of artifact.concurrency) {
    lines.push(`| ${armLabel(row.arm)} | ${row.wallMs?.toFixed(0) ?? '—'} ms`
      + ` | ${row.throughputMiBs?.toFixed(2) ?? '—'} MiB/s`
      + ` | ${row.status}${row.reason !== undefined ? `: ${row.reason}` : ''} |`);
  }
  lines.push('');
  return lines;
}

function cleanupSection(artifact: Artifact): string[] {
  const lines = ['## Cleanup', ''];
  for (const step of artifact.cleanup.steps) {
    lines.push(`- ${step.ok ? 'PASS' : 'FAIL'} — ${step.gate}: ${step.detail}`);
  }
  lines.push('');
  lines.push(artifact.cleanup.residue
    ? '**RESIDUE REMAINS.** This run did NOT clean up after itself; exit code is nonzero.'
    : 'No residue. Every gate passed and the replay pass found nothing left.');
  lines.push('');
  return lines;
}

export function renderMarkdown(artifact: Artifact): string {
  const lines = [
    `# Payload transport comparison — run \`${artifact.plan.runId}\``,
    '',
    `Worker \`${artifact.plan.workerName}\`, bucket \`${artifact.plan.bucketName}\`, `
      + `seed ${artifact.plan.seed}, ${artifact.plan.reps} rep(s), `
      + `concurrency ${artifact.plan.concurrency}.`,
    '',
    '## What the arms measure',
    '',
  ];
  for (const spec of ARM_SPECS) {
    lines.push(`- **${spec.label}** (\`${spec.id}\`): ${spec.question}`);
  }
  lines.push('');
  lines.push('The figure ranked per tier is the SLOWER direction\'s median '
    + '(max of PUT and GET medians): a transport is as good as its worst leg.');
  lines.push('');

  // The honesty notes, before any number.
  for (const note of NOTES) lines.push(note, '');

  lines.push(...availabilitySection(artifact));
  for (const sizeMiB of artifact.plan.sizesMiB) lines.push(...tierSection(artifact, sizeMiB));
  lines.push(...controlRpcSection(artifact));
  lines.push(...concurrencySection(artifact));
  lines.push(...cleanupSection(artifact));

  lines.push('## Measurement provenance and byte accounting', '');
  lines.push(CPU_ACCOUNTING_NOTE);
  lines.push('');
  lines.push(OWNER_TIMED_NOTE);
  lines.push('');
  lines.push('Every timed transfer ran INSIDE the benchmark container or across its '
    + 'owning-DO SDK surface; the driver issued commands and read results only, '
    + 'and no payload body ever originated on it. Digests were verified inside '
    + 'the container AND independently by a server-side read of each stored object.');
  lines.push('');
  lines.push('The base64 arm carried its payloads across the owner boundary as base64 '
    + 'text (raw bytes × 4/3). The other arms carried raw bytes end to end.');
  lines.push('');
  return lines.join('\n');
}
