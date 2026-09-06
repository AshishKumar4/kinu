/**
 * How a memory-backed record store holds records: codec bytes keyed by the record's own
 * identity, never live objects. Two Actor-local stores hold contributions this way — Slots
 * and Surfaces — and both owe the same immutability, ordering and revision arithmetic, so
 * the primitives live once rather than once per store.
 */
export type RecordMap = Map<string, Uint8Array>;
export declare function cloneRecordMap(records: RecordMap): RecordMap;
/**
 * Writes a record, refusing a rewrite of one already held. Attribution is immutable for a
 * record's lifetime (SPEC §4.2), so superseding a record is a retirement followed by a
 * fresh materialization and never a write over the bytes it replaces.
 */
export declare function insertImmutable(records: RecordMap, key: string, bytes: Uint8Array, subject: string): void;
/** The records in the one order every store lists them in, so two reads agree. */
export declare function orderedRecords(records: RecordMap): readonly (readonly [string, Uint8Array])[];
export declare function sameRecordMaps(left: RecordMap, right: RecordMap): boolean;
export declare function equalBytes(left: Uint8Array, right: Uint8Array): boolean;
/**
 * An Actor-local transaction is synchronous, so a callback that returned a promise escaped
 * the transaction rather than ran inside it. The caller names the store, because the code
 * is a protocol violation of that store and not of the guard. Only the async refusal is
 * relabelled: any other failure is a defect in the guard itself and is rethrown as it came,
 * because reporting it as a store protocol violation would name the wrong cause.
 */
export declare function requireSynchronousRecordResult<Result>(result: Result, subject: string): Result;
