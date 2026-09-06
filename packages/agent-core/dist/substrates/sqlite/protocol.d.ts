import { ProtocolPersistenceAdapter, ProtocolRecordStorage } from "../../protocol/index.js";
import { TransactionalSqlite } from "./sqlite.js";
export declare class SqliteProtocolPersistence extends ProtocolPersistenceAdapter<TransactionalSqlite> {
    constructor(database: TransactionalSqlite);
    protected storage(transaction: TransactionalSqlite): ProtocolRecordStorage;
}
