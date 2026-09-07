/**
 * Every strategy on the same declared workloads, through the conformance
 * machine, counted at the store. This is a local adapter measurement, not
 * the deployed protocol. Counts include GET, PUT, HEAD, LIST and DELETE;
 * bytes include both reads and writes.
 *
 * Workload, per file count N in {1000, 5000}, files of 4 KiB:
 *   base    plant N files, checkpoint once
 *   edits   20 checkpoints, each after one 4 KiB write to one existing file
 *   wake    replace the container, attach, read one file
 *
 * Base and edit windows include the workspace writes and their checkpoints.
 * Wake includes one file read. Each row also reports whole-run store work.
 * An arm that refuses a step reports the refusal.
 *
 *   bun packages/devbox/bench/measure-first/local-comparison.ts
 */

import { CONFORMANCE_ARMS } from '../../tests/support/strategy-machine';
import type { ConformanceArm } from '../../tests/support/strategy-machine';
import { generatedTree } from '../../tests/support/tree-model';
import { parseDevboxStrategyName, type DevboxStrategyName } from '../../src/storage';

interface Counted {
  readonly ops: number;
  readonly bytes: number;
}

interface ArmResult {
  readonly arm: DevboxStrategyName;
  readonly files: number;
  base: Counted;
  editMean: Counted;
  editMax: Counted;
  wake: Counted;
  whole: Counted;
  restoreOps: number;
  refusal: string | null;
}

function counted(arm: ConformanceArm, since: number): Counted {
  const ops = arm.durable.ops.slice(since);
  return { ops: ops.length, bytes: ops.reduce((sum, op) => sum + op.bytes, 0) };
}

async function checkpoint(arm: ConformanceArm, what: string): Promise<void> {
  const outcome = await arm.storage().checkpoint('quiesce');
  if (outcome.kind !== 'committed') {
    throw new Error(`${what}: ${outcome.kind}${outcome.reason === undefined ? '' : ` (${outcome.reason})`}`);
  }
}

async function measure(name: DevboxStrategyName, files: number, edits: number): Promise<ArmResult> {
  const arm = CONFORMANCE_ARMS[name]();
  const empty: Counted = { ops: 0, bytes: 0 };
  const result: ArmResult = {
    arm: name, files, base: empty, editMean: empty, editMax: empty, wake: empty, whole: empty, restoreOps: 0, refusal: null,
  };
  try {
    await arm.storage().attach();
    const tree = generatedTree({ seed: 3, files, bytesPerFile: 4096 });
    const baseStart = arm.durable.ops.length;
    await arm.workspace.plant(tree);
    await checkpoint(arm, 'the base checkpoint');
    result.base = counted(arm, baseStart);

    const targets = tree.filter((entry) => entry.kind === 'file').map((entry) => entry.path);
    let editOps = 0;
    let editBytes = 0;
    let maxOps = 0;
    let maxBytes = 0;
    for (let round = 0; round < edits; round += 1) {
      const target = targets[(round * 7919) % targets.length];
      if (target === undefined) throw new Error('the tree has no files');
      const start = arm.durable.ops.length;
      const text = `edit ${round} `;
      await arm.workspace.write(target, text.repeat(Math.ceil(4096 / text.length)).slice(0, 4096));
      await checkpoint(arm, `edit ${round}`);
      const edit = counted(arm, start);
      editOps += edit.ops;
      editBytes += edit.bytes;
      maxOps = Math.max(maxOps, edit.ops);
      maxBytes = Math.max(maxBytes, edit.bytes);
    }
    result.editMean = { ops: editOps / edits, bytes: Math.round(editBytes / edits) };
    result.editMax = { ops: maxOps, bytes: maxBytes };

    arm.replaceContainer();
    const wakeStart = arm.durable.ops.length;
    const attached = await arm.storage().attach();
    if (attached.kind !== 'attached') throw new Error(`wake answered ${attached.kind}`);
    const probe = targets[0];
    if (probe === undefined) throw new Error('the tree has no files');
    const restored = await arm.workspace.read(probe);
    const firstEdit = 'edit 0 '.repeat(Math.ceil(4096 / 7)).slice(0, 4096);
    if (restored !== firstEdit) throw new Error('The wake did not return the committed bytes');
    result.wake = counted(arm, wakeStart);
    result.restoreOps = arm.work().restore.totalRemoteOps;
    result.whole = counted(arm, 0);
  } catch (error) {
    result.refusal = error instanceof Error ? error.message.slice(0, 160) : String(error);
  }
  return result;
}

function cell(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(1);
}

async function main(): Promise<void> {
  const edits = 20;
  const arms = Object.keys(CONFORMANCE_ARMS).map((name) => {
    const parsed = parseDevboxStrategyName(name);
    if (parsed === null) throw new Error(`Unrecognised conformance arm ${name}`);
    return parsed;
  });
  const rows: ArmResult[] = [];
  for (const files of [1_000, 5_000]) {
    for (const arm of arms) rows.push(await measure(arm, files, edits));
  }
  console.log(`| arm | files | base ops | base bytes | edit ops (mean) | edit bytes (mean) | edit bytes (max) | wake ops | wake bytes | restore ops | run ops | run bytes |`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const row of rows) {
    if (row.refusal !== null) {
      console.log(`| ${row.arm} | ${cell(row.files)} | refused: ${row.refusal} |`);
      continue;
    }
    console.log(`| ${row.arm} | ${cell(row.files)} | ${cell(row.base.ops)} | ${cell(row.base.bytes)} | ${cell(row.editMean.ops)} | ${cell(row.editMean.bytes)} | ${cell(row.editMax.bytes)} | ${cell(row.wake.ops)} | ${cell(row.wake.bytes)} | ${cell(row.restoreOps)} | ${cell(row.whole.ops)} | ${cell(row.whole.bytes)} |`);
  }
}

await main();
