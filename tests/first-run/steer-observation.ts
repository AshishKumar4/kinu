import type { EvalSubgoal } from '@kinu.run/test-utils';

/** The marker the correction asks for verbatim, so a paraphrase cannot pass. */
export const STEER_MARKER = 'KINU_STEER_LANDED';

/** The turn the correction interrupts: two files, the second of which the correction moves. */
export const STEER_TURN = 'Write a four-line summary of what a write-ahead log is into notes/wal.txt using your file '
  + 'tool, then write a one-line version of it into notes/short.txt. Reply with only DONE.';

/** Sent through the composer's own steer while {@link STEER_TURN} is running. */
export const STEER = 'Correction before you finish: write the one-line version into notes/steered.txt '
  + `instead of notes/short.txt, and make its first line exactly ${STEER_MARKER}.`;

/** The follow-up turn: the listing has to name what the workspace holds after the correction. */
export const LISTING_TURN = 'List the files under notes/ with your file tool and reply with only their names.';

/** What the case read off the deployment once both turns had settled. */
export interface SteerEvidence {
  /** The DO's own statement about where the correction landed, or null when it never said. */
  readonly landing: 'mid-turn' | 'turn' | null;
  /** notes/steered.txt and notes/wal.txt over the files route; '' when absent. */
  readonly steered: string;
  readonly wal: string;
  readonly history: readonly { readonly role: string; readonly text: string }[];
}

/**
 * The row's verdicts. The correction reached the work (steered.txt carries the marker), it is a
 * durable user row, and the later listing names both files the workspace holds. A landing of
 * `mid-turn` or `turn` is correct either way: which one happens is the model's pace.
 */
export function steerSubgoals(evidence: SteerEvidence): EvalSubgoal[] {
  const durable = evidence.history.some((row) => row.role === 'user' && row.text.includes(STEER_MARKER));
  const listing = evidence.history.filter((row) => row.role === 'assistant').at(-1)?.text ?? '';
  const listed = evidence.wal.trimEnd().split('\n').length === 4 && listing.includes('steered.txt') && listing.includes('wal.txt');

  return [
    { what: 'landing', reached: evidence.landing !== null, detail: `the workspace answered the steer with ${String(evidence.landing)}` },
    {
      what: 'correction-applied',
      reached: evidence.steered.split('\n')[0] === STEER_MARKER,
      detail: `notes/steered.txt: ${JSON.stringify(evidence.steered.slice(0, 120))}`,
    },
    { what: 'steer-is-durable', reached: durable, detail: `the steer ${durable ? 'is' : 'is NOT'} a user row in the transcript` },
    {
      what: 'listing-truthful',
      reached: listed,
      detail: `the listing ${listed ? 'names' : 'does not name'} both notes files: ${JSON.stringify(listing.slice(0, 160))}`,
    },
  ];
}
