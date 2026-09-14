/**
 * Worker-only slate storage, behind `@kinu.run/core/slates`.
 *
 * The storage modules here import the vendored agent-core runtime (SQLite
 * record seams, content-store base classes), which touches `node:util` at
 * module scope and cannot load in a browser; the runtime module texts ride
 * along as data — the `kinu:slate` server and client sources are the slate
 * API, authored in core and served by whichever backend hosts the worker.
 */
export { SqliteSlateStore } from './store';

export { SqliteSlateContentStore } from './content';

export { SqliteSlateInvocations, type SlateInvocationAuthority } from './invocations';

export { SlateFiles, slateDirectory } from './files';

export { WorkspaceSlates, type WorkspaceSlatesDeps } from './runtime';

export { initSlateStateTable, SLATE_STORAGE_BINDING, SqliteSlateStateStore, routeSlateStorageCall, type SlateStorageOp, type SlateStorageListOptions } from './state';

export { SLATE_SERVER_MODULE, SLATE_CLIENT_MODULE } from './runtime-modules';
