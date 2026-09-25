/**
 * The twin check (BD-010): every public method the cf actor and the CLI session both expose is one
 * operation, so each is driven by a shared case on both backends or named here as an adapter seam
 * with the reason its answer is the platform's own. The twins are the compiler's view of the two
 * classes: a method added to both without a classification fails typecheck, here.
 */
import { describe, expect, test } from 'bun:test';
import type { OrchestratorAgent } from '../../src/orchestrator';
import type { LocalAgentSession } from '../../../cli-backend/src/local-session';
import { SHARED_CASES } from './cases';

type Shared = Extract<keyof OrchestratorAgent, keyof LocalAgentSession>;

/** Public methods of both classes under one name. */
type PublicTwin = {
  [K in Shared]: OrchestratorAgent[K] extends (...args: never[]) => void
    ? LocalAgentSession[K] extends (...args: never[]) => void ? K : never
    : never
}[Shared];

const SHARED = 'driven by a shared case';

/** Every twin, classified: a shared case drives it, or the reason each backend answers alone. */
const TWINS = {
  setReasoningEffort: SHARED, getReasoningEffort: SHARED, setModel: SHARED, getStoredModelSpec: SHARED,
  getProviderAccounts: SHARED, setProviderAccount: SHARED,
  setRole: SHARED, getShellApprovalMode: SHARED, setShellApprovalMode: SHARED,
  getShellApprovalGrants: SHARED, revokeShellApprovalGrants: SHARED,
  setAlwaysActiveSkills: SHARED, getAlwaysActiveSkills: SHARED,
  readInstructionApproval: SHARED, approveInstruction: SHARED, listInstructionApprovals: SHARED,
  revokeInstruction: SHARED, listDeferredApprovals: SHARED, decideDeferredApprovals: SHARED,
  listBackgroundJobs: SHARED, jobResult: SHARED, cancelBackgroundJob: SHARED,
  createTimerTrigger: SHARED, cancelTrigger: SHARED, listRuns: SHARED, getRunEvents: SHARED,
  getShadowStatus: SHARED, applyScaffoldDecision: SHARED, runScaffoldGepaOptimization: SHARED,
  getEvolutionChangelog: SHARED, revertChangelogEntry: SHARED, markChangelogSeen: SHARED,
  latestAlternateTakes: SHARED, pickAlternateTake: SHARED,
  getActivePlanReview: SHARED, savePlanReviewAnnotations: SHARED, decidePlanReview: SHARED,
  requestRefinement: SHARED, listRefinements: SHARED, showRefinement: SHARED, decideRefinement: SHARED,
  send: SHARED, revertConversation: SHARED,
  broadcast: 'cf overrides Agent.broadcast over its connection tags; the CLI emits to its one listener',
  checkpointStatus: 'cf reads the connected device\'s checkpoint store over deviceRpc; the CLI reads its own machine\'s',
  listFileCheckpoints: 'the store lives where the files are: a connected device for cf, this machine for the CLI',
  planFileRestore: 'the store lives where the files are: a connected device for cf, this machine for the CLI',
  restoreFileCheckpoint: 'the store lives where the files are: a connected device for cf, this machine for the CLI',
} as const satisfies Record<PublicTwin, string>;

const twins = Object.entries(TWINS);

describe('the twin check', () => {
  test('every twin a shared case claims is one this check drives, and every driven twin is claimed', () => {
    const driven = twins.filter(([, reason]) => reason === SHARED).map(([name]) => name).sort();
    const claimed = [...new Set(SHARED_CASES.flatMap((shared) => shared.covers))].sort();

    expect(claimed).toEqual(driven);
  });
});
