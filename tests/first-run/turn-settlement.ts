import { absorbingRunId } from '@kinu.run/test-utils';
import type { RunEvent } from '../../packages/core/src/index';

export type TurnSettlement = 'pending' | 'replied' | { readonly ended: string };

/** What a caller knows about how the marker landed. `landedAt` is the done
 *  frame's arrival as an ISO string; `splicedAtStep` is the `kinuSteerAtStep`
 *  metadata on the marker's transcript row — the step the absorbing run read
 *  the marker in, which bounds which of that run's events the marker's answer
 *  owns. */
export interface MarkerLanding {
  readonly landedAt?: string;
  readonly splicedAtStep?: number;
  /** The run the send's done frame named as the answerer, when it reported
   *  `mid-turn` — the exact attribution, ahead of any inference from
   *  `landedAt`. */
  readonly absorbedBy?: string | null;
}

/** What the assistant said in answer to the marker's prompt, whichever run
 *  answered it: every assistant row after the marker's own user row. A send
 *  that landed mid-turn has no turn result of its own — its answer is the
 *  absorbing run's, and the transcript is where it lands. Empty when the
 *  marker never landed or nothing has answered yet. */
export function firstRunReplyText(
  history: readonly { readonly role: string; readonly text: string }[],
  marker: string,
): string {
  const asked = history.findIndex((row) => row.role === 'user' && row.text.includes(marker));

  if (asked === -1) return '';

  return history.slice(asked + 1).filter((row) => row.role === 'assistant').map((row) => row.text).join('\n');
}

/** The step index the marker was spliced into, read off its transcript row —
 *  undefined when the row carries no steer-step metadata or never landed. */
export function firstRunSpliceStep(
  history: readonly { readonly role: string; readonly text: string; readonly landedAtStep?: number }[],
  marker: string,
): number | undefined {
  return history.find((row) => row.role === 'user' && row.text.includes(marker))?.landedAtStep;
}

/**
 * The marker's run: its own `run_start` when it opened one, or the run that
 * absorbed it when the send landed mid-turn.
 *
 * THE ATTRIBUTION RULE: a prompt whose send reports `landed:'mid-turn'` is
 * spliced into the run that was open when it landed — the genesis run, for a
 * first chat — and gets NO `run_start` of its own. A scan keyed only on
 * `userMessage` finds nothing for it and scores the absorbing run's calls as
 * belonging to nobody. `landing.landedAt` names the done frame's arrival;
 * `landing.splicedAtStep` bounds the window to the steps that came AFTER the
 * splice — calls the absorbing run made before it read the marker are the
 * run's own, not the prompt's answer.
 */
export function firstRunTurnEvents(
  events: readonly RunEvent[], marker: string, landing?: MarkerLanding,
): readonly RunEvent[] {
  const start = events.find((event) => event.type === 'run_start' && event.userMessage?.includes(marker));
  const runId = start?.runId ?? landing?.absorbedBy ?? absorbingRunId(events, landing?.landedAt);

  if (runId === null) return [];

  const own = events.filter((event) => event.runId === runId);
  const atStep = landing?.splicedAtStep;

  // Post-splice only. `atStep` is the AI-SDK stepNumber the steer was read in
  // (0-based); the step_finish emitted for it carries `stepIndex = atStep + 1`
  // (the accumulator counts from 1). So the step whose finish CLOSES the run's
  // pre-landing work is `stepIndex === atStep`, and everything after it is
  // what the marker's answer owns — calls before it are the run's own, made
  // before it ever saw the marker.
  if (start === undefined && atStep !== undefined && atStep > 0) {
    const boundary = own.find((event) => event.type === 'step_finish' && event.stepIndex === atStep);

    if (boundary !== undefined) return own.filter((event) => event.eventIndex > boundary.eventIndex);
  }

  return own;
}

/** Terminal evidence belongs to the run that accepted the marker, not the
 * next run_end in a workspace that can also be running genesis or a wake. */
export function firstRunTurnSettlement(
  events: readonly RunEvent[], marker: string, landing?: MarkerLanding,
): TurnSettlement {
  const own = firstRunTurnEvents(events, marker, landing);
  const end = own.find((event) => event.type === 'run_end');

  if (end === undefined || end.type !== 'run_end') return 'pending';

  const replied = own.some((event) => event.type === 'step_finish' && event.messages?.some((message) =>
    message.role === 'assistant' && (Array.isArray(message.content)
      ? message.content.some((part) => part.type === 'text' && part.text.trim().length > 0)
      : message.content.trim().length > 0)));

  return replied ? 'replied' : { ended: `${end.reason ?? 'ended'}${end.error === undefined ? '' : `: ${end.error}`}` };
}
