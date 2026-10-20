/**
 * What a turn picked, and which picks a dream reads as confused (docs/EVOLUTION.md, "Picks"). A pick is a skill read or
 * a crafted tool used. Picks are confused where a turn read one skill and then another, or where the user corrected
 * a turn and the next one picked something else. Only dreams read them: no turn sees this.
 */
import * as v from 'valibot';
import type { CompletedTurn } from './types';
import type { TurnRating } from './ratings';

export const TurnPicksSchema = v.object({
  /** In the order they were read, a re-read of the same one not repeated. */
  skills: v.pipe(v.array(v.string()), v.readonly()),
  tools: v.pipe(v.array(v.string()), v.readonly()),
});

export type TurnPicks = v.InferOutput<typeof TurnPicksSchema>;

/** A skill is picked by reading its `SKILL.md`, through `/skills` or the folder it lives in. */
const SKILL_READ = /skills\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\/SKILL\.md/gu;

/** From the turn's own calls: a `file` call that is not a read picks nothing. */
export function turnPicks(turn: Pick<CompletedTurn, 'toolCalls' | 'craftedToolsUsed'>): TurnPicks {
  const skills: string[] = [];

  for (const call of turn.toolCalls) {
    if (call.name === 'file' && call.op !== 'read') continue;

    for (const [, name] of call.argsWindow.matchAll(SKILL_READ)) {
      if (name !== undefined && skills.at(-1) !== name) skills.push(name);
    }
  }

  return { skills, tools: [...(turn.craftedToolsUsed ?? [])] };
}

export type PickKind = 'skill' | 'tool';

interface PickSwitch {
  readonly kind: PickKind;
  readonly from: string;
  readonly to: string;
  /** The turns it switched in, or the corrected turns it switched after. */
  readonly turns: readonly string[];
}

interface CorrectedPick {
  readonly kind: PickKind;
  readonly name: string;
  readonly picked: number;
  readonly corrected: number;
}

export interface ConfusedPicks {
  readonly switches: readonly PickSwitch[];
  readonly corrected: readonly CorrectedPick[];
}

/** From this the rater read the user's next words as a correction (`RatingVerdict.corrected`). */
const CORRECTED_FROM = 0.5;

const KINDS = [['skill', 'skills'], ['tool', 'tools']] as const;

/** Over rated turns, in the order they were rated; a turn whose picks were not recorded is skipped. */
export function confusedPicks(ratings: readonly TurnRating[]): ConfusedPicks {
  const rated = ratings.flatMap((rating) => (rating.picks === null ? [] : [{ rating, picks: rating.picks }]))
    .sort((a, b) => a.rating.createdAt - b.rating.createdAt);

  const switches = new Map<string, { kind: PickKind; from: string; to: string; turns: string[] }>();
  const tallies = new Map<string, { kind: PickKind; name: string; picked: number; corrected: number }>();

  const switched = (kind: PickKind, from: string, to: string, turnId: string): void => {
    const key = JSON.stringify([kind, from, to]);
    const held = switches.get(key) ?? { kind, from, to, turns: [] };

    if (!held.turns.includes(turnId)) held.turns.push(turnId);
    switches.set(key, held);
  };

  for (const [at, { rating, picks }] of rated.entries()) {
    const corrected = rating.corrected >= CORRECTED_FROM;

    for (const [index, name] of picks.skills.entries()) {
      const before = picks.skills[index - 1];

      if (before !== undefined) switched('skill', before, name, rating.turnId);
    }

    for (const [kind, field] of KINDS) {
      for (const name of new Set(picks[field])) {
        const key = JSON.stringify([kind, name]);
        const held = tallies.get(key) ?? { kind, name, picked: 0, corrected: 0 };
        tallies.set(key, { ...held, picked: held.picked + 1, corrected: held.corrected + Number(corrected) });
      }

      const next = rated[at + 1]?.picks[field];

      if (!corrected || next === undefined) continue;

      for (const from of picks[field].filter((name) => !next.includes(name))) {
        for (const to of next.filter((name) => !picks[field].includes(name))) switched(kind, from, to, rating.turnId);
      }
    }
  }

  return { switches: [...switches.values()], corrected: [...tallies.values()].filter((tally) => tally.corrected > 0) };
}

/**
 * The dream's section on confused picks: each switch, each corrected pick, and the current description of every
 * one named. Empty when there is none.
 */
export function renderConfusedPicks(confused: ConfusedPicks, describe: (kind: PickKind, name: string) => string): string {
  if (confused.switches.length === 0 && confused.corrected.length === 0) return '';
  const named = new Map<string, { kind: PickKind; name: string }>();

  for (const { kind, from, to } of confused.switches) {
    named.set(JSON.stringify([kind, from]), { kind, name: from });
    named.set(JSON.stringify([kind, to]), { kind, name: to });
  }

  for (const { kind, name } of confused.corrected) named.set(JSON.stringify([kind, name]), { kind, name });

  return [
    ...confused.switches.map(({ kind, from, to, turns }) =>
      `  - ${kind} \`${from}\`, then \`${to}\`: ${String(turns.length)} time${turns.length === 1 ? '' : 's'}`),
    ...confused.corrected.map(({ kind, name, picked, corrected }) =>
      `  - ${kind} \`${name}\`: picked in ${String(picked)} turn${picked === 1 ? '' : 's'}, ${String(corrected)} of them corrected`),
    '  Their descriptions now:',
    ...[...named.values()].map(({ kind, name }) => `  - ${kind} \`${name}\`: ${describe(kind, name)}`),
  ].join('\n');
}
