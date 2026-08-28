/**
 * In-memory implementations of the two durable seams the candidate control
 * plane owns. Behavior tests drive the production state machine through these
 * and inject resets at the exact durable write or object await they choose.
 */

import * as v from 'valibot';

import { PublicationInterrupted, envelopeBytes, parseEnvelopeBytes } from '../../src/candidates/publication';
import type { CandidateControlStore, CandidateControlUpdate, CandidateEnvelopeStore } from '../../src/candidates/control';
import { CandidateControlStateV1Schema } from '../../src/durability/contracts';
import type { CandidateControlStateV1, OperationRecord, RootEnvelopeV1 } from '../../src/durability/contracts';

type OperationPhase = OperationRecord['phase'];

/** A durable write or object await that a container reset interrupted. */
export class ControlReset extends PublicationInterrupted {
  constructor(readonly at: string) {
    super(`reset at ${at}`);
    this.name = 'ControlReset';
  }
}

export class MemoryControlStore implements CandidateControlStore {
  record: CandidateControlStateV1 = { version: 1, head: null, operation: null };
  /** Every phase persisted, in order, including repeats. */
  readonly writes: OperationPhase[] = [];
  /** Reset immediately after the durable write that reaches this phase. */
  resetAfterPhase: OperationPhase | null = null;

  async read(): Promise<CandidateControlStateV1> {
    return v.parse(CandidateControlStateV1Schema, this.record);
  }

  async update<T>(apply: (current: CandidateControlStateV1) => CandidateControlUpdate<T>): Promise<T> {
    const update = apply(await this.read());
    if (update.next === null) return update.result;
    this.record = v.parse(CandidateControlStateV1Schema, update.next);
    const phase = this.record.operation?.phase;
    if (phase === undefined) return update.result;
    this.writes.push(phase);
    if (this.resetAfterPhase === phase) {
      this.resetAfterPhase = null;
      throw new ControlReset(phase);
    }
    return update.result;
  }

  async clear(): Promise<void> {
    this.record = { version: 1, head: null, operation: null };
  }
}

export class MemoryEnvelopeStore implements CandidateEnvelopeStore {
  /** Canonical envelope bytes, keyed by the digest that addresses them. */
  readonly objects = new Map<string, Uint8Array>();
  resetOnWrite = false;
  resetOnRead = false;

  async write(envelope: RootEnvelopeV1, rootEnvelopeId: string): Promise<void> {
    if (this.resetOnWrite) {
      this.resetOnWrite = false;
      throw new ControlReset('envelope-write');
    }
    const existing = this.objects.get(rootEnvelopeId);
    if (existing !== undefined) {
      parseEnvelopeBytes(existing, rootEnvelopeId);
      return;
    }
    this.objects.set(rootEnvelopeId, envelopeBytes(envelope));
  }

  async read(rootEnvelopeId: string): Promise<RootEnvelopeV1> {
    if (this.resetOnRead) {
      this.resetOnRead = false;
      throw new ControlReset('envelope-read');
    }
    const bytes = this.objects.get(rootEnvelopeId);
    if (bytes === undefined) throw new Error(`candidate envelope is absent: ${rootEnvelopeId}`);
    return parseEnvelopeBytes(bytes, rootEnvelopeId);
  }
}
