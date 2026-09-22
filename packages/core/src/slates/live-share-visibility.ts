/** Leaf module: anywhere else this constant sits in an import cycle (rpc.ts, sharing.ts, project.ts, host-context.ts) and evaluates too early. */
import * as v from 'valibot';

const LIVE_SHARE_VISIBILITIES = ['users', 'public'] as const;

export type LiveShareVisibility = (typeof LIVE_SHARE_VISIBILITIES)[number];

export const LiveShareVisibilitySchema = v.picklist(LIVE_SHARE_VISIBILITIES);
