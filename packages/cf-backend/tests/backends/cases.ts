/**
 * The shared behaviour cases. Each names the backend twins it drives: the same method on the cf actor
 * and on the CLI session, whose policy lives in core. `twins.test.ts` holds the covered names equal to
 * the twins the two classes actually share, less their declared adapter seams.
 */
import type { SharedBackend } from './backend';
import { CHECKPOINT_CASES } from './cases/checkpoints';
import { CONFIG_PLANE_CASES } from './cases/config-plane';
import { CONVERSATION_CASES } from './cases/conversation';
import { EVOLUTION_CASES } from './cases/evolution';
import { OWNER_DESK_CASES } from './cases/owner-desk';
import { WORK_LEDGER_CASES } from './cases/work-ledger';

export interface SharedCase {
  readonly title: string;
  /** Twin methods whose shared policy this case would catch a backend dropping. */
  readonly covers: readonly string[];
  run(backend: SharedBackend): Promise<void>;
}

export const SHARED_CASES: readonly SharedCase[] = [
  ...CONFIG_PLANE_CASES,
  ...OWNER_DESK_CASES,
  ...WORK_LEDGER_CASES,
  ...EVOLUTION_CASES,
  ...CONVERSATION_CASES,
  ...CHECKPOINT_CASES,
];
