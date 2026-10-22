/**
 * The single copy of every Cloudflare platform number and how it was established; `scripts/platform-catalog.ts --report` renders it.
 * Probing rules: pin compat date/flags to production, label each claim, copy failure strings verbatim, never fill a missing half, and never trust `wrangler dev` for enforcement.
 */

/** How a claim was established. Additive: never re-purpose an existing value. */
export type EvidenceLabel =
  | 'proven-by-probe'
  | 'proven-by-source'
  | 'observed-in-production'
  | 'documented'
  | 'inferred'
  | 'speculative';

/** Labels a fault injector may treat as real; `documented` gives a threshold, not the runtime's behaviour at it. */
const PROVEN_LABELS: readonly EvidenceLabel[] = [
  'proven-by-probe',
  'proven-by-source',
  'observed-in-production',
];

type LimitUnit = 'bytes' | 'ms' | 'count';

/** Base unit only; call sites must not convert. */
interface PlatformQuantity {
  readonly value: number;
  readonly unit: LimitUnit;
}

/** Copied verbatim, never paraphrased. */
interface PlatformObservable {
  readonly context: string;
  readonly message: string;
}

/** What a threshold actually protects; a number with a scope must carry it in the type. */
export const BOUNDS_KINDS = [
  'peak-resident', 'wire', 'row', 'query', 'response', 'storage', 'bundle', 'duration', 'concurrency', 'count', 'silence',
] as const;

type BoundsKind = (typeof BOUNDS_KINDS)[number];

interface PlatformMeasurement {
  readonly scenario: string;
  readonly value: number;
  readonly unit: LimitUnit;
}

export interface PlatformFact {
  readonly subject: string;
  readonly limit: PlatformQuantity | null;
  readonly origin: 'platform' | 'self-imposed';
  readonly bounds: BoundsKind | null;
  readonly evidence: EvidenceLabel;
  /** A URL for `documented`; otherwise a `path:line` or transcript locator. */
  readonly provenance: string;
  /** When the evidence was obtained, not written down. */
  readonly date: string;
  readonly trigger: string;
  readonly onBreach: string;
  /** Failure signatures only, verbatim: a fault injector reads this. */
  readonly observable: readonly PlatformObservable[];
  readonly firstPartySignal: boolean;
  readonly notes?: string;
  readonly measurements?: readonly PlatformMeasurement[];
  readonly contributors?: readonly string[];
  readonly conflictsWith?: readonly string[];
  /** A located live defect in this repo, not a suspected one. */
  readonly knownBreachPath?: string;
}

const KiB = 1024;

const MiB = 1024 * 1024;

/** Cloudflare's documented sizes are decimal (DO limits page, footnote 2); where readings differ the smaller is used. */
const MB = 1000 * 1000;

const GB = 1000 * 1000 * 1000;

const CF_DO_LIMITS = 'https://developers.cloudflare.com/durable-objects/platform/limits/';

const CF_DO_STATE = 'https://developers.cloudflare.com/durable-objects/api/state/';

const CF_WORKER_LIMITS = 'https://developers.cloudflare.com/workers/platform/limits/';

const NIMBUS_JIT_PROBE = '~/Nimbus/scratchpad/jit-limits-verification.md';

const DOCS_READ = '2026-08-17';

export const PLATFORM_CATALOG = {
  'container.instance.vcpu': {
    subject: 'vCPU allocated to each Kinu computer',
    limit: { value: 2, unit: 'count' },
    origin: 'self-imposed',
    bounds: 'count',
    evidence: 'proven-by-source',
    provenance: 'packages/cf-backend/wrangler.jsonc:121-124',
    date: '2026-08-22',
    trigger: 'a computer workload needs more than 2 CPU cores',
    onBreach: 'the workload receives no additional cores and remains bounded by the container allocation',
    observable: [],
    firstPartySignal: false,
  },

  'container.instance.memory': {
    subject: 'Memory allocated to each Kinu computer',
    limit: { value: 6_144 * MiB, unit: 'bytes' },
    origin: 'self-imposed',
    bounds: 'peak-resident',
    evidence: 'proven-by-source',
    provenance: 'packages/cf-backend/wrangler.jsonc:121-124',
    date: '2026-08-22',
    trigger: 'computer resident memory exceeds the configured 6144 MiB allocation',
    onBreach: 'the container process is terminated by its memory limit',
    observable: [],
    firstPartySignal: false,
    measurements: [
      { scenario: 'deployed container free -m total', value: 6_185 * MiB, unit: 'bytes' },
    ],
  },


  'container.instance.disk': {
    subject: 'Disk allocated to each Kinu computer',
    limit: { value: 8_000 * MB, unit: 'bytes' },
    origin: 'self-imposed',
    bounds: 'storage',
    evidence: 'proven-by-source',
    provenance: 'packages/cf-backend/wrangler.jsonc:121-124',
    date: '2026-08-22',
    trigger: 'computer files consume the configured 8000 MB disk allocation',
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
      + '~128 MiB for the supervisor DO isolate (possibly less, if it is shared) while facets '
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
      + 'response, which waiting for a missing completion cannot do, because that confuses a '
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
      'THE ANSWER TO THE HARDEST PROBLEM IN THIS FILE. Four entries: do.isolate.reset_silent, '
      + 'do.evict.no_signal, do.isolate.cotenancy, and the platform-side half of '
      + 'worker.subrequests: have firstPartySignal false and throw nothing, so no error '
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
      'the failure RECURS on retry: unlike do.reset.transient, so it must surface rather '
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
      + '(128 MiB shared across co-tenanting peers) is NOT what the probe found: eight peers '
      + 'sat on eight distinct isolates with one constructor call each, and four peers held '
      + '100 MB apiece without incident. What is real is the failure at 120 MB apiece, where '
      + 'one of four silently lost its allocation. So the useful claim is conditional pressure, '
      + 'not shared address space: a more actionable fact than the one that was lost, arrived '
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
      'heap telemetry reports zero forever (every field of the returned struct is 0) so any '
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
      + 'simulated heap, which is what makes a deterministic DO lifecycle lane possible.',
  },

  'do.block_concurrency.cancel_ms': {
    subject: 'blockConcurrencyWhile() held too long is cancelled and the Durable Object is reset',
    limit: { value: 30_000, unit: 'ms' },
    origin: 'platform',
    bounds: 'duration',
    evidence: 'proven-by-probe',
    provenance: 'packages/cf-backend/tests/workerd/do-init-gate.test.ts:1-8, scripts/do-init-gate.ts:8-18',
    date: '2026-08-16',
    trigger: 'a blockConcurrencyWhile callback still pending ~30 s after the gate opened',
    onBreach:
      'the block is cancelled, the Durable Object is RESET, and the request 500s; every '
      + 'event queued behind the gate (pure @callable reads included) dies with it',
    observable: [
      {
        context: 'thrown into every caller waiting on the object',
        message:
          'A call to blockConcurrencyWhile() in a Durable Object waited for too long. '
          + 'The call was canceled and the Durable Object was reset.',
      },
      {
        context: 'what the owner saw in the product',
        message: "Couldn't load the plan: RPC call to listAgentTasks timed out after 30000ms",
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
    provenance: 'packages/cf-backend/tests/workerd/do-init-gate.test.ts:4-5',
    date: '2026-08-16',
    trigger: 'a pure read issued against an object already inside a long await',
    onBreach:
      'nothing: this is the hypothesis that was DISPROVED. An object parked inside a turn '
      + 'awaiting the model answers a pure @callable read in 1 ms',
    observable: [],
    firstPartySignal: false,
    notes:
      'Recorded because it is the wrong explanation people reach for first. A slow read on a '
      + 'busy object is a cold start or an activation gate, never "the DO is single-threaded '
      + 'and busy talking to the model".',
  },

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
      + 'request or WebSocket message RESETS the remaining budget to the limit, but burning '
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
      + 'mechanism: DurableObjectState::waitUntil forwards to IoContext::addWaitUntil, and '
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
      + 'written as such, including the agents-SDK keepAlive heartbeat, which is alarm-backed and '
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
      + 'from inside a turn only advance across awaits: CPU-bound work is invisible to them. '
      + 'Anything that renders elapsed time to the model is measuring awaits, not work.',
  },

  'rpc.arg_bytes': {
    subject: 'Largest byte payload carried as an ordinary Workers RPC argument or return value',
    limit: { value: 32 * MiB, unit: 'bytes' },
    origin: 'platform',
    bounds: 'wire',
    evidence: 'observed-in-production',
    provenance: 'staging 667f96316, evals pilot d8b53e373 trial 2: '
      + 'kinu/tmp/evals-lane/pilot-d8b53e373/trials/2/evals/evals-minecraft-1792378577427/'
      + 'opencode-go-muse-spark-1-3-contributor/product/minecraft-trial-1/transcript.md:8',
    date: '2026-10-19',
    trigger: 'structured-clone size of an RPC argument or return value > 32 MiB',
    onBreach: 'the call fails at the boundary before the receiver runs, and its caller gets the error',
    observable: [
      {
        context: "a workspace's GET .../get-messages, which read its agent's whole chat back over the facet RPC (500)",
        message: 'Serialized RPC arguments or return values are limited to 32MiB, but the size of this value was: 70107941 bytes',
      },
    ],
    measurements: [
      { scenario: "a 341-step computer-use chat returned whole by its agent's facet, its screenshots inline", value: 70_107_941, unit: 'bytes' },
    ],
    firstPartySignal: true,
    notes:
      'Touched on staging 2026-10-19: the runtime refused a 70 MB return value in its own words, the facet path\'s figure '
      + '(do.facet.rpc_bytes) for an ordinary call. Nimbus states the same number uncited and operates at 28 MiB '
      + '(facet.rpc_payload_budget); Cloudflare publishes 32 MiB only for received WebSocket messages '
      + '(websocket.message_bytes). A chat now crosses as byte-bounded pages, each image an address fetched alone '
      + '(session/chat-media.ts, CHAT_PAGE_BYTES), so no read of it grows with its length.',
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

  'run_events.page_bytes': {
    subject: 'Stored run-event text one page may carry out of the workspace object',
    limit: { value: 256 * KiB, unit: 'bytes' },
    origin: 'self-imposed',
    bounds: 'response',
    evidence: 'proven-by-source',
    provenance: 'packages/core/src/events/recorder.ts:367-386',
    date: '2026-09-24',
    trigger: 'the next event would take a run-event page\'s stored text past 256 KiB',
    onBreach: 'the page ends before that event and the reader asks again from it; a first event larger than the bound comes alone',
    observable: [],
    firstPartySignal: true,
    measurements: [
      { scenario: 'Worker code live in the isolate before any workspace (deployed bundle, wrangler dev)', value: 57_500_000, unit: 'bytes' },
      { scenario: 'one 500-event page read as parsed events, peak added', value: 11_900_000, unit: 'bytes' },
      { scenario: '20 SSE followers resuming at event 350 of a 2.35 MB ledger, peak added', value: 33_300_000, unit: 'bytes' },
    ],
    notes:
      'Stands for do.isolate.transient_alloc_reset and worker.memory_kill_is_burst_sensitive: '
      + 'the object dies of allocation bursts, and 47 of the 71 OrchestratorAgent exceededMemory '
      + 'kills between 2026-09-22 and 09-24 landed on getRunEvents during reader storms. A page '
      + 'read as parsed events cost about eight times its text (the row, JSON.parse, the valibot '
      + 'copy, the RPC clone, the re-stringify for SSE), so a follower resuming on a trial-sized '
      + 'ledger allocated megabytes per poll. Forwarded as stored text, a page costs about its '
      + 'text twice (the row and the RPC clone). At 256 KiB, 20 followers draining at once put '
      + 'at most 20 x 256 KiB x 2 = 10 MiB in flight, under a fifth of the 70 MB the transient '
      + 'wall leaves above the Worker code, so the turn that is writing the ledger keeps the '
      + 'rest. A first event larger than the bound comes alone (do.sqlite.row_bytes caps it), '
      + 'so a reader still passes it.',
  },

  'files.page_bytes': {
    subject: 'Listing text one Files page may carry out of the workspace object',
    limit: { value: 256 * KiB, unit: 'bytes' },
    origin: 'self-imposed',
    bounds: 'response',
    evidence: 'proven-by-source',
    provenance: 'packages/core/src/read-models/files.ts:373-381',
    date: '2026-10-15',
    trigger: 'a folder whose entries, at the longest a name can be, would take one listing past 256 KiB',
    onBreach: 'the page ends at FILES_PAGE_ENTRIES and the reader asks again from `next`; a machine is asked one window of that size',
    observable: [],
    firstPartySignal: true,
    measurements: [
      { scenario: 'a 56,762-entry machine folder read whole, each entry statted (de5c43919\'s parent): reader heap, peak added, no page answered in 690 s', value: 441_073_905, unit: 'bytes' },
      { scenario: 'the same, reader resident memory, peak added', value: 1_023_963_136, unit: 'bytes' },
      { scenario: 'the same folder a page at a time, all 349 pages read in 6.4 s, no entry statted: reader heap, peak added', value: 6_380_261, unit: 'bytes' },
      { scenario: 'the same, reader resident memory, peak added', value: 21_823_488, unit: 'bytes' },
      { scenario: 'the largest page answered', value: 12_347, unit: 'bytes' },
    ],
    notes:
      'Stands for do.isolate.transient_alloc_reset and worker.memory_kill_is_burst_sensitive, as run_events.page_bytes '
      + 'does, and is the same text bound so the two pages can be in flight together. Observed in production on '
      + '2026-10-14: workspace pine-brook-a26400b1 opened its PC in Files, whose /tmp held 56,762 entries; the folder '
      + 'was read whole and each entry statted through the hub, and the object was reset for memory 11 times in an hour '
      + 'inside websocket messages. The entry count is derived, not chosen: this bound over the longest entry a listing '
      + 'can answer (a 255-byte name whose every byte JSON escapes to six characters). The measurements are the reader '
      + 'in Bun against the real device daemon (packages/cli/tests/daemon-update.test.ts), not the object itself: the '
      + 'whole-folder read passed the 128 MB isolate wall three times over.',
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
      { context: 'Nimbus supervisor <-> facet', message: 'Cannot deserialize cloned data' },
    ],
    firstPartySignal: true,
    notes:
      'Stronger than the claim it was probed against: a Module cannot cross ANY boundary, '
      + 'including a same-isolate structuredClone. Kinu paid for this independently: the '
      + 'device-tunnel upgrade path passed a WebSocket as a DO-RPC argument and 500\'d every '
      + 'daemon connect in production (packages/cf-backend/tests/unit-device-hub.test.ts:1-2).',
  },

  'rpc.prototype_chain': {
    subject:
      'Workers RPC resolves a method on the receiver\'s PROTOTYPE CHAIN; TypeScript `private` '
      + 'is erased and therefore reachable, and own instance properties are not reachable at all',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: 'packages/cf-backend/src/rpc-surface.ts:2-5',
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
      + 'another. Only `#private` is hidden from RPC. This is why UserDO internals: raw '
      + 'credential rows included: are reachable today, and it is the platform fact behind '
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
    onBreach: 'the write succeeds and the read fails permanently: a durably unreadable value',
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
      + 'tools cannot be compiled in-process on the hosted backend and why eval goes '
      + 'through the Worker Loader.',
  },

  'worker_loader.do_dynamic_worker_concurrency': {
    subject: 'Calls one Durable Object may have awaiting an answer from distinct Dynamic Workers at once',
    limit: { value: 10, unit: 'count' },
    origin: 'platform',
    bounds: 'concurrency',
    evidence: 'proven-by-probe',
    provenance:
      '~/kinu-logs/nimbus-integration/dwlimit-probe-2026-10-02/results.json#fanout_entry_11, #two_requests_6_and_6 '
      + 'and #background_callbacks (probe index.ts and run.sh beside it; deployed on the Kinu account 2026-10-02 ~22:05Z, '
      + 'then deleted); the limit is published at https://developers.cloudflare.com/changelog/post/2026-08-28-durable-objects-dynamic-workers-limit/',
    date: '2026-10-02',
    trigger: 'a call to an eleventh distinct Dynamic Worker (agent isolate, Nimbus process facet) while ten have calls awaiting an answer',
    onBreach: 'the call is refused before it runs; Kinu queues an agent-isolate call until one of its own ends (cf-backend dynamic-worker-slots.ts)',
    observable: [{
      context: 'thrown to the caller of the Dynamic Worker',
      message: 'Dynamic worker concurrency limit exceeded: each request may have up to 10 concurrent dynamic worker invocations. '
        + 'Wait for one to finish before starting another.',
    }],
    firstPartySignal: true,
    measurements: [
      { scenario: 'one request: calls in flight to distinct workers that succeed, entrypoints and facets alike', value: 10, unit: 'count' },
      { scenario: 'two concurrent requests to one object, 6 held calls each: calls the second got before refusals', value: 4, unit: 'count' },
      { scenario: 'isolates that answered and kept working (with or without callbacks): slots they hold', value: 0, unit: 'count' },
    ],
    notes:
      'Per object, shared by all its requests, though the message says "each request"; a call to a worker already in '
      + 'flight counts once; only calls awaiting an answer hold a slot. Staging eval 85a438698 hit it in site-preview '
      + '(three swarms) and true-myth-combinators (the trial ledger read). Nimbus keeps the per-object ledger '
      + '(@nimbus-sh/fabric budgets.ts) that Kinu holds its agent calls on.',
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
      'the callback does not run and the FIRST bytes keep serving: new source silently has '
      + 'no effect',
    observable: [],
    firstPartySignal: false,
    notes:
      'Refuted the claim it was probed against ("the module-init window is one-shot, only at '
      + 'load time"): three loads under fresh names returned 38 / 39 / 40, each reflecting the '
      + 'bytes supplied at that instant, so compilation-on-demand IS available at request '
      + 'time. The confined half is real: a compiled Module cannot leave the child that '
      + 'compiled it (rpc.clone_refused). The caching half is a live hazard for this repo: '
      + 'crafted tools are versioned source dispatched via env.LOADER.get(toolName, ...), so an '
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
      + 'IsolateBase constructor, unconditional: no compat flag, no config knob, applied '
      + 'before any worker code runs. NO CONFIGURATION PERMITS IT. A spin-wait substitute is '
      + 'pointless rather than merely slow: one isolate on one thread with no concurrent '
      + 'mutator, and date_now.frozen_between_io means the loop cannot even observe time.',
  },

  'do.sqlite.row_bytes': {
    subject: 'Maximum size of a string, BLOB or table row in a SQLite-backed Durable Object',
    limit: { value: 8 * MiB, unit: 'bytes' },
    origin: 'platform',
    bounds: 'row',
    evidence: 'proven-by-probe',
    provenance:
      '/mnt/local/kinu/evidence/do-sqlite-row-bytes-2026-10-21/RESULT.md:3-6 (production, compat 2026-10-20, probe Worker '
      + 'worker.ts, deleted after) and LOCAL.md:5-8 there (local workerd 1.20260930.2 through Miniflare, local-run.mjs)',
    date: '2026-10-21',
    trigger: 'an INSERT or UPDATE whose row, or any single string/BLOB in it, exceeds 8 MiB',
    onBreach: 'the write fails; reads and deletes continue to work',
    observable: [{ context: 'the INSERT or UPDATE', message: 'string or blob too big: SQLITE_TOOBIG' }],
    firstPartySignal: true,
    measurements: [
      { scenario: 'largest single BLOB in a one-key row, production and local workerd alike', value: 8_388_635, unit: 'bytes' },
      { scenario: 'the first BLOB refused, production and local workerd alike', value: 8_388_636, unit: 'bytes' },
      { scenario: 'TEXT accepted, local workerd (8 MiB + 64 refused)', value: 8 * MiB, unit: 'bytes' },
    ],
    notes:
      'RAISED FROM 2 MB, AHEAD OF THE DOCS. Cloudflare\'s limits page (last updated 2026-06-01) still says 2 MB; '
      + 'production refused nothing up to 8 MiB on 2026-10-21 and refused 8,388,636 bytes and 16 MiB, '
      + 'and local workerd 1.20260930.2, which the workerd tests run on, answered byte for byte the same, '
      + 'so one number governs both and a test passes only what production allows. The limit is the '
      + 'record\'s: a one-key row carries a BLOB 27 bytes past 8 MiB, and columns beside it share the 8 MiB. '
      + 'Every bound derived from this entry was re-read for the raise (2026-10-21): the reasons are at '
      + 'each, and the agents SDK still guards a chat message at its own ROW_MAX_BYTES (1.8 MB, agents '
      + '0.26.0), which governs the cloud\'s inline attachments, not this. The 2 MB the entry held before '
      + 'had a probe behind it too (do.storage.sync_kv\'s value cap at about 2,200,000 bytes), since raised alike.',
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
      + 'ones: a batched multi-VALUES insert is the realistic breach.',
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

  'do.sqlite.like_pattern_bytes': {
    subject: 'Maximum length of a LIKE or GLOB pattern in a SQLite-backed Durable Object',
    limit: { value: 50, unit: 'bytes' },
    origin: 'platform',
    bounds: 'query',
    evidence: 'proven-by-probe',
    provenance:
      'packages/cf-backend/tests/workerd/text-search.test.ts:12 under workerd; on staging (kinu-staging 5c522f12d, '
      + '2026-10-19), GET /api/gallery?q=<n bytes> with one listing indexed',
    date: '2026-10-19',
    trigger: 'a LIKE or GLOB whose pattern exceeds 50 bytes, evaluated against at least one row',
    onBreach: 'the whole statement is refused, not answered; a table with no rows to compare answers nothing and no error',
    observable: [{ context: 'thrown by sql.exec() on the first row compared', message: 'LIKE or GLOB pattern too complex: SQLITE_ERROR' }],
    firstPartySignal: true,
    measurements: [
      { scenario: "a search's `%q%` pattern answered (q = 48 bytes)", value: 50, unit: 'bytes' },
      { scenario: "a search's `%q%` pattern refused, 500 (q = 49 bytes)", value: 51, unit: 'bytes' },
    ],
    notes:
      'The documented D1 limit (https://developers.cloudflare.com/d1/platform/limits/) holds for Durable Object SQLite too, '
      + 'and workerd applies it locally, unlike bun:sqlite (50,000). Kinu matches text by instr over lower() '
      + '(packages/core/src/utils/text-match.ts), never a pattern; what still takes a pattern is the database tool\'s '
      + '`like` operator, whose caller writes the pattern and is answered this refusal.',
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
      'Relevant because a shipped table\'s DDL is its genesis here (scripts/schema-drift.ts): '
      + 'a column joins a table only through a reset deployment, and nothing checks the count.',
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
      'ordinary writes fail catchably: INSERT, UPDATE, put(), sql.exec(), while SELECT, '
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
      'The quota is shared by the root object, EVERY facet beneath it, and every clone, and '
      + 'a copy-on-write clone consumes its FULL logical bytes against it with no CoW credit, '
      + 'so an O(1) clone is free in time and not in quota. Causality was established by '
      + 'freeing 5 GiB and retrying successfully '
      + '(~/Nimbus/scratchpad/do-sqlite-fork-feasibility.md §4). Every Kinu fork and '
      + 'subagent is a facet, so this is one shared 10 GB across a whole exploration tree: '
      + 'and see do.storage.size_is_per_object, because NOTHING on the platform reports the '
      + 'shared total. Accounting is LOGICAL rather than physical: a 1.058 GB facet cloned nine '
      + 'times is roughly 10.58 GB logical across ten databases, and all of them succeeded before '
      + 'the tenth failed, so the quota is not a simple sum of what any one reader can see. '
      + 'The published 10 GB is CONSERVATIVE and kept as the number to act on: a deployed probe '
      + 'bisected the real wall between 10.58 GB (fit) and 11.6 GB (failed), and note 10 GiB, '
      + '10,737,418,240 bytes, falls INSIDE that window, so 10 GiB describes where the wall sits '
      + 'and is not a number to design to; it is 7.37% above the published figure. Budget against '
      + 'the published 10^10 anyway, because the breach mode makes this an ADMISSION-CONTROL input '
      + 'and not a health metric: you cannot alert at 99% on a limit whose breach destroys the '
      + 'destination, so decide BEFORE the clone, with reserve, on the arithmetic '
      + 'X·(N+1) <= quota. A generic internal-storage reset must therefore NOT be filed as '
      + 'unavailable-storage and left there: quota exhaustion is decidable in advance. '
      + 'BUT NONE OF THAT DESCRIBES KINU TODAY, and reading it as though it did is the error '
      + 'this paragraph exists to head off. There is NO clone path here: zero `ctx.facets.clone(` '
      + 'call sites outside this file, so a Kinu fork copies nothing: it shares the parent\'s '
      + 'Nimbus file plane and gets an EMPTY private SQLite of 4096 bytes. The clone arithmetic is '
      + 'preventive only. And for the facet leak below, bytes are NOT the binding constraint: see '
      + 'do.facet.count, which is reached roughly an order of magnitude sooner.'
      + ' '
      + 'The facet implementation recorded at git 4ebb58082:packages/cf-backend/src/facet-spawn.ts:61 '
      + 'aborts without wiping storage and deletes hired actors only, a combination that leaks head '
      + 'and branch SQLite at 15 fresh facet IDs per default search unless terminal deletion covers '
      + 'them. Kinu binds every logical actor through state/actor-host.ts to the workspace SQLite, '
      + 'so the facet measurements are preventive platform knowledge, not the storage topology.',
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
      + 'size, is unmeasured: the cap itself is not published.',
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
      + 'that the request SUCCEEDED: a 200 went back to the client and the object died '
      + 'afterwards, so a success response is not evidence the object survived the work, and '
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
      + 'reconciles the whole family: 248 MiB burst, 200 MiB across RPCs, 128 MiB transient in a '
      + 'DO, 130-150 MB under real work: as answers to four different questions rather than four '
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
      'A NUMBER THAT READS FINE AND IS FALSE: the shape the `bounds` axis exists to catch, and '
      + 'it was within one review of shipping as a dashboard metric. The quota in '
      + 'do.storage.bytes is shared by the root, every facet and every clone, and no platform API '
      + 'returns that total, so headroom is a SUM the application must aggregate itself: emit '
      + 'each reading with the scope it came from and add them. Recorded as a GAP IN THE PLATFORM '
      + 'rather than papered over with the nearest available number.',
  },

  'do.storage.sync_kv': {
    subject:
      'ctx.storage.kv on a SQLite-backed Durable Object is genuinely synchronous: structured '
      + 'clone, zero awaits, with a per-value cap just under 8 MiB',
    limit: { value: 8_388_620, unit: 'bytes' },
    origin: 'platform',
    bounds: 'row',
    // Raised with do.sqlite.row_bytes, whose SQLite holds the value; measured on local workerd, not on production.
    evidence: 'proven-by-probe',
    provenance:
      '/mnt/local/kinu/evidence/do-sqlite-row-bytes-2026-10-21/LOCAL.md:9-10 (local workerd 1.20260930.2, a Uint8Array '
      + 'put and read back); before, workerd util/sqlite.c++:1362-1380 and api/sync-kv.h:15-16, behaviour probed at '
      + '~/Nimbus/scratchpad/workerd-capability-survey.md §1.2 (route /synckv)',
    date: '2026-10-21',
    trigger: 'a ctx.storage.kv put whose structured-cloned value exceeds 8,388,620 bytes',
    onBreach: 'the put throws; the value is not stored',
    observable: [{ context: 'the put', message: 'string or blob too big: SQLITE_TOOBIG' }],
    firstPartySignal: true,
    notes:
      'DIRECTLY RELEVANT TO THE ACTIVATION GATE. A sync KV read takes no await at all, so it '
      + 'cannot be what stalls an onStart, which sharpens do.init_gate.awaited_by from "avoid '
      + 'I/O" to "avoid the AWAIT": local storage reads are free, and it is the cross-object hop '
      + 'that kills. Registered outside every compatibility flag check '
      + '(api/actor-state.h:307-309), so it is not gated. The mechanism is why this can be sync '
      + 'while nothing network-shaped can: a SQLite read is a blocking pread on a local file '
      + '(sqlite.c++:2100-2103) and writes are made to LOOK synchronous by the output gate '
      + '(io-gate.h:12-21). The cap was about 2,200,000 bytes until the platform raised '
      + 'do.sqlite.row_bytes to 8 MiB (2026-10-21); a value is its record, so it moved alike. Production\'s '
      + 'KV cap is not measured: its SQL row cap is, and answered as local workerd did.',
  },

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
    subject: 'Subrequests per invocation: every fetch() plus every call to KV, R2, D1 or a binding',
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
      + 'first-party signal for", which conflicts with the documented error string: the two '
      + 'are probably different situations (a refused subrequest you can catch, versus a '
      + 'platform-side termination you cannot). Unresolved.',
    conflictsWith: ['do.evict.no_signal'],
  },

  'worker.connect.private_address': {
    subject: "A Worker's connect() to a private, loopback or link-local address, or to a name that resolves to one",
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'observed-in-production',
    provenance: '~/kinu-logs/research/egress-dnsprobe-2026-10-11.md §2',
    date: '2026-10-11',
    trigger: 'connect() to localhost, or to a name resolving to 127/8, 10/8, 192.168/16 or 169.254/16',
    onBreach: 'the socket is refused at open; nothing is sent',
    observable: [{ context: 'socket.opened rejects', message: 'proxy request failed, cannot connect to the specified address' }],
    firstPartySignal: true,
    notes:
      'The resolved address is judged, not only a literal: 127.0.0.1.nip.io:22, 10.0.0.1.nip.io:22, 192.168.1.1.nip.io:5432 '
      + 'and 169.254.169.254.nip.io:8080 were refused while github.com:22 opened. Documented for addresses at '
      + 'https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/ (silent on names). Port 80 is refused for every '
      + 'host. So Kinu\'s egress (packages/cf-backend/src/egress/outbound.ts) judges names and literals and leaves resolution '
      + 'to the platform. Miniflare enforces none of it.',
  },

  'r2.etag.compressed_weak': {
    subject: "The ETag an R2 object's GET answers through the S3 API, by the encoding it is sent in",
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: 'scripts/devbox-container-tier.test.ts:110 (R2 as measured on the live fixture lease, read three ways on 2026-10-19)',
    date: '2026-10-19',
    trigger: 'a GET that accepts gzip, which Bun\'s and the browsers\' fetch send by default, of an object R2 compresses',
    onBreach: 'the answer comes gzip with its ETag weakened, W/"<md5>"; a PUT whose If-Match names that tag answers 412, as a conditional '
      + 'write another writer beat would',
    observable: [{ context: 'a GET without Accept-Encoding: identity', message: 'ETag: W/"839e114709ca83e1090a8cbf53663d3b"' }],
    firstPartySignal: true,
    notes:
      'Accept-Encoding: identity answers the strong ETag, "839e114709ca83e1090a8cbf53663d3b", which a PUT\'s If-Match holds against; a '
      + 'bucket listing names the strong one too. The devbox contracts\' fixture lease read its version from a default GET, so every '
      + 'takeover of an ended holder was refused as taken by another run (staging deploy of 001f6d749, 2026-10-19; '
      + 'scripts/fixtures/devbox-e2e/ledger.ts reads it uncompressed). A version read for a conditional write is read with identity.',
  },

  'worker.connect.address_forms': {
    subject: "The spellings of an IP address a Worker's connect() reaches",
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'observed-in-production',
    provenance: '~/kinu-logs/research/egress-hostforms-2026-10-12.md §2-§3',
    date: '2026-10-12',
    trigger: 'connect() to an IPv4 written other than as a dotted quad, an unbracketed IPv6, or an IPv6 that embeds an IPv4',
    onBreach: 'the socket is refused at open; nothing is sent',
    observable: [{ context: 'socket.opened rejects', message: 'proxy request failed, cannot connect to the specified address' }],
    firstPartySignal: true,
    notes:
      '8.8.8.8:53 and [2001:4860:4860::8888]:53 opened and answered DNS; 0x8.0x8.0x8.0x8, 0x08080808, 134744072, 8.8.2056, '
      + '010.010.010.010 and 008.008.008.008 were refused, as were bare 2001:4860:4860::8888, ::ffff:8.8.8.8, [::808:808], '
      + '[64:ff9b::808:808] (NAT64), [2002:808:808::] (6to4) and Teredo. [64:ff9b:1::808:808] was not refused: its open timed '
      + 'out. Kinu\'s egress (egressHost) refuses every such spelling itself and connects in the canonical one.',
  },

  'worker.fetch.private_address': {
    subject: "A Worker's fetch() to a private or loopback address, or to a name that resolves to one",
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'observed-in-production',
    provenance: '~/kinu-logs/research/egress-dnsprobe-2026-10-11.md §1',
    date: '2026-10-11',
    trigger: 'fetch() of a URL whose host resolves to a private address, or names localhost or an IP literal',
    onBreach: 'Cloudflare answers 403 with a 1002 or 1003 error code; the request never reaches the address',
    observable: [
      { context: 'name resolving to a private address', message: 'error code: 1002' },
      { context: 'localhost or an IP literal', message: 'error code: 1003' },
    ],
    firstPartySignal: true,
    notes: '127.0.0.1.nip.io, 10.0.0.1.nip.io and 169.254.169.254.nip.io answered 1002; localhost and 127.0.0.1 answered 1003; '
      + 'example.com answered 200. Miniflare enforces none of it.',
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
    onBreach: 'the seventh call is QUEUED until one of the six receives its headers, not rejected',
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
      + 'to the object. This repo already handles it the only way available: a job row still '
      + 'marked `running` when nothing in the isolate owns it IS an orphan, whatever became of '
      + 'its fiber, and stamps its own message ("the workspace restarted before it '
      + 'finished") because the platform supplies none.',
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
      + 'probed: they came out of production, not a designed experiment. '
      + 'The first string is NOT always a deploy: do.storage.write_await_reset throws the same words '
      + 'with no deploy, and it recurs as long as the work keeps its shape, so re-attempting the same '
      + 'work loops. Its message alone cannot tell the two apart.',
    conflictsWith: ['do.storage.write_await_reset'],
  },

  'do.storage.write_await_reset': {
    subject:
      'A Durable Object request that alternates SQLite writes, awaits and tens of ms of CPU is reset after about a '
      + 'second of CPU',
    limit: { value: 1_000, unit: 'ms' },
    origin: 'platform',
    bounds: 'duration',
    evidence: 'proven-by-probe',
    provenance: '/mnt/local/kinu/logs/research/do-write-await-reset/RESULTS.md §2',
    date: '2026-10-22',
    trigger: 'a request that writes SQLite, awaits anything, computes 12 ms or more, and repeats, for about 1 s of CPU',
    onBreach:
      'its next storage call throws and the object is reset, in the words of a code deploy though none happened; the '
      + 'same work reset again on every attempt',
    observable: [
      { context: 'awaited writes between dense CPU, no deploy', message: 'Durable Object reset because its code was updated.' },
    ],
    firstPartySignal: true,
    measurements: [
      { scenario: '64 writes, ~12.5-37 ms of CPU between, a timer yield each: earliest reset (CPU)', value: 1_000, unit: 'ms' },
      { scenario: '16 writes, ~125 ms of CPU between: reset 2 of 3, at (CPU)', value: 3_700, unit: 'ms' },
      { scenario: '64 writes, ~4 ms of CPU between: no reset (3 of 3), up to (CPU)', value: 2_800, unit: 'ms' },
      { scenario: '2 writes around fully synchronous CPU, no await: no reset (12 of 12), up to (CPU)', value: 8_000, unit: 'ms' },
      { scenario: 'no writes: no reset (7 of 7), up to (CPU)', value: 6_000, unit: 'ms' },
      { scenario: '16 writes, 12.5 ms of work between: CPU billed for 0.2 s of work, at least', value: 2_100, unit: 'ms' },
    ],
    notes:
      'The writes are the variable, not calls or facets: the same CPU with no writes survived in a plain object, a '
      + 'static facet, a loader facet and a dynamic-worker entrypoint, while with a write per slice it reset in a plain '
      + 'object, a static facet and a loader facet alike. A held call beside the work does not protect it (D10 renews '
      + 'the CPU budget, which this is not), nor does `await ctx.storage.sync()` after each write. The kind of await does '
      + 'not matter (setTimeout, scheduler.wait, a real fetch): the same writes inside one synchronous section survived. '
      + 'Each awaited write also inflates the request\'s CPU by 5-40 ms. So work that computes between writes either '
      + 'keeps the writes in one synchronous section or keeps its CPU between awaited writes to a few ms. Not '
      + 'established: the platform\'s mechanism, and whether CPU or wall time is the bound (64-write resets landed at '
      + '1.1-1.3 s of wall too). The agent-placement study\'s "facet work with no call in flight is reset in 3-12 s" '
      + 'wrote a row per slice, so it is this.',
    conflictsWith: ['do.reset.transient'],
  },

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
      + 'same number for a different mechanism with no source: they may or may not be the '
      + 'same cap.',
    conflictsWith: ['rpc.arg_bytes'],
  },

  'email.routing.rules_per_domain': {
    subject: 'Routing rules Cloudflare Email Routing holds for one domain',
    limit: { value: 200, unit: 'count' },
    origin: 'platform',
    bounds: 'count',
    evidence: 'documented',
    provenance: 'https://developers.cloudflare.com/email-routing/limits/',
    date: '2026-10-21',
    trigger: 'a 201st routing rule asked for on one domain',
    onBreach: 'Cloudflare refuses to make the rule; Kinu refuses the address it would have routed, in Cloudflare\'s words, and makes nothing of it',
    observable: [],
    firstPartySignal: true,
    notes:
      'An apex routes every address by its one catch-all; a subdomain has none (Catch-all rules are only available for the '
      + 'apex domain: developers.cloudflare.com/email-service/configuration/subdomains/), so a deployment whose mail is on a '
      + 'subdomain holds a literal rule for each address it gives out: the person\'s, and each workspace\'s and agent\'s '
      + '(core/src/deploy/mail-rules.ts). No cap of Kinu\'s comes before this one. A rule matches one address of at most 90 '
      + 'characters (the rules API\'s matcher value), and a +tag variant of it does not route. Unmeasured: the refusal\'s '
      + 'words need a zone that may hold 200 probe rules, which no zone of Kinu\'s shared with a live deployment may.',
  },
  'email.routing.message_bytes': {
    subject: 'Maximum size of an inbound message Cloudflare Email Routing delivers to a Worker',
    limit: { value: 25 * MiB, unit: 'bytes' },
    origin: 'platform',
    bounds: 'wire',
    evidence: 'documented',
    provenance: 'https://developers.cloudflare.com/email-routing/limits/',
    date: DOCS_READ,
    trigger: 'an inbound message larger than 25 MiB addressed to a routed address',
    onBreach: 'Email Routing rejects the message before the Worker sees it',
    observable: [],
    firstPartySignal: true,
    notes:
      'The whole message is handed to the email() Worker as a stream. Kinu buffers at most '
      + 'INBOUND_EMAIL_MAX_BYTES (2 MiB, email/route.ts) and authorizes the sender before '
      + 'assembling anything, so an unauthorized sender cannot spend the platform ceiling.',
  },

  'websocket.hibernation_state': {
    subject:
      'A hibernated WebSocket keeps its serialized attachment and tags; everything held in '
      + 'isolate memory is gone',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-source',
    provenance: 'packages/cf-backend/src/cli/rpc-gate.ts:3-5, :17-18; actor-agent.ts:677-679',
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
      + 'wake. The dynamic-context ledger relies on the same fact from the other side: a '
      + 'cold start legitimately starts with one fresh block.',
  },


  // Kinu spawns no facets (actors share one workspace SQLite via state/actor-host.ts); these entries record why:
  // `do.facet.cpu_shared`, `do.isolate.abort_keeps_isolate`, `do.facet.count`.

  'do.facet.memory_independent': {
    subject: 'A facet\'s memory ceiling, independent of its parent\'s residency',
    // Kinu's agent facets (loaded workers) under a turn's churn: 125 MB lived and 130 MB was reset. That is the published
    // 128 MB, and D8's 110/115 MB with a heavier base, not the 208 MiB Nimbus's plain facets measured on 2026-07-24.
    limit: { value: 125 * MB, unit: 'bytes' },
    origin: 'platform',
    bounds: 'peak-resident',
    evidence: 'proven-by-probe',
    provenance: '/mnt/local/kinu/tmp/agent-placement/DESIGN.md §2.3',
    date: '2026-10-21',
    trigger: 'an agent facet whose turn holds more than about 125 MB',
    onBreach: 'the facet is reset; its parent and its siblings keep running (their boot ids unchanged)',
    observable: [],
    firstPartySignal: false,
    measurements: [
      { scenario: 'a Kinu agent facet under turn churn, highest that lived (f44999, 2026-10-21)', value: 125 * MB, unit: 'bytes' },
      { scenario: 'a Kinu agent facet under turn churn, lowest reset (f44999, 2026-10-21)', value: 130 * MB, unit: 'bytes' },
      { scenario: 'D8, an agent facet with a 13-18 MB idle base, highest that lived (2026-09-27)', value: 110 * MB, unit: 'bytes' },
      { scenario: 'Nimbus plain facets, parent holding 0 or 128 MiB (2026-07-24): not Kinu\'s loader facets', value: 208 * MiB, unit: 'bytes' },
    ],
    notes:
      'The good half of the facet trade holds: one facet\'s reset leaves its parent and its siblings alone, so a fan-out '
      + 'of agents does not share one budget. The ceiling is not 208 MiB for Kinu: that was Nimbus\'s plain facets; a '
      + 'loaded worker\'s facet is reset near the published 128 MB. Plan on about 125 MB per agent isolate, and on agents '
      + 'sharing an isolate sharing it. Read together with do.facet.cpu_shared, which is the price.',
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
      'synchronous or CPU-bound work inside any facet: a non-indexed SQL scan, a large '
      + 'JSON.parse/stringify, heavy string building, while a sibling or the parent is called',
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
      + 'peer objects (not more facets) are the shape that actually parallelises. Note also '
      + 'that a facet call can exceed facet.rpc_timeout_ms purely because a sibling was busy, '
      + 'in which case the timeout is measuring the neighbour rather than the work.',
  },

  'do.facet.cpu_ms': {
    subject: 'Active CPU time a Durable Object facet from a loaded Worker may spend: the default, whatever its parent declares',
    limit: { value: 30_000, unit: 'ms' },
    origin: 'platform',
    bounds: 'duration',
    evidence: 'proven-by-probe',
    provenance: '~/kinu-logs/research/FACET-CPU-LIMIT-1008.md §1',
    date: '2026-10-08',
    trigger: 'a facet spending about 30 s of CPU on work no newer call into it is waiting for',
    onBreach: 'the facet is reset and the call rejects in its caller; the parent keeps running',
    observable: [
      { context: 'the call into the facet, parent limits.cpu_ms unset', message: 'Worker exceeded CPU time limit.' },
      { context: 'the call into the facet, parent limits.cpu_ms 300000', message: 'Durable Object exceeded its CPU time limit and was reset.' },
    ],
    firstPartySignal: true,
    measurements: [
      { scenario: 'yielding CPU burn in a facet, parent limits.cpu_ms unset', value: 31_538, unit: 'ms' },
      { scenario: 'yielding CPU burn in a facet, parent limits.cpu_ms 300000', value: 32_564, unit: 'ms' },
      { scenario: 'same, again (§5 long)', value: 32_018, unit: 'ms' },
      { scenario: '200 slices of 0.42 s, each inside its own call into the facet: all ran (§5 lexical)', value: 84_000, unit: 'ms' },
      { scenario: '200 slices of one long call, each resumed by a call into the facet that waits for it: all ran (§5 permit)', value: 110_000, unit: 'ms' },
    ],
    notes:
      'The parent\'s limits.cpu_ms (300000 here) does not reach its facets. A call into the facet that starts a piece of '
      + 'work and waits for it gives that piece a budget of its own, even when the piece is a continuation of a longer '
      + 'call (§5): so long work in a facet is paced by calls into it. Unmeasured (§2): WorkerCode limits.cpuMs, which the '
      + 'Dynamic Workers docs say can only lower the plan\'s. In production (§3) a hired agent\'s turn, run inside the '
      + 'one call that hands it over, was killed after 22 steps.',
  },

  'do.facet.subrequests': {
    subject: 'Subrequests a Durable Object facet from a loaded Worker may make while it stays busy, across every call into it',
    limit: { value: 10_000, unit: 'count' },
    origin: 'platform',
    bounds: 'count',
    evidence: 'proven-by-probe',
    provenance: '~/kinu-logs/research/FACET-SUBREQUEST-LIMIT-1017.md §1-§3',
    date: '2026-10-17',
    trigger: 'a facet\'s calls on its bindings and its fetches, summed while it has a call in flight or work pending',
    onBreach: 'each further call on a binding and each fetch throws until the facet has been idle past about 10 s',
    observable: [{ context: 'the refused call, a model fetch included', message: 'Too many subrequests by single Worker invocation.' }],
    firstPartySignal: true,
    measurements: [
      { scenario: 'calls on a service binding before the throw', value: 10_000, unit: 'count' },
      { scenario: 'calls on a held stub a binding answered: none refused', value: 12_000, unit: 'count' },
      { scenario: 'idle that did not reset an exhausted facet (2 runs)', value: 10_000, unit: 'ms' },
      { scenario: 'idle that did reset it, the instance kept (first call 1 ms)', value: 12_000, unit: 'ms' },
      { scenario: 'first call after ctx.facets.abort, which also resets it', value: 4_723, unit: 'ms' },
      { scenario: 'staging rc16: steps of a Minecraft turn before its model call was refused', value: 148, unit: 'count' },
    ],
    notes:
      'Not per call into the facet: back-to-back calls of 6,000 made 6,000 then 4,000, as did two calls from separate '
      + 'invocations of the parent seconds apart, and a step grant (do.facet.cpu_ms) renews CPU but not this. The facet\'s own '
      + 'timer keeps it busy. A pipelined call on the stub a binding call returns adds none; a fetch through a binding '
      + 'counts one. The parent\'s limits.subrequests does not reach the facet. So an agent holds what it calls into its '
      + 'workspace through (agent-facet/workspace-rpc.ts), and its steps cost about one each, their model call. The '
      + 'invocation worker.subrequests counts is, for a facet, this busy span.',
  },

  'do.facet.abort_reuses_isolate': {
    subject:
      'ctx.facets.abort(name) rejects pending work but REUSES the same isolate, only rotating the '
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
      + '(it was called on every head abort, every spawn-bootstrap failure and every MCTS '
      + 'branch teardown, git 4ebb58082:packages/cf-backend/src/facet-spawn.ts), and it means an '
      + 'abort neither frees the retained memory nor '
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
      'Directly constrains this repo: forks and subagents are facets, so a head cannot '
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
      + 'directly from the UI worker: every observation of a running fork has to be relayed '
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
      + 'the opposite: blast radius is contained in BOTH directions',
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
    onBreach: 'unknown at the cap, which was read in the index format, not reached; creation fails long before it (do.facet.creation_degrades)',
    observable: [],
    firstPartySignal: false,
    measurements: [
      { scenario: 'facets created beneath one root object, none refused for count (f44999, 2026-10-21)', value: 31_773, unit: 'count' },
    ],
    notes:
      'LIFETIME, not concurrent: deleting a facet does not free its id, and re-creating a name under '
      + 'the same parent reuses that name\'s id (workerd facet-tree-index.h, read again 2026-10-21). '
      + 'Kinu gives every agent its own facet (D9): main by its id, every other agent by a fresh '
      + 'storage key. So each head, swarm node, steer branch and hire '
      + 'uses one id for good, and no name is reused. Counted per workspace on actor.startup\'s '
      + '`facets` (identity/workspace-actors.ts facetNamesGiven): a ceiling, as an actor that never '
      + 'ran used no id. The SDK\'s `cf_agents_sub_agents` does not count them: Kinu calls '
      + 'ctx.facets.get itself (agent-facets.ts). '
      + 'Not what binds first: creation degrades from about 31,300 (do.facet.creation_degrades), and '
      + 'the 10 concurrent Dynamic Workers (worker_loader.do_dynamic_worker_concurrency) bind before '
      + 'either. Bytes give no warning: a fresh facet database is 4096 bytes, so a byte dashboard '
      + 'reads healthy up to the wall, the shape of do.storage.size_is_per_object.',
  },

  'do.facet.creation_degrades': {
    subject: 'Facet creation beneath one Durable Object slows with its count, and fails long before do.facet.count',
    limit: { value: 31_300, unit: 'count' },
    origin: 'platform',
    bounds: 'count',
    evidence: 'proven-by-probe',
    provenance: '/mnt/local/kinu/tmp/agent-placement/DESIGN.md §2.6',
    date: '2026-10-21',
    trigger: 'creating facets beneath a root object that has created about 31,300 of them',
    onBreach:
      'most creations are cut by a storage reset of the root, or answered 1101; the root still answers '
      + 'a plain read, and resumes from what it stored',
    observable: [
      { context: 'a batch of facet creations past about 31,300 in one root object', message: 'Internal error in Durable Object storage caused object to be reset' },
    ],
    firstPartySignal: true,
    measurements: [
      { scenario: '2,000 facets created from zero', value: 19_000, unit: 'ms' },
      { scenario: '500 facets created at about 10,850', value: 29_000, unit: 'ms' },
      { scenario: '500 facets created at 25,000-27,000, fastest', value: 70_000, unit: 'ms' },
      { scenario: 'one facet created at 31,772', value: 8_100, unit: 'ms' },
      { scenario: '20 facets created in a fresh object, fastest', value: 12_800, unit: 'ms' },
    ],
    notes:
      'Creation cost grows with the count, from about 105 a second at zero to 6.7 a second at '
      + '27,000. So a workspace that has made tens of thousands of agents makes every new agent\'s '
      + 'first call slower, long before any refusal. Aborting each facet right after its write reset '
      + 'the root (2 trials), so the climb kept its instances; the root was reset 8 times on the way '
      + 'and resumed from its stored count. Read with do.facet.count, which this precedes; Kinu\'s '
      + 'per-workspace count is actor.startup\'s `facets`.',
  },

  'do.facet.clone_name_unvalidated': {
    subject:
      'ctx.facets.clone accepts nonsense source names without error, and every one of them WIPES '
      + 'the destination',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: 'local://observability-contract.md: clone source-name probe',
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
      + 'silent data loss with no exception anywhere: the worst combination in this catalog, '
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
      + 'workspace state essentially free in time, and it is UNDOCUMENTED, with no '
      + 'compatibility promise, so building on it is a bet. The quota half is the trap: an O(1) '
      + 'clone is not a cheap clone, and crossing the 10 GB quota with one is a silent reset '
      + 'that leaves the destination empty. '
      + 'KINU DOES NOT USE THIS TODAY: there are zero `ctx.facets.clone(` call sites outside '
      + 'this file, and a fork shares the parent\'s file plane rather than copying it. Catalogued '
      + 'because it is the obvious thing to reach for when someone wants cheap forking, and both '
      + 'its traps (no compatibility promise, full logical bytes against the quota) are '
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
      'there is no field to set, so the memory ceiling cannot be configured at all, and the '
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


  'tracing.scoped_spans_only': {
    subject: 'Native spans are bound to their invocation, including manually ended spans',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: 'docs/OBSERVABILITY.md:245-248: PlatformRefresh RESULTS-2026-09-28.txt; workerd 1.20260926.1, compat 2026-09-28',
    date: '2026-09-28',
    trigger: 'opening a span in one invocation and ending it in a later invocation',
    onBreach: 'the recorded span ends with its owning invocation, not when a later invocation calls end()',
    observable: [],
    firstPartySignal: false,
    notes: 'enterSpan, startActiveSpan, startSpan, getActiveSpan, recordException and setAttributes exist. '
      + 'A span ended two invocations later, about 2 seconds wall time, recorded 2-3 ms locally. '
      + 'Long turns still need persisted correlation and fresh spans across invocation boundaries.',
  },

  'tracing.inert_locally': {
    subject: 'Local tracing records span structure and outcomes, but not span attributes',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: 'docs/OBSERVABILITY.md:245-248: PlatformRefresh RESULTS-2026-09-28.txt; local collector on workerd 1.20260926.1',
    date: '2026-09-28',
    trigger: 'reading custom spans from the local collector',
    onBreach: 'attributes are null; a local trace cannot prove production attribute propagation',
    observable: [],
    firstPartySignal: false,
    notes: 'Native span APIs are available locally. recordException({name,code}) recorded an error outcome '
      + 'without a message. Attribute-level evidence still requires a deployed trace.',
  },

  'worker.v8_pointer_compression': {
    subject:
      'workerd runs V8 with pointer compression, so a live JS value costs roughly a third less '
      + 'than on Node: asymptotically, once the fixed heap floor is amortised',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: 'local://v8-sizing-probe.md: VmHWM of the workerd child under wrangler 4.97.0, fresh isolate per size',
    date: '2026-08-17',
    trigger: 'estimating resident bytes for a large JS array or per-element structure inside a Worker',
    onBreach:
      'nothing fails here: this is a conversion factor, not a ceiling. A budget computed from '
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
      + 'this entry contributes is that ordinary byte counts cross them: an LCS table over ONE '
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
    provenance: 'local://observability-contract.md: facet spawn probe, workerd 1.20260601.1',
    date: '2026-08-17',
    trigger: 'mapping a Durable Object id to a class, or correlating telemetry on ctx.id, for a facet',
    onBreach:
      'every facet is labelled as its root\'s class: every head and every subagent reads as '
      + 'an OrchestratorAgent, and nothing contradicts the label',
    observable: [],
    firstPartySignal: false,
    notes:
      'A CORRECTNESS TRAP FOR ANY PER-AGENT VIEW, not just for tracing. Kinu spawns every '
      + 'subagent and every exploration head as a facet, so an id-keyed roster, an id-keyed '
      + 'log field or an id-keyed UI grouping silently collapses the whole tree into one '
      + 'orchestrator. Correlate on selfPath. This is the "correct, wired, dead" shape at the '
      + 'identity layer: the map returns a class name, the name is wrong, and nothing fails.',
  },

  'do.facet.work_is_traced': {
    subject: 'Class facets have RPC span edges; loader facets expose root-side calls and native tail logs, not work spans',
    limit: null,
    origin: 'platform',
    bounds: null,
    evidence: 'proven-by-probe',
    provenance: 'docs/OBSERVABILITY.md:250-256: PlatformRefresh local class-facet result; Facets kinu-trace-probe-0928 and kinu-tail-probe-0928 deployed loader-facet report',
    date: '2026-09-28',
    trigger: 'tracing RPCs to a class facet versus a WorkerLoader facet',
    onBreach: 'loader-facet work has no invocation span; root-side RPC spans alone do not show its execution',
    observable: [],
    firstPartySignal: false,
    notes: 'Class-facet probes show facet_subrequest to jsrpc, and durable_object_subrequest to jsrpc on return. '
      + 'Deployed loader facets showed root jsRpcSession to jsRpcCall in 10/10 traces with a missing session parent, '
      + 'no facet-work spans and direct logs received in 0/12 observations. WorkerCode tails delivered logs in 9/9 calls '
      + 'under the loader script after about 2 minutes. RPC throws appeared canceled with no tail exceptions. '
      + 'Use native tails for loader-facet diagnostics; do not infer loader tracing from class-facet results. '
      + 'The loader probes were deleted and retained no log files; these counts are the investigating lane report.',
  },

  'worker.script_bytes': {
    subject: 'Deployed Worker size, uncompressed',
    limit: { value: 64 * MiB, unit: 'bytes' },
    origin: 'platform',
    bounds: 'bundle',
    evidence: 'documented',
    provenance: `${CF_WORKER_LIMITS}#worker-size`,
    date: '2026-09-28',
    trigger: 'a bundle over 64 MiB uncompressed (`Total Upload` in `wrangler deploy --dry-run`) on Free or Paid',
    onBreach: 'the deploy is rejected',
    observable: [],
    firstPartySignal: true,
    notes:
      'There is no compressed limit; the dry-run prints gzip for reference only. Reading on '
      + '2026-09-28: 21,347 KiB raw, 5,745 KiB gzip. Bundle size also charges against '
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
    observable: [{ context: 'a script or version upload, code 10021', message: 'Error: Script startup exceeded CPU time limit.\n' }],
    firstPartySignal: true,
    measurements: [
      { scenario: 'rc30 (b04fac742) upload, the fast reading', value: 363, unit: 'ms' },
      { scenario: 'rc30 (b04fac742) upload, the slow reading', value: 949, unit: 'ms' },
      { scenario: 'rc30 (b04fac742) local `wrangler check startup`, median of 5', value: 202, unit: 'ms' },
    ],
    notes:
      'The practical ceiling on bundle size, and the reason module top level is the only place '
      + 'codegen is permitted (isolate.codegen_blocked): the startup window is short by '
      + 'construction. Every cold activation of every Durable Object pays it. The upload validator '
      + 'reads it in two modes (f44999, 2026-10-21, eight uploads of one rc30 bundle, each '
      + '`startup_time_ms`): 363, 364, 371 and 377 ms, then 777, 794 and 949 ms, and one upload '
      + 'refused 10021. The same bundle passed on retry four times in four (0.2.0+62b6c90c6, the same '
      + 'day). A refusal is surfaced in these words with a retry the person presses, never retried '
      + 'by itself: the self-deploy page, and deploy.sh, which fails the upload for its operator.',
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
      + '"// raw -> boots, 8 MiB raw -> fails.": the number before the first "raw" has been '
      + 'edited away, and `git show 0a6798b` shows it was never intact in git, so a two-point '
      + 'boots/fails bracket survives as one point. An earlier draft of THIS entry guessed 4 MiB '
      + 'and that guess was wrong; it is recorded here because inventing the missing half is '
      + 'exactly the failure the catalog exists to prevent, and it nearly happened again inside '
      + 'the fix. The file also contradicts itself: 8 MiB raw is documented as failing while '
      + 'VFS_BUNDLE_MAX_BYTES is 24 MiB raw: reconcilable only because the ENCODED 22 MiB gate '
      + 'is what actually binds and the raw cap is a cheap pre-check. Modelled as SILENT because '
      + 'the probe recorded that the '
      + 'child fails to boot and did not record whether anything reaches the loader caller, or '
      + 'with what wording: assuming no signal is the harder and therefore safer assumption '
      + 'until somebody captures it.',
  },

  'workers_dev.fresh_route_404': {
    subject: 'A workers.dev address just bound to a script answering 404 before it serves the script',
    limit: null,
    origin: 'platform',
    bounds: 'duration',
    evidence: 'proven-by-probe',
    provenance: 'docs/SELF-DEPLOY.md#f44999-2026-10-21',
    date: '2026-10-21',
    trigger: 'a request to <script>.<subdomain>.workers.dev in the seconds after the script\'s workers.dev route is enabled',
    onBreach: 'the address answers HTTP 404, though the script is deployed and the route enabled',
    observable: [{ context: 'a request to the address', message: 'HTTP 404' }],
    firstPartySignal: true,
    measurements: [
      { scenario: 'kinu-sdtest-before-0802: bound, then answered after one 3 s wait', value: 3_000, unit: 'ms' },
      { scenario: 'kinu-sdtest-10210741: bound 07:49:23, 404 then, answering by 07:49:52', value: 29_000, unit: 'ms' },
    ],
    notes:
      'Cloudflare publishes no figure for it. A change to a deployment is carried everywhere within a couple of seconds '
      + '(the docs\' "Version overrides"); a workers.dev route newly enabled took up to the longest measured here. The '
      + 'self-deploy smoke asks again while it lasts (core deploy/steps.ts SMOKE_PATIENCE_MS), never reading a 404 then '
      + 'as the version\'s own answer.',
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
      + 'that document is NOT in the working tree, only its screenshots survived the '
      + 'public-repo purge, and its recovered text (git 947c2560:docs/STABILITY-AUDIT.md §A4) '
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
      'nothing fails, but an APPLICATION-level keepalive message is not a control frame, so it '
      + 'is delivered to webSocketMessage and wakes the object every interval',
    observable: [],
    firstPartySignal: true,
    notes:
      'Cloudflare states this keeps connections alive without waking the Durable Object. '
      + 'A browser cannot send a control frame, so a page sends the JSON `PAGE_KEEPALIVE.ping` '
      + 'every 25 s and every actor registers it with `setWebSocketAutoResponse`, the same '
      + 'no-wake answer for an application frame. Until 2026-09-26 it reached '
      + 'webSocketMessage and woke an idle workspace every 25 s, per open page.',
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

  'provider.stream.idle_ms': {
    subject: 'Longest a model provider\'s stream may send no byte (before its headers, before its first chunk, or between two) before the call fails',
    limit: { value: 360_000, unit: 'ms' },
    origin: 'self-imposed',
    bounds: 'silence',
    evidence: 'observed-in-production',
    provenance: '~/kinu-logs/evals-fast/stream-silence/measurements.txt:3-10',
    date: '2026-10-01',
    trigger: 'a streamed model request whose provider sends no byte for the bound',
    onBreach: 'the fetch or its body fails with a retryable APICallError (cause KinuError timeout): the owner\'s retries, then the fallback chain, take over',
    observable: [{ context: 'the turn\'s provider failure', message: 'sent nothing for' }],
    firstPartySignal: true,
    notes: 'Twice the longest silence a completed stream showed across 427 eval trials (7,665 steps) on kinu.run and '
      + 'staging, 2026-09-30..10-01: opencode-go Muse thinking between reasoning-start and reasoning-end. Measured as '
      + 'SDK events reached the eval client, an upper bound on raw-byte silence: OpenRouter documents ": OPENROUTER '
      + 'PROCESSING" keep-alive comments, which are bytes and re-arm the bound; opencode-go sends no byte at all while '
      + 'Muse thinks (probes/raw-bytes-muse-2026-10-01.log). Live stalls it ends: Muse 40+ min '
      + '(t34) and OpenRouter Ling heads 38+ min (t33), staging f75f06932.',
    measurements: [
      { scenario: 'opencode-go/muse-spark-1.3: longest silence inside a completed step (n=4,018, p99 52.3s)', value: 181_800, unit: 'ms' },
      { scenario: 'opencode-go/muse-spark-1.3: request to first content, waits out (p99 26.5s)', value: 136_100, unit: 'ms' },
      { scenario: 'opencode-go/muse-spark-1.3 raw socket, effort high: no byte while the reasoning item is open', value: 55_718, unit: 'ms' },
      { scenario: 'openrouter/ling-3.0-flash-vl: request to first content (n=2,206, p99 6.1s)', value: 94_900, unit: 'ms' },
      { scenario: 'workers-ai/glm-5.3: request to first content, 429 waits out (n=127, p99 45.5s)', value: 73_100, unit: 'ms' },
      { scenario: 'openrouter/mercury-2.5: request to first content (n=1,298, p99 13.0s)', value: 27_300, unit: 'ms' },
    ],
  },

  'job.context_silence_ms': {
    subject: 'Longest the context a detached background job runs in may leave its liveness probe unanswered before the job is given up as lost',
    limit: { value: 600_000, unit: 'ms' },
    origin: 'self-imposed',
    bounds: 'silence',
    evidence: 'observed-in-production',
    provenance: '~/kinu-logs/research/HUNG-RPC-ArmedBat.md:67-87',
    date: '2026-10-08',
    trigger: 'a running job whose context answered no probe for the bound, read at an alarm',
    onBreach: 'the job is recovered as an evicted one is: re-driven if its kind resumes, else settled failed saying it was lost, and its agent woken',
    observable: [{ context: 'the job\'s settled error', message: 'nothing came back from its work for' }],
    firstPartySignal: true,
    notes: 'Twice the per-invocation CPU limit Kinu configures (limits.cpu_ms 300 s), which staging reached (302.5 s, '
      + '2026-10-08). A probe waits for the CPU queued ahead of it on its object\'s thread and nothing else, so the '
      + 'bound holds while no object queues more than it: the most any production workspace object spent in any 600 s '
      + 'window was 577.8 s, a 4 % margin over that coarse upper bound. A job misjudged past it is safe: its re-drive '
      + 'claims a new epoch first, and the first attempt is refused every write. Silence re-armed by every answer, '
      + 'never a limit on how long the job runs. Staging bgjob-qwywfmf0ej8nhsf4jxlym (2026-10-08 07:44Z) detached and '
      + 'never ended while its workspace served 800+ more invocations.',
    measurements: [
      { scenario: 'staging OrchestratorAgent, max CPU in one invocation over 24 h (n=279,216)', value: 302_500, unit: 'ms' },
      { scenario: 'production OrchestratorAgent, max CPU in one invocation over 7 days, sampled', value: 29_338, unit: 'ms' },
      { scenario: 'production, most CPU one workspace object spent in any 600 s window over 72 h: the most a probe can queue behind', value: 577_805, unit: 'ms' },
      { scenario: 'workerd, a probe sent into 40 queued invocations of 28 ms CPU each: it waits for the work ahead of it, then answers', value: 953, unit: 'ms' },
    ],
  },

  'browser.session.keep_alive_ms': {
    subject: 'Longest a Browser Run Chrome session may sit idle, with no connection, before it closes',
    limit: { value: 1_200_000, unit: 'ms' },
    origin: 'platform',
    bounds: 'duration',
    evidence: 'proven-by-probe',
    provenance: '~/kinu-logs/browser/PROBES-2026-09-28.md#keepalive',
    date: '2026-09-28',
    trigger: 'acquire({ keepAlive }) above 1,200,000; or a session idle longer than the keepAlive it was acquired with',
    onBreach: 'acquire is refused with 400; an idle session closes and getSession answers null',
    observable: [{ context: 'env.BROWSER.acquire', message: 'BrowserBindingError: Too big: expected number to be <=1200000 (status=400, code=2000)' }],
    firstPartySignal: true,
    notes:
      'Kitesurf takes no keep_alive at all ("Options not supported with browser=kitesurf: keep_alive"): its session '
      + 'is created on connect and ends with the connection, so web/browser-sessions.ts records Chrome sessions only.',
  },
} as const satisfies Readonly<Record<string, PlatformFact>>;

export type PlatformFactId = keyof typeof PLATFORM_CATALOG;

export interface PlatformFactEntry {
  readonly id: string;
  readonly fact: PlatformFact;
}

/** For iteration: indexing the `as const` catalog by a variable yields a union where optional fields are unaddressable. */
export function platformFact(id: PlatformFactId): PlatformFact {
  return PLATFORM_CATALOG[id];
}

export function platformFactEntries(): readonly PlatformFactEntry[] {
  return platformFactIds().map((id) => ({ id, fact: platformFact(id) }));
}

/**
 * The predicate narrows rather than casts, restoring the key union `Object.keys` loses. A function, not a module-scope
 * list: the browser imports modules that import this one, and a call at module scope ships the whole catalog to it.
 */
export function platformFactIds(): readonly PlatformFactId[] {
  return Object.keys(PLATFORM_CATALOG).filter((id): id is PlatformFactId => id in PLATFORM_CATALOG);
}

/** Since the last byte, never a total. */
export type SilenceBoundId = {
  [Id in PlatformFactId]: (typeof PLATFORM_CATALOG)[Id]['bounds'] extends 'silence' ? Id : never;
}[PlatformFactId];

export function silenceBoundMs(id: SilenceBoundId): number {
  return PLATFORM_CATALOG[id].limit.value;
}

/** The faults a deterministic-simulation lane may inject: the catalog filtered to proven evidence. */
export function injectableFaults(): readonly PlatformFactId[] {
  return platformFactIds().filter((id) => PROVEN_LABELS.includes(platformFact(id).evidence));
}
