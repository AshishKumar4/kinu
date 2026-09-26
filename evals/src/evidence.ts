// What a trial leaves behind when its workspace is torn down: its transcript and ledger, the files and
// slates the workspace held at the end, and the data its slates served, under the run's directory. A
// failed trial is read from here to tell the model's work from the product's.
import { isUtf8 } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { SLATES_ROOT, WORKSPACE_ROOT, type JsonValue, type RunEvent } from '@kinu.run/core';
import { unheld } from './redact';
import type { HarnessRun } from './results';
import type { KinuPublicSession } from './session';
import type { EvalTask } from './task';
import { renderTrial } from './trajectories';
import { SlateAnswerSchema } from './verifier';

/** Folders that hold no one's work: installed packages and version-control history. */
const SKIPPED = new Set(['node_modules', '.git']);

export type EvidenceSession = Pick<KinuPublicSession, 'listFiles' | 'readBytes' | 'listSlates' | 'slateOp'>;

/** The workspace as it ended, read before teardown. */
export interface WorkspaceEvidence {
  /** Every file under the home and the slates, by absolute path. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** The slate listing, and each slate's `history` answer: its versions, or why it has none. */
  readonly slates: JsonValue;
  /** The task's reads of its slates' data, each as the slate answered it. */
  readonly data: readonly JsonValue[];
}

async function walk(session: EvidenceSession, dir: string, files: Map<string, Uint8Array>): Promise<void> {
  for (const entry of await session.listFiles(dir, { allowMissing: true })) {
    const path = `${dir}/${entry.name}`;

    if (entry.type === 'file') files.set(path, await session.readBytes(path));
    else if (!SKIPPED.has(entry.name)) await walk(session, path, files);
  }
}

/** Read what the workspace holds and what its slates serve. Every read is one a person could make. */
export async function gatherEvidence(session: EvidenceSession, reads: EvalTask['evidence']): Promise<WorkspaceEvidence> {
  const files = new Map<string, Uint8Array>();

  for (const root of [WORKSPACE_ROOT, SLATES_ROOT]) await walk(session, root, files);

  const listing = await session.listSlates();
  const histories: JsonValue[] = [];

  for (const id of [...listing.slates.map((slate) => slate.id), ...listing.problems.map((problem) => problem.id)]) {
    histories.push({ id, history: await session.slateOp({ op: 'history', id }) });
  }

  const data: JsonValue[] = [];

  await reads?.(async (slate, method, input) => {
    const answer = v.parse(SlateAnswerSchema, await session.slateOp({ op: 'call', id: slate, method, args: input === undefined ? [] : [input] }));

    data.push({ slate, method, input: input ?? null, answer });

    return answer.ok ? answer.value : null;
  });

  return { files, slates: { listing, histories }, data };
}

/** A file as the workspace held it, the run's own credential taken out of text. */
function kept(bytes: Uint8Array): string | Uint8Array {
  return isUtf8(bytes) ? unheld(new TextDecoder().decode(bytes)) : bytes;
}

/**
 * Write one trial's evidence into `directory`: `transcript.md` (rendered, and scrubbed, as a reviewer
 * reads a report), `ledger.jsonl`, and, when the workspace could be read, `files/`, `slates.json` and
 * `data.json`; when it could not, `workspace.txt` says why. Everything but the transcript is kept as
 * the deployment answered, less the run's own credential: a pattern scrub would rewrite the code a
 * reader came for, and this directory stays on the machine that ran the trial.
 */
export function writeEvidence(directory: string, trial: {
  readonly run: HarnessRun;
  readonly verdict: { status: 'passed' | 'failed'; durationMs: number };
  readonly events: readonly RunEvent[];
  readonly workspace: WorkspaceEvidence | { readonly unread: string };
}): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'transcript.md'), `${renderTrial(trial.run, trial.verdict)}\n`);
  writeFileSync(join(directory, 'ledger.jsonl'), trial.events.map((event) => `${unheld(JSON.stringify(event))}\n`).join(''));

  if ('unread' in trial.workspace) {
    writeFileSync(join(directory, 'workspace.txt'), `The workspace could not be read before teardown: ${unheld(trial.workspace.unread)}\n`);

    return;
  }

  for (const [path, bytes] of trial.workspace.files) {
    const target = join(directory, 'files', path);

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, kept(bytes));
  }

  writeFileSync(join(directory, 'slates.json'), `${unheld(JSON.stringify(trial.workspace.slates, null, 2))}\n`);
  writeFileSync(join(directory, 'data.json'), `${unheld(JSON.stringify(trial.workspace.data, null, 2))}\n`);
}
