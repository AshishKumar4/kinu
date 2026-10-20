/**
 * The hand-labelled sample the measurement's classifier and judges are held to: the owner's own reading of what counts
 * as a correction, and of whether an answer would have drawn it again. Drawn from training turns only; the held-out
 * set is never shown before the arms run.
 */
import * as v from 'valibot';
import { Seeded } from '../tasks/seeded';
import type { OwnerTurn } from './omp';

/** What a next message is, as the owner reads it: keys 1 to 4. */
export const MESSAGE_LABELS = ['Preference or rule', 'Project fact', 'Slip', 'Not a correction'] as const;

/** Whether an answer would have drawn the correction again: keys 1 to 4. */
export const AGAIN_LABELS = ['Yes', 'No', 'Partly', "Can't tell"] as const;

export const LabelItemSchema = v.object({
  id: v.string(),
  kind: v.picklist(['message', 'again']),
  asked: v.string(),
  answer: v.string(),
  /** The owner's next message: the one labelled, or the correction an answer is held to. */
  said: v.string(),
});

export type LabelItem = v.InferOutput<typeof LabelItemSchema>;

/** The survey's correction words: a sample drawn half from messages holding one shows the classes the rest would hide. */
const CORRECTION_WORDS = /\b(?:no|don'?t|why did you|bruh|i told you|stop|instead|prefer|do not|should not|already asked|again)\b/iu;

/** Characters shown of the request, the answer and the next message: a message is labelled from itself, its turn only
 *  glanced at, so ten take about a minute; an answer is read against the correction. */
const SHOWN = {
  message: { asked: 160, answer: 240, said: 400 },
  again: { asked: 240, answer: 600, said: 400 },
} as const satisfies Record<'message' | 'again', { asked: number; answer: number; said: number }>;

const cut = (text: string, chars: number): string => (text.length <= chars ? text : `${text.slice(0, chars).trimEnd()} …`);

/** `count` of `items` in a seeded order, none twice. */
function drawn<T>(items: readonly T[], count: number, rng: Seeded): T[] {
  const pool = [...items];

  return Array.from({ length: Math.min(count, pool.length) }, () => pool.splice(rng.int(0, pool.length - 1), 1)[0]).filter((item) => item !== undefined);
}

/**
 * `messages` next messages, half holding a correction word, then `again` answers held to the correction they drew:
 * half the answer that drew it, half the answer given after it, each kind in a seeded order that hides which is which.
 */
export function labelSample(train: readonly OwnerTurn[], { messages, again, seed }: { readonly messages: number; readonly again: number; readonly seed: number }): LabelItem[] {
  const rng = new Seeded(seed);
  const answered = train.filter((turn) => turn.followup !== null && turn.turn.assistantResponse.trim() !== '');
  const worded = answered.filter((turn) => CORRECTION_WORDS.test(turn.followup?.text ?? ''));
  const plain = answered.filter((turn) => !CORRECTION_WORDS.test(turn.followup?.text ?? ''));

  const item = (turn: OwnerTurn, kind: LabelItem['kind'], answer: string): LabelItem => ({
    id: `${kind}:${turn.turn.turnId ?? turn.at}`, kind,
    asked: cut(turn.turn.userMessage, SHOWN[kind].asked), answer: cut(answer, SHOWN[kind].answer), said: cut(turn.followup?.text ?? '', SHOWN[kind].said),
  });

  const labelled = [...drawn(worded, Math.ceil(messages / 2), rng), ...drawn(plain, Math.floor(messages / 2), rng)].map((turn) => item(turn, 'message', turn.turn.assistantResponse));
  // The turn that answered a correction: its request is the correction, asked when the correction was said.
  const after = new Map(train.map((turn) => [JSON.stringify([turn.turn.userMessage, turn.at]), turn] as const));

  const held = drawn(worded.filter((turn) => after.get(JSON.stringify([turn.followup?.text, turn.followup?.at]))?.turn.assistantResponse.trim()), again, rng)
    .map((turn, at) => {
      const next = after.get(JSON.stringify([turn.followup?.text, turn.followup?.at]));

      return at % 2 === 0 || next === undefined
        ? { ...item(turn, 'again', turn.turn.assistantResponse), id: `again:drew:${turn.turn.turnId ?? turn.at}` }
        : { ...item(turn, 'again', next.turn.assistantResponse), id: `again:after:${turn.turn.turnId ?? turn.at}` };
    });

  // One kind at a time, so a key keeps one meaning while it is pressed.
  return [...drawn(labelled, labelled.length, rng), ...drawn(held, held.length, rng)];
}
