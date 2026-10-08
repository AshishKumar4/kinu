/**
 * The shared behaviour cases: each drives the same operation on the cf actor and on the CLI session, whose
 * policy lives in core.
 */
import type { BackendOpening, SharedBackend } from './backend';
import { CHECKPOINT_CASES } from './cases/checkpoints';
import { CONFIG_PLANE_CASES } from './cases/config-plane';
import { CONVERSATION_CASES } from './cases/conversation';
import { EVOLUTION_CASES } from './cases/evolution';
import { MEMORY_CASES } from './cases/memory';
import { OWNER_DESK_CASES } from './cases/owner-desk';
import { WORK_LEDGER_CASES } from './cases/work-ledger';

export interface SharedCase {
  readonly title: string;
  /** The machine the backend is opened on, where a case needs one unlike the default. */
  readonly opens?: () => BackendOpening;
  run(backend: SharedBackend): Promise<void>;
}

export const SHARED_CASES: readonly SharedCase[] = [
  ...CONFIG_PLANE_CASES,
  ...OWNER_DESK_CASES,
  ...WORK_LEDGER_CASES,
  ...EVOLUTION_CASES,
  ...CONVERSATION_CASES,
  ...CHECKPOINT_CASES,
  ...MEMORY_CASES,
];
