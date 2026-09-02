// A candidate box on the platform stand-in, with the two things the candidate
// arms need that an ephemeral box does not: an object store the Durable Object
// side reads and verifies against, and a container-side runner that answers.
//
// WHY THIS IS ONE FIXTURE. The candidate lifecycle is composed in `Devbox`'s
// own `#candidatePorts` — the control row's read-modify-write, the envelope
// writes, the closure verification, the runner starts and the result reads —
// and `tests/support/strategy-machine.ts` substitutes exactly those ports, so
// it cannot see a defect in how the class ORDERS them across a drive. The
// devbox-harness runs the shipped class over the faithful container; this
// module adds what a candidate strategy asks of the platform beyond that
// container, and nothing else: the runner is the one process the box starts
// that has to ANSWER, and the bucket is the one binding it reads.
import { sha256Hex } from '../../src/cas/hash';
import { MutationLog, toCapturedCut } from '../../src/capture/model';
import { BOUNDED_LAYERS_FORMAT } from '../../src/candidates/bounded-layers';
import { candidateStorePaths } from '../../src/candidates/container';
import type { CandidateContainerFormat, CandidateStorePaths } from '../../src/candidates/container';
import { MERKLE_PACK_FORMAT } from '../../src/candidates/merkle-pack';
import {
  MemoryCandidateObjectSink,
  planCandidatePublication,
  stageCandidatePayload,
  type CandidatePublicationDraft,
  type CandidatePayloadStore,
  type DurableRootFormat,
} from '../../src/candidates/publication';
import { CandidateRunControlV1Schema, CandidateControlStateV1Schema } from '../../src/durability/contracts';
import type { CandidateRunControlV1, OperationRecord } from '../../src/durability/contracts';
import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../../src/lifecycle';
import { DEVBOX_WORKDIR, type DevboxStore, type DevboxStrategyName, type StoredValue } from '../../src/storage';
import { Devbox, TEST_BOX_ID, harness, runnerOption } from './devbox-harness';
import type { Harness, RunnerInvocation, TestEnv } from './devbox-harness';
import * as v from 'valibot';

const enc = new TextEncoder();

/** Where the bundled runner lives in the image; the box only passes it on. */
export const CANDIDATE_RUNNER_PATH = '/opt/kinu/candidate-runner.bundle.mjs';

/** The root envelope id the control row's head names, or null before a publish. */
export function candidateHead(rows: Map<string, StoredValue>, format: CandidateContainerFormat): string | null {
  const row = rows.get(`devbox:candidate-control:${format}`);
  if (row === undefined) return null;
  return v.parse(CandidateControlStateV1Schema, row).head?.rootEnvelopeId ?? null;
}

/**
 * The bucket binding, in memory.
 *
 * The candidate ports reach exactly these members: `get` and `put` for the
 * envelope, `head` for the closure verification (key, size, version and the
 * sha256 checksum R2 records for a single PUT), and `list`/`delete` for a
 * discard. Each answers what the R2 binding answers, checksum included, so the
 * shipped `verifyObject` runs unchanged against it.
 */
export interface MemoryBucket {
  readonly handle: R2Bucket;
  readonly objects: Map<string, Uint8Array>;
}

export function memoryBucket(): MemoryBucket {
  const objects = new Map<string, Uint8Array>();
  const handle: R2Bucket = Object.create({
    get: async (key: string) => {
      const bytes = objects.get(key);
      if (bytes === undefined) return null;
      return { key, size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer };
    },
    put: async (key: string, value: Uint8Array) => {
      objects.set(key, value.slice());
    },
    head: async (key: string) => {
      const bytes = objects.get(key);
      if (bytes === undefined) return null;
      return {
        key,
        size: bytes.byteLength,
        version: sha256Hex(bytes),
        checksums: { sha256: await crypto.subtle.digest('SHA-256', bytes.slice()) },
      };
    },
    list: async (options?: R2ListOptions) => ({
      objects: [...objects.keys()]
        .filter((key) => key.startsWith(options?.prefix ?? ''))
        .map((key) => ({ key })),
      truncated: false,
    }),
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  });
  return { handle, objects };
}

/**
 * The container-side runner, answering the three actions the box starts it
 * for from the control snapshot the box hands it — the way the bundled runner
 * does, minus the filesystem: `restore` names the head it is handed, `seed`
 * acknowledges, and `checkpoint` either publishes what was written since the
 * last publish as a staged draft, or answers that the fence found the
 * published manifest unchanged.
 *
 * THE DRAFT IS REAL. It goes through `planCandidatePublication` and
 * `stageCandidatePayload`, and its objects land in the bucket under the box's
 * payload prefix, so the Durable Object's own finalization verifies, seals and
 * CASes exactly what it would verify on the deployment. A hand-written draft
 * would be a second opinion on the publication contract.
 */
export class PublishingRunner {
  /** Every start the box made, in order, so a test can say which action ran. */
  readonly invocations: RunnerInvocation[] = [];
  readonly #log = new MutationLog();
  #unpublished = false;

  constructor(
    private readonly bucket: MemoryBucket,
    private readonly paths: CandidateStorePaths,
    private readonly format: DurableRootFormat,
  ) {}

  /** A workload write. The next checkpoint's fence sees it and publishes. A
   *  capture must carry every ancestor of a path, so the directories above a
   *  nested one are created first, as a shell's `mkdir -p` would. */
  async write(path: string, text: string): Promise<void> {
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      const directory = parts.slice(0, depth).join('/');
      if (this.#log.entryOf(directory) === null) await this.#log.perform({ op: 'mkdir', path: directory });
    }
    await this.#log.perform({ op: 'write', path, content: { kind: 'dense', bytes: enc.encode(text) } });
    this.#unpublished = true;
  }

  async answer(invocation: RunnerInvocation): Promise<string> {
    this.invocations.push(invocation);
    const encoded = runnerOption(invocation.argv, 'control-state');
    if (encoded === undefined) throw new Error('the runner was started without a control snapshot');
    const control = v.parse(CandidateRunControlV1Schema, JSON.parse(atob(encoded)));
    if (invocation.action === 'restore') {
      return JSON.stringify({ ok: true, rootId: control.head?.pointer.rootEnvelopeId ?? null });
    }
    if (invocation.action === 'seed') return JSON.stringify({ ok: true });
    if (invocation.action !== 'checkpoint') throw new Error(`the runner has no action ${invocation.action}`);
    if (!this.#unpublished) return JSON.stringify({ ok: true, noChange: true });
    const reply = await this.#publish(control, runnerOption(invocation.argv, 'box') ?? TEST_BOX_ID);
    this.#unpublished = false;
    return JSON.stringify(reply);
  }

  async #publish(
    control: CandidateRunControlV1,
    boxId: string,
  ): Promise<{ ok: true; movedBytes: number; heldBytes: number; draft: CandidatePublicationDraft }> {
    const operation = transferring(control);
    const sink = new MemoryCandidateObjectSink();
    const plan = await planCandidatePublication({
      format: this.format,
      expectedParentRootId: operation.expectedParent,
      capture: toCapturedCut(this.#log.entries, {
        mechanism: 'mutation-journal',
        cut: this.#log.lastSeq,
        generation: this.#log.generation,
        entries: this.#log.paths().flatMap((path) => {
          const entry = this.#log.entryOf(path);
          return entry === null ? [] : [entry];
        }),
      }, {
        captureId: operation.operationId,
        epoch: operation.epoch,
        baseRevision: operation.baseRevision,
        stableStageHandle: `stage-${operation.operationId}`,
      }),
      sink,
      dependencies: [await sink.stage(`objects/delta-${operation.attemptId}`, enc.encode(`delta ${operation.epoch}`))],
      root: await sink.stage(`roots/root-${operation.attemptId}`, enc.encode(`root ${operation.epoch}`)),
    });
    const draft = await stageCandidatePayload(plan, {
      operationId: operation.operationId,
      attemptId: operation.attemptId,
      boxId,
      epoch: operation.epoch,
      bootId: operation.bootId,
      kind: operation.kind,
      expiresAt: String(Date.now() + 60_000),
    }, this.#payloads());
    const moved = [draft.rootReceipt, draft.closureReceipt, ...draft.dependencyReceipts]
      .reduce((sum, receipt) => sum + Number(receipt.byteLength), 0);
    return { ok: true, movedBytes: moved, heldBytes: moved, draft };
  }

  /** The payload transport: bytes land in the bucket under the payload prefix,
   *  which is where the box's `verifyObject` asks for them. */
  #payloads(): CandidatePayloadStore {
    return {
      issuePayloadGrant: async (intent) => ({
        operationId: intent.operationId,
        attemptId: intent.attemptId,
        expiresAt: intent.expiresAt,
        opaque: intent.exactKey,
      }),
      uploadObject: async (grant, body) => {
        const bytes = new Uint8Array(await new Response(body).arrayBuffer());
        await this.bucket.handle.put(`${this.paths.payloadPrefix}/${grant.opaque}`, bytes);
        return {
          operationId: grant.operationId,
          attemptId: grant.attemptId,
          key: grant.opaque,
          byteLength: String(bytes.byteLength),
          sha256: sha256Hex(bytes),
          etag: `etag-${sha256Hex(bytes).slice(0, 16)}`,
          verified: true,
        };
      },
    };
  }
}

function transferring(control: CandidateRunControlV1): Extract<OperationRecord, { readonly phase: 'transferring' }> {
  const operation = control.operation;
  if (operation === null || operation.phase !== 'transferring') {
    throw new Error(`the runner was handed a ${operation?.phase ?? 'missing'} operation instead of a transfer`);
  }
  return operation;
}

/** One candidate box, its container, its durable rows, its bucket and its runner. */
export interface CandidateBoxHarness extends Harness<InstanceType<typeof Devbox<TestEnv>>> {
  readonly bucket: MemoryBucket;
  readonly runner: PublishingRunner;
  readonly paths: CandidateStorePaths;
}

/**
 * A candidate box on a fresh container, fresh durable rows, an empty bucket and
 * a runner that answers. The policy's port probe is shortened the way every
 * candidate test shortens it: the admission probe is a real wait, and nothing
 * here is about its length.
 */
export function candidateBox(format: CandidateContainerFormat): CandidateBoxHarness {
  const bucket = memoryBucket();
  class CandidateBox extends Devbox<TestEnv> {
    protected override get strategy(): DevboxStrategyName {
      return format;
    }

    protected override get candidateRunnerPath(): string {
      return CANDIDATE_RUNNER_PATH;
    }

    protected override get store(): DevboxStore {
      return { binding: 'BACKUP_BUCKET', bucket: bucket.handle };
    }

    protected override get ambientCheckpoints(): boolean {
      return false;
    }

    protected override get policy(): DevboxPolicy {
      return { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };
    }
  }
  const stand = harness(CandidateBox);
  const paths = candidateStorePaths(`boxes/${TEST_BOX_ID}`, format);
  const runner = new PublishingRunner(
    bucket,
    paths,
    format === 'merkle-pack' ? MERKLE_PACK_FORMAT : BOUNDED_LAYERS_FORMAT,
  );
  stand.container.runner = async (invocation) => await runner.answer(invocation);
  stand.container.fileWritten = async (path, content) => {
    const relative = path.startsWith(`${DEVBOX_WORKDIR}/`)
      ? path.slice(DEVBOX_WORKDIR.length + 1)
      : path;
    await runner.write(relative, content);
  };
  return { ...stand, bucket, runner, paths };
}
