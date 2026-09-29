import type { SqlExec, SqlExecutor } from "../types";

type StoreSql = SqlExecutor | SqlExec;

const revisions = new WeakMap<StoreSql, number>();

export function storeRevision(storage: StoreSql): number {
	return revisions.get(storage) ?? 0;
}

export function markStoreChanged(storage: StoreSql): void {
	revisions.set(storage, storeRevision(storage) + 1);
}
