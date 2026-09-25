/** In-container sync (D30): the image's `sync.js` checkpoints on the container's own disk and
 *  egress, and asks its box only for the record, the binding and the store mount. */
import * as v from 'valibot';
import { describeThrown as describe } from './lifecycle';
import { shellPath } from './chunked-delta';
import {
  CHAIN_STORE_MOUNT,
  ChainRecordAdvanced,
  baseObjectKey,
  deltaObjectKey,
  normalizeChainState,
  seedStampPorts,
  storeObjectUrl,
  type ChainLayer,
  type ChainState,
  type ChangeStatus,
  type SnapshotChainPorts,
} from './snapshot-chain';
import {
  CHECKPOINT_OUTCOME_KINDS,
  DEVBOX_RUNTIME_DIR,
  DEVBOX_WORKDIR,
  type CheckpointKind,
  type CheckpointOutcome,
  type DevboxStorage,
  type StoredValue,
} from './storage';

/** Resolves nowhere publicly: a lapse in interception fails to connect. */
export const DEVBOX_SYNC_HOST = 'devbox.internal';

export const DEVBOX_SYNC_HANDLER = 'devboxSync';

/** Not the default session: the store mount the flush asks for runs there. */
export const DEVBOX_SYNC_SESSION = 'devbox-sync';

export const DEVBOX_SYNC_PROGRAM = '/usr/local/lib/devbox/sync.js';

/** In `/tmp` so a replacement container cannot inherit it. */
export const BOOT_ID_PATH = '/tmp/devbox-boot-id';

export const SYNC_PID_PATH = `${DEVBOX_RUNTIME_DIR}/sync.pid`;

export const SYNC_SOCKET_PATH = `${DEVBOX_RUNTIME_DIR}/sync.sock`;

const SyncConfigSchema = v.object({
  storeRoot: v.pipe(v.string(), v.minLength(1)),
  binding: v.pipe(v.string(), v.minLength(1)),
  excludes: v.array(v.string()),
  periodMs: v.pipe(v.number(), v.integer(), v.minValue(1_000)),
});

export type SyncConfig = v.InferOutput<typeof SyncConfigSchema>;

function encodeSyncConfig(config: SyncConfig): string {
  return Buffer.from(JSON.stringify(config)).toString('base64');
}

export function decodeSyncConfig(encoded: string | undefined): SyncConfig {
  if (encoded === undefined || encoded === '') throw new Error('DEVBOX_SYNC_CONFIG is not set: only the box starts this program');

  return v.parse(SyncConfigSchema, JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')));
}

const WireValueSchema: v.GenericSchema<StoredValue> = v.lazy(() => WireValueOptions);

const WireValueOptions: v.GenericSchema<StoredValue> = v.union([
  v.string(), v.number(), v.boolean(), v.null(), v.array(WireValueSchema), v.record(v.string(), WireValueSchema),
]);

/** `clearState`, attach and extraction stay the box's. */
const RequestSchema = v.variant('op', [
  v.object({ op: v.literal('readState') }),
  v.object({ op: v.literal('writeState'), state: WireValueSchema, expectedRev: v.nullable(v.number()) }),
  v.object({ op: v.literal('checkChanges'), dir: v.string(), since: v.nullable(v.string()) }),
  v.object({ op: v.literal('mountStore'), at: v.string() }),
  v.object({ op: v.literal('unmountStore'), at: v.string() }),
  v.object({ op: v.literal('objectFacts'), key: v.string() }),
  v.object({ op: v.literal('deleteObjects'), keys: v.array(v.string()) }),
]);

type ReceivedRequest = v.InferOutput<typeof RequestSchema>;

type SyncRequest =
  | { readonly op: 'readState' }
  | { readonly op: 'writeState'; readonly state: ChainState; readonly expectedRev: number | null }
  | { readonly op: 'checkChanges'; readonly dir: string; readonly since: string | null }
  | { readonly op: 'mountStore' | 'unmountStore'; readonly at: string }
  | { readonly op: 'objectFacts'; readonly key: string }
  | { readonly op: 'deleteObjects'; readonly keys: readonly string[] };

const EnvelopeSchema = v.object({ generation: v.nullable(v.string()), request: RequestSchema });

const ChangesReplySchema = v.object({ status: v.picklist(['unchanged', 'changed', 'resync']), version: v.string() });

const LayerReplySchema = v.nullable(v.object({
  bytes: v.number(),
  digest: v.optional(v.string()),
  objectVersion: v.optional(v.string()),
}));

const RefusalSchema = v.union([
  v.object({ ok: v.literal(false), error: v.literal('advanced'), expectedRev: v.nullable(v.number()), storedRev: v.nullable(v.number()) }),
  v.object({ ok: v.literal(false), error: v.literal('refused'), reason: v.string() }),
]);

const ReplySchema = v.union([v.object({ ok: v.literal(true), value: WireValueSchema }), RefusalSchema]);

type SyncValue = ChainState | { readonly status: ChangeStatus; readonly version: string } | ChainLayer | null;

type SyncReply = { readonly ok: true; readonly value: SyncValue } | v.InferOutput<typeof RefusalSchema>;

interface SyncHost {
  readonly ports: SnapshotChainPorts;
  readonly generation: () => Promise<string | undefined>;
}

export interface SyncAnswer {
  readonly status: number;
  readonly body: string;
}

function answer(reply: SyncReply): SyncAnswer {
  let status = 200;

  if (!reply.ok) status = reply.error === 'advanced' ? 409 : 403;

  return { status, body: JSON.stringify(reply) };
}

/** Any process in the container can reach the host, so the box refuses another generation, a key
 *  outside its store root, and a record naming a layer the store does not hold at that size. */
export async function serveSync(host: SyncHost, body: string): Promise<SyncAnswer> {
  let envelope: v.InferOutput<typeof EnvelopeSchema>;

  try {
    envelope = v.parse(EnvelopeSchema, JSON.parse(body));
  } catch (error) {
    return answer({ ok: false, error: 'refused', reason: `not a sync request: ${describe({ cause: error })}` });
  }

  const restored = await host.generation();

  if (restored === undefined || envelope.generation !== restored) {
    return answer({
      ok: false, error: 'refused',
      reason: `container generation ${envelope.generation ?? 'none'} is not the one this box restored (${restored ?? 'none'})`,
    });
  }

  try {
    return answer({ ok: true, value: await dispatch(host.ports, envelope.request) });
  } catch (error) {
    if (error instanceof ChainRecordAdvanced) {
      return answer({ ok: false, error: 'advanced', expectedRev: error.expectedRev, storedRev: error.storedRev });
    }

    return answer({ ok: false, error: 'refused', reason: describe({ cause: error }) });
  }
}

async function dispatch(ports: SnapshotChainPorts, request: ReceivedRequest): Promise<SyncValue> {
  const root = ports.storeRoot();

  const inRoot = (key: string): string => {
    if (!key.startsWith(`${root}/`)) throw new Error(`${key} is outside this box's store prefix ${root}`);

    return key;
  };

  switch (request.op) {
    case 'readState':
      return await ports.readState();

    case 'writeState': {
      const next = normalizeChainState(request.state);

      if (next === null) throw new Error('the proposed chain record does not parse');
      await assertLayersHeld(ports, root, next);
      await ports.writeState(next, request.expectedRev);

      return null;
    }

    case 'checkChanges':
      if (request.dir !== DEVBOX_WORKDIR) throw new Error(`only ${DEVBOX_WORKDIR} is tracked, not ${request.dir}`);

      return await ports.checkChanges(request.dir, request.since ?? undefined);

    case 'mountStore':
    case 'unmountStore':
      if (request.at !== CHAIN_STORE_MOUNT) throw new Error(`the store mounts only at ${CHAIN_STORE_MOUNT}, not ${request.at}`);
      await (request.op === 'mountStore' ? ports.mountStore(request.at) : ports.unmountStore(request.at));

      return null;

    case 'objectFacts':
      return (await ports.objectFacts(inRoot(request.key))) ?? null;

    case 'deleteObjects':
      await ports.deleteObjects(request.keys.map(inRoot));

      return null;
  }
}

async function assertLayersHeld(ports: SnapshotChainPorts, root: string, next: ChainState): Promise<void> {
  if (next.mode !== 'chain') throw new Error('the container proposes chain records only');
  const stored = await ports.readState();

  const named = [
    { key: baseObjectKey(root, next.base.id), bytes: next.base.bytes, known: stored?.base.id === next.base.id },
    ...(next.delta === undefined ? [] : [{
      key: deltaObjectKey(root, next.delta.id ?? next.base.id),
      bytes: next.delta.bytes,
      known: stored?.delta?.id === next.delta.id && stored?.base.id === next.base.id,
    }]),
  ];

  for (const layer of named) {
    if (layer.known) continue;
    const held = await ports.objectFacts(layer.key);

    if (held?.bytes !== layer.bytes) {
      throw new Error(`the proposed record names ${layer.key} at ${String(layer.bytes)} bytes and the store holds ${held === undefined ? 'no such object' : `${String(held.bytes)} bytes`}`);
    }
  }
}

type SyncTransport = (body: string) => Promise<{ readonly status: number; readonly text: string }>;

type SyncCall = (request: SyncRequest) => Promise<StoredValue>;

/** A fenced refusal surfaces as {@link ChainRecordAdvanced}, so the checkpoint re-reads. */
export function syncCaller(transport: SyncTransport, generation: () => Promise<string | undefined>): SyncCall {
  return async (request) => {
    const sent = await transport(JSON.stringify({ generation: (await generation()) ?? null, request }));
    let reply: v.InferOutput<typeof ReplySchema>;

    try {
      reply = v.parse(ReplySchema, JSON.parse(sent.text));
    } catch (error) {
      throw new Error(`the box answered ${request.op} with ${String(sent.status)}: ${sent.text.slice(0, 300)}`, { cause: error });
    }

    if (reply.ok) return reply.value;

    if (reply.error === 'advanced') throw new ChainRecordAdvanced(reply.expectedRev, reply.storedRev);

    throw new Error(`the box refused ${request.op}: ${reply.reason}`);
  };
}

interface SyncIo {
  readonly exec: SnapshotChainPorts['exec'];
  readonly call: SyncCall;
  readonly generation: () => Promise<string | undefined>;
  readonly log: (line: string) => void;
}

/** The record is remembered from the last read or write, so a tick with nothing to commit asks the
 *  box nothing; a refused write forgets it. */
export function containerChainPorts(config: SyncConfig, io: SyncIo): SnapshotChainPorts {
  const refuse = async (what: string): Promise<never> => {
    throw new Error(`${what} is the box's, not the container's`);
  };

  let known: { readonly state: ChainState | null } | undefined;

  return {
    containerRunning: () => true,
    allowExtraction: () => false,
    archiveExcludes: () => config.excludes,
    readState: async () => {
      known ??= { state: normalizeChainState(await io.call({ op: 'readState' })) };

      return known.state;
    },
    writeState: async (state, expectedRev) => {
      const started = Date.now();

      try {
        await io.call({ op: 'writeState', state, expectedRev });
        known = { state };
        io.log(JSON.stringify({ event: 'devbox.sync.commit', rev: state.rev, ms: Date.now() - started }));
      } catch (error) {
        known = undefined;
        throw error;
      }
    },
    clearState: async () => await refuse('discarding the record'),
    checkpointIntervalMs: () => config.periodMs,
    checkChanges: async (dir, since) => v.parse(ChangesReplySchema, await io.call({ op: 'checkChanges', dir, since: since ?? null })),
    exec: io.exec,
    containerGeneration: io.generation,
    storeRoot: () => config.storeRoot,
    storeObjectUrl: (key) => storeObjectUrl(config.storeRoot, config.binding, key),
    mountStore: async (at) => {
      await io.call({ op: 'mountStore', at });
    },
    unmountStore: async (at) => {
      await io.call({ op: 'unmountStore', at });
    },
    stamp: (phase) => {
      io.log(JSON.stringify({ event: 'devbox.sync.stamp', phase }));
    },
    objectFacts: async (key) => {
      const facts = v.parse(LayerReplySchema, await io.call({ op: 'objectFacts', key }));

      return facts === null ? undefined : { bytes: facts.bytes, digest: facts.digest, objectVersion: facts.objectVersion };
    },
    deleteObjects: async (keys) => {
      await io.call({ op: 'deleteObjects', keys });
    },
    ...seedStampPorts(io.exec),
    countEntries: async (dir) => {
      const counted = await io.exec(countEntriesCommand(dir));

      if (counted.exitCode !== 0) throw new Error(`counting ${dir} failed: ${counted.stderr.trim()}`);

      return Number(counted.stdout.trim());
    },
    restoreExtract: async () => await refuse('extraction'),
    createExtractSnapshot: async () => await refuse('extraction'),
    now: () => Date.now(),
    log: io.log,
  };
}

function countEntriesCommand(dir: string): string {
  return `find ${shellPath(dir)} -mindepth 1 -maxdepth 1 | wc -l`;
}

/** Ticks and flushes never overlap; a checkpoint that throws is a failed outcome, not an exit. */
export function syncWorker(storage: DevboxStorage): SyncWorker {
  const checkpoint = async (kind: CheckpointKind): Promise<CheckpointOutcome> => {
    try {
      return await storage.checkpoint(kind);
    } catch (error) {
      return { kind: 'failed', reason: `the checkpoint threw: ${describe({ cause: error })}`, bytes: undefined, movedBytes: undefined };
    }
  };

  let last: Promise<CheckpointOutcome | undefined> = Promise.resolve(undefined);

  return {
    run: async (kind) => {
      const run = last.then(async () => await checkpoint(kind));
      last = run;

      return await run;
    },
    drained: async () => {
      await last;
    },
  };
}

export interface SyncLoop {
  readonly periodMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  readonly stopped: () => boolean;
}

/** A full period after each tick ends, so the interval gate never skips a tick (tickClock). */
export async function runSyncLoop(run: (kind: CheckpointKind) => Promise<CheckpointOutcome>, loop: SyncLoop): Promise<void> {
  for (;;) {
    await loop.sleep(loop.periodMs);

    if (loop.stopped()) return;
    const started = Date.now();
    const outcome = await run('tick');
    loop.log(JSON.stringify({ event: 'devbox.sync.tick', ms: Date.now() - started, ...outcome }));
  }
}

export interface SyncWorker {
  readonly run: (kind: CheckpointKind) => Promise<CheckpointOutcome>;
  readonly drained: () => Promise<void>;
}

const OutcomeSchema = v.object({
  kind: v.picklist(CHECKPOINT_OUTCOME_KINDS),
  reason: v.optional(v.string()),
  bytes: v.optional(v.number()),
  movedBytes: v.optional(v.number()),
});

export function parseSyncOutcome(stdout: string, stderr: string, exitCode: number): CheckpointOutcome {
  try {
    const parsed = v.parse(OutcomeSchema, JSON.parse(stdout.trim().split('\n').at(-1) ?? ''));

    return { kind: parsed.kind, reason: parsed.reason, bytes: parsed.bytes, movedBytes: parsed.movedBytes };
  } catch (error) {
    return {
      kind: 'failed',
      reason: `the container's sync answered no outcome (exit ${String(exitCode)}): ${stderr.trim() || stdout.trim() || describe({ cause: error })}`,
      bytes: undefined,
      movedBytes: undefined,
    };
  }
}

/** `$sync` is the running program's pid or empty; a reused pid is not the program. */
const FIND_SYNC = `sync=$(cat '${SYNC_PID_PATH}' 2>/dev/null); `
  + `grep -qs ${DEVBOX_SYNC_PROGRAM} "/proc/$sync/cmdline" 2>/dev/null || sync=`;

/** Workers Logs carries the container's stdout; a log it cannot take never stops the sync. */
const TO_CONTAINER_LOG = 'tee --output-error=warn /proc/1/fd/1';

/** A running program is left alone: stopping it could cut a publication short. */
export function syncStartCommand(config: SyncConfig): string {
  return `# devbox-sync-start-v1\n${FIND_SYNC}\n`
    + `if [ -z "$sync" ]; then rm -f '${SYNC_SOCKET_PATH}'; `
    + `DEVBOX_SYNC_CONFIG=${encodeSyncConfig(config)} setsid nohup bun ${DEVBOX_SYNC_PROGRAM} run </dev/null `
    + `> >(${TO_CONTAINER_LOG} >/dev/null 2>&1) 2>&1 & fi`;
}

/** Waits until the program finished its checkpoint and exited, so none races the detach; on the
 *  command line, since an unreaped exit keeps its pid. */
export function syncStopCommand(): string {
  return `# devbox-sync-stop-v1\n${FIND_SYNC}\n`
    + 'if [ -n "$sync" ]; then kill -TERM "$sync"; '
    + `while grep -qs ${DEVBOX_SYNC_PROGRAM} "/proc/$sync/cmdline"; do sleep 0.2; done; fi`;
}

export const SYNC_ALIVE_PROBE = `${FIND_SYNC}; [ -n "$sync" ] && printf alive; true`;

/** Answered by the running program after its tick in flight; the outcome is stdout. */
export function syncFlushCommand(config: SyncConfig, kind: CheckpointKind): string {
  return `# devbox-sync-flush-v1\nDEVBOX_SYNC_CONFIG=${encodeSyncConfig(config)} bun ${DEVBOX_SYNC_PROGRAM} flush ${kind} `
    + `2> >(${TO_CONTAINER_LOG} >&2)`;
}

export function parseCheckpointKind(value: string | null | undefined): CheckpointKind {
  return value === 'tick' ? 'tick' : 'quiesce';
}
