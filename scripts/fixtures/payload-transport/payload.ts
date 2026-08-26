/**
 * Run identity and the byte accounting.
 *
 * THE DRIVER GENERATES NO PAYLOAD BYTES. Deterministic payloads are produced
 * inside the benchmark container by `container-harness.ts` (the same mulberry32
 * integer math, seeded identically), and the driver learns only each file's
 * digest and exact length from the seed step. What remains here is the
 * arithmetic the report needs: where bytes went, counted rather than inferred.
 */


/**
 * Run identity. Unique per invocation so a crashed run can never collide with
 * a live one, and so teardown deletes exactly what its own run created.
 */
export interface RunIdentity {
  readonly runId: string;
  readonly workerName: string;
  readonly bucketName: string;
}

const NAME_STEM = 'kinu-payload-bench';

export function runIdentity(now = new Date(), randomHex = randomSuffix()): RunIdentity {
  const stamp = now.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const suffix = `${stamp.slice(2)}x${randomHex}`;
  return {
    runId: `${stamp}-${randomHex}`,
    workerName: `${NAME_STEM}-${suffix}`,
    bucketName: `${NAME_STEM}-${suffix}`,
  };
}

/** Six hex characters — enough entropy that two live runs never share a name. */
function randomSuffix(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 6);
}

/** Names must satisfy both wrangler Worker and R2 bucket naming constraints. */
export function isValidResourceName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,52}$/.test(name);
}

/**
 * Base64 expansion at a code boundary: every raw byte triple becomes four
 * ASCII characters. This is measured wire volume for the do-base64 arm — it is
 * what the current owning-DO path puts across its RPC boundary.
 */
export const base64Length = (rawBytes: number): number => Math.ceil(rawBytes / 3) * 4;

/**
 * Where the bytes went for one transfer on one arm, counted from the arm's
 * declared shape rather than inferred from platform telemetry that does not
 * exist.
 */
export interface TransitBytes {
  /** Raw payload volume. */
  readonly payloadBytes: number;
  /** Bytes carried AS base64 text across a code boundary (do-base64 only). */
  readonly base64CarriedBytes: number | null;
  /** Bytes through the owning Durable Object boundary. Null when none crossed. */
  readonly ownerBoundaryBytes: number | null;
  /** Bytes through the WorkerEntrypoint interception hop. Same rule. */
  readonly proxyBoundaryBytes: number | null;
  /**
   * CPU time consumed by the transfer, in milliseconds.
   * ALWAYS null today: workerd exposes no per-request CPU counter to the
   * request path, and Workers analytics aggregates cannot attribute CPU to one
   * arm of one run. Reported as unknown rather than inferred — see the CPU note
   * in `report.ts`.
   */
  readonly cpuMs: null;
}

export function transitFor(
  arm: { crossesOwnerDO: boolean; crossesProxyEntrypoint: boolean; base64AtBoundary: boolean },
  sizeBytes: number,
): TransitBytes {
  const carried = arm.base64AtBoundary ? base64Length(sizeBytes) : null;
  return {
    payloadBytes: sizeBytes,
    base64CarriedBytes: carried,
    ownerBoundaryBytes: arm.crossesOwnerDO ? sizeBytes : null,
    proxyBoundaryBytes: arm.crossesProxyEntrypoint ? sizeBytes : null,
    cpuMs: null,
  };
}
