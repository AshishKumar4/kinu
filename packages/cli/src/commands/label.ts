/**
 * `proteus label` — the hand-labeling flow that measures the turn-outcome
 * classifier, and the bias-corrected numbers it buys.
 *
 * Three steps, in order: draw a file, fill it in, hand it back.
 *
 *   proteus label export <agent>          # writes a file of turns to judge
 *   $EDITOR <file>                        # one letter per turn
 *   proteus label ingest <agent> <file>   # validates and stores
 *   proteus label report <agent>          # what the labels established
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_LABEL_BUDGET, parseLabelingFile, renderCalibrationReport, renderLabelingFile,
  type CalibrationReport, type LabelIngestResult, type LabelingItem,
} from '@proteus/core';
import { resolveAgentTarget, type AgentTarget } from '../agent-target.js';
import { requireAuthConfig } from '../config.js';
import { callAgentRpc } from '../cloud-api.js';
import { ACCENT, DIM, OK, WARN } from '../display.js';
import {
  getLocalCalibration, recordLocalOutcomeLabels, sampleLocalLabeling,
} from '../local-inspection.js';

interface LabelOpts {
  out?: string;
  size?: string;
  labeler?: string;
  json?: boolean;
}

export async function labelCommand(
  action: string | undefined,
  name: string | undefined,
  file: string | undefined,
  opts: LabelOpts = {},
): Promise<void> {
  if (!name) throw new Error('Usage: proteus label <export|ingest|report> <agent> [file]');
  const target = resolveAgentTarget(name);
  switch (action) {
    case 'export': return exportLabels(target, opts);
    case 'ingest': return ingestLabels(target, file, opts);
    case 'report': return reportLabels(target, opts);
    default:
      throw new Error(`Unknown action "${action ?? ''}" — use export, ingest, or report.`);
  }
}

// ── export ───────────────────────────────────────────────────────

async function exportLabels(target: AgentTarget, opts: LabelOpts): Promise<void> {
  const size = parsePositiveInt(opts.size, DEFAULT_LABEL_BUDGET, 'size');
  const items = target.mode === 'cloud'
    ? await cloudRpc<LabelingItem[]>(target, 'sampleOutcomeLabeling', [size])
    : sampleLocalLabeling(target.localName, size);

  if (items.length === 0) {
    console.log(`${WARN('nothing to label')} ${target.name} has no classifier-graded turns left to check.`);
    console.log(DIM('The classifier grades a turn once the user sends a follow-up. Chat with the agent first.'));
    return;
  }

  const path = resolve(opts.out ?? `${target.name}-calibration.txt`);
  writeFileSync(path, renderLabelingFile(items), 'utf8');

  if (opts.json) {
    console.log(JSON.stringify({ path, turns: items.length }, null, 2));
    return;
  }
  console.log(`${OK('drew')} ${items.length} turn${items.length === 1 ? '' : 's'} → ${ACCENT(path)}` +
    DIM(`  (~${Math.round(items.length * 0.35)}–${Math.round(items.length * 0.5)} minutes)`));
  console.log('');
  console.log('  1. Open it and put one letter after each `verdict:` —');
  console.log(DIM('       a accepted   c corrected   f frustrated   b abandoned   ? unclear'));
  console.log(DIM('     In vim: /^verdict:  then  n  to step, then  A <letter> Esc.'));
  console.log(`  2. ${ACCENT(`proteus label ingest ${target.requestedName} ${path}`)}`);
  console.log(`  3. ${ACCENT(`proteus label report ${target.requestedName}`)}`);
  console.log('');
  console.log(DIM("The classifier's own verdicts are not in the file on purpose — seeing them"));
  console.log(DIM('first would anchor yours, and the gap between the two is the measurement.'));
}

// ── ingest ───────────────────────────────────────────────────────

async function ingestLabels(target: AgentTarget, file: string | undefined, opts: LabelOpts): Promise<void> {
  if (!file) throw new Error('Usage: proteus label ingest <agent> <file>');
  const path = resolve(file);
  const parsed = parseLabelingFile(readFileSync(path, 'utf8'));

  // Nothing is written while the file has a problem in it: a labeling pass is
  // half an hour of a person's attention, and a partial write would make the
  // rest of it ambiguous to re-do. Every problem is listed at once so the file
  // is fixed in one pass.
  if (parsed.errors.length > 0) {
    throw new Error(
      `${parsed.errors.length} problem${parsed.errors.length === 1 ? '' : 's'} in ${path} — nothing was stored:\n` +
      parsed.errors.map((problem) => `  ${problem}`).join('\n'),
    );
  }
  if (parsed.labels.length === 0) {
    console.log(`${WARN('no verdicts')} every turn in ${path} was left blank.`);
    return;
  }

  const labeler = opts.labeler ?? process.env.USER ?? 'owner';
  const result = target.mode === 'cloud'
    ? await cloudRpc<LabelIngestResult>(target, 'recordOutcomeLabeling', [labeler, parsed.labels])
    : recordLocalOutcomeLabels(target.localName, { labeler, labels: parsed.labels });

  if (opts.json) {
    console.log(JSON.stringify({ ...result, skipped: parsed.skipped, labeler }, null, 2));
    return;
  }
  console.log(`${OK('stored')} ${result.stored} verdict${result.stored === 1 ? '' : 's'} as ${labeler}` +
    (parsed.skipped > 0 ? DIM(`  (${parsed.skipped} left blank)`) : ''));
  if (result.stored > 0) {
    console.log(`  You disagreed with the classifier on ${result.disagreements} of ${result.stored}.`);
  }
  if (result.unknown.length > 0) {
    console.log(`${WARN('skipped')} ${result.unknown.length} turn${result.unknown.length === 1 ? '' : 's'} ` +
      `no longer in the ledger: ${result.unknown.slice(0, 3).join(', ')}${result.unknown.length > 3 ? '…' : ''}`);
  }
  console.log('');
  console.log(renderCalibrationReport(await fetchReport(target)));
}

// ── report ───────────────────────────────────────────────────────

async function reportLabels(target: AgentTarget, opts: LabelOpts): Promise<void> {
  if (opts.json) {
    console.log(JSON.stringify(await fetchReport(target), null, 2));
    return;
  }
  console.log(renderCalibrationReport(await fetchReport(target)));
}

/** The calibration report for either backend. Shared with `proteus alignment`,
 *  which renders the same block beneath K_align. */
export async function fetchReport(target: AgentTarget): Promise<CalibrationReport> {
  return target.mode === 'cloud'
    ? cloudRpc<CalibrationReport>(target, 'getOutcomeCalibration', [])
    : getLocalCalibration(target.localName);
}

function cloudRpc<T>(target: AgentTarget, method: string, args: unknown[]): Promise<T> {
  const auth = requireAuthConfig();
  return callAgentRpc<T>(auth.origin, auth.token, target.cloudName, method, args);
}

function parsePositiveInt(value: string | undefined, fallback: number, label: string): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}
