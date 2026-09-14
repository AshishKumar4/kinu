/**
 * Who a live share answers: the accounts the owner named, or anyone with the
 * address.
 *
 * A leaf module for one reason: `rpc.ts` needs the picklist for its operation
 * schema, `sharing.ts` needs it for the record schema, and `sharing.ts` reads
 * `SLATE_BINDING_KINDS` off `project.ts` — which loads this module's importer
 * (`rpc.ts`) through `host-context.ts`. Anywhere else the constant sits
 * inside a cycle and evaluates before its own module.
 */
import * as v from 'valibot';

const LIVE_SHARE_VISIBILITIES = ['users', 'public'] as const;

export type LiveShareVisibility = (typeof LIVE_SHARE_VISIBILITIES)[number];

export const LiveShareVisibilitySchema = v.picklist(LIVE_SHARE_VISIBILITIES);
