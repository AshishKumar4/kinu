/**
 * The read seam every capture mechanism looks through.
 *
 * Mechanisms see a tree, not the log: `paths`, `stat`, `readEntry`. That is the
 * point — a mechanism must be judged by what it does with ordinary filesystem
 * observations, because that is all it gets on a real container. Reads are
 * async so each one is an interleaving point concurrent writers can land in,
 * which is what makes the soundness races exercisable rather than theoretical.
 */

import { tick } from './model';
import type { MutationLog, NodeEntry, StatSnapshot, UpperPath } from './model';

export interface CaptureView {
  paths(): readonly UpperPath[];
  stat(path: UpperPath): StatSnapshot | null;
  /** One staged read of a path's full entry; null when it vanished. */
  readEntry(path: UpperPath): Promise<NodeEntry | null>;
}

/** The view over the model's live upper. Tests and drivers both use this. */
export function logView(log: MutationLog): CaptureView {
  return {
    paths: () => log.paths(),
    stat: (path) => log.statOf(path),
    readEntry: async (path) => {
      await tick();
      return log.entryOf(path);
    },
  };
}
