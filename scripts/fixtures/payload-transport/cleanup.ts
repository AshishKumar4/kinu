/**
 * Cleanup: the admission gate for a finished run, never a score.
 *
 * A measurement that leaves a Worker on the edge, a container application
 * running, or an object in a bucket is not a completed measurement. These gates
 * decide whether the run may claim to be over; the driver maps them onto its
 * exit code. Every gate is evaluated from EVIDENCE the teardown itself
 * collected — listings, inventories, deletion results — never from "no error
 * was thrown".
 */

export interface CleanupGate {
  readonly id: string;
  readonly name: string;
  /** What the gate checks, stated so a human can verify it by hand. */
  readonly checks: string;
}

/** The gates, in execution order. */
export const CLEANUP_GATES: readonly CleanupGate[] = [
  {
    id: 'C1',
    name: 'multipart-ledger-drained',
    checks: 'every multipart upload id recorded in the durable ledger was aborted, '
      + 'and no in-progress upload remains under the run prefix',
  },
  {
    id: 'C2',
    name: 'bucket-state-empty',
    checks: 'the fixture inventory reports zero objects and zero bytes in the whole bucket',
  },
  {
    id: 'C3',
    name: 'container-application-absent',
    checks: 'the sandbox container is DESTROYED (not merely stopped) with its '
      + 'ephemeral DO state cleared, and the derived container application '
      + '(<worker>-sandbox) is deleted and confirmed absent — a Worker delete '
      + 'alone does NOT remove it',
  },
  {
    id: 'C4',
    name: 'fixture-worker-absent',
    checks: 'the fixture Worker is deleted and no longer answers on workers.dev',
  },
  {
    id: 'C5',
    name: 'bucket-deleted',
    checks: 'wrangler reports the run bucket gone',
  },
  {
    id: 'C6',
    name: 'local-material-cleared',
    checks: 'generated wrangler config, bearer token, credential material, and '
      + 'the durable ledger for this run are removed from disk',
  },
  {
    id: 'C7',
    name: 'cleanup-replay-idempotent',
    checks: 'running every step a second time finds nothing left to do and '
      + 'changes nothing',
  },
];
export const EXIT_OK = 0;
/** The run measured what it could but something failed mid-flight; artifact written. */
export const EXIT_RUN_FAILURE = 1;
/** ANY cleanup gate failed: resources of ours are still out there. */
export const EXIT_RESIDUE = 2;

export interface CleanupEvidence {
  readonly gate: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface CleanupVerdict {
  readonly residue: boolean;
  readonly failedGates: readonly string[];
  readonly steps: readonly CleanupEvidence[];
}

/**
 * Whether a wrangler deletion output PROVES absence. Only an explicit
 * not-found/already-deleted response counts. A WRANGLER_FAILED prefix alone
 * proves NOTHING — it wraps auth errors, network failures, and API faults
 * identically — so treating it as "gone" would let a live resource read as
 * clean. Callers pass the full output; the explicit phrases below are the ones
 * Cloudflare's CLI actually prints for absent resources.
 */
export function provesAbsence(output: string): boolean {
  if (!output.startsWith('WRANGLER_FAILED')) return true; // success output = deleted
  const lowered = output.toLowerCase();
  return lowered.includes('not found') || lowered.includes('could not find') || lowered.includes('already deleted') || lowered.includes('does not exist');
}

/**
 * Evaluate the teardown evidence against the gate list. AGGREGATION RULE: a
 * gate may carry MANY evidence rows (multi-pass teardown emits one per pass);
 * the gate passes only when at least one row exists AND EVERY row is ok. A
 * later failure therefore can never hide behind an earlier success, and a gate
 * with NO evidence counts as FAILED — silence is not cleanliness.
 */
export function evaluateCleanup(evidence: readonly CleanupEvidence[]): CleanupVerdict {
  const steps: CleanupEvidence[] = CLEANUP_GATES.map((gate) => {
    const rows = evidence.filter((entry) => entry.gate === gate.name);
    if (rows.length === 0) {
      return { gate: gate.name, ok: false, detail: 'no evidence was collected for this gate' };
    }
    const failures = rows.filter((row) => !row.ok);
    if (failures.length > 0) {
      return { gate: gate.name, ok: false, detail: `${failures.length}/${rows.length} check(s) failed; last: ${failures[failures.length - 1]!.detail}` };
    }
    return { gate: gate.name, ok: true, detail: `${rows.length} check(s) passed` };
  });
  const failed = steps.filter((step) => !step.ok).map((step) => step.gate);
  return { residue: failed.length > 0, failedGates: failed, steps };
}

/** The driver's exit code for a run, given its failure (if any) and verdict. */
export function exitFor(runFailure: string | null, cleanup: CleanupVerdict): number {
  if (cleanup.residue) return EXIT_RESIDUE;
  if (runFailure !== null) return EXIT_RUN_FAILURE;
  return EXIT_OK;
}
