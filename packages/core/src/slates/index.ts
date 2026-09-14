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

export {
  buildSlateHostContext, isSlateFrameMessage, slateFrameSrc, slateInlineHeight, slateLinkId,
  SLATE_HOST_CONTEXT_MESSAGE, SLATE_INLINE_HEIGHT, SLATE_QUERY_PARAM, SLATE_SIZE_CHANGED_MESSAGE, SLATE_THEME_TOKENS,
  SlateFrameMessageSchema, type SlateHostContext,
} from './host-context';

export { SlateShareStore, initSlateShareTables, type NewSlateShare, type ShareUser } from './shares';

export { WorkspaceBlueprints, type WorkspaceBlueprintsDeps, type BlueprintReading } from './blueprints';

export type { DurableAppIdentity, DurableApps } from './durable-app';
