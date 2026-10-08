/** The state operations served over an actor's program state, as `state.*`. */
import type { ProgramStateStore } from '../identity/program-state';
import type { CodemodeProvider } from '../types/codemode';
import { serve } from '../operations/operation';
import { STATE } from '../operations/state';
import { codemodeNamespace } from './operation-surfaces';

export function createStateCodemodeProvider(state: ProgramStateStore): CodemodeProvider {
  return codemodeNamespace('state', [
    serve(STATE.get, async ({ key }) => state.get(key)),
    serve(STATE.set, async ({ key, value }) => {
      state.set(key, value);

      return null;
    }),
    serve(STATE.delete, async ({ key }) => {
      state.delete(key);

      return null;
    }),
    serve(STATE.list, async ({ prefix }) => state.list(prefix)),
  ]);
}
