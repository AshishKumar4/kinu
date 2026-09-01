import type { PayloadGrant, RangeReadIntent, UploadIntent } from '@kinu.run/devbox/durability/contracts';
import { DURABILITY_OPERATION_PHASES } from '@kinu.run/devbox/durability/contracts';

export type { PayloadGrant, RangeReadIntent, UploadIntent };

/**
 * The four payload transports this instrument compares, and the geometry every
 * one of them shares.
 *
 * The question: when a large payload has to move between a driver and durable
 * object storage, what does each transport COST — and specifically, how much of
 * the cost is the owning Durable Object sitting on the path with a base64
 * transform in its hands. The @cloudflare/sandbox source claims presigned
 * upload runs at "~24 MB/s throughput vs ~0.6 MB/s for base64 readFile"; that
 * claim ships as a docstring with no method, and `report.ts` labels it
 * unverified. This instrument is the measurement that would verify or retire it.
 *
 * The arms deliberately mirror the product's own surfaces:
 *
 *   do-base64            the current path — payload crosses the owning DO
 *                        boundary base64-encoded, chunked under the platform's
 *                        ~32 MiB structured-clone ceiling ('rpc.arg_bytes' in
 *                        packages/core/src/platform-catalog.ts)
 *   loopback-entrypoint  the same Worker calling its own WorkerEntrypoint
 *                        export (the ContainerProxy shape) over a service
 *                        binding, carrying raw bytes
 *   presigned-r2         an owner-issued PayloadGrant whose opaque value is a
 *                        SigV4 presigned URL; bytes go driver → R2 directly
 *   temp-s3-creds        short-lived scoped temporary S3 credentials, minted
 *                        locally from a parent R2 token as the current R2 docs
 *                        specify; unavailable only if that parent pair is absent
 */

/** The arms, in report order. A closed union: a name typo is a compile error. */
export const PAYLOAD_ARMS = [
  'do-base64',
  'loopback-entrypoint',
  'presigned-r2',
  'temp-s3-creds',
] as const;
export type PayloadArmId = (typeof PAYLOAD_ARMS)[number];

export interface ArmSpec {
  readonly id: PayloadArmId;
  readonly label: string;
  /** What the arm measures, stated once and rendered verbatim. */
  readonly question: string;
  /** Payload bytes traverse the owning Durable Object. */
  readonly crossesOwnerDO: boolean;
  /** Payload bytes traverse the WorkerEntrypoint service-binding hop. */
  readonly crossesProxyEntrypoint: boolean;
  /** Payload crosses its code boundary base64-encoded rather than raw. */
  readonly base64AtBoundary: boolean;
}

export const ARM_SPECS: readonly ArmSpec[] = [
  {
    id: 'do-base64',
    label: 'owning DO, base64 boundary',
    question: 'What does the current owning-DO base64 path cost per byte?',
    crossesOwnerDO: true,
    crossesProxyEntrypoint: false,
    base64AtBoundary: true,
  },
  {
    id: 'loopback-entrypoint',
    label: 'loopback WorkerEntrypoint',
    question: 'What does the proxy entrypoint hop add over a direct storage write?',
    crossesOwnerDO: false,
    crossesProxyEntrypoint: true,
    base64AtBoundary: false,
  },
  {
    id: 'presigned-r2',
    label: 'presigned direct R2',
    question: 'What is the floor when no Kinu code sits on the byte path?',
    crossesOwnerDO: false,
    crossesProxyEntrypoint: false,
    base64AtBoundary: false,
  },
  {
    id: 'temp-s3-creds',
    label: 'temporary S3 credentials',
    question: 'Does a scoped temporary credential change anything over a presigned URL?',
    crossesOwnerDO: false,
    crossesProxyEntrypoint: false,
    base64AtBoundary: false,
  },
];

export const armSpec = (id: PayloadArmId): ArmSpec =>
  ARM_SPECS.find((spec) => spec.id === id)!;

/**
 * The payload tiers, in MiB.
 *
 * CHOSEN AGAINST THE THING BEING MEASURED, not for round numbers. 8 MiB is
 * `SMALL_PUT_BYTES` in packages/devbox/src/object-store.ts — the exact line
 * where the owning DO stops buffering one copy and promotes to multipart, so
 * the smallest tier sits ON the routing boundary the product actually has. 64
 * and 256 MiB are the sizes a real workspace archive reaches: the deployed
 * failure quoted in snapshot-chain.ts moved a 700 MB delta, and a tier that
 * stopped at 100 MiB would have measured only the regime where nothing hurts.
 */
export const PAYLOAD_SIZES_MIB = [8, 64, 256] as const;
export type PayloadSizeMiB = (typeof PAYLOAD_SIZES_MIB)[number];

/**
 * The tier the concurrency probe runs at: the MIDDLE one.
 *
 * Derived, never retyped. The probe used to spell its size `10` at the call
 * site and again inside its own MiB/s arithmetic, so retiering the instrument
 * would have left it asking for a tier that no longer exists while still
 * dividing by the old number — a row that reads as a throughput and is not one.
 * The middle tier because the probe measures CONTENTION, not size: the
 * smallest tier finishes before concurrency can be observed and the largest
 * spends the run on bytes rather than on overlap.
 */
export const CONCURRENCY_TIER_MIB = PAYLOAD_SIZES_MIB[1];

export const MIB = 1024 * 1024;

/**
 * The owning-DO arm holds no plan and no part geometry, and that absence is
 * the point.
 *
 * This file used to carry `PART_SIZE_BYTES`, `base64ReadPlan` and a chunk/part
 * algebra, because that arm read bounded base64 chunks and welded them into
 * exact 16 MiB R2 multipart parts inside the Durable Object. None of it
 * described devbox: `snapshot-chain.ts` hands the container's byte stream
 * straight to `packages/devbox/src/object-store.ts`'s `putStream`, which does
 * its own routing. The arm now calls that function, so the geometry belongs to
 * the product and the numbers are the product's — and the fixture keeps no
 * second copy of a decision it does not own.
 */

/**
 * Cell outcome statuses. `corrupt` stands alone, not as a failure flavour:
 * a transfer that completed but returned wrong bytes is a different defect from
 * one that threw. `decision.ts` excludes both from ranking but names them
 * differently in the report.
 */
export const CELL_STATUSES = ['ok', 'unavailable', 'failed', 'corrupt'] as const;
export type CellStatus = (typeof CELL_STATUSES)[number];

/**
 * Every cell walks the shared durability operation phases. A transfer is
 * `intent` when its Upload/RangeRead intent exists, `transferring` while bytes
 * move, `sealed` once storage accepted it, `published` once the driver verified
 * digest AND length end to end, `failed` on any throw. `acknowledged` never
 * applies: this instrument has no downstream consumer to ack.
 */
export type CellPhase = (typeof DURABILITY_OPERATION_PHASES)[number];

/** Why an arm could not run, decided before any measurement is attempted. */
export interface Unavailability {
  readonly arm: PayloadArmId;
  readonly available: boolean;
  /** Required whenever `available` is false; rendered verbatim in the report. */
  readonly reason: string;
}
