/**
 * What a measured arm is held to and what it may read: the held-out requests, drawn once and frozen before any arm runs,
 * and, for each, the commands its recorded turn ran with what they answered, which the inert boundary serves a kept
 * shell call from (docs/TOOLS.md, "The inert boundary").
 */
import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { Seeded } from '../tasks/seeded';
import { drawn } from './omp-labels';
import type { OwnerTurn } from './omp';
import type { JsonValue } from '../../packages/core/src/index';

/** Shorter than this, a request leans on the conversation it was asked in ("and the status?") and stands for nothing alone. */
const SHORTEST_REQUEST = 80;

export const FrozenHeldOutSchema = v.object({
  seed: v.number(),
  /** The turns drawn, by id, in the order every arm runs them. */
  turnIds: v.array(v.string()),
  /** A digest of the ids, so a later run can show it read the same set. */
  digest: v.string(),
});

export type FrozenHeldOut = v.InferOutput<typeof FrozenHeldOutSchema>;

/** `count` held-out turns that were answered and drew a next message, and whose request stands alone; `all`, every one,
 *  in a seeded order, so a run cut short has answered a random part. */
export function freezeHeldOut(heldOut: readonly OwnerTurn[], { count, seed }: { readonly count: number | 'all'; readonly seed: number }): FrozenHeldOut {
  const eligible = count === 'all' ? heldOut : heldOut.filter((turn) => turn.followup !== null && turn.turn.assistantResponse.trim() !== '' && turn.turn.userMessage.length >= SHORTEST_REQUEST);
  const turnIds = drawn(eligible, count === 'all' ? eligible.length : count, new Seeded(seed)).flatMap((turn) => (turn.turn.turnId === undefined ? [] : [turn.turn.turnId]));

  return { seed, turnIds, digest: createHash('sha256').update(turnIds.join('\n')).digest('hex') };
}

const ShellArgs = v.object({ command: v.string() });

const ShellArgsText = v.pipe(v.string(), v.parseJson(), ShellArgs);

/** A recorded shell call's command and its answer, for the commands whose arguments survived whole in the record. */
export function recordedShell(turn: OwnerTurn): ReadonlyMap<string, string> {
  return new Map(turn.turn.toolCalls.flatMap((call) => {
    const args = call.name === 'bash' ? v.safeParse(ShellArgsText, call.argsWindow) : null;

    return args?.success === true && call.resultWindow !== undefined ? [[args.output.command.trim(), call.resultWindow] as const] : [];
  }));
}

/** The boundary's answer to a kept `shell` call: the recorded answer to the same command, where the turn ran it. */
export function shellFromRecord(recorded: ReadonlyMap<string, string>): (name: string, input: JsonValue) => string | null {
  return (name, input) => {
    const args = name === 'shell' ? v.safeParse(ShellArgs, input) : null;

    return args?.success === true ? recorded.get(args.output.command.trim()) ?? null : null;
  };
}
