import type { RunEvent } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { INFRA_FAILURE_MARKER } from '@kinu.run/test-utils';
import type { KinuPublicSession, PublicMessage } from './session';

/** How often an unsettled workspace is looked at. A poll, not a deadline: nothing here ends a turn. A poll reads only
 *  what the ledger added since the last one, so a short interval costs the deployment little. */
const IDLE_POLL_MS = 1_000;

/** Polls in a row the deployment's transport may fail before the trial fails as infrastructure. */
const DROPPED_POLLS = 3;

function openRuns(events: readonly RunEvent[]): string[] {
  const ended = new Set(events.filter((event) => event.type === 'run_end').map((event) => event.runId));

  return events.filter((event) => event.type === 'run_start' && !ended.has(event.runId)).map((event) => event.runId);
}

/** What one poll of {@link settle} saw: whether the workspace was busy, and the ledger it read. */
export type SettlePoll = (busy: boolean, events: readonly RunEvent[]) => void;

/**
 * Wait until the workspace has nothing left to do for this turn: no run open, no background job
 * running, no helper working, seen on two polls in a row. A background job's completion wakes the
 * agent in a run of its own, and that run answers the prompt too.
 */
export async function settle(session: KinuPublicSession, polled?: SettlePoll): Promise<void> {
  let quiet = 0;
  let dropped = 0;

  for (;;) {
    let busy = true;

    try {
      const [events, jobs, helpers] = await Promise.all([session.runEvents(), session.backgroundJobs(), session.subordinates()]);

      busy = openRuns(events).length > 0 || jobs.some((job) => job.status === 'running')
        || helpers.some((helper) => helper.status === 'working');

      dropped = 0;
      polled?.(busy, events);
    } catch (error) {
      // An eviction closes the socket under the polls in flight, and the next poll redials. Three
      // failed polls in a row is a deployment that is not answering, and fails the trial as that.
      dropped += 1;

      if (!renderThrownChain({ cause: error }).includes(INFRA_FAILURE_MARKER) || dropped >= DROPPED_POLLS) throw error;
    }

    quiet = busy ? 0 : quiet + 1;

    if (quiet >= 2) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, IDLE_POLL_MS); });
  }
}

/** What the agent said after `prompt`, oldest first; wake rows between are the agent's own work. */
export function repliesTo(history: readonly PublicMessage[], prompt: string): string[] {
  const asked = history.map((row) => row.role === 'user' && row.text.trim() === prompt.trim()).lastIndexOf(true);

  if (asked === -1) return [];

  return history.slice(asked + 1).filter((row) => row.role === 'assistant' && row.text.trim() !== '').map((row) => row.text);
}
