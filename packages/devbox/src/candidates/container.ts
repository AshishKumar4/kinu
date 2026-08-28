import * as v from 'valibot';

import {
  CandidatePublicationDraftSchema,
  type CandidatePublicationDraft,
} from './publication';
import {
  CandidateRunControlV1Schema,
  type CandidateControlStateV1,
  type CandidateRunControlV1,
} from '../durability/contracts';
import { DEVBOX_RUNTIME_DIR, DEVBOX_WORKDIR } from '../storage';
import type { AttachOutcome, CheckpointKind, CheckpointOutcome, DevboxStorage } from '../storage';

export type CandidateContainerFormat = 'bounded-layers' | 'merkle-pack';

/** The mounted immutable-object prefix used by the runner payload store. */
export const CANDIDATE_STORE_MOUNT = `${DEVBOX_RUNTIME_DIR}/candidate-r2`;

/**
 * The control envelope is deliberately outside the payload mount. A container
 * replacement owns the mounted payload subtree, while the Durable Object owns
 * the envelope that makes its head readable after that replacement.
 */
export interface CandidateStorePaths {
  readonly payloadPrefix: string;
  readonly envelopePrefix: string;
  readonly mountPrefix: string;
}

export function candidateStorePaths(
  boxPrefix: string,
  format: CandidateContainerFormat,
): CandidateStorePaths {
  const payloadPrefix = `${boxPrefix}/candidate/${format}`;
  return {
    payloadPrefix,
    envelopePrefix: `${boxPrefix}/candidate-control/${format}/envelopes`,
    mountPrefix: `/${payloadPrefix}`,
  };
}
/** Runner results remain local control replies, never DO payload. */
export const CANDIDATE_RUNNER_RESULT_DIR = `${DEVBOX_RUNTIME_DIR}/candidate-results`;

/**
 * The mutation journal for one candidate arm. The daemon backs `root` and
 * presents it at the workdir, so every workload write is journaled and a
 * checkpoint reads a fenced cut instead of walking the tree. Its state — the
 * control socket and the sealed stage — stays outside both the journal mount
 * and the store mount, or a capture would read through the mount it captures.
 */
export const CANDIDATE_JOURNAL_BINARY = '/usr/local/bin/kinu-journal-daemon';
export const CANDIDATE_JOURNAL_ROOT = `${DEVBOX_RUNTIME_DIR}/candidate-journal/root`;
export const CANDIDATE_JOURNAL_STATE = `${DEVBOX_RUNTIME_DIR}/candidate-journal/state`;
export const CANDIDATE_JOURNAL_SOCKET = `${CANDIDATE_JOURNAL_STATE}/control.sock`;
export const CANDIDATE_JOURNAL_MOUNT = DEVBOX_WORKDIR;

/**
 * The host seam for one candidate arm. The container receives only control
 * metadata — the durable head pointer with the envelope it names, plus the
 * operation the host begun — and moves payload bytes over the mounted store.
 */
export interface CandidateRunnerProcess {
  readonly id: string;
  getLogs(): Promise<{ readonly stdout: string; readonly stderr: string }>;
}

export interface CandidateAttachmentHealth {
  readonly storeMounted: boolean;
  readonly storeAccessible: boolean;
  readonly journalProcess: boolean;
  readonly journalSocket: boolean;
  readonly journalMounted: boolean;
}

function attachmentFailure(health: CandidateAttachmentHealth): string {
  const missing = [
    !health.storeMounted ? 'store mount' : undefined,
    !health.storeAccessible ? 'store access' : undefined,
    !health.journalProcess ? 'journal process' : undefined,
    !health.journalSocket ? 'journal socket' : undefined,
    !health.journalMounted ? 'journal mount' : undefined,
  ].filter((part): part is string => part !== undefined);
  return `candidate attached-container repair could not establish ${missing.join(', ')}`;
}

async function retireRunnerAttempt(
  ports: CandidateContainerPorts,
  processId: string,
  resultPath: string,
): Promise<void> {
  try {
    await ports.clearRunnerAttempt(resultPath);
  } catch (cause) {
    console.error(
      `[devbox] terminal candidate runner ${processId} could not be cleared: `
      + (cause instanceof Error ? cause.message : String(cause)),
    );
  }
}

export interface CandidateContainerPorts {
  readonly format: CandidateContainerFormat;
  readonly runnerPath: string;
  readonly mountStore: () => Promise<void>;
  readonly unmountStore: () => Promise<void>;
  readonly clearStore: () => Promise<void>;
  /** Facts observed from the live container; each repair decision starts here. */
  readonly attachmentHealth: () => Promise<CandidateAttachmentHealth>;
  readonly begin: (kind: CheckpointKind) => Promise<CandidateRunControlV1>;
  readonly finalize: (draft: CandidatePublicationDraft) => Promise<CandidateControlStateV1>;
  readonly restoreState: () => Promise<CandidateRunControlV1>;
  /** Settles a fenced manifest that is already the immutable published head. */
  readonly settleNoChange: (control: CandidateRunControlV1) => Promise<CandidateControlStateV1>;
  readonly bootId: () => Promise<string | undefined>;
  /** Creates a fresh transfer attempt after its runner terminates. */
  readonly redrive: (control: CandidateRunControlV1) => Promise<CandidateRunControlV1>;
  readonly clearControl: () => Promise<void>;
  /** Clears a terminal reply before the one checkpoint process id is reused. */
  readonly clearRunnerAttempt: (resultPath: string) => Promise<void>;
  /** Removes all local runner reply files when the candidate itself is discarded. */
  readonly clearRunnerResults: () => Promise<void>;
  /** Mounts the journal daemon over the workdir once its root is materialized. */
  readonly startJournal: () => Promise<void>;
  /** Stops the daemon and releases the workdir mount. An absent daemon is not an error. */
  readonly stopJournal: () => Promise<void>;
  readonly getRunnerProcess: (processId: string) => Promise<CandidateRunnerProcess | null>;
  /** Wait through process metadata, never the SDK's SSE log stream. */
  readonly waitForRunnerExit: (processId: string) => Promise<{ readonly exitCode: number }>;
  /** The live checkpoint that still owns the journal, if one is resumable. */
  readonly activeCheckpoint: () => Promise<CandidateRunnerProcess | null>;
  readonly startRunnerProcess: (
    command: string,
    processId: string,
  ) => Promise<CandidateRunnerProcess>;
  readonly readRunnerResult: (path: string) => Promise<string>;
  readonly boxId: () => string;
  readonly recordFailure: (reason: string) => Promise<void>;
}

const RestoreReplySchema = v.strictObject({
  ok: v.literal(true),
  rootId: v.nullable(v.string()),
});
const SeedReplySchema = v.strictObject({
  ok: v.literal(true),
});
const CheckpointReplySchema = v.union([
  v.strictObject({
    ok: v.literal(true),
    noChange: v.literal(true),
  }),
  v.strictObject({
    ok: v.literal(true),
    movedBytes: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    heldBytes: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    draft: CandidatePublicationDraftSchema,
  }),
]);
/** The fixed SDK process/result slot for the one active checkpoint control record. */
export interface CandidateRunnerPaths {
  readonly processId: string;
  readonly resultPath: string;
}

export function candidateCheckpointRunnerPaths(): CandidateRunnerPaths {
  return {
    processId: 'candidate-runner-checkpoint',
    resultPath: `${CANDIDATE_RUNNER_RESULT_DIR}/checkpoint.json`,
  };
}
async function runnerPaths(
  action: 'checkpoint' | 'restore' | 'seed',
  control: CandidateRunControlV1,
  bootId: string | undefined,
): Promise<CandidateRunnerPaths> {
  if (action === 'checkpoint') {
    const operation = control.operation;
    if (operation?.phase !== 'transferring') {
      throw new Error('candidate checkpoint has no transferring operation');
    }
    return candidateCheckpointRunnerPaths();
  }
  const identity = `${action}:${control.head?.pointer.rootEnvelopeId ?? 'empty'}:${bootId ?? 'missing-boot'}`;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)));
  const key = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  return {
    processId: `candidate-runner-${key}`,
    resultPath: `${CANDIDATE_RUNNER_RESULT_DIR}/${key}.json`,
  };
}

function runnerCommand(
  ports: CandidateContainerPorts,
  action: 'checkpoint' | 'restore' | 'seed',
  control: CandidateRunControlV1,
  resultPath: string,
): string {
  const parts = [
    'bun', ports.runnerPath,
    '--action', action,
    '--format', ports.format,
    '--workspace', CANDIDATE_JOURNAL_ROOT,
    '--journal-socket', CANDIDATE_JOURNAL_SOCKET,
    '--store', CANDIDATE_STORE_MOUNT,
    '--box', ports.boxId(),
    '--control-state', btoa(JSON.stringify(v.parse(CandidateRunControlV1Schema, control))),
    '--result', resultPath,
  ];
  return parts.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(' ');
}

async function invokeRunner<Reply>(
  ports: CandidateContainerPorts,
  action: 'checkpoint' | 'restore' | 'seed',
  control: CandidateRunControlV1,
  bootId: string | undefined,
  schema: v.GenericSchema<unknown, Reply>,
  existing?: CandidateRunnerProcess,
): Promise<Reply> {
  const paths = await runnerPaths(action, control, bootId);
  const retained = existing
    ?? (action === 'checkpoint'
      ? await ports.activeCheckpoint()
      : await ports.getRunnerProcess(paths.processId));
  const process = retained
    ?? await ports.startRunnerProcess(runnerCommand(ports, action, control, paths.resultPath), paths.processId);
  const exited = await ports.waitForRunnerExit(process.id);
  if (exited.exitCode !== 0) {
    const logs = await process.getLogs();
    throw new Error(`candidate ${action} failed: ${logs.stderr || logs.stdout}`);
  }
  return v.parse(schema, JSON.parse(await ports.readRunnerResult(paths.resultPath)));
}

async function invokeRestore(
  ports: CandidateContainerPorts,
  control: CandidateRunControlV1,
  bootId: string | undefined,
  existing?: CandidateRunnerProcess,
) {
  return await invokeRunner(ports, 'restore', control, bootId, RestoreReplySchema, existing);
}

async function invokeCheckpoint(ports: CandidateContainerPorts, control: CandidateRunControlV1) {
  return await invokeRunner(ports, 'checkpoint', control, undefined, CheckpointReplySchema);
}

async function seedJournal(
  ports: CandidateContainerPorts,
  control: CandidateRunControlV1,
): Promise<void> {
  await invokeRunner(ports, 'seed', control, undefined, SeedReplySchema);
}

/**
 * The candidate arms share one container path. The runner moves payload only
 * through that mount. The Durable Object supplies and updates small control
 * metadata; it never receives a payload body.
 */
export function candidateContainerStorage(ports: CandidateContainerPorts): DevboxStorage {
  let attaching: Promise<AttachOutcome> | undefined;

  const attach = async (): Promise<AttachOutcome> => {
    const control = await ports.restoreState();
    // A restore runner stays in the container after an isolate reset. Find it
    // before mountStore, because a replacement mount cuts off its payload read.
    const bootId = await ports.bootId();
    const paths = await runnerPaths('restore', control, bootId);
    const existing = await ports.getRunnerProcess(paths.processId);
    if (existing !== null) {
      const restored = await invokeRestore(ports, control, bootId, existing);
      // A reset can lose the box's in-memory attach state after the previous
      // attach started its journal but before it stamped the boot. Reuse the
      // completed restore result, but replace that daemon before serving work:
      // two daemons must never recover or append one journal/WAL concurrently.
      await ports.stopJournal();
      await ports.startJournal();
      await seedJournal(ports, control);
      return restored.rootId === null
        ? { kind: 'empty', detail: 'candidate control has no published head' }
        : { kind: 'attached', detail: `restored candidate root ${restored.rootId}` };
    }

    await ports.mountStore();
    // Materialize beneath the journal, never through it: a restore is not a
    // workload mutation, and the first cut after a wake must describe the
    // restored tree rather than a rewrite of every file in it.
    await ports.stopJournal();
    const restored = await invokeRestore(ports, control, bootId);
    await ports.startJournal();
    await seedJournal(ports, control);
    return restored.rootId === null
      ? { kind: 'empty', detail: 'candidate control has no published head' }
      : { kind: 'attached', detail: `restored candidate root ${restored.rootId}` };
  };

  const repairAttached = async (): Promise<void> => {
    const checkpoint = await ports.activeCheckpoint();
    let health = await ports.attachmentHealth();
    if (checkpoint !== null) {
      if (health.storeMounted && health.storeAccessible
        && health.journalProcess && health.journalSocket && health.journalMounted) return;
      await ports.waitForRunnerExit(checkpoint.id);
      health = await ports.attachmentHealth();
    }
    if (!health.storeMounted || !health.storeAccessible) {
      await ports.mountStore();
      health = await ports.attachmentHealth();
      if (!health.storeMounted || !health.storeAccessible) throw new Error(attachmentFailure(health));
    }
    if (!health.journalProcess || !health.journalSocket || !health.journalMounted) {
      await ports.stopJournal();
      await ports.startJournal();
    }
    // A finalization can commit the durable head just before this isolate dies.
    // Seeding a healthy daemon is idempotent when it already has that head and
    // advances it when its in-memory base is stale.
    await seedJournal(ports, await ports.restoreState());
    health = await ports.attachmentHealth();
    if (!health.storeMounted || !health.storeAccessible
      || !health.journalProcess || !health.journalSocket || !health.journalMounted) {
      throw new Error(attachmentFailure(health));
    }
  };

  return {
    async attach(): Promise<AttachOutcome> {
      if (attaching !== undefined) return await attaching;
      const run = attach();
      attaching = run;
      try {
        return await run;
      } finally {
        if (attaching === run) attaching = undefined;
      }
    },
    repairAttached,
    async checkpoint(kind: CheckpointKind): Promise<CheckpointOutcome> {
      const operationKind = kind === 'tick' ? 'tick' : 'barrier';
      try {
        for (;;) {
          const begun = await ports.begin(kind);
          const active = begun.operation;
          if (active?.phase !== 'transferring') {
            throw new Error(`candidate ${kind} did not begin a transferring operation`);
          }
          const paths = await runnerPaths('checkpoint', begun, undefined);
          let staged: v.InferOutput<typeof CheckpointReplySchema>;
          try {
            staged = await invokeCheckpoint(ports, begun);
          } catch (error) {
            // A terminal runner must never retain the reusable process slot.
            // If redrive itself is interrupted, the cleared slot lets the
            // persisted operation be resumed by the next checkpoint.
            try {
              await ports.redrive(begun);
            } catch (cause) {
              console.error(
                `[devbox] terminal candidate runner could not be redriven: `
                + (cause instanceof Error ? cause.message : String(cause)),
              );
            } finally {
              await retireRunnerAttempt(ports, paths.processId, paths.resultPath);
            }
            throw error;
          }
          if ('noChange' in staged) {
            await ports.settleNoChange(begun);
            await retireRunnerAttempt(ports, paths.processId, paths.resultPath);
            if (active.kind !== operationKind) continue;
            return {
              kind: 'skipped',
              reason: `candidate ${ports.format} ${kind} fenced the published manifest`,
              bytes: undefined,
              movedBytes: 0,
            };
          }
          const finalized = await ports.finalize(staged.draft);
          const head = finalized.head;
          if (head === null) throw new Error('candidate finalization did not publish a head');
          await seedJournal(ports, await ports.restoreState());
          await retireRunnerAttempt(ports, paths.processId, paths.resultPath);
          // AGAINST THE OPERATION KIND, never against the checkpoint kind. A
          // record's kind is `tick` or `barrier`; a checkpoint's is `tick` or
          // `quiesce`. Comparing the two made every published quiesce take the
          // `continue` — `barrier !== 'quiesce'` is always true — so the loop
          // published a fresh generation forever and no candidate box could
          // ever stop. The no-change branch above already compares the right
          // one; this is the same question and now asks it the same way.
          if (active.kind !== operationKind) continue;
          return {
            kind: 'committed',
            reason: `candidate ${ports.format} ${kind} published ${head.rootEnvelopeId}`,
            bytes: staged.heldBytes,
            movedBytes: staged.movedBytes,
          };
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        try {
          await ports.recordFailure(reason);
        } catch (cause) {
          console.error(
            `[devbox] the failure of "${reason}" could not be recorded durably: `
            + (cause instanceof Error ? cause.message : String(cause)),
          );
        }
        return { kind: 'failed', reason, bytes: undefined, movedBytes: undefined };
      }
    },
    detach: async () => {
      await ports.stopJournal();
      await ports.unmountStore();
    },
    discard: async () => {
      await ports.stopJournal();
      await ports.unmountStore();
      await ports.clearStore();
      await ports.clearRunnerResults();
      await ports.clearControl();
    },
  };
}
