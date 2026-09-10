/**
 * Worker-only slate storage, behind `@kinu.run/core/slates`.
 *
 * Every module here imports the vendored agent-core runtime (SQLite record
 * seams, content-store base classes), which touches `node:util` at module
 * scope and cannot load in a browser. The root barrel stays free of them so
 * client code can value-import it; worker code imports this subpath instead.
 */
export { SqliteSlateStore } from './store';

export { SqliteSlateContentStore } from './content';

export { SqliteSlateInvocations, type SlateInvocationAuthority } from './invocations';

export { SlateFiles, slateDirectory } from './files';

export { WorkspaceSlates, type WorkspaceSlatesDeps } from './runtime';
