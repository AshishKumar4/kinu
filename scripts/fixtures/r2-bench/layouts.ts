/**
 * The four workspace layouts under measurement, and the s3fs option sets that
 * define three of them.
 *
 * This file is the answer to "which options, exactly" — declared once, consumed
 * by the driver, printed into the report, and pinned by
 * `scripts/bench-r2-workspace.test.ts`. A layout whose options live only in a
 * shell command in someone's terminal is not a reproducible measurement.
 *
 * ── What the SDK already applies, and what a caller may still change ────────
 *
 * `mountBucketR2Egress` (@cloudflare/sandbox 0.12.8,
 * dist/sandbox-CPj2jsbz.js:8084-8092) builds the `-o` argument in this order:
 *
 *   { passwd_file, ...R2_DEFAULT_S3FS_OPTIONS, ...caller, use_path_request_style,
 *     url, ahbe_conf, ...(readOnly ? { ro } : {}) }
 *
 * Three consequences, all load-bearing for the option sets below:
 *
 *   1. `R2_DEFAULT_S3FS_OPTIONS` — `stat_cache_expire=60`, `enable_noobj_cache`,
 *      `multipart_size=5` (dist:7220-7224) — is spread BEFORE the caller's, so
 *      a caller CAN raise them. `nomixupload` arrives from the r2 provider
 *      defaults (dist:4809) and merges by flag name (dist:4816-4828).
 *   2. `use_path_request_style`, `url`, `ahbe_conf` and `ro` are spread AFTER
 *      the caller's, so a caller CANNOT change them. `passwd_file` and `url`
 *      are additionally refused up front (dist:8012-8022) with
 *      InvalidMountConfigError.
 *   3. `url=http://r2.internal` means every s3fs request is intercepted by the
 *      Worker and served from the R2 BINDING. No S3 credential exists in the
 *      container: the password file holds the literal dummies "x"/"x"
 *      (dist:8064-8067). Any option that presupposes real credentials or TLS to
 *      a public endpoint is therefore meaningless here — see REJECTED below.
 */

/** Where each layout puts the tree the workloads run against. */
export const NATIVE_ROOT = '/workspace';
export const R2_MOUNT_PATH = '/r2bench';
export const OVERLAY_LOWER_MOUNT = '/r2lower';
export const OVERLAY_MERGED = '/overlay';
export const S3FS_CACHE_DIR = '/var/cache/s3fs-bench';

/**
 * Options the SDK forces after the caller's, so requesting them is at best a
 * no-op and at worst a mount failure. Pinned so a future option set cannot
 * quietly include one and appear to have taken effect.
 */
export const SDK_FORCED_S3FS_OPTIONS = [
  'use_path_request_style',
  'url',
  'ahbe_conf',
  'ro',
] as const;

/** Options the SDK refuses outright, with InvalidMountConfigError. */
export const SDK_REFUSED_S3FS_OPTIONS = ['passwd_file', 'url'] as const;

/** What the SDK applies when the caller passes nothing. Layout `r2-uncached`
 *  IS this set: it is the honest "what you get out of the box" arm. */
export const SDK_DEFAULT_R2_S3FS_OPTIONS = [
  'stat_cache_expire=60',
  'enable_noobj_cache',
  'multipart_size=5',
  'nomixupload',
] as const;

/**
 * The tuned arm. Every entry is here for a reason that survives being asked
 * "what would happen without it", and each reason is a measurable prediction
 * the report either confirms or refutes.
 */
export const TUNED_S3FS_OPTIONS = [
  // Whole-object local cache. Without it every read of a file already read is
  // another GET, so a re-read is network-bound and `git status` over a tree
  // pays for the tree twice. This is the single option the cached arm exists
  // to measure.
  `use_cache=${S3FS_CACHE_DIR}`,
  // The cache is on the container's 8000 MB disk (container.instance.disk),
  // shared with /workspace and any toolchain. s3fs evicts nothing on its own:
  // without a floor it fills the disk and then every write fails with ENOSPC,
  // which is a worse failure than a cache miss.
  'ensure_diskfree=2048',
  // Drop the cache at unmount. A benchmark that leaves gigabytes behind is not
  // a benchmark that "leaves no resources", and a warm cache surviving into the
  // next arm would make that arm's cold numbers a lie.
  'del_cache',
  // 60 s expiry is shorter than a single long workload, so a tree walked twice
  // re-STATs everything the second time. 900 s outlives every phase here.
  'stat_cache_expire=900',
  // s3fs's default entry ceiling is 100000. A 10k-file phase plus directory
  // markers plus negative entries crosses it, and eviction inside a phase looks
  // like a cache that does not work.
  'max_stat_cache_size=400000',
  // Kept explicitly rather than inherited: negative-lookup caching is what makes
  // module resolution survivable, since a failed resolve stats many paths that
  // do not exist. Listing it here means the tuned arm still has it if the SDK's
  // defaults ever change.
  'enable_noobj_cache',
  // 5 MiB parts on a 100 MiB object is 20 sequential round trips. 16 MiB is 7.
  'multipart_size=16',
  // Parallelism for those parts. Deliberately 8 and not 32: every part is an
  // intercepted request served by the Worker, and `worker.simultaneous_connections`
  // is SIX per invocation with the seventh QUEUED rather than refused
  // (platform-catalog.ts:1320-1338), so a large value buys latency, not
  // throughput. 8 is one step past the documented ceiling so the report can
  // say whether the ceiling binds here at all.
  'parallel_count=8',
  // Parallel HEADs while listing. A directory listing is one LIST plus a HEAD
  // per entry, so this bounds how fast a 1k-entry directory can be stat'd.
  'multireq_max=20',
  // Fewer LIST round trips per directory.
  'list_object_max_keys=1000',
  // R2 needs it and the provider defaults supply it; restated so the tuned arm
  // is a complete description of itself.
  'nomixupload',
] as const;

/**
 * Configurations considered and REJECTED, with the reason each was rejected.
 * The acceptance criterion asks for these by name, and a rejected option with
 * no reason is an opinion.
 */
export const REJECTED_S3FS_OPTIONS: readonly { option: string; reason: string }[] = [
  {
    option: 'nomultipart',
    reason:
      'Forces every write into one PUT. The intercepted PUT path buffers the object in '
      + 'the Worker isolate, whose ceiling is 128 MB (worker.isolate.memory), so a '
      + '100 MiB write moves from "slow" to "resets the isolate". Rejected on the '
      + 'failure mode, not the speed.',
  },
  {
    option: 'sigv2',
    reason:
      'R2 is SigV4-only. Moot regardless: the request never reaches R2 as S3 — it is '
      + 'intercepted at http://r2.internal and served through the binding, so the '
      + 'signature is never verified. An option that changes nothing observable is '
      + 'noise in a config someone will later trust.',
  },
  {
    option: 'no_check_certificate',
    reason:
      'The endpoint is plain http to an internal host. There is no certificate to skip. '
      + 'Carrying it would train the next reader to add it where there IS one.',
  },
  {
    option: 'use_cache without ensure_diskfree',
    reason:
      'The cache shares the 8000 MB container disk with /workspace. s3fs does not bound '
      + 'it, so the arm ends in ENOSPC on an unrelated write and the benchmark reports a '
      + 'write failure instead of a cache result.',
  },
  {
    option: 'parallel_count=32',
    reason:
      'Six connections may await headers per invocation and the seventh QUEUES '
      + '(worker.simultaneous_connections). Above the ceiling the extra parts wait, so the '
      + 'number is bought as latency and the option reads as a tuning win that is not one. '
      + 'Measured at 8 instead, one step past the ceiling, so the report can state whether '
      + 'the ceiling binds.',
  },
  {
    option: 'allow_other',
    reason:
      'Requires user_allow_other in /etc/fuse.conf, which the sandbox image does not set. '
      + 'The mount is single-uid; the option adds a failure mode and no capability.',
  },
  {
    option: 'notsup_compat_dir',
    reason:
      'Stops s3fs recognising zero-byte directory markers. The egress handler and every '
      + 'other writer of this bucket create them, so the option makes directories written '
      + 'by one path invisible to another — silent, and exactly the class of bug a storage '
      + 'benchmark exists to avoid shipping.',
  },
  {
    option: 'dbglevel=info / curldbg',
    reason:
      'Per-request logging inside the measured path. It changes the number it is supposed '
      + 'to explain. Available for triage, never for a reported run.',
  },
];

export type LayoutId = 'native' | 'r2-uncached' | 'r2-tuned' | 'overlay';

export interface LayoutSpec {
  readonly id: LayoutId;
  /** One line, printed in the report table. */
  readonly label: string;
  /** Directory the workloads run in. */
  readonly root: string;
  /** Absent for the native control. */
  readonly mount?: {
    readonly mountPath: string;
    /** Passed to `mountBucket`. Must start with '/'. Scoped DO-side by the
     *  egress handler, so no path mistake inside the container can write
     *  outside it. */
    readonly prefix: string;
    readonly readOnly: boolean;
    readonly s3fsOptions: readonly string[];
  };
  /** True when the layout needs an explicit sync to make writes durable. */
  readonly needsSync: boolean;
  /** What this arm is here to answer. */
  readonly question: string;
}

/**
 * `runId` scopes every object this benchmark writes, and the scoping is
 * enforced by the platform rather than by discipline: the driver calls
 * `mountBucket('BACKUP_BUCKET', path, { prefix: '/bench/<runId>', … })`, and
 * the credential-less R2 path applies that prefix in the Durable Object
 * (`getR2EgressParams` → `normalizeMountPrefix`, dist:8006-8010, 5615, 5626).
 * So the mount ROOT is the run scope: a wrong path inside the container writes
 * to the wrong key under `bench/<runId>/` and cannot escape it. Teardown
 * deletes exactly this prefix.
 */
export function benchKeyPrefix(runId: string): string {
  return `bench/${runId}/`;
}

/** The `prefix` form `mountBucket` requires: leading '/', no trailing '/'. */
export function mountPrefixFor(runId: string): string {
  return `/bench/${runId}`;
}

export function layoutsFor(runId: string): readonly LayoutSpec[] {
  const prefix = mountPrefixFor(runId);
  return [
    {
      id: 'native',
      label: 'native /workspace (control)',
      root: `${NATIVE_ROOT}/bench-${runId}`,
      needsSync: false,
      question: 'What does the container disk do, so every R2 number has a denominator.',
    },
    {
      id: 'r2-uncached',
      label: 'R2 s3fs, SDK defaults',
      root: `${R2_MOUNT_PATH}/uncached`,
      mount: {
        mountPath: R2_MOUNT_PATH,
        prefix,
        readOnly: false,
        s3fsOptions: [],
      },
      needsSync: false,
      question: 'What a workspace on R2 costs with no tuning at all.',
    },
    {
      id: 'r2-tuned',
      label: 'R2 s3fs, native use_cache + tuned stat/no-object/parallel/multipart',
      root: `${R2_MOUNT_PATH}/tuned`,
      mount: {
        mountPath: R2_MOUNT_PATH,
        prefix,
        readOnly: false,
        s3fsOptions: TUNED_S3FS_OPTIONS,
      },
      needsSync: false,
      question: 'How much of the uncached gap the documented options actually close.',
    },
    {
      id: 'overlay',
      label: 'read-only R2 lower + native writable upper, explicit sync',
      root: `${OVERLAY_MERGED}/work`,
      mount: {
        mountPath: OVERLAY_LOWER_MOUNT,
        prefix,
        readOnly: true,
        s3fsOptions: TUNED_S3FS_OPTIONS,
      },
      needsSync: true,
      question:
        'Whether native write speed plus an explicit sync beats writing through FUSE, '
        + 'and what the sync costs.',
    },
  ];
}

/**
 * The mount a layout needs, as an identity over (mountPath, prefix, readOnly,
 * options). `mountBucketR2Egress` REFUSES a second mount of the same binding at
 * a different prefix or a different readOnly value (dist:8058-8061), so arms
 * cannot be stacked: the driver unmounts before every mount. This function is
 * what lets it skip a remount when two consecutive arms genuinely want the same
 * mount, and never skip one when they do not.
 */
export function mountSignature(spec: LayoutSpec): string | null {
  if (spec.mount === undefined) return null;
  const options = [...spec.mount.s3fsOptions].sort().join(',');
  return `${spec.mount.mountPath}|${spec.mount.prefix}|${spec.mount.readOnly}|${options}`;
}
