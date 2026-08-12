/**
 * Views — agent-authored dashboards, host-rendered.
 *
 * The agent writes JSON; the host owns every pixel. Data comes only from RPC
 * methods the signed-in owner can already call. See `spec.ts` for why the
 * vocabulary is closed and `sources.ts` for why the data list is.
 */

export {
  VIEW_SPEC_VERSION, VIEW_LIMITS, ViewSpecSchema, parseViewSpec, resolveViewPath,
  type ViewSpec, type ViewBlock, type ViewLeafBlock, type ViewSource, type ViewColumn,
  type ViewSpecResult,
} from './spec.js';

export {
  VIEW_DATA_SOURCES, RESERVED_VIEW_TITLES, normalizeViewTitle, type ViewDataSource,
} from './sources.js';

export {
  initViewTables, createView, deleteView, listViews, listViewVersions, readView, revertView,
  viewSlug,
  type AgentViewSummary, type AgentViewVersion, type CreateViewResult, type ReadViewResult,
  type ViewStatus, type ViewStoreDeps,
} from './store.js';
