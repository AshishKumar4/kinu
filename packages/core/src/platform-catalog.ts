/**
 * What the Cloudflare platform actually does, and how we know.
 *
 * This is a MODULE and not a document because the failure it replaces is
 * documentary. `~/Nimbus/packages/worker/src/constants.ts` justifies a
 * load-bearing 128 MiB production ceiling with "per
 * a gitignored internal research note (§6, invariant I1)". That file lived under
 * a gitignored `docs/research/`, was never committed, and is gone. The citation
 * shipped, in ten worktree copies, and the evidence did not — and the number it
 * defended turns out to be wrong, which no reader could have discovered.
 *
 * Its sibling a second such note was compiled from Cloudflare's INTERNAL
 * repository. Neither is to be reconstructed here, and nothing in this file
 * cites a `cf-*-dossier` section: entries cite the MEASUREMENT. The same
 * shape bit this repo from the other direction: `lean/Proteus/Execution/
 * ToolSystem.lean` still proves completeness over a five-tool surface that no
 * longer exists. Prose beside code drifts from code; prose generated FROM code
 * cannot.
 *
 * So there is exactly one copy of every number here, production constants
 * import it, and `scripts/platform-catalog.ts --report` renders the human
 * catalog on demand. Nothing in `docs/` restates it.
 *
 * ## Reading an entry
 *
 * `evidence` is the whole point. "Cloudflare documents 128 MB" and "we measured
 * 128 MB" are different facts and must read differently — an unlabelled number
 * is precisely what produced a dangling `§6 invariant I1`. The labels are the
 * ones `~/Nimbus/scratchpad/jit-limits-verification.md` used, which is the
 * methodology this file copies: probe the claim on a real deployed Worker, read
 * workerd's C++ when the probe needs explaining, and let the write-up refute
 * the claims it set out to confirm.
 *
 *   proven-by-probe        ran against a real Workers runtime and observed it
 *   proven-by-source       read in workerd / a dependency's own source
 *   observed-in-production incident or log evidence, not a designed probe
 *   documented             Cloudflare publishes it; `provenance` is the URL
 *   inferred               follows from something proven, not itself observed
 *   speculative            plausible, unverified — never act on one
 *
 * `origin` separates the platform's number from ours. Nimbus's 28 MiB RPC
 * payload cap is `self-imposed` beneath a `platform` 32 MiB ceiling, and
 * conflating the two is how a self-imposed budget becomes folklore about the
 * runtime.
 *
 * `trigger` is the machine-checkable predicate, `observable` the VERBATIM
 * string the application sees, and `firstPartySignal` whether we get told at
 * all. A fault with no signal must be modelled as silent disappearance; a
 * simulator that invents its own error string tests nothing.
 *
 * ## If you add an entry by probing
 *
 * Five rules, each of which exists because breaking it already produced a false
 * published claim in this ecosystem.
 *
 *   1. PIN THE CONFIG TO PRODUCTION. A probe whose `compatibility_date` or flag
 *      set differs from what we ship measures a different platform. One
 *      one-month compat-date difference in a Nimbus probe produced a confident,
 *      false, table-generating claim that request-time wasm compilation is
 *      blocked even at module top level — false for every date Nimbus ships.
 *      Record the date and flags in the entry.
 *   2. STATE THE LABEL PER CLAIM, NOT PER WRITE-UP. A probe usually establishes
 *      a behaviour while a threshold comes from reading source; those are two
 *      labels. `do.storage.sync_kv` is `proven-by-source` for that reason.
 *   3. RECORD THE WORDING. If you watched it fail, copy the string. The gate
 *      refuses a `proven-by-probe` entry that claims a first-party signal and
 *      supplies no verbatim observable.
 *   4. NEVER FILL IN A MISSING HALF. `facet.module_text_bytes` was a two-point
 *      boots/fails bracket whose lower bound was edited out of the Nimbus
 *      source; an earlier draft of that entry GUESSED it, in this file, while
 *      building the gate against exactly that. A gap is a legitimate value.
 *   5. A PROBE THAT EXCEEDS A DOCUMENTED LIMIT MEANS THE DOCUMENTATION IS
 *      CONSERVATIVE, NOT THAT THE LIMIT MOVED. `do.storage.bytes` is the worked
 *      example: the published 10 GB is 10^10 bytes, a deployed bisect put the
 *      wall between 10.58 GB and 11.6 GB, and 10 GiB (10,737,418,240) sits
 *      inside that window. So 10 GiB describes where the wall is and is not a
 *      number anyone may design to. Keep `limit` at the published figure and put
 *      the measurement in `measurements`.
 *   6. `wrangler dev` IS NOT PRODUCTION. It does not enforce the isolate memory
 *      cap (a probe isolate reached 822 MiB unkilled) and it collects no traces
 *      (`tracing.inert_locally`). A local run measures bytes and API surface,
 *      never an enforcement point.
 *
 * Deploying a throwaway Worker is the right tool and the pattern is proven:
 * account-pinned, `workers.dev` only, `preview_urls: false`, deleted at the end,
 * with the deletion recorded. Propose it before spending the account's
 * resources.
 *
 * ## What this file is not
 *
 * It is not a budget. Nothing here caps the agent — the entries with
 * `origin: 'self-imposed'` are recorded because they are frequently mistaken
 * for platform facts, not because this file endorses them.
 */

/** How a claim was established. Additive: never re-purpose an existing value. */
export type EvidenceLabel =
  | 'proven-by-probe'
  | 'proven-by-source'
  | 'observed-in-production'
  | 'documented'
  | 'inferred'
  | 'speculative';

/**
 * Labels a fault injector may treat as real behaviour. `documented` is
 * deliberately absent: a published number tells you the threshold, not what the
 * runtime does at it, and injecting a documented-but-unobserved failure makes a
 * simulation easier than production rather than harder.
 */
export const PROVEN_LABELS: readonly EvidenceLabel[] = [
  'proven-by-probe',
  'proven-by-source',
  'observed-in-production',
];

export type LimitUnit = 'bytes' | 'ms' | 'count';

/** A threshold in its base unit. Never a human spelling: call sites must not
 *  convert, and "128 MB" vs "128 MiB" is a real unresolved ambiguity recorded
 *  in `notes` rather than hidden in a multiplier. */
export interface PlatformQuantity {
  readonly value: number;
  readonly unit: LimitUnit;
}

/** A verbatim signature the application sees. Copied, never paraphrased — the
 *  difference between a retryable reset and an OOM that must surface is the
 *  exact wording. */
export interface PlatformObservable {
  readonly context: string;
  readonly message: string;
}

/**
 * What a threshold actually protects — the axis this catalog was missing.
 *
 * A METRIC IS ONLY AS REAL AS THE SCOPE IT IS LABELLED WITH. A correct value
 * with the wrong scope reads as evidence and is not, which is strictly MORE
 * dangerous than a missing one because it survives review. `read-models/files.ts`
 * caps a response at 512 KiB AFTER the whole file is resident;
 * `read-models/workspace-diff.ts` bounds 400 files at 256 KiB each, a product of
 * 102.4 MiB under a ceiling it never mentions; `do.storage.size_is_per_object`
 * returns a true byte count for one object against a quota shared by dozens.
 * Every one of those looks like memory protection and none of it is.
 *
 * So the rule generalises past this union: IF A NUMBER HAS A SCOPE, THE TYPE
 * MUST CARRY IT. Naming the axis makes "this constant cannot protect an isolate,
 * it only truncates a reply" a statement the type system participates in, and
 * `bounds` is non-nullable whenever `limit` is present so a threshold cannot be
 * declared without one.
 */
export type BoundsKind =
  | 'peak-resident'
  | 'wire'
  | 'row'
  | 'query'
  | 'response'
  | 'storage'
  | 'bundle'
  | 'duration'
  | 'concurrency'
  | 'count';

export interface PlatformMeasurement {
  readonly scenario: string;
  readonly value: number;
  readonly unit: LimitUnit;
}

export interface PlatformFact {
  /** The thing being bounded or described, in one line. */
  readonly subject: string;
  /** The threshold, or null when the entry is a behaviour rather than a bound. */
  readonly limit: PlatformQuantity | null;
  readonly origin: 'platform' | 'self-imposed';
  /** What the threshold protects, or null when the entry bounds nothing. */
  readonly bounds: BoundsKind | null;
  readonly evidence: EvidenceLabel;
  /** A URL for `documented`; otherwise `path:line` in this repo, `~/Nimbus`, or
   *  a named transcript locator. Never empty. */
  readonly provenance: string;
  /** ISO date the evidence was obtained, not the date it was written down. */
  readonly date: string;
  /** The machine-checkable predicate that fires this fault. */
  readonly trigger: string;
  /** What the runtime does. Observable consequence, not a warning. */
  readonly onBreach: string;
  /** FAILURE signatures only, verbatim. Not return values, not log lines a
   *  healthy path emits: a fault injector reads this, and anything in here that
   *  is not what breaching looks like makes the simulation wrong. */
  readonly observable: readonly PlatformObservable[];
  /** False when the platform terminates us with nothing we can catch or read. */
  readonly firstPartySignal: boolean;
  readonly notes?: string;
  readonly measurements?: readonly PlatformMeasurement[];
  /** Named allocation sources, for a ceiling that can only be estimated. */
  readonly contributors?: readonly string[];
  /** Entries whose sources disagree with this one. Never silently reconciled. */
  readonly conflictsWith?: readonly string[];
  /** A path in THIS repo already on course to breach this entry. Present means a
   *  live defect has been located, not that one is suspected — the value names
   *  the file and the mechanism so it can be closed rather than remembered. */
  readonly knownBreachPath?: string;
}

const KiB = 1024;
const MiB = 1024 * 1024;

/**
 * Cloudflare writes storage sizes in decimal — "1 GB = 1,000,000,000 bytes and
 * not a gibibyte", footnote 2 of the Durable Objects limits page — so a
 * documented `MB` is taken as 10^6. Nimbus's own comments write the same
 * ceilings in `MiB`. Where the two readings differ the SMALLER is used, because
 * over-reading a ceiling is the direction that fails in production.
 */
const MB = 1000 * 1000;
const GB = 1000 * 1000 * 1000;

const CF_DO_LIMITS = 'https://developers.cloudflare.com/durable-objects/platform/limits/';
const CF_DO_STATE = 'https://developers.cloudflare.com/durable-objects/api/state/';
const CF_WORKER_LIMITS = 'https://developers.cloudflare.com/workers/platform/limits/';
const NIMBUS_JIT_PROBE = '~/Nimbus/scratchpad/jit-limits-verification.md';

/** Every documented entry was read from the live docs on this date. */
const DOCS_READ = '2026-08-17';

export const PLATFORM_CATALOG = {
  // ── Memory ────────────────────────────────────────────────────────────

  'container.instance.vcpu': {
    subject: 'vCPU allocated to each Kinu sandbox container',
    limit: { value: 2, unit: 'count' },
    origin: 'self-imposed',
    bounds: 'count',
    evidence: 'proven-by-source',
    provenance: 'packages/cf-backend/wrangler.jsonc:121-124',
    date: '2026-08-22',
    trigger: 'a sandbox workload needs more than 2 CPU cores',
    onBreach: 'the workload receives no additional cores and remains bounded by the container allocation',
    observable: [],
    firstPartySignal: false,
  },

  'container.instance.memory': {
    subject: 'Memory allocated to each Kinu sandbox container',
    limit: { value: 6_144 * MiB, unit: 'bytes' },
    origin: 'self-imposed',
    bounds: 'peak-resident',
    evidence: 'proven-by-source',
    provenance: 'packages/cf-backend/wrangler.jsonc:121-124',
    date: '2026-08-22',
    trigger: 'sandbox resident memory exceeds the configured 6144 MiB allocation',
    onBreach: 'the container process is terminated by its memory limit',
    observable: [],
    firstPartySignal: false,
    measurements: [
      { scenario: 'deployed container free -m total', value: 6_185 * MiB, unit: 'bytes' },
    ],
  },

  'container.instance.disk': {
    subject: 'Disk allocated to each Kinu sandbox container',
    limit: { value: 8_000 * MB, unit: 'bytes' },
    origin: 'self-imposed',
    bounds: 'storage',
    evidence: 'proven-by-source',
    provenance: 'packages/cf-backend/wrangler.jsonc:121-124',
    date: '2026-08-22',
    trigger: 'sandbox files consume the configured 8000 MB disk allocation',
    onBreach: 'writes fail because the container disk is full',
    observable: [],
    firstPartySignal: false,
  },

  'worker.isolate.memory': {
    subject: 'Memory per V8 isolate: JavaScript heap plus WebAssembly allocations',
    limit: { value: 128 * MB, unit: 'bytes' },
    origin: 'platform',
    bounds: 'peak-resident',
    evidence: 'documented',
    provenance: `${CF_WORKER_LIMITS}#memory`,
    date: DOCS_READ,
    trigger: 'isolate resident bytes > 128 MB',
    onBreach:
      'the runtime lets in-flight requests complete and creates a fresh isolate for '
      + 'subsequent requests; under high load it may cancel incoming requests instead',
    observable: [
      { context: 'client', message: 'Worker exceeded resource limits' },
      { context: 'buffering a response body', message: 'Memory limit would be exceeded before EOF' },
      { context: 'Logpush / analytics invocation outcome', message: 'exceededMemory' },
    ],
    firstPartySignal: true,
    notes:
      'REFUTED AS THE OPERATIVE CEILING FOR A DURABLE OBJECT. This is the published number '
      + 'and it is catalogued as such, but two independent probes on the owner\'s own account '
      + 'put the real wall far higher: 248 MiB allocates and 256 MiB fails '
      + '(do.isolate.oom_catchable), and roughly 180-200 MiB is the wall for memory that must '
      + 'SURVIVE ACROSS RPCs (do.isolate.reset_silent). Nimbus halved its own budget to 64 MiB '
      + 'against this figure, so the cost of the missing evidence was a 4x-conservative '
      + 'production constant nobody could re-derive. Per-isolate, not per-invocation. '
      + 'Cloudflare writes "128 MB" and Nimbus writes "128 MiB"; the smaller decimal reading '
      + 'is kept here because it is the published claim, not because it is the ceiling. '
      + 'Nimbus\'s own heavy-alloc-coord.ts:9-16 still calls its 128 MiB headroom calculation '
      + '"aspirational" at HEAD. One probe DID land on 128 MiB and it is narrower than the docs '
      + 'claim: do.isolate.transient_alloc_reset reset a DO at exactly 128 MiB of '
      + 'allocate-and-free, in the DO context and not in a facet. So the best current reading is '
      + '~128 MiB for the supervisor DO isolate — possibly less, if it is shared — while facets '
      + 'get substantially more. And the whole family is confounded by '
      + 'worker.memory_kill_is_burst_sensitive: the kill is rate-sensitive, so none of these '
      + 'numbers is a static capacity.',
    conflictsWith: ['do.isolate.oom_catchable', 'do.isolate.reset_silent'],
  },

  'do.isolate.oom_catchable': {
    subject: 'The single-burst allocation wall for a Durable Object isolate, which throws and is catchable',
    limit: { value: 256 * MiB, unit: 'bytes' },
    origin: 'platform',
    bounds: 'peak-resident',
    evidence: 'proven-by-probe',
    provenance:
      '~/Nimbus/scratchpad/fork-m1-report.md §4 rung table '
      + '(worker nimbus-probe-fork-m1, owner account, colo IAD)',
    date: '2026-07-16',
    trigger: 'a single burst allocation of roughly 256 MiB inside one Durable Object isolate',
    onBreach: 'a catchable throw; the object survives and the caller can degrade',
    observable: [{ context: 'thrown to the allocating code', message: 'Error: Worker exceeded memory limit.' }],
    firstPartySignal: true,
    measurements: [
      { scenario: 'single-burst allocation that succeeds', value: 248 * MiB, unit: 'bytes' },
      { scenario: 'single-burst allocation that fails', value: 256 * MiB, unit: 'bytes' },
    ],
    notes:
      'The probe\'s own conclusion was "the 128 MiB assumption is WRONG (in our favor)". This '
      + 'is the FORGIVING mode and it is the one people find first, because it is the one that '
      + 'throws. Do not budget against it: memory that has to survive a return to the event '
      + 'loop hits do.isolate.reset_silent at roughly 180-200 MiB with no error at all.',
    conflictsWith: ['worker.isolate.memory', 'do.isolate.reset_silent'],
  },

  'do.isolate.reset_silent': {
    subject:
      'The wall for memory that must SURVIVE ACROSS RPCs, past which the object is reset with '
      + 'no error on any surface',
    limit: { value: 200 * MiB, unit: 'bytes' },
    origin: 'platform',
    bounds: 'peak-resident',
    evidence: 'proven-by-probe',
    provenance:
      '~/Nimbus/scratchpad/pdmem/results-v2-base-soloFacetLadder.json#lastGoodMB, '
      + 'corroborated by ~/Nimbus/scratchpad/fork-m2-report.md §1',
    date: '2026-07-23',
    trigger: 'retained bytes above roughly 200 MiB held across an RPC boundary or event-loop return',
    onBreach:
      'the object is reset. In-memory state is gone, the boot id changes, and NOTHING is '
      + 'thrown or logged on any surface the application can read',
    observable: [],
    firstPartySignal: false,
    measurements: [
      { scenario: 'last ladder rung that survived across RPCs', value: 200 * MiB, unit: 'bytes' },
      { scenario: 'survive-across-RPCs wall, independent probe', value: 180 * MiB, unit: 'bytes' },
    ],
    notes:
      'THE DANGEROUS MODE, and the reason do.isolate.oom_catchable must not be treated as the '
      + 'budget. A burst can reach 248 MiB and a retained working set cannot reach 200 MiB, so '
      + 'the SAME number of bytes either throws or silently vaporises the object depending on '
      + 'whether it outlives one turn of the event loop. Must be simulated as silent '
      + 'disappearance. '
      + 'SILENT IS NOT UNDETECTABLE, and this is the most useful thing in the entry: see '
      + 'do.isolate.generation_counter. Nothing is thrown, but the reset IS observable '
      + 'POSITIVELY on the very next call, with no timeout, and it can be told apart from a slow '
      + 'response — which waiting for a missing completion cannot do, because that confuses a '
      + 'reset with still-running and only fires after our own deadline.',
    conflictsWith: ['worker.isolate.memory', 'do.isolate.oom_catchable'],
  },

  'do.isolate.generation_counter': {
    subject:
      'A Durable Object isolate carries a generation counter that increments on every reset, so a '
      + 'silent reset is detectable positively on the next call',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance:
      '~/Nimbus/scratchpad/oc-attach-reset-dossier.md §4 (generation multiplied into the id '
      + 'space); abort-reuse caveat from local://observability-contract.md §9.1',
    date: '2026-08-17',
    trigger: 'comparing the generation observed on two calls to the same object path',
    onBreach:
      'a discontinuity means the object was reset between the two calls, and everything held in '
      + 'memory across them is gone',
    observable: [],
    firstPartySignal: false,
    measurements: [
      { scenario: 'consecutive resets observed as generation steps on one object', value: 4, unit: 'count' },
    ],
    notes:
      'THE ANSWER TO THE HARDEST PROBLEM IN THIS FILE. Four entries — do.isolate.reset_silent, '
      + 'do.evict.no_signal, do.isolate.cotenancy, and the platform-side half of '
      + 'worker.subrequests — have firstPartySignal false and throw nothing, so no error '
      + 'taxonomy will ever construct a code for any of them. A generation discontinuity turns '
      + 'all four from an inference into a MEASUREMENT: positive, timeout-free, and able to tell '
      + 'a reset from a slow call. Nimbus multiplies the generation into the id space and observed '
      + 'it stepping 1000001 -> 2000001 -> 3000001 -> 4000002 across four resets. Costs one '
      + 'integer carried per unit of work. Pair it with the object PATH and never with ctx.id: '
      + 'do.facet.id_is_root_namespace makes an id-keyed correlation silently label every head as '
      + 'its root. '
      + 'THE COUNTER MUST BE PERSISTED AND INCREMENTED IN THE CONSTRUCTOR, NOT DERIVED FROM BOOT '
      + 'OR ISOLATE IDENTITY. do.facet.abort_reuses_isolate is the case that breaks the naive '
      + 'version: an abort rejects pending RPCs and kills in-flight work while KEEPING the same '
      + 'isolate, so a boot-derived generation shows no discontinuity across the most common way '
      + 'a Kinu head dies. Facet SQLite survives reset and eviction, so a persisted counter '
      + 'increments on every genuine re-construction including a post-abort re-get. The two '
      + 'implementations are indistinguishable on a happy-path probe and differ exactly here.',
  },

  'do.isolate.oom_reported': {
    subject: 'The wording an isolate memory reset surfaces as, when it surfaces at all',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'inferred',
    provenance: '~/Nimbus/packages/worker/src/observability/oom-classify.ts:14-16, :98-100',
    date: '2026-07-24',
    trigger: 'an isolate memory reset that does produce a message',
    onBreach:
      'the failure RECURS on retry — unlike do.reset.transient — so it must surface rather '
      + 'than be re-driven',
    observable: [
      {
        context: 'thrown into the caller',
        message: "Durable Object's isolate exceeded its memory limit and was reset",
      },
      { context: 'Nimbus clone failure surfaced to Kinu', message: 'Worker exceeded memory limit' },
    ],
    firstPartySignal: true,
    notes:
      'Separated from the thresholds because a wording is not a limit. The DO-specific string '
      + 'is pinned as a regex in shipping Nimbus code, but its comment attributes it to an '
      + 'internal note that is not readable from here, so the verbatim form is UNVERIFIED. '
      + 'The behaviour is not in doubt: the owner hit it as "clone failed: Worker exceeded '
      + 'memory limit". The second string is what a caller of Nimbus actually observed.',
  },

  'do.isolate.cotenancy': {
    subject:
      'Peer Durable Objects normally get their own isolate, but memory pressure between peers '
      + 'is real and NOT uniform: a peer can silently lose its retained bytes',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance:
      '~/Nimbus/scratchpad/pdmem/results-base.json#isoSurvey and #holdlong (owner account)',
    date: '2026-07-23',
    trigger: 'several peer Durable Objects of one class each retaining a large working set concurrently',
    onBreach:
      'one peer is reset and loses its retained bytes while its siblings continue; a new boot '
      + 'id is the only evidence',
    observable: [],
    firstPartySignal: false,
    measurements: [
      { scenario: 'peer DOs surveyed, each on its own isolate (maxCtorCount 1)', value: 8, unit: 'count' },
      { scenario: 'peers each holding 100 MB concurrently, all surviving', value: 4, unit: 'count' },
      { scenario: 'peers each holding 120 MB, of which three survived', value: 3, unit: 'count' },
    ],
    notes:
      'THIS ENTRY IS THE REASON THIS FILE EXISTS, and its history is the argument for the '
      + 'file\'s shape. Nimbus halves its supervisor budget to 64 MiB citing "§6 invariant I1" '
      + 'in a document that was never committed and is gone. The blanket claim in that citation '
      + '— 128 MiB shared across co-tenanting peers — is NOT what the probe found: eight peers '
      + 'sat on eight distinct isolates with one constructor call each, and four peers held '
      + '100 MB apiece without incident. What is real is the failure at 120 MB apiece, where '
      + 'one of four silently lost its allocation. So the useful claim is conditional pressure, '
      + 'not shared address space — a more actionable fact than the one that was lost, arrived '
      + 'at by measuring instead of citing.',
  },

  'worker.memory_usage_unobservable': {
    subject: 'process.memoryUsage() returns 0 for every field inside a Durable Object class context',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-source',
    provenance: '~/Nimbus/packages/worker/src/observability/heap-estimate.ts:6-11',
    date: '2026-07-24',
    trigger: 'any call to process.memoryUsage() outside a dynamic-worker isolate under nodejs_compat',
    onBreach:
      'heap telemetry reports zero forever — every field of the returned struct is 0 — so any '
      + 'memory-containment check built on it is vacuous, and headroom must be ESTIMATED from '
      + 'accounted allocations instead',
    observable: [],
    firstPartySignal: false,
    contributors: [
      'static worker-bundle baseline resident in V8',
      'VFS LRU cache (capped)',
      'in-flight VFS writes',
      'pre-bundle slices resident in the supervisor',
      'streaming RPC buffers',
    ],
    notes:
      'Nimbus replaced two helpers that called it anyway and reported zero forever. Because '
      + 'the estimate is a deterministic function of accounted allocations, it doubles as a '
      + 'simulated heap — which is what makes a deterministic DO lifecycle lane possible.',
  },

  // ── The activation gate ───────────────────────────────────────────────

  'do.block_concurrency.cancel_ms': {
    subject: 'blockConcurrencyWhile() held too long is cancelled and the Durable Object is reset',
    limit: { value: 30_000, unit: 'ms' },
    origin: 'platform',
    bounds: 'duration',
    evidence: 'proven-by-probe',
    provenance: 'packages/cf-backend/tests/unit-do-init-gate.test.ts:14-19, scripts/do-init-gate.ts:8-18',
    date: '2026-08-16',
    trigger: 'a blockConcurrencyWhile callback still pending ~30 s after the gate opened',
    onBreach:
      'the block is cancelled, the Durable Object is RESET, and the request 500s; every '
      + 'event queued behind the gate — pure @callable reads included — dies with it',
    observable: [
      {
        context: 'thrown into every caller waiting on the object',
        message:
          'A call to blockConcurrencyWhile() in a Durable Object waited for too long. '
          + 'The call was canceled and the Durable Object was reset.',
      },
      {
        context: 'what the owner saw in the product',
        message: "Couldn't load the plan — RPC call to listAgentTasks timed out after 30000ms",
      },
    ],
    firstPartySignal: true,
    measurements: [
      { scenario: 'pure @callable SELECT against an idle warm object', value: 2, unit: 'ms' },
      { scenario: 'same read against an object parked inside a turn awaiting the model', value: 1, unit: 'ms' },
      { scenario: 'cold activation whose onStart awaited a filesystem DO busy 2 s', value: 2_303, unit: 'ms' },
      { scenario: 'cold activation whose onStart awaited a filesystem DO busy 10 s', value: 10_215, unit: 'ms' },
      { scenario: 'cold activation whose onStart awaited a filesystem DO busy 25 s', value: 25_212, unit: 'ms' },
      { scenario: 'clean onStart, same busy filesystem DO, worst of four runs', value: 339, unit: 'ms' },
    ],
    notes:
      'Reset was observed at 31 s against a 31 s-busy neighbour, so 30 s is the threshold and '
      + '31 s the confirmed breach. The lesson recorded at the time: the pure-read invariant '
      + 'held at the method and was defeated at the object.',
  },

  'do.init_gate.awaited_by': {
    subject:
      'partyserver runs onStart() inside ctx.blockConcurrencyWhile(), and fetch, '
      + 'webSocketMessage, webSocketClose and alarm all await that same gate',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-source',
    provenance: 'partyserver/dist/index.js #ensureInitialized; index.d.ts:339 declares `void | Promise<void>`',
    date: '2026-08-16',
    trigger: 'any await in an onStart override on a partyserver-derived Durable Object',
    onBreach:
      'every event on the object waits for the awaited work, then '
      + 'do.block_concurrency.cancel_ms applies',
    observable: [],
    firstPartySignal: false,
    notes:
      'The base signature accepts `void | Promise<void>`, so widening an override to `async` '
      + 'typechecks, lints, and passes the whole suite while resetting the object under load. '
      + 'That is why `scripts/do-init-gate.ts` exists: the contract was real and its '
      + 'enforcement was a comment.',
  },

  'do.input_gate.scope': {
    subject:
      'The Durable Object input gate closes around STORAGE operations, not around awaiting a '
      + 'network response',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: 'packages/cf-backend/tests/unit-do-init-gate.test.ts:17-19',
    date: '2026-08-16',
    trigger: 'a pure read issued against an object already inside a long await',
    onBreach:
      'nothing — this is the hypothesis that was DISPROVED. An object parked inside a turn '
      + 'awaiting the model answers a pure @callable read in 1 ms',
    observable: [],
    firstPartySignal: false,
    notes:
      'Recorded because it is the wrong explanation people reach for first. A slow read on a '
      + 'busy object is a cold start or an activation gate, never "the DO is single-threaded '
      + 'and busy talking to the model".',
  },

  // ── CPU and wall clock ────────────────────────────────────────────────

  'do.cpu_ms_per_invocation': {
    subject: 'Active CPU time per Durable Object invocation (HTTP request, WebSocket message, or alarm)',
    limit: { value: 30_000, unit: 'ms' },
    origin: 'platform',
    bounds: 'duration',
    evidence: 'documented',
    provenance: `${CF_DO_LIMITS}#can-i-increase-durable-objects-cpu-limit`,
    date: DOCS_READ,
    trigger: 'active CPU time in one invocation > limits.cpu_ms (default 30 s, max 300 s)',
    onBreach: 'the invocation is terminated; error 1102 reaches the client',
    observable: [
      { context: 'client', message: 'Worker exceeded resource limits' },
      { context: 'Logpush / analytics invocation outcome', message: 'exceededCpu' },
    ],
    firstPartySignal: true,
    notes:
      'CPU only: waiting on the model, storage or any I/O does not count. Each incoming '
      + 'request or WebSocket message RESETS the remaining budget to the limit — but burning '
      + 'more than the limit BETWEEN incoming network requests raises the chance the object '
      + 'is evicted and reset. That is the shape of a long agent turn with no inbound traffic, '
      + 'and it is the documented mechanism behind do.evict.no_signal. '
      + 'THE LINE IS NOT STABLE IN EITHER DIRECTION: a facet burn was killed at roughly '
      + '33.8 s rather than 30 s, and ~/Nimbus/scratchpad/codex-checkout-c5.md:63 records a '
      + 'clone-prepare that passed in the morning and hit the CPU limit the same afternoon '
      + '"under account load". Budgeting against a hard 30 s will be wrong both ways.',
  },

  'do.alarm.wall_ms': {
    subject: 'Wall-clock time for one Durable Object alarm handler invocation',
    limit: { value: 900_000, unit: 'ms' },
    origin: 'platform',
    bounds: 'duration',
    evidence: 'documented',
    provenance: `${CF_DO_LIMITS}#wall-time-limits-by-invocation-type`,
    date: DOCS_READ,
    trigger: 'an alarm handler still running 15 minutes after it fired',
    onBreach: 'the invocation is terminated mid-handler',
    observable: [],
    firstPartySignal: false,
    notes:
      'Load-bearing here: the whole scheduled-callback and job-recovery chain runs on alarms, '
      + 'and an alarm override that dropped its `super` call silently killed every scheduled '
      + 'callback for weeks. A turn resumed from an alarm inherits 15 minutes of wall time, '
      + 'not the unlimited budget an HTTP-triggered turn gets.',
  },

  'worker.wall.http_unlimited': {
    subject: 'An HTTP- or RPC-triggered Worker or Durable Object has no wall-clock limit while the caller stays connected',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'documented',
    provenance: `${CF_DO_LIMITS}#wall-time-limits-by-invocation-type`,
    date: DOCS_READ,
    trigger: 'client disconnect, or response completion, with work still outstanding',
    onBreach:
      'work associated with that request may be cancelled immediately unless it was handed to '
      + 'ctx.waitUntil()',
    observable: [],
    firstPartySignal: false,
    notes:
      'The corollary matters more than the limit: a detached run that outlives its request '
      + 'is cancelled unless something holds the execution context open. Cloudflare also '
      + 'gives in-flight requests a 30 s grace period across a runtime update a few times a '
      + 'week, which is one non-code source of a mid-turn death.',
  },

  'worker.wait_until.grace_ms': {
    subject: 'How long ctx.waitUntil() extends execution past the response or client disconnect',
    limit: { value: 30_000, unit: 'ms' },
    origin: 'platform',
    bounds: 'duration',
    evidence: 'documented',
    provenance: `${CF_WORKER_LIMITS}#duration`,
    date: DOCS_READ,
    trigger: 'a waitUntil promise still pending 30 s after the response was sent',
    onBreach: 'the extension ends and remaining work is cancelled',
    observable: [],
    firstPartySignal: false,
    notes:
      'WORKER SCOPE ONLY, and reading it as general is how a Durable Object came to hold its own '
      + 'wake-up open with waitUntil. This limit is the non-actor branch of workerd\'s '
      + 'IncomingRequest::drain; the actor branch has no timeout and no extension at all. See '
      + 'do.wait_until.no_op.',
    conflictsWith: ['do.wait_until.no_op'],
  },

  'do.wait_until.no_op': {
    subject: 'ctx.waitUntil() has no effect inside a Durable Object',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'documented',
    provenance: `${CF_DO_STATE}#waituntil`,
    date: DOCS_READ,
    trigger: 'any call to DurableObjectState.waitUntil()',
    onBreach:
      'nothing: the object\'s lifetime is not extended and the request or RPC completes exactly '
      + 'when it would have anyway. The promise still runs, as any unawaited promise in an actor '
      + 'does, and carries no guarantee that it finishes',
    observable: [],
    firstPartySignal: false,
    notes:
      'It exists only for API compatibility with ExecutionContext, and that compatibility IS the '
      + 'hazard: the call reads as a durability decision and is not one. workerd shows the '
      + 'mechanism — DurableObjectState::waitUntil forwards to IoContext::addWaitUntil, and '
      + 'IoContext::addTask says "In Actors, we treat all tasks as wait-until tasks", so '
      + 'ctx.waitUntil(p) and a bare floating p are the same code path in an actor. '
      + 'worker.wait_until.grace_ms is the NON-ACTOR branch of IncomingRequest::drain and does not '
      + 'apply here at all; what actually becomes of the promise is '
      + 'do.background_task.cancelled_on_reset. Kinu shipped this exact mistake: scheduleTimerAt '
      + 'held the arm of the object\'s own wake-up row with waitUntil under a docstring claiming '
      + 'the write "lands even if the caller\'s invocation ends first", and the only failure path '
      + 'was a console line. anti-slop/no-wait-until-in-durable-object now rejects the call '
      + 'outright.',
    conflictsWith: ['worker.wait_until.grace_ms'],
  },

  'do.background_task.cancelled_on_reset': {
    subject: 'What becomes of a promise still in flight when a Durable Object invocation returns',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: 'local://waituntil-do-probe.md §3',
    date: '2026-08-17',
    trigger:
      'a promise started inside a Durable Object that has not settled when the object is evicted, '
      + 'reset or aborted',
    onBreach:
      'the promise is cancelled where it stands and its remaining effects never happen. The '
      + 'cancellation is not delivered to JavaScript, so an attached .catch() does not run, nothing '
      + 'is logged, and the caller has already been told the operation succeeded',
    observable: [],
    firstPartySignal: false,
    measurements: [
      { scenario: 'awaited inside the invocation: response held until the write committed', value: 3035, unit: 'ms' },
      { scenario: 'handed to ctx.waitUntil: response returned before the write', value: 12, unit: 'ms' },
      { scenario: 'left as a bare floating promise: response returned before the write', value: 10, unit: 'ms' },
    ],
    notes:
      'The probe is the decisive half of do.wait_until.no_op, because the documentation says the '
      + 'call has no effect and does not say what happens to the promise. Six cases on a '
      + 'production-pinned throwaway Worker (deleted; the route now 404s): a delayed storage write '
      + 'DOES land while the object stays alive, identically with waitUntil and without it, and is '
      + 'identically LOST when ctx.abort() lands first. A control ran the same write with no reset '
      + 'and it landed, so the loss is the reset and not a broken probe. abort() is the '
      + 'deterministic stand-in for eviction because drain() cancels actor background work on '
      + 'onShutdown(), which is the path eviction takes; do.evict.no_signal records that eviction '
      + 'itself cannot be forced or observed. The consequence for design: the only retention a '
      + 'Durable Object has is an await inside the invocation, where the output gate holds the '
      + 'response until the storage write commits. Everything else is best-effort and must be '
      + 'written as such — including the agents-SDK keepAlive heartbeat, which is alarm-backed and '
      + 'therefore itself depends on the wake-up row landing.',
  },

  'date_now.frozen_between_io': {
    subject: 'Date.now() does not advance between I/O operations inside a Worker',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-source',
    provenance: `${NIMBUS_JIT_PROBE}:207-212`,
    date: '2026-07-24',
    trigger: 'two Date.now() reads with no intervening I/O',
    onBreach:
      'both reads return the same value, so any CPU-only interval measures as 0 ms and a '
      + 'spin loop cannot observe time passing at all',
    observable: [],
    firstPartySignal: false,
    notes:
      'A timing side-channel mitigation, not a bug. It means wall-clock durations reported '
      + 'from inside a turn only advance across awaits — CPU-bound work is invisible to them. '
      + 'Anything that renders elapsed time to the model is measuring awaits, not work.',
  },

  // ── RPC and structured clone ──────────────────────────────────────────

  'rpc.arg_bytes': {
    subject: 'Largest byte payload carried as an ordinary Workers RPC argument or return value',
    limit: { value: 32 * MiB, unit: 'bytes' },
    origin: 'platform',
    bounds: 'wire',
    evidence: 'inferred',
    provenance: '~/Nimbus/packages/worker/src/constants.ts:67-70',
    date: '2026-07-24',
    trigger: 'structured-clone size of an RPC argument or return value > 32 MiB',
    onBreach: 'the call fails at the boundary before the receiver runs',
    observable: [],
    firstPartySignal: true,
    notes:
      'A SECOND UNSOURCED NUMBER. Nimbus states "the platform limit is 32 MiB" and cites '
      + 'nothing; Cloudflare publishes 32 MiB only for RECEIVED WEBSOCKET MESSAGES '
      + '(websocket.message_bytes), and the RPC lifecycle docs give no size at all. The two '
      + 'may be the same underlying cap or may be unrelated. Nimbus operates at 28 MiB '
      + '(facet.rpc_payload_budget) to leave structured-clone metadata headroom, so the real '
      + 'ceiling has never been touched. Top probe candidate.',
    conflictsWith: ['websocket.message_bytes'],
  },

  'facet.rpc_payload_budget': {
    subject: 'Nimbus\'s self-imposed RPC payload budget, and the slice ceiling derived from it',
    limit: { value: 28 * MiB, unit: 'bytes' },
    origin: 'self-imposed',
    bounds: 'wire',
    evidence: 'proven-by-source',
    provenance: '~/Nimbus/packages/worker/src/constants.ts:70, :85, :121',
    date: '2026-07-24',
    trigger: 'an on-demand slice or facet transfer exceeding the budget',
    onBreach: 'Nimbus refuses the transfer itself; the platform is never reached',
    observable: [],
    firstPartySignal: true,
    notes:
      'Recorded ONLY because it is routinely mistaken for the platform number. It is ours: '
      + '32 MiB less roughly 6% structured-clone overhead, doubling as the cap on peak '
      + 'supervisor slice memory. Nimbus notes concurrency=2 of max slices crashed a '
      + 'Mossaic-scale project, which is why PRE_BUNDLE_CONCURRENCY is 1.',
  },

  'rpc.clone_refused': {
    subject: 'Values that cannot cross a worker boundary at all, at any size',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: `${NIMBUS_JIT_PROBE}:36-68`,
    date: '2026-07-24',
    trigger: 'a compiled WebAssembly.Module, a WorkerLoader binding, or a WebSocket in an RPC argument or return value',
    onBreach: 'the call rejects at the boundary; the receiver never runs',
    observable: [
      { context: 'a compiled WebAssembly.Module, any direction', message: 'Unable to deserialize cloned data.' },
      {
        context: 'a WorkerLoader binding passed into a child env',
        message: 'Could not serialize object of type "WorkerLoader". This type does not support serialization.',
      },
      { context: 'Nimbus supervisor ↔ facet', message: 'Cannot deserialize cloned data' },
    ],
    firstPartySignal: true,
    notes:
      'Stronger than the claim it was probed against: a Module cannot cross ANY boundary, '
      + 'including a same-isolate structuredClone. Kinu paid for this independently — the '
      + 'device-tunnel upgrade path passed a WebSocket as a DO-RPC argument and 500\'d every '
      + 'daemon connect in production (packages/cf-backend/tests/unit-device-hub.test.ts:3-5).',
  },

  'rpc.prototype_chain': {
    subject:
      'Workers RPC resolves a method on the receiver\'s PROTOTYPE CHAIN; TypeScript `private` '
      + 'is erased and therefore reachable, and own instance properties are not reachable at all',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: 'packages/cf-backend/src/rpc-surface.ts:4-21',
    date: '2026-08-16',
    trigger: 'any `stub.foo(...)` where foo is anywhere on the prototype chain below Object.prototype',
    onBreach:
      'a method intended as internal is callable from another Durable Object by a cast, so a '
      + '`private`-only tier check is advisory rather than enforced',
    observable: [
      {
        context: 'calling an own instance property, or a name that does not exist',
        message: 'The RPC receiver does not implement the method "x".',
      },
    ],
    firstPartySignal: true,
    notes:
      'Verified against workerd 1.20260601.1 via miniflare with one Durable Object calling '
      + 'another. Only `#private` is hidden from RPC. This is why UserDO internals — raw '
      + 'credential rows included — are reachable today, and it is the platform fact behind '
      + 'the open `#private` hardening item.',
  },

  'do.storage.wasm_module_unreadable': {
    subject:
      'ctx.storage accepts a compiled WebAssembly.Module on put() and can never read it back',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: `${NIMBUS_JIT_PROBE}:52-61`,
    date: '2026-07-24',
    trigger: "ctx.storage.put(key, <compiled WebAssembly.Module>) followed by get(key)",
    onBreach: 'the write succeeds and the read fails permanently — a durably unreadable value',
    observable: [
      { context: 'the put', message: 'stored' },
      { context: 'the subsequent get', message: 'internal error; reference = 1uv5ip2lecbfa2e91tu7onr7' },
    ],
    firstPartySignal: true,
    notes:
      'A serializer/deserializer ASYMMETRY, which is why every related error mentions '
      + 'deserialization. Worth knowing far beyond wasm: a value the storage layer accepts is '
      + 'not thereby a value it can return.',
  },

  // ── Code generation ───────────────────────────────────────────────────

  'isolate.codegen_blocked': {
    subject:
      'eval, new Function(source) and WebAssembly compilation from bytes are all blocked at '
      + 'request time, in every context, by one per-isolate flag',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: `${NIMBUS_JIT_PROBE}:106-166 (probe matrix + workerd/src/workerd/jsg/setup.c++:415-416, 576, 583)`,
    date: '2026-07-24',
    trigger:
      'eval / new Function(src) / new WebAssembly.Module(bytes) / compile / instantiate(bytes) '
      + 'anywhere other than module top level',
    onBreach: 'a synchronous throw; nothing is compiled',
    observable: [
      { context: 'eval and new Function', message: 'Code generation from strings disallowed for this context' },
      { context: 'wasm from bytes', message: 'WebAssembly.Module(): Wasm code generation disallowed by embedder' },
    ],
    firstPartySignal: true,
    notes:
      'Blocked at parent request time, in a DO constructor, at DO request time, in a DO ALARM '
      + 'handler (its own IoContext), inside a dynamically import()ed module at request time, '
      + 'and at Worker Loader child request time. Allowed ONLY at module top level, and that '
      + 'window is a compat flag (allow_eval_during_startup, default on for compat dates '
      + '>= 2025-06-01) rather than a property of bundling a .wasm module. Two carve-outs: '
      + 'new Function() with NO arguments succeeds everywhere, and WebAssembly.validate is '
      + 'allowed everywhere. WebAssembly.compileStreaming does not exist in workerd at all. '
      + 'This is the single most load-bearing platform fact in this repo: it is why crafted '
      + 'tools cannot be compiled in-process on the hosted backend and why execute_tools goes '
      + 'through the Worker Loader.',
  },

  'worker_loader.child_cached_by_name': {
    subject:
      'env.LOADER.get(name, cb) opens an unlimited number of FRESH request-time compilation '
      + 'windows, but never re-runs cb for a name already loaded',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: `${NIMBUS_JIT_PROBE}:72-102`,
    date: '2026-07-24',
    trigger: 'a second env.LOADER.get with the same name and different module bytes',
    onBreach:
      'the callback does not run and the FIRST bytes keep serving — new source silently has '
      + 'no effect',
    observable: [],
    firstPartySignal: false,
    notes:
      'Refuted the claim it was probed against ("the module-init window is one-shot, only at '
      + 'load time"): three loads under fresh names returned 38 / 39 / 40, each reflecting the '
      + 'bytes supplied at that instant, so compilation-on-demand IS available at request '
      + 'time. The confined half is real — a compiled Module cannot leave the child that '
      + 'compiled it (rpc.clone_refused). The caching half is a live hazard for this repo: '
      + 'crafted tools are versioned source dispatched via env.LOADER.get(toolName, …), so an '
      + 'edited tool re-dispatched under the same name within one isolate lifetime may run '
      + 'the old body with NO signal. Not yet probed against our dispatcher.',
  },

  'atomics.wait_unavailable': {
    subject:
      'Atomics.wait is unavailable in every context, though SharedArrayBuffer, growable SAB, '
      + 'shared wasm memory and Atomics.waitAsync all work',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: `${NIMBUS_JIT_PROBE}:170-205 (workerd/src/workerd/jsg/setup.c++:420)`,
    date: '2026-07-24',
    trigger: 'any Atomics.wait call, including on shared wasm memory and with timeout 0',
    onBreach: 'a synchronous throw; the check precedes the value comparison',
    observable: [{ context: 'the call', message: 'Atomics.wait cannot be called in this context' }],
    firstPartySignal: true,
    notes:
      'SetAllowAtomicsWait(false) appears exactly once in the whole workerd tree, in the '
      + 'IsolateBase constructor, unconditional — no compat flag, no config knob, applied '
      + 'before any worker code runs. NO CONFIGURATION PERMITS IT. A spin-wait substitute is '
      + 'pointless rather than merely slow: one isolate on one thread with no concurrent '
      + 'mutator, and date_now.frozen_between_io means the loop cannot even observe time.',
  },

  // ── Durable Object storage ────────────────────────────────────────────

  'do.sqlite.row_bytes': {
    subject: 'Maximum size of a string, BLOB or table row in a SQLite-backed Durable Object',
    limit: { value: 2 * MB, unit: 'bytes' },
    origin: 'platform',
    bounds: 'row',
    evidence: 'documented',
    provenance: `${CF_DO_LIMITS}#sql-storage-limits`,
    date: DOCS_READ,
    trigger: 'an INSERT or UPDATE whose row, or any single string/BLOB in it, exceeds 2 MB',
    onBreach: 'the write fails; reads and deletes continue to work',
    observable: [],
    firstPartySignal: true,
    notes:
      'A SECOND DANGLING CITATION, now retired. '
      + '~/Nimbus/packages/worker/src/session/state-store.ts:52-54 asserts this same 2 MB cap '
      + '"Per a second internal research note, §9" and tightens itself to 256 KiB against '
      + 'it; that document was compiled from Cloudflare internal source, is gone, and cannot be '
      + 'restored. The number is right, it is now sourced from the page Cloudflare publishes, '
      + 'AND it has an independent probe behind it — do.storage.sync_kv measured the value cap '
      + 'at roughly 2,200,000 bytes against workerd util/sqlite.c++:1362-1380. So the one lost '
      + 'claim that mattered is the one claim that is now over-evidenced, and nothing in Kinu '
      + 'needs the dossier. '
      + 'The whole chat transcript, plan documents and MCTS search nodes persist as rows here. '
      + 'The agents SDK truncates a chat message to its own ROW_MAX_BYTES guard beneath this, '
      + 'but can only shrink TEXT parts — file parts ride through verbatim as base64, at 4/3 '
      + 'of raw, which is what CLOUD_MAX_INLINE_ATTACHMENT_BYTES is derived from.',
  },

  'do.sqlite.statement_bytes': {
    subject: 'Maximum SQL statement length in a SQLite-backed Durable Object',
    limit: { value: 100 * KiB, unit: 'bytes' },
    origin: 'platform',
    bounds: 'query',
    evidence: 'documented',
    provenance: `${CF_DO_LIMITS}#sql-storage-limits`,
    date: DOCS_READ,
    trigger: 'a single sql.exec() statement whose text exceeds 100 KB',
    onBreach: 'the statement is rejected',
    observable: [],
    firstPartySignal: true,
    notes:
      'Documented as "100 KB"; taken as binary KiB here because the value is a SQLite '
      + 'compile-time parameter (SQLITE_MAX_SQL_LENGTH) rather than a billing quantity. '
      + 'The reading is unverified. Reached by generated statements, not by hand-written '
      + 'ones — a batched multi-VALUES insert is the realistic breach.',
  },

  'do.sqlite.bound_params': {
    subject: 'Maximum bound parameters per query in a SQLite-backed Durable Object',
    limit: { value: 100, unit: 'count' },
    origin: 'platform',
    bounds: 'query',
    evidence: 'documented',
    provenance: `${CF_DO_LIMITS}#sql-storage-limits`,
    date: DOCS_READ,
    trigger: 'a query with more than 100 `?` placeholders bound',
    onBreach: 'the query is rejected',
    observable: [],
    firstPartySignal: true,
    notes:
      'Low, and the easiest of these to hit accidentally: any batched insert of more than '
      + '100/columns rows in one statement breaches it. Nimbus batches at 64 rows for its own '
      + 'reasons; nothing in this repo checks.',
  },

  'do.sqlite.columns_per_table': {
    subject: 'Maximum columns per table in a SQLite-backed Durable Object',
    limit: { value: 100, unit: 'count' },
    origin: 'platform',
    bounds: 'row',
    evidence: 'documented',
    provenance: `${CF_DO_LIMITS}#sql-storage-limits`,
    date: DOCS_READ,
    trigger: 'a CREATE TABLE or ALTER TABLE ADD COLUMN taking a table past 100 columns',
    onBreach: 'the DDL is rejected',
    observable: [],
    firstPartySignal: true,
    notes:
      'Relevant because this repo reconciles columns additively at activation '
      + '(reconcileColumns), which is a monotonically growing count with no ceiling check.',
  },

  'do.storage.bytes': {
    subject: 'Storage per SQLite-backed Durable Object',
    limit: { value: 10 * GB, unit: 'bytes' },
    origin: 'platform',
    bounds: 'storage',
    evidence: 'documented',
    provenance: `${CF_DO_LIMITS}#sqlite-backed-durable-objects-general-limits`,
    date: DOCS_READ,
    trigger: 'total object storage reaching 10 GB on Workers Paid (5 GB per account on Free)',
    onBreach:
      'ordinary writes fail catchably — INSERT, UPDATE, put(), sql.exec() — while SELECT, '
      + 'get(), list() and DELETE keep working so space can be freed. A FACET CLONE that '
      + 'crosses the quota does NOT fail catchably: the object is reset and the destination is '
      + 'left EMPTY',
    observable: [
      { context: 'an ordinary write over quota', message: 'database or disk is full: SQLITE_FULL' },
      {
        context: 'a facet clone over quota',
        message: 'Internal error in Durable Object storage caused object to be reset',
      },
    ],
    firstPartySignal: true,
    measurements: [
      { scenario: 'documented quota, the figure to budget against', value: 10 * GB, unit: 'bytes' },
      { scenario: 'largest logical total observed to FIT on a deployed probe', value: 10_580_000_000, unit: 'bytes' },
      { scenario: 'logical total observed to FAIL on a deployed probe', value: 11_600_000_000, unit: 'bytes' },
    ],
    notes:
      'The quota is shared by the root object, EVERY facet beneath it, and every clone — and '
      + 'a copy-on-write clone consumes its FULL logical bytes against it with no CoW credit, '
      + 'so an O(1) clone is free in time and not in quota. Causality was established by '
      + 'freeing 5 GiB and retrying successfully '
      + '(~/Nimbus/scratchpad/do-sqlite-fork-feasibility.md §4). Every Kinu fork and '
      + 'subordinate is a facet, so this is one shared 10 GB across a whole exploration tree — '
      + 'and see do.storage.size_is_per_object, because NOTHING on the platform reports the '
      + 'shared total. Accounting is LOGICAL rather than physical: a 1.058 GB facet cloned nine '
      + 'times is roughly 10.58 GB logical across ten databases, and all of them succeeded before '
      + 'the tenth failed, so the quota is not a simple sum of what any one reader can see. '
      + 'The published 10 GB is CONSERVATIVE and kept as the number to act on: a deployed probe '
      + 'bisected the real wall between 10.58 GB (fit) and 11.6 GB (failed) — and note 10 GiB, '
      + '10,737,418,240 bytes, falls INSIDE that window, so 10 GiB describes where the wall sits '
      + 'and is not a number to design to; it is 7.37% above the published figure. Budget against '
      + 'the published 10^10 anyway, because the breach mode makes this an ADMISSION-CONTROL input '
      + 'and not a health metric — you cannot alert at 99% on a limit whose breach destroys the '
      + 'destination, so decide BEFORE the clone, with reserve, on the arithmetic '
      + 'X·(N+1) <= quota. A generic internal-storage reset must therefore NOT be filed as '
      + 'unavailable-storage and left there: quota exhaustion is decidable in advance. '
      + 'BUT NONE OF THAT DESCRIBES KINU TODAY, and reading it as though it did is the error '
      + 'this paragraph previously invited. There is NO clone path here — zero `ctx.facets.clone(` '
      + 'call sites outside this file — so a Kinu fork copies nothing: it shares the parent\'s '
      + 'Nimbus file plane and gets an EMPTY private SQLite of 4096 bytes. The clone arithmetic is '
      + 'preventive only. And for the facet leak below, bytes are NOT the binding constraint: see '
      + 'do.facet.count, which is reached roughly an order of magnitude sooner.',
    knownBreachPath: 'packages/cf-backend/src/facet-spawn.ts:61 calls abortSubAgent, which per the agents 0.20.1 dist only does ctx.facets.abort and explicitly does NOT wipe storage; deleteSubAgent is called for SubordinateAgent and never for ExplorationAgent. So every head and MCTS branch facet leaks its SQLite permanently, at a default 15 fresh-nanoid facets per search (config.ts:89-92). Owned by ActorUnification. THE FIX IS TERMINAL-ONLY: abortSubAgent must REMAIN for mid-flight eviction, because deleteSubAgent wipes storage and a naive substitution turns a slow leak into immediate data loss on live heads',
  },

  'sqlite.nomem': {
    subject: 'The storage layer refusing an allocation, distinct from an isolate OOM',
    limit: null,
    origin: 'platform',
    bounds: 'peak-resident',
    evidence: 'inferred',
    provenance: '~/Nimbus/packages/worker/src/observability/oom-classify.ts:11-12, :81-84',
    date: '2026-07-24',
    trigger: 'a storage operation whose working set exceeds the per-object SQLite allocation cap',
    onBreach: 'the operation throws; the object survives',
    observable: [
      { context: 'the failing operation', message: 'SQLITE_NOMEM' },
      { context: 'stderr variant', message: 'out of memory' },
    ],
    firstPartySignal: true,
    notes:
      'Nimbus pins these signatures because they were reaching recordFailure() and being '
      + 'misread as isolate OOM. Which specific operations trigger it, and at what working-set '
      + 'size, is unmeasured — the cap itself is not published.',
  },

  'do.kv.value_bytes': {
    subject: 'Key and value size for a KEY-VALUE-backed Durable Object class',
    limit: { value: 128 * KiB, unit: 'bytes' },
    origin: 'platform',
    bounds: 'row',
    evidence: 'documented',
    provenance: `${CF_DO_LIMITS}#key-value-backed-durable-objects-general-limits`,
    date: DOCS_READ,
    trigger: 'a put() with a value over 128 KiB or a key over 2 KiB on a KV-backed class',
    onBreach: 'the write is rejected',
    observable: [],
    firstPartySignal: true,
    notes:
      'DOES NOT APPLY HERE, and is catalogued so that nobody remembers it as if it did. Every '
      + 'Durable Object class in this deployment is declared under new_sqlite_classes, so '
      + 'do.sqlite.row_bytes is the governing cap. The KV backend is also unavailable to new '
      + 'accounts.',
  },


  'do.isolate.transient_alloc_reset': {
    subject: 'A transient allocate-and-free of 128 MiB inside a Durable Object context resets the object',
    limit: { value: 128 * MiB, unit: 'bytes' },
    origin: 'platform',
    bounds: 'peak-resident',
    evidence: 'proven-by-probe',
    provenance: '~/Nimbus/scratchpad/oc-attach-reset-dossier.md §4',
    date: '2026-07-24',
    trigger: 'allocating and immediately freeing 128 MiB inside a Durable Object class context',
    onBreach:
      'the isolate is reset roughly 1.7 s later and the generation counter bumps. In-memory '
      + 'session state is lost; durable state survives. THE REQUEST RETURNED 200 FIRST',
    observable: [],
    firstPartySignal: false,
    measurements: [
      { scenario: 'allocate-and-free that survived (generation unchanged)', value: 96 * MiB, unit: 'bytes' },
      { scenario: 'allocate-and-free that reset the object', value: 128 * MiB, unit: 'bytes' },
      { scenario: 'delay from the allocation to the observed reset', value: 1_700, unit: 'ms' },
    ],
    notes:
      'THE ONLY PLACE 128 MiB WAS EVER MEASURED, and it is narrower than the documented claim: '
      + 'the DO context, not a facet, and a transient burst rather than a retained set. 32, 64 '
      + 'and 96 MiB were all fine on the same worker. The detail that matters operationally is '
      + 'that the request SUCCEEDED — a 200 went back to the client and the object died '
      + 'afterwards — so a success response is not evidence the object survived the work, and '
      + 'anything that caches in memory after replying has already lost it.',
  },

  'worker.memory_kill_is_burst_sensitive': {
    subject:
      'The memory kill is triggered by allocation BURST and pressure, not by a static capacity '
      + 'line, so the same worker dies lower under real work than under a deliberate ladder',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: '~/Nimbus/scratchpad/opencode-oom-fix.md §3 "The measured gap"',
    date: '2026-07-24',
    trigger: 'a fast allocation ramp, as distinct from a large steady working set',
    onBreach: 'the isolate is killed at a level a static ladder on the same worker survives',
    observable: [{ context: 'the killed invocation', message: 'Worker exceeded memory limit' }],
    firstPartySignal: true,
    measurements: [
      { scenario: 'natural workload killed at, lower bound', value: 130 * MB, unit: 'bytes' },
      { scenario: 'natural workload killed at, upper bound', value: 150 * MB, unit: 'bytes' },
      { scenario: 'explicit ladder on the SAME worker reached, lower bound', value: 200 * MB, unit: 'bytes' },
      { scenario: 'explicit ladder on the SAME worker reached, upper bound', value: 250 * MB, unit: 'bytes' },
    ],
    notes:
      'READ THIS BEFORE TRUSTING ANY OTHER MEMORY NUMBER HERE, INCLUDING THE MEASURED ONES. '
      + 'The probe\'s own words: the kill is burst/pressure-triggered, not static capacity, and '
      + '"a 25-40 MB static diet cannot close a gap that static capacity does not explain". That '
      + 'reconciles the whole family — 248 MiB burst, 200 MiB across RPCs, 128 MiB transient in a '
      + 'DO, 130-150 MB under real work — as answers to four different questions rather than four '
      + 'contradictions. The practical consequence: a memory budget derived from a ladder '
      + 'OVERSTATES what real work gets, so an allocation-rate reduction buys more than a '
      + 'headroom calculation predicts.',
    conflictsWith: [
      'worker.isolate.memory',
      'do.isolate.oom_catchable',
      'do.isolate.reset_silent',
      'do.isolate.transient_alloc_reset',
    ],
  },

  'do.storage.size_is_per_object': {
    subject:
      'ctx.storage.sql.databaseSize reports the CALLING object\'s own database only; the shared '
      + 'quota total is not exposed anywhere',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: 'local://observability-contract.md §9.3',
    date: '2026-08-17',
    trigger: 'reading databaseSize on a facet and treating it as headroom against do.storage.bytes',
    onBreach:
      'the reading is a true number answering the wrong question: a head\'s private database is '
      + 'tiny beside its root\'s, so a headroom metric built on it reports plenty of room while '
      + 'the object sits near the quota and about to reset uncatchably',
    observable: [],
    firstPartySignal: false,
    notes:
      'A NUMBER THAT READS FINE AND IS FALSE — the shape the `bounds` axis exists to catch, and '
      + 'it was within one review of shipping as a dashboard metric. The quota in '
      + 'do.storage.bytes is shared by the root, every facet and every clone, and no platform API '
      + 'returns that total, so headroom is a SUM the application must aggregate itself: emit '
      + 'each reading with the scope it came from and add them. Recorded as a GAP IN THE PLATFORM '
      + 'rather than papered over with the nearest available number.',
  },

  'do.storage.sync_kv': {
    subject:
      'ctx.storage.kv on a SQLite-backed Durable Object is genuinely synchronous — structured '
      + 'clone, zero awaits — with a per-value cap of about 2.2 MB',
    limit: { value: 2_200_000, unit: 'bytes' },
    origin: 'platform',
    bounds: 'row',
    // proven-by-SOURCE, not by probe, and the distinction is not pedantry: the
    // probe established that sync KV WORKS, and the 2.2 MB figure was read in
    // workerd's own bounds check. Labelling it probed would claim we watched a
    // value get rejected and neglected to write down what it said — and the gate
    // rejects exactly that claim, which is how this label got corrected.
    evidence: 'proven-by-source',
    provenance:
      'workerd util/sqlite.c++:1362-1380 and api/sync-kv.h:15-16; behaviour probed at '
      + '~/Nimbus/scratchpad/workerd-capability-survey.md §1.2 (route /synckv)',
    date: '2026-07-24',
    trigger: 'a ctx.storage.kv put whose structured-cloned value exceeds roughly 2,200,000 bytes',
    onBreach: 'the value is rejected; the wording was not captured — see the declared gap',
    observable: [],
    firstPartySignal: true,
    notes:
      'DIRECTLY RELEVANT TO THE ACTIVATION GATE. A sync KV read takes no await at all, so it '
      + 'cannot be what stalls an onStart — which sharpens do.init_gate.awaited_by from "avoid '
      + 'I/O" to "avoid the AWAIT": local storage reads are free, and it is the cross-object hop '
      + 'that kills. Registered outside every compatibility flag check '
      + '(api/actor-state.h:307-309), so it is not gated. The mechanism is why this can be sync '
      + 'while nothing network-shaped can: a SQLite read is a blocking pread on a local file '
      + '(sqlite.c++:2100-2103) and writes are made to LOOK synchronous by the output gate '
      + '(io-gate.h:12-21). The ~2.2 MB figure also independently CORROBORATES the 2 MB per-row '
      + 'cap that the second lost dossier asserted — the one lost claim that now has a probe '
      + 'behind it.',
  },

  // ── Throughput, eviction, connections ─────────────────────────────────

  'do.requests_per_second_soft': {
    subject: 'Soft request throughput for a single Durable Object instance',
    limit: { value: 1_000, unit: 'count' },
    origin: 'platform',
    bounds: 'concurrency',
    evidence: 'documented',
    provenance: `${CF_DO_LIMITS}#how-much-work-can-a-single-durable-object-do`,
    date: DOCS_READ,
    trigger: 'sustained inbound requests to one object above roughly 1,000 per second',
    onBreach: 'the runtime queues, then returns an overloaded error to the caller',
    observable: [{ context: 'the caller', message: 'Durable Object is overloaded' }],
    firstPartySignal: true,
    notes:
      'Soft and workload-dependent: an object that serialises large JSON per request realises '
      + 'far less. Each object is single-threaded, so this is a per-coordination-atom budget.',
  },

  'worker.subrequests': {
    subject: 'Subrequests per invocation — every fetch() plus every call to KV, R2, D1 or a binding',
    limit: { value: 10_000, unit: 'count' },
    origin: 'platform',
    bounds: 'count',
    evidence: 'documented',
    provenance: `${CF_WORKER_LIMITS}#subrequests`,
    date: DOCS_READ,
    trigger: 'subrequest count in one invocation exceeding the configured limit (50 on Free)',
    onBreach: 'further subrequests are refused for the rest of the invocation',
    observable: [{ context: 'the refused subrequest', message: 'Too many subrequests.' }],
    firstPartySignal: true,
    notes:
      'Each hop of a redirect chain counts, so the total exceeds the number of fetch() calls '
      + 'in the source. Nimbus lists the subrequest cap among the terminations it has "no '
      + 'first-party signal for", which conflicts with the documented error string — the two '
      + 'are probably different situations (a refused subrequest you can catch, versus a '
      + 'platform-side termination you cannot). Unresolved.',
    conflictsWith: ['do.evict.no_signal'],
  },

  'worker.simultaneous_connections': {
    subject: 'Connections simultaneously waiting for response headers, per invocation',
    limit: { value: 6, unit: 'count' },
    origin: 'platform',
    bounds: 'concurrency',
    evidence: 'documented',
    provenance: `${CF_WORKER_LIMITS}#simultaneous-open-connections`,
    date: DOCS_READ,
    trigger: 'a seventh fetch/KV/R2/Queues/TCP/outbound-WebSocket call opened while six await headers',
    onBreach: 'the seventh call is QUEUED until one of the six receives its headers — not rejected',
    observable: [],
    firstPartySignal: false,
    notes:
      'SIX, and measured from the top-level request: Workers reached through a service binding '
      + 'SHARE the budget. Once headers arrive a connection stops counting, so this bounds '
      + 'concurrent time-to-first-byte, not concurrent streams. Directly relevant to parallel '
      + 'exploration: N branches plus the orchestrator each opening a model call inside one '
      + 'invocation serialise past six, which presents as latency rather than an error, and '
      + 'is a plausible contributor to the delegation rate-limit storm.',
  },

  'do.evict.no_signal': {
    subject: 'Platform-side termination of a Durable Object with nothing the object can catch',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'inferred',
    provenance:
      '~/Nimbus/packages/worker/src/observability/oom-classify.ts:19-21; eviction taxonomy at '
      + 'heap-estimate.ts:26-31; this repo infers it at packages/core/src/jobs/runner.ts:26',
    date: '2026-07-24',
    trigger:
      'memory pressure on the runtime process (lru), operator or abuse kill (condemned), '
      + 'roughly 70-140 s without traffic (inactive), per-owner dynamic-worker LRU cap '
      + '(default 50), or an abuse ban (dynamic_worker_banned)',
    onBreach:
      'the object simply stops: in-memory state and any fiber driving work are gone, with no '
      + 'error delivered anywhere. Recovery must be inferred from durable state alone',
    observable: [],
    firstPartySignal: false,
    notes:
      'MUST be simulated as SILENT DISAPPEARANCE rather than a throw, or the simulation is '
      + 'easier than production. Five labelled workerd reasons are known but none is delivered '
      + 'to the object. This repo already handles it the only way available — a job row still '
      + 'marked `running` when nothing in the isolate owns it IS an orphan, whatever became of '
      + 'its fiber — and stamps its own message ("interrupted by Durable Object eviction '
      + 'before completion") because the platform supplies none.',
    conflictsWith: ['worker.subrequests'],
  },

  'do.reset.transient': {
    subject: 'Durable Object resets that are safe to re-attempt, as distinct from resource resets that are not',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'observed-in-production',
    provenance: '~/Nimbus/packages/worker/src/observability/oom-classify.ts:110-134',
    date: '2026-07-24',
    trigger: 'a code deploy rolling over, or a storage-subsystem cold-start hiccup, mid-request',
    onBreach:
      'the in-flight request or RPC rejects, but the work never ran to a conclusion, so it is '
      + 'safe to re-attempt',
    observable: [
      { context: 'code deploy', message: 'Durable Object reset because its code was updated.' },
      {
        context: 'storage cold start',
        message:
          'Internal error while starting up Durable Object storage caused object to be reset; '
          + 'reference = ...',
      },
      {
        context: 'storage timeout',
        message: 'Durable Object storage operation exceeded timeout which caused the object to be reset.',
      },
    ],
    firstPartySignal: true,
    notes:
      'These three strings are the difference between a retry that succeeds and a retry loop: '
      + 'do.isolate.oom also says "was reset" and RECURS, so a discriminator that matched on '
      + '"reset" alone would loop forever on a real OOM. Recorded as observed rather than '
      + 'probed — they came out of production, not a designed experiment.',
  },

  // ── WebSockets ────────────────────────────────────────────────────────

  'websocket.message_bytes': {
    subject: 'Maximum size of a WebSocket message a Durable Object can RECEIVE',
    limit: { value: 32 * MiB, unit: 'bytes' },
    origin: 'platform',
    bounds: 'wire',
    evidence: 'documented',
    provenance: `${CF_DO_LIMITS}#sqlite-backed-durable-objects-general-limits`,
    date: DOCS_READ,
    trigger: 'an inbound WebSocket frame larger than 32 MiB',
    onBreach: 'the message is refused',
    observable: [],
    firstPartySignal: true,
    notes:
      'Documented for RECEIVED messages only; nothing is published about the outbound '
      + 'direction. This is the only published 32 MiB figure, and rpc.arg_bytes asserts the '
      + 'same number for a different mechanism with no source — they may or may not be the '
      + 'same cap.',
    conflictsWith: ['rpc.arg_bytes'],
  },

  'websocket.hibernation_state': {
    subject:
      'A hibernated WebSocket keeps its serialized attachment and tags; everything held in '
      + 'isolate memory is gone',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-source',
    provenance: 'packages/cf-backend/src/cli/rpc-gate.ts:28-31, :44-45; actor-agent.ts:677-679',
    date: '2026-08-16',
    trigger: 'a Durable Object hibernating with accepted WebSockets, then waking on a message',
    onBreach:
      'in-memory maps, caches and per-connection objects are empty on wake; only attachment '
      + 'and tag data survives',
    observable: [],
    firstPartySignal: false,
    notes:
      'Load-bearing for authorization: the CLI RPC scope restriction is persisted as a '
      + 'connection TAG precisely because a tag rides the attachment through hibernation, '
      + 'while a per-connection allowlist in memory would silently widen to full access on '
      + 'wake. The dynamic-context ledger relies on the same fact from the other side — a '
      + 'cold start legitimately starts with one fresh block.',
  },


  // ── Durable Object facets ─────────────────────────────────────────────
  //
  // Every Kinu fork and subordinate is a FACET, not its own Durable Object:
  // the agents SDK spawns them through `subAgent()` -> `ctx.facets.get()`. So
  // the entries below are not exotica — they are the substrate the whole
  // exploration topology runs on, and none of them was known here before.

  'do.facet.memory_independent': {
    subject: 'A facet\'s memory ceiling is independent of its parent\'s residency',
    limit: { value: 208 * MiB, unit: 'bytes' },
    origin: 'platform',
    bounds: 'peak-resident',
    evidence: 'proven-by-probe',
    provenance: '~/Nimbus/scratchpad/do-facets-migration.md §1.6, §1.7, §1.8',
    date: '2026-07-24',
    trigger: 'a facet allocating while its parent already holds a large working set',
    onBreach: 'nothing — the ceilings do not interact',
    observable: [],
    firstPartySignal: false,
    measurements: [
      { scenario: 'facet ceiling with parent holding 0 bytes', value: 208 * MiB, unit: 'bytes' },
      { scenario: 'facet ceiling with parent holding 128 MiB — bit-identical', value: 208 * MiB, unit: 'bytes' },
      { scenario: 'eight facets at 192 MiB plus a 128 MiB parent, live at once', value: 1664 * MiB, unit: 'bytes' },
      { scenario: 'facets confirmed to be distinct isolates', value: 40, unit: 'count' },
    ],
    notes:
      'The GOOD half of the facet trade, and it is a large one: memory is genuinely per-facet, '
      + 'so a fan-out of heads does not share one 128-200 MiB budget. Read together with '
      + 'do.facet.cpu_shared, which is the price.',
  },

  'do.facet.cpu_shared': {
    subject:
      'Facets of one Durable Object share a single execution thread: CPU-bound or synchronous '
      + 'work in any facet stalls every sibling and the parent for its full duration',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: '~/Nimbus/scratchpad/do-facets-migration.md §1.12',
    date: '2026-07-24',
    trigger:
      'synchronous or CPU-bound work inside any facet — a non-indexed SQL scan, a large '
      + 'JSON.parse/stringify, heavy string building — while a sibling or the parent is called',
    onBreach:
      'sibling RPCs that normally return in 0-1 ms block for the length of the neighbour\'s '
      + 'burn, measured to 33,833 ms at the CPU cap',
    observable: [],
    firstPartySignal: false,
    measurements: [
      { scenario: 'sibling facet trivial status() RPC, baseline', value: 1, unit: 'ms' },
      { scenario: 'same call while a neighbour burns CPU', value: 5_476, unit: 'ms' },
      { scenario: 'same call, second run', value: 6_082, unit: 'ms' },
      { scenario: 'same call, third run', value: 5_146, unit: 'ms' },
      { scenario: 'same call against a neighbour running to the 30 s CPU cap', value: 33_833, unit: 'ms' },
      { scenario: 'the control: two PEER Durable Objects, fully independent', value: 4, unit: 'ms' },
    ],
    notes:
      'Parallel exploration is built on facets, so N heads are N isolates on ONE thread. '
      + 'NO KINU FORK LATENCY HAS BEEN ATTRIBUTED TO THIS MECHANISM, and the current '
      + 'exposure looks weak rather than strong: heads are predominantly I/O-bound, and an '
      + 'awaited generateText yields the thread for nearly all of a head\'s wall clock. This is '
      + 'a forward-looking hazard, catalogued so that a future "why did a trivial head RPC take '
      + '5 s?" is answered in minutes instead of being rediscovered. The real exposure is '
      + 'SYNCHRONOUS work: Nimbus blew the 30 s CPU limit on a `WHERE seq = ?` full scan over '
      + '16,000 rows of 64 KiB. Two PEER Durable Objects measured 4 ms under the same load, so '
      + 'peer objects — not more facets — are the shape that actually parallelises. Note also '
      + 'that a facet call can exceed facet.rpc_timeout_ms purely because a sibling was busy, '
      + 'in which case the timeout is measuring the neighbour rather than the work.',
  },

  'do.facet.abort_reuses_isolate': {
    subject:
      'ctx.facets.abort(name) rejects pending work but REUSES the same isolate — only rotating the '
      + 'loader id gives a fresh one',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: 'local://observability-contract.md §9.1 (rekey=false probe)',
    date: '2026-08-17',
    trigger: 'ctx.facets.abort(name) followed by a re-get of the same name',
    onBreach:
      'pending RPCs are rejected and in-flight work dies, while the isolate, its boot identity '
      + 'and its retained memory all persist unchanged',
    observable: [],
    firstPartySignal: false,
    notes:
      'Probe verbatim: `[rekey=false] phase1 boot=g6vaa659 held=128 -> abort -> re-get '
      + 'boot=g6vaa659 held=128 (same isolate)`. This is the most common way a Kinu head dies '
      + '— facet-spawn.ts calls it on every head abort, every spawn-bootstrap failure and every '
      + 'MCTS branch teardown — and it means an abort neither frees the retained memory nor '
      + 'produces any boot-level discontinuity. Two consequences: '
      + 'do.isolate.generation_counter must be persisted rather than boot-derived or it is blind '
      + 'to exactly this case, and memory held by an aborted head still counts against the '
      + 'ceilings until the isolate actually goes. Distinct again from a parent ctx.abort(), which '
      + 'rebuilds the Durable Object instance and KEEPS the isolate, leaving the facet alive and '
      + 'still holding its memory.',
  },

  'do.facet.rpc_bytes': {
    subject: 'Serialized argument or return size for one facet RPC',
    limit: { value: 32 * MiB, unit: 'bytes' },
    origin: 'platform',
    bounds: 'wire',
    evidence: 'proven-by-probe',
    provenance:
      '~/Nimbus/scratchpad/do-facets-migration.md §1.15; '
      + '~/Nimbus/scratchpad/do-sqlite-fork-feasibility.md §4',
    date: '2026-07-24',
    trigger: 'a facet RPC argument or return value serializing to more than 32 MiB',
    onBreach: 'the call is refused at the boundary',
    observable: [
      {
        context: 'the refused call',
        message: 'Serialized RPC arguments or return values are limited to 32MiB',
      },
    ],
    firstPartySignal: true,
    notes:
      'This is the FIRST-HAND 32 MiB figure, and it retires the unsourced one: rpc.arg_bytes '
      + 'asserted the same number for ordinary Workers RPC citing nothing, and here the '
      + 'runtime says it in its own words for the facet path Kinu actually uses.',
    conflictsWith: ['rpc.arg_bytes'],
  },

  'do.facet.no_alarms': {
    subject: 'A facet cannot set an alarm; only the root object can',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: '~/Nimbus/scratchpad/do-facets-migration.md §1.14.1',
    date: '2026-07-24',
    trigger: 'ctx.storage.setAlarm() from inside a facet',
    onBreach: 'a synchronous throw; scheduling must be owned by the root object and fanned in',
    observable: [{ context: 'the setAlarm call', message: 'Error: Facets currently cannot set alarms.' }],
    firstPartySignal: true,
    notes:
      'Directly constrains this repo: forks and subordinates are facets, so a head cannot '
      + 'schedule its own resumption, its own timeout, or its own recovery sweep. Everything '
      + 'time-driven must route through the root\'s single alarm (see do.alarm.wall_ms), which '
      + 'is also the only alarm there is.',
  },

  'do.facet.stub_local': {
    subject: 'A facet stub is coordinator-local and cannot be transferred, stored, or re-invoked indirectly',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: '~/Nimbus/scratchpad/do-facets-migration.md §1.11',
    date: '2026-07-24',
    trigger: 'passing a facet stub to another Worker or DO, storing it, or calling .call/.apply on it',
    onBreach: 'a throw; direct and detached invocation from the coordinator are the only working shapes',
    observable: [
      {
        context: 'any transfer attempt',
        message: 'DataCloneError: Durable Object Facet stubs cannot be transferred between Workers',
      },
    ],
    firstPartySignal: true,
    notes:
      'Means the coordinator is structurally the only thing that can talk to a head. A live '
      + 'fork roster cannot be handed to another object, and a head cannot be addressed '
      + 'directly from the UI worker — every observation of a running fork has to be relayed '
      + 'by its parent.',
  },

  'do.facet.eviction_joint': {
    subject: 'Parent and facets evict together, and an OOM in either leaves the other intact',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: '~/Nimbus/scratchpad/do-facets-migration.md §1.13',
    date: '2026-07-24',
    trigger: 'between two and five minutes of idleness across the parent and its facets',
    onBreach:
      'all of them evict together: facet SQLite persists, in-memory state does not. An OOM is '
      + 'the opposite — blast radius is contained in BOTH directions',
    observable: [],
    firstPartySignal: false,
    measurements: [
      { scenario: 'observed joint idle-eviction window, lower bound', value: 120_000, unit: 'ms' },
      { scenario: 'observed joint idle-eviction window, upper bound', value: 300_000, unit: 'ms' },
    ],
    notes:
      'A facet OOM leaves the parent running, and a parent OOM leaves the facet alive with the '
      + 'same boot id still holding its memory. So a head can outlive its coordinator, which is '
      + 'the mechanism behind runs outliving their host. Joint eviction at 2-5 min idle is also '
      + 'much sooner than a paused turn suggests, and only durable state survives it.',
  },

  'do.facet.count': {
    subject: 'Facets creatable beneath one Durable Object over its lifetime',
    limit: { value: 65_536, unit: 'count' },
    origin: 'platform',
    bounds: 'count',
    evidence: 'proven-by-source',
    provenance: '~/Nimbus/scratchpad/do-sqlite-fork-feasibility.md:308 (workerd FacetTreeIndex format)',
    date: '2026-07-24',
    trigger: 'the 65,537th facet name ever used beneath one root object',
    onBreach: 'unknown — the ceiling was read in the index format, not reached',
    observable: [],
    firstPartySignal: false,
    notes:
      'LIFETIME, not concurrent. A per-run or per-head facet name burns one permanently, so a '
      + 'long-lived workspace object doing thousands of explorations has a finite budget that '
      + 'nothing in this repo counts. Read in source; deliberately not probed, because reaching '
      + 'it would cost 65,536 facet creations. '
      + 'THIS IS THE BINDING CONSTRAINT FOR THE LEAK, NOT do.storage.bytes. A fresh facet '
      + 'database is 4096 bytes and a leaked head writes kilobytes, so at 15 permanent facets per '
      + 'default MCTS search this cap arrives at roughly 4,400 searches — an order of magnitude '
      + 'before 10 GB is threatened. A byte-based dashboard therefore reads healthy for the '
      + 'ENTIRE LIFE of the defect and then the object hits a hard facet-id wall the telemetry '
      + 'never mentioned: the same "true number answering the wrong question" shape as '
      + 'do.storage.size_is_per_object. '
      + 'HEADROOM IS ALREADY QUERYABLE, no new bookkeeping needed. The agents SDK writes a row '
      + 'per facet into `cf_agents_sub_agents` at spawn, and `abortSubAgent` does NOT call '
      + '`_forgetSubAgent` while `deleteSubAgent` does (verified in node_modules/agents/dist/'
      + 'index.js: abortSubAgent at :5765 with no forget, deleteSubAgent forgetting at :5793). So '
      + '`SELECT COUNT(*) FROM cf_agents_sub_agents` IS the leak counter, and once a terminal-only '
      + 'delete lands it should go flat instead of monotonic. It is DISTRIBUTED like the journal — '
      + 'the root holds depth-1 heads and each depth-1 facet holds its own depth-2 — so a '
      + 'root-only count under-reports a recursive split.',
    knownBreachPath: 'packages/cf-backend/src/facet-spawn.ts:61 calls abortSubAgent, which per the agents 0.20.1 dist only does ctx.facets.abort and explicitly does NOT wipe storage; deleteSubAgent is called for SubordinateAgent and never for ExplorationAgent. So every head and MCTS branch facet leaks its SQLite permanently, at a default 15 fresh-nanoid facets per search (config.ts:89-92). Owned by ActorUnification. THE FIX IS TERMINAL-ONLY: abortSubAgent must REMAIN for mid-flight eviction, because deleteSubAgent wipes storage and a naive substitution turns a slow leak into immediate data loss on live heads',
  },

  'do.facet.clone_name_unvalidated': {
    subject:
      'ctx.facets.clone accepts nonsense source names without error, and every one of them WIPES '
      + 'the destination',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: 'local://observability-contract.md — clone source-name probe',
    date: '2026-08-17',
    trigger: "ctx.facets.clone with a source name of '', '.', '..', '/', 'root' or '0'",
    onBreach:
      'the call SUCCEEDS and the destination facet is wiped. No exception, no diagnostic, nothing '
      + 'to trace',
    observable: [],
    firstPartySignal: false,
    notes:
      'A TYPO DOES NOT THROW, IT DELETES. All six inputs above were accepted. If any fork path '
      + 'ever derives a facet name from a path fragment, an id substring or model output, that is '
      + 'silent data loss with no exception anywhere — the worst combination in this catalog, '
      + 'because it is destructive AND invisible AND reachable from untrusted input. Validate the '
      + 'name at the call site; the platform will not.',
  },

  'do.facet.clone_cow': {
    subject: 'ctx.facets.clone is O(1) copy-on-write in time, and full-price in quota',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: '~/Nimbus/scratchpad/do-sqlite-fork-feasibility.md §4',
    date: '2026-07-24',
    trigger: 'ctx.facets.clone of a facet of any size',
    onBreach:
      'nothing at clone time; the cost lands on do.storage.bytes, where the clone counts its '
      + 'FULL logical bytes with no copy-on-write credit',
    observable: [],
    firstPartySignal: false,
    measurements: [
      { scenario: 'clone of a 4 MB facet', value: 18, unit: 'ms' },
      { scenario: 'clone of a 1.05 GB facet', value: 54, unit: 'ms' },
    ],
    notes:
      'Flat 18-54 ms across two and a half orders of magnitude, which makes forking a whole '
      + 'workspace state essentially free in time — and it is UNDOCUMENTED, with no '
      + 'compatibility promise, so building on it is a bet. The quota half is the trap: an O(1) '
      + 'clone is not a cheap clone, and crossing the 10 GB quota with one is a silent reset '
      + 'that leaves the destination empty. '
      + 'KINU DOES NOT USE THIS TODAY: there are zero `ctx.facets.clone(` call sites outside '
      + 'this file, and a fork shares the parent\'s file plane rather than copying it. Catalogued '
      + 'because it is the obvious thing to reach for when someone wants cheap forking, and both '
      + 'its traps — no compatibility promise, full logical bytes against the quota — are '
      + 'invisible at the call site.',
  },

  'worker_loader.limits_no_memory': {
    subject: 'A dynamically loaded Worker\'s limits can express CPU and subrequests, and NOT memory',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-source',
    provenance:
      '@cloudflare/workers-types/experimental/index.d.ts:4345-4360; '
      + '~/Nimbus/scratchpad/workerd-capability-survey.md:331-335 '
      + '(workerd/src/workerd/server/server.c++:4932-4939)',
    date: '2026-08-17',
    trigger: 'attempting to bound a child Worker\'s or facet\'s memory through its limits object',
    onBreach:
      'there is no field to set, so the memory ceiling cannot be configured at all — and the '
      + 'cpuMs field that DOES exist is accepted and then dropped by workerd OSS, so it can be '
      + 'set while enforcing nothing',
    observable: [],
    firstPartySignal: false,
    notes:
      'WorkerLoaderWorkerCode.limits is `{ cpuMs?: number; subRequests?: number }`. This is why '
      + 'every memory ceiling in this catalog is a fact to design around rather than a knob: '
      + 'nothing an application can write bounds a child isolate\'s memory. The cpuMs half is '
      + 'worse than absent, because a value that is accepted and ignored reads as a guard.',
  },


  // ── Observability, and the shape of the tracing API we actually have ──

  'tracing.scoped_spans_only': {
    subject:
      'The native Workers tracer at our pin offers only SCOPED spans: tracing.enterSpan exists, '
      + 'startActiveSpan does not, and a Span has no end()',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance:
      'local://observability-contract.md — ObservabilityLibraries two-DO probe, '
      + 'wrangler 4.97.0 / workerd 1.20260601.1, compat 2025-12-01 + nodejs_compat',
    date: '2026-08-17',
    trigger: 'calling tracing.startActiveSpan, span.end(), span.setAttributes(), or reading ctx.tracing',
    onBreach:
      'a TypeError, because the member does not exist. Span.prototype is exactly '
      + '["isTraced","setAttribute"], and ctx.tracing is undefined — only the module import works',
    observable: [{ context: 'the call', message: 'TypeError: tracing.startActiveSpan is not a function' }],
    firstPartySignal: true,
    notes:
      'startActiveSpan shipped 2026-07-28 and the workerd bundled with our wrangler predates it. '
      + 'The consequence is architectural, not cosmetic: a span whose lifetime is a stream, a '
      + 'hibernation cycle or an alarm CANNOT be held open, so any such trace has to be a '
      + 'persisted link plus a fresh scoped span on resume — the same mechanism '
      + 'websocket.hibernation_state already forces. `enterSpan` does survive a DO-to-DO RPC hop; '
      + 'that half was confirmed in the same run.',
  },

  'tracing.inert_locally': {
    subject: 'Custom spans are inert under `wrangler dev --local`: isTraced is false for every span',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance:
      'local://observability-contract.md — ObservabilityLibraries probe under '
      + '`wrangler dev --local` (miniflare, no trace collector)',
    date: '2026-08-17',
    trigger:
      'creating a custom span locally with observability.traces.enabled and NO tail_consumer '
      + 'attached',
    onBreach:
      'nothing is recorded and nothing says so — the span is created, isTraced reads false, and '
      + 'no tree is assembled',
    observable: [],
    firstPartySignal: false,
    notes:
      'BOUNDS WHAT ANYONE CAN VERIFY ON A LAPTOP, but less than first thought: attaching a '
      + 'tail_consumer flips every isTraced to TRUE locally, so a local run CAN prove a span is '
      + 'being recorded. What it cannot prove is the tree\'s SHAPE — `tailStream`, which carries '
      + 'spanOpen/spanClose, is typed but not dispatched by workerd 1.20260601.1 ("Handler does '
      + 'not export a tail() function."), and the legacy tail TraceItem has no spans field. So '
      + 'nesting and propagation are deployed-only evidence. One hazard learned by hanging a dev '
      + 'server: a worker that is its OWN tail_consumer and makes an RPC inside the tail handler '
      + 'is an infinite loop, because the RPC emits a trace event that re-invokes the handler.',
  },

  'worker.v8_pointer_compression': {
    subject:
      'workerd runs V8 with pointer compression, so a live JS value costs roughly a third less '
      + 'than on Node — asymptotically, once the fixed heap floor is amortised',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: 'local://v8-sizing-probe.md — VmHWM of the workerd child under wrangler 4.97.0, fresh isolate per size',
    date: '2026-08-17',
    trigger: 'estimating resident bytes for a large JS array or per-element structure inside a Worker',
    onBreach:
      'nothing fails here — this is a conversion factor, not a ceiling. A budget computed from '
      + 'Node measurements OVERSTATES workerd at the large end, and one computed from a SMALL '
      + 'sample overstates the per-element cost several-fold',
    observable: [],
    firstPartySignal: false,
    measurements: [
      { scenario: 'workerd bytes per element at 1,000 elements (heap floor dominates)', value: 13, unit: 'bytes' },
      { scenario: 'workerd bytes per element at 13,107 elements (asymptotic)', value: 5, unit: 'bytes' },
      { scenario: 'Node 22 V8 in-heap bytes per element, compression off', value: 8, unit: 'bytes' },
    ],
    notes:
      'NOT FLAT, and quoting it as flat is the way to be wrong: 12.6 B/element at 1,000 lines '
      + 'falls to 4.64 at 13,107 because a fixed V8 heap floor is being amortised. The figure to '
      + 'use is the asymptotic 4.6-5.2, and the ~0.64 workerd:Node ratio holds only at the large '
      + 'end. The comparison number is Node\'s 8.04 B/element measured IN-HEAP with the table '
      + 'live, which is the like-for-like figure; a Bun/JSC VmHWM reading of 8.8 exists in the '
      + 'artefact and is a different method, labelled there. '
      + 'THIS PROBE MEASURES BYTES, NOT THE ENFORCEMENT POINT: `wrangler dev` does not enforce '
      + 'the production isolate cap, and the probe isolate reached 822 MiB unkilled. The '
      + 'enforcement points are do.isolate.reset_silent and do.isolate.oom_catchable, and what '
      + 'this entry contributes is that ordinary byte counts cross them — an LCS table over ONE '
      + 'admitted 256 KiB file passes the ~200 MiB silent-reset wall at roughly 6,100 lines '
      + '(+226 MiB at 6,376, +330 MiB at 8,192), which means MEMORY binds long before '
      + 'do.cpu_ms_per_invocation does. Read with worker.memory_kill_is_burst_sensitive: an '
      + 'allocation ramp this steep is the shape that dies below any measured static wall.',
  },

  'do.facet.id_is_root_namespace': {
    subject:
      'A facet\'s ctx.id is minted from the ROOT object\'s namespace, so a Durable Object id '
      + 'cannot tell you which class is running',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: 'local://observability-contract.md — facet spawn probe, workerd 1.20260601.1',
    date: '2026-08-17',
    trigger: 'mapping a Durable Object id to a class, or correlating telemetry on ctx.id, for a facet',
    onBreach:
      'every facet is labelled as its root\'s class — every head and every subordinate reads as '
      + 'an OrchestratorAgent — and nothing contradicts the label',
    observable: [],
    firstPartySignal: false,
    notes:
      'A CORRECTNESS TRAP FOR ANY PER-AGENT VIEW, not just for tracing. Kinu spawns every '
      + 'subordinate and every exploration head as a facet, so an id-keyed roster, an id-keyed '
      + 'log field or an id-keyed UI grouping silently collapses the whole tree into one '
      + 'orchestrator. Correlate on selfPath. This is the "correct, wired, dead" shape at the '
      + 'identity layer: the map returns a class name, the name is wrong, and nothing fails.',
  },

  'do.facet.work_is_traced': {
    subject: 'Work inside a facet IS traced: a span opened in a facet reports isTraced true',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: 'local://observability-contract.md — ctx.facets.get spawn probe, isTraced true in the facet',
    date: '2026-08-17',
    trigger: 'opening a span inside a facet spawned via ctx.facets.get(name, () => ({ class }))',
    onBreach: 'nothing — this is the capability, recorded because its absence was assumed',
    observable: [],
    firstPartySignal: false,
    notes:
      'Probed with the exact spawn shape Kinu uses, so heads, subordinates and MCTS branches '
      + 'are NOT invisible to the native tracer — which makes the owner\'s repeated '
      + '"I cannot see what the forks are doing" a wiring problem rather than a platform one. '
      + 'One direction is still open and it is the direction that matters: whether ROOT to FACET '
      + 'emits a subrequest edge. Facet-to-root goes through getServerByName and is a genuine '
      + 'subrequest; root-to-facet is an in-container stub call that may not be, in which case '
      + 'the tree carries every head-to-orchestrator edge and no orchestrator-to-head edge, and '
      + 'fan-out is invisible in exactly the direction being investigated. Deployed probe, both '
      + 'directions, before anything is built on the tree\'s shape.',
  },

  // ── Bundle and startup ────────────────────────────────────────────────

  'worker.script_bytes': {
    subject: 'Deployed Worker size after gzip compression',
    limit: { value: 10 * MB, unit: 'bytes' },
    origin: 'platform',
    bounds: 'bundle',
    evidence: 'documented',
    provenance: `${CF_WORKER_LIMITS}#worker-size`,
    date: DOCS_READ,
    trigger: 'a bundle over 10 MB gzipped on Workers Paid (3 MB Free), or 64 MB uncompressed',
    onBreach: 'the deploy is rejected',
    observable: [],
    firstPartySignal: true,
    notes:
      'Comfortable today and worth watching, because bundle size also charges against '
      + 'worker.startup_ms, which is the tighter of the two.',
  },

  'worker.startup_ms': {
    subject: 'Time allowed for a Worker to evaluate its top-level module scope',
    limit: { value: 1_000, unit: 'ms' },
    origin: 'platform',
    bounds: 'duration',
    evidence: 'documented',
    provenance: `${CF_WORKER_LIMITS}#worker-startup-time`,
    date: DOCS_READ,
    trigger: 'module top-level evaluation exceeding 1 second',
    onBreach: 'the deploy or the isolate start fails',
    observable: [],
    firstPartySignal: true,
    notes:
      'The practical ceiling on bundle size, and the reason module top level is the only place '
      + 'codegen is permitted (isolate.codegen_blocked) — the startup window is short by '
      + 'construction. Every cold activation of every Durable Object pays it.',
  },

  'facet.module_text_bytes': {
    subject: 'Per-module text size a dynamically loaded Worker child can boot with',
    limit: { value: 8 * MiB, unit: 'bytes' },
    origin: 'platform',
    bounds: 'bundle',
    evidence: 'proven-by-probe',
    provenance: '~/Nimbus/packages/worker/src/constants.ts:90-115',
    date: '2026-07-24',
    trigger: 'a dynamic worker module whose JSON-ENCODED text exceeds workerd\'s per-module limit',
    onBreach: 'the child fails to boot',
    observable: [],
    firstPartySignal: false,
    measurements: [
      { scenario: 'raw bundle observed to FAIL (the only surviving datum)', value: 8 * MiB, unit: 'bytes' },
      { scenario: 'Nimbus self-imposed JSON-encoded ceiling', value: 22 * MiB, unit: 'bytes' },
    ],
    notes:
      'The gate is on the JSON-ENCODED UTF-8 byte length, not the raw content sum, because the '
      + 'module embeds the bundle as `const X = ${JSON.stringify(bundle)}` and every escaped '
      + 'newline and quote adds bytes. 24 MiB raw encodes to roughly 30-50 MiB of module text. '
      + 'Measure with TextEncoder().encode().length: String.length counts UTF-16 code units '
      + 'and undercounts non-ASCII. '
      + 'THE LOWER BOUND OF THIS MEASUREMENT NO LONGER EXISTS. constants.ts:96 reads verbatim '
      + '"// raw → boots, 8 MiB raw → fails." — the number before the first "raw" has been '
      + 'edited away, and `git show 0a6798b` shows it was never intact in git, so a two-point '
      + 'boots/fails bracket survives as one point. An earlier draft of THIS entry guessed 4 MiB '
      + 'and that guess was wrong; it is recorded here because inventing the missing half is '
      + 'exactly the failure the catalog exists to prevent, and it nearly happened again inside '
      + 'the fix. The file also contradicts itself: 8 MiB raw is documented as failing while '
      + 'VFS_BUNDLE_MAX_BYTES is 24 MiB raw — reconcilable only because the ENCODED 22 MiB gate '
      + 'is what actually binds and the raw cap is a cheap pre-check. Modelled as SILENT because '
      + 'the probe recorded that the '
      + 'child fails to boot and did not record whether anything reaches the loader caller, or '
      + 'with what wording — assuming no signal is the harder and therefore safer assumption '
      + 'until somebody captures it.',
  },

  'edge.websocket_idle_reap_ms': {
    subject: 'Cloudflare\'s edge closing a WebSocket that has been idle too long',
    limit: { value: 100_000, unit: 'ms' },
    origin: 'platform',
    bounds: 'duration',
    evidence: 'speculative',
    provenance: 'git 947c2560:docs/STABILITY-AUDIT.md:47-55 (DELETED FROM THE WORKING TREE)',
    date: '2026-08-17',
    trigger: 'an open WebSocket with no frames in either direction for roughly 100 s',
    onBreach: 'the socket closes and a long-paused turn silently dies',
    observable: [],
    firstPartySignal: false,
    notes:
      'THE SAME FAILURE AS do.isolate.cotenancy, INSIDE THIS REPO. '
      + '`packages/cf-backend/src/hooks/use-kinu.ts` ships a live 25 s application-level '
      + 'heartbeat on every open connection and justified it with a bare "STABILITY-AUDIT §A4"; '
      + 'that document is NOT in the working tree — only its screenshots survived the '
      + 'public-repo purge — and its recovered text (git 947c2560:docs/STABILITY-AUDIT.md §A4) '
      + 'says "Cloudflare\'s documented 100s reap" while citing no URL. Cloudflare\'s Workers limits, Durable Objects limits and '
      + 'WebSocket best-practices pages publish no such figure (read 2026-08-17). So the chain '
      + 'is: production behaviour, citing a deleted document, citing "documented", citing '
      + 'nothing. Labelled speculative for exactly that reason. The audit did verify the '
      + 'HEARTBEAT ("idle 110 s, connection still alive") which proves the mitigation works '
      + 'and says nothing about the threshold. See websocket.protocol_ping_auto_answered for '
      + 'why the chosen mitigation is also the expensive one.',
  },

  'websocket.protocol_ping_auto_answered': {
    subject:
      'The runtime answers RFC 6455 ping frames itself, without waking a hibernated Durable '
      + 'Object or invoking webSocketMessage',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'documented',
    provenance: 'https://developers.cloudflare.com/durable-objects/best-practices/websockets/#automatic-pingpong-handling',
    date: DOCS_READ,
    trigger: 'an inbound WebSocket control frame (ping) on an accepted, possibly hibernated socket',
    onBreach:
      'nothing fails — but an APPLICATION-level keepalive message is not a control frame, so it '
      + 'is delivered to webSocketMessage and wakes the object every interval',
    observable: [],
    firstPartySignal: true,
    notes:
      'Cloudflare states this keeps connections alive without waking the Durable Object. '
      + 'Kinu keeps its sockets warm with a JSON `{type:"ping"}` message instead, which is '
      + 'not a control frame: it costs a wake, an invocation and a CPU budget reset on every '
      + 'open connection every 25 s, against the unsourced threshold in '
      + 'edge.websocket_idle_reap_ms. Recorded, not changed — the fix belongs to whoever owns '
      + 'the transport.',
  },

  'facet.rpc_timeout_ms': {
    subject: 'Nimbus\'s own per-task deadline on a facet call',
    limit: { value: 30_000, unit: 'ms' },
    origin: 'self-imposed',
    bounds: 'duration',
    evidence: 'proven-by-source',
    provenance: '~/Nimbus/packages/worker/src/constants.ts:88',
    date: '2026-07-24',
    trigger: 'a facet task still pending 30 s after dispatch',
    onBreach: 'the facet-pool race rejects with a TimeoutError; the facet itself is not stopped',
    observable: [{ context: 'the caller', message: 'TimeoutError' }],
    firstPartySignal: true,
    notes:
      'OURS, not the platform\'s, and it coincides numerically with '
      + 'do.block_concurrency.cancel_ms and do.cpu_ms_per_invocation, which makes it easy to '
      + 'mistake for a platform number. A workspace command hitting exactly 30 s could be any '
      + 'of the three, and only the observable tells them apart.',
  },
} as const satisfies Readonly<Record<string, PlatformFact>>;

export type PlatformFactId = keyof typeof PLATFORM_CATALOG;

/** One entry, addressed by its id — the shape generic consumers work in. */
export interface PlatformFactEntry {
  readonly id: string;
  readonly fact: PlatformFact;
}

/**
 * One entry, read generically.
 *
 * `PLATFORM_CATALOG` is `as const`, which is what lets a named call site write
 * `PLATFORM_CATALOG['do.sqlite.row_bytes'].limit.value` with no null check — the
 * literal type carries the fact that this particular entry has a threshold. The
 * cost is that indexing by a VARIABLE yields a union of fifty-odd literal object
 * types, on which an optional field like `measurements` is not addressable. So
 * code that names an entry reads the const, and code that iterates comes through
 * here. One object, two ways in, no second copy.
 */
export function platformFact(id: PlatformFactId): PlatformFact {
  return PLATFORM_CATALOG[id];
}

/** The whole catalog as entries, in declaration order. */
export function platformFactEntries(): readonly PlatformFactEntry[] {
  return PLATFORM_FACT_IDS.map((id) => ({ id, fact: platformFact(id) }));
}

/** Every catalog id, in declaration order. The predicate is what makes this a
 *  narrowing rather than a cast: `Object.keys` loses the key union, and the
 *  gate, the report and the fault filter all need it back. */
export const PLATFORM_FACT_IDS: readonly PlatformFactId[] = Object.keys(PLATFORM_CATALOG)
  .filter((id): id is PlatformFactId => id in PLATFORM_CATALOG);

/**
 * The faults a deterministic-simulation lane may inject as real behaviour.
 *
 * Exported as a function rather than left to each consumer's own filter so that
 * "the fault set is the catalog, filtered to proven evidence" is one definition
 * with one place to change. The deliberately-excluded set is the complement:
 * `documented`, `inferred` and `speculative` entries describe a threshold
 * without anyone having watched the runtime cross it.
 */
export function injectableFaults(): readonly PlatformFactId[] {
  return PLATFORM_FACT_IDS.filter((id) => PROVEN_LABELS.includes(platformFact(id).evidence));
}
