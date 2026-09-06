import type { SynchronousResultGuard } from "../../actors/index.js";
export type SqliteValue = string | number | Uint8Array | null;
export interface SqliteRow {
    readonly [column: string]: SqliteValue;
}
type SqliteRead = (statement: string, bindings: readonly SqliteValue[]) => readonly SqliteRow[];
type SqliteWrite = (statement: string, bindings: readonly SqliteValue[]) => void;
interface SqliteView {
    beforeRead?(statement: string, bindings: readonly SqliteValue[]): void;
    projectRows?(statement: string, rows: readonly SqliteRow[]): readonly SqliteRow[];
    beforeRun?(statement: string, bindings: readonly SqliteValue[]): void;
    capability?: SqliteMutationCapability;
}
declare const sqliteMutationCapabilityBrand: unique symbol;
interface SqliteMutationCapability {
    readonly [sqliteMutationCapabilityBrand]: true;
}
interface SqliteReadExecutor {
    readonly read: SqliteRead;
    readonly identity?: object;
}
interface DerivedSqliteRead {
    readonly source: ReadableSqlite;
    readonly view?: SqliteView;
}
type ReadableSqliteConstruction = SqliteReadExecutor | DerivedSqliteRead;
interface SqliteExecutors extends SqliteReadExecutor {
    readonly write: SqliteWrite;
}
interface DerivedTransactionalSqlite {
    readonly source: TransactionalSqlite;
    readonly view?: SqliteView;
}
type TransactionalSqliteConstruction = SqliteExecutors | DerivedTransactionalSqlite;
export declare function isSqliteText(value: SqliteValue | undefined): value is string;
export declare function isSqliteNumber(value: SqliteValue | undefined): value is number;
export declare abstract class ReadableSqlite {
    #private;
    readonly all: SqliteRead;
    protected constructor(construction: ReadableSqliteConstruction);
}
export declare abstract class TransactionalSqlite extends ReadableSqlite {
    #private;
    readonly run: SqliteWrite;
    protected constructor(construction: TransactionalSqliteConstruction);
    abstract transaction<Result>(operation: () => Result, ...guard: SynchronousResultGuard<Result>): Result;
}
export declare function hasSameSqliteProvenance(left: ReadableSqlite, right: ReadableSqlite): boolean;
export declare function ownSqliteMutations(database: TransactionalSqlite): TransactionalSqlite;
export declare function withExclusiveSqliteMutation<Result>(database: TransactionalSqlite, operation: (database: TransactionalSqlite) => Result, ...guard: SynchronousResultGuard<Result>): Result;
export {};
