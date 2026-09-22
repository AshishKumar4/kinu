import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFileTuiPreferenceStore,
  type TuiPreferences,
  type TuiPreferenceStore,
} from '../../src/tui/preferences';

/** In-memory preference store seeded from the production file store's own fallback, so defaults cannot drift. */
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
