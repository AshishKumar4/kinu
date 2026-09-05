/**
 * Gadgets — agent-written apps: a server the host runs in a dynamic-worker
 * facet with no network and only the bindings its manifest declares, and a
 * client the host runs in a sandboxed iframe with no network and one
 * MessagePort to its server. See docs/LIVE-UI.md.
 */

export {
  GADGET_DIR, GADGET_MANIFEST_FILE, GADGET_SERVER_FILE, GADGET_CLIENT_FILE, GADGET_CLIENT_STYLE_FILE,
  GADGET_SERVER_CLASS, GADGET_LIMITS, GadgetManifestSchema, GadgetBindingSchema,
  RESERVED_GADGET_TITLES, normalizeGadgetTitle,
  parseGadgetManifest, gadgetBindings, gadgetFilesRoot, isGadgetSlug, isGadgetBindingName,
  type GadgetManifest, type GadgetManifestResult, type GadgetBinding, type GadgetBindingKind,
  type GadgetFilesBinding, type GadgetMcpBinding,
} from './manifest';

export { GADGET_DATA_SOURCES, isGadgetDataSource, type GadgetDataSource } from './sources';

export {
  gadgetPath, listGadgets, readGadget, readGadgetClient, readGadgetServer,
  type GadgetRecord, type GadgetProblem, type GadgetListing, type GadgetReadResult,
} from './files';

export {
  GADGET_HOST_METHODS, GADGETS_CHANGED_EVENT, isGadgetMethodName, gadgetSummary,
  type GadgetCallResult, type GadgetsChangedEvent, type GadgetSummary,
} from './rpc';

export {
  GADGET_MCP_ACTION_RULE, gadgetExecutor, resolveGadgetFilePath, resolveGadgetDataSource, reviewGadgetMcpCall,
  type GadgetMcpTool, type GadgetMcpReview,
} from './bindings';
