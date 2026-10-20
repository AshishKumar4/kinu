/**
 * One project's OMP sessions as owner turns, split at a cutoff, written where no repository reaches:
 *
 *   bun evals/omp/convert.ts --sessions ~/.omp/agent/sessions/-Proteus --cutoff 2026-10-10 --commit f2fa713f7 \\
 *     --out /mnt/local/kinu/datasets/omp/proteus
 *
 * Writes `train.jsonl` and `held-out.jsonl` (one `OwnerTurn` per line) and `counts.json`, which names the cutoff's provenance:
 * the repository commit the arms read (the last before the cutoff) and the last training turn. Delegated agents' logs, in
 * each session's own directory, are not the owner's and are not read.
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { OwnerTurns, parseLogLine, shakenRegions, splitAt, type OwnerTurn } from '../src/omp';

/** Shaken artifacts read so far, by session and number; a session's few hundred fit, and each is read once. */
function artifacts(sessions: string): (session: string, id: number) => ReadonlyMap<number, string> | null {
  const read = new Map<string, ReadonlyMap<number, string> | null>();

  return (session, id) => {
    const path = join(sessions, session, `${String(id)}.shake.log`);

    if (!read.has(path)) read.set(path, existsSync(path) ? shakenRegions(readFileSync(path, 'utf8')) : null);

    return read.get(path) ?? null;
  };
}

async function readSession(turns: OwnerTurns, path: string, session: string): Promise<void> {
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    if (line.trim() !== '') turns.add(session, parseLogLine(line));
  }
}

const followed = (turns: readonly OwnerTurn[]) => turns.filter((turn) => turn.followup !== null).length;

if (import.meta.main) {
  const { values } = parseArgs({ options: { sessions: { type: 'string' }, cutoff: { type: 'string' }, commit: { type: 'string' }, out: { type: 'string' } } });
  const { sessions, cutoff, commit, out } = values;

  if (sessions === undefined || cutoff === undefined || commit === undefined || out === undefined) {
    throw new Error('--sessions, --cutoff, --commit and --out are required');
  }

  const files = readdirSync(sessions).filter((name) => name.endsWith('.jsonl')).sort();
  const turns = new OwnerTurns(artifacts(sessions));

  for (const file of files) await readSession(turns, join(sessions, file), file.replace(/\.jsonl$/u, ''));
  const all = turns.turns();
  const { train, heldOut } = splitAt(all, cutoff);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'train.jsonl'), train.map((turn) => JSON.stringify(turn)).join('\n') + '\n');
  writeFileSync(join(out, 'held-out.jsonl'), heldOut.map((turn) => JSON.stringify(turn)).join('\n') + '\n');

  const counts = {
    sessions: files.length, cutoff, cutoffCommit: commit, lastTrainingTurn: train.at(-1) === undefined ? null : { at: train.at(-1)?.at, session: train.at(-1)?.turn.sessionId },
    ...turns.read(),
    ownerTurns: all.length, first: all[0]?.at ?? null, last: all.at(-1)?.at ?? null,
    train: { turns: train.length, answered: followed(train), toolCalls: train.reduce((sum, turn) => sum + turn.turn.toolCalls.length, 0) },
    heldOut: { turns: heldOut.length, answered: followed(heldOut), toolCalls: heldOut.reduce((sum, turn) => sum + turn.turn.toolCalls.length, 0) },
    redacted: all.filter((turn) => JSON.stringify(turn).includes('<redacted>')).length,
    stillShaken: all.filter((turn) => JSON.stringify(turn).includes('[shaken ~')).length,
    noAnswer: all.filter((turn) => turn.turn.assistantResponse.trim() === '').length,
  };

  writeFileSync(join(out, 'counts.json'), `${JSON.stringify(counts, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(counts)}\n`);
}
