import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFileTuiPreferenceStore,
  type TuiPreferences,
  type TuiPreferenceStore,
} from '../../src/tui/preferences';

/** In-memory preference store for renderer tests. Product code persists to disk.
 *
 *  The seed defaults come from production the way a first run gets them — a file
 *  store pointed at a path that does not exist returns its own fallback — so a
 *  default that changes cannot leave these fixtures asserting the old one. */
export function createMemoryTuiPreferenceStore(
  initial: TuiPreferences = createFileTuiPreferenceStore(
    join(tmpdir(), 'kinu-tui-preferences-absent', 'tui.json'),
  ).read(),
): TuiPreferenceStore {
  let current = structuredClone(initial);
  return {
    read: () => current,
    write(preferences) {
      current = structuredClone(preferences);
    },
  };
}
