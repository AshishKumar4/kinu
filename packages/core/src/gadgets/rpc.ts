/**
 * The call contract between a gadget's client and its server, as the host
 * carries it: the iframe names a method and JSON arguments over its
 * MessagePort, the browser forwards them over the workspace RPC as
 * `gadgetCall(slug, method, args)`, and the owning object invokes that method
 * on the facet. One name rule and one result shape, shared by every hop.
 */

import * as v from 'valibot';
import type { JsonValue } from '../utils/json';
import type { Refusal } from '../obs/index';
import type { GadgetRecord } from './files';
import { gadgetBindings } from './manifest';

/**
 * Method names the runtime reserves on a Durable Object class. Calling one
 * through the bridge would reach the platform's handler, not the gadget's
 * API: `fetch` is the HTTP entry, `alarm` the timer, the `webSocket*` trio
 * the hibernation hooks, and `constructor` is not a method at all.
 */
const GadgetHostMethodSchema = v.picklist([
  'constructor', 'fetch', 'alarm', 'connect', 'webSocketMessage', 'webSocketClose', 'webSocketError',
]);

const METHOD_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/** An identifier the bridge will forward. Names starting with `_` are the
 *  gadget's own private convention and stay unreachable, the same line
 *  Cap'n Web draws for `#`-prefixed members. */
export function isGadgetMethodName(name: string): boolean {
  return METHOD_RE.test(name) && !v.is(GadgetHostMethodSchema, name);
}

/** What a forwarded call answers: the method's JSON value, or a refusal with
 *  its class first so every hop and the model branch on `reason`. */
export type GadgetCallResult =
  | { readonly ok: true; readonly value: JsonValue }
  | ({ readonly ok: false } & Refusal);

/** The message the owning object broadcasts when files under `gadgets/`
 *  change. The UI re-lists on it and remounts any open tab among `slugs`. */
export const GADGETS_CHANGED_EVENT = 'gadgets_changed';

export interface GadgetsChangedEvent {
  readonly type: typeof GADGETS_CHANGED_EVENT;
  readonly slugs: readonly string[];
}

/** What the tab strip draws: the declaration's title and which halves exist,
 *  never the code. */
export interface GadgetSummary {
  readonly slug: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly hasServer: boolean;
  readonly hasClient: boolean;
  /** The binding names the manifest declares, so a reader sees a gadget's
   *  reach beside its name. */
  readonly bindings: readonly string[];
}

export function gadgetSummary(record: GadgetRecord): GadgetSummary {
  return {
    slug: record.slug,
    title: record.manifest.title,
    subtitle: record.manifest.subtitle ?? null,
    hasServer: record.hasServer,
    hasClient: record.hasClient,
    bindings: gadgetBindings(record.manifest).map(([name]) => name),
  };
}
