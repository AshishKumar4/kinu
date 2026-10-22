/**
 * How a live share acts (docs/SLATE-SHARING-NIMBUS.md §2): the contract the share path, the Gallery and the share
 * sheet build against. A share's row is the workspace's `slate_shares` (its `live` kind); these are its new columns' values, the
 * viewer's consent rows in their own account, and the one call that keeps a Gallery listing in step with its share.
 */
import * as v from 'valibot';
import { GalleryCategorySchema } from './gallery-api';

/**
 * `own`, "their own access", the default: the shared server holds no one's grant, the owner's included, and each
 * viewer's personal parts run with that viewer's own. `owner`, "my access": the shared server acts with the owner's
 * share grant, inside the slate's reach, its effects approved by the owner.
 */
const SHARE_MODES = ['own', 'owner'] as const;

export type ShareMode = (typeof SHARE_MODES)[number];

export const ShareModeSchema = v.picklist(SHARE_MODES);

/**
 * What a slate's first share starts from (H7): `as-is`, the slate itself with its state; `empty`, a copy of it made
 * now in the same workspace, code only, so its state starts empty. One path either way: the copy is a fork, shared.
 */
export const ShareStartSchema = v.picklist(['as-is', 'empty']);

/**
 * A slate's revision (`share-policy.ts` `slateRevision`): the source digest its durable app was last built from. A
 * viewer's consent and the owner's `owner`-mode grant (`slate_shares.grant_revision`) each name the revision they
 * were given for; a different one asks again.
 */
export type SlateRevision = string;

const Name = v.pipe(v.string(), v.minLength(1));

/** A connection's root as its tools name it, canonical (`{ owner, repo }` for a repository; `{}` for none). */
const RootSchema = v.record(v.string(), v.string());

/**
 * One viewer's consent for one slate to use one of their connections in their own personal parts, kept in their own
 * account (`slate_consents`), never in the owner's workspace.
 */
export const SlateConsentSchema = v.object({
  workspace: Name,
  slate: Name,
  /** `mcp.<server>`, `ai` or `web`. */
  server: Name,
  root: RootSchema,
  tools: v.array(Name),
  /** Whether the part may ask to run an effect tool; each effect is still approved, its payload shown. */
  effects: v.boolean(),
  revision: Name,
});

export type SlateConsent = v.InferOutput<typeof SlateConsentSchema>;

/** What a listing's card shows, as its owner set it on the share sheet: what the Gallery's index finds and sorts by. */
const GalleryCardSchema = v.object({
  title: Name,
  line: v.string(),
  category: GalleryCategorySchema,
  ownerName: v.string(),
  /** The digest of the picture the workspace last took of the shared page, once there is one. */
  picture: v.nullable(v.string()),
  /** Its share's distinct signed-in viewers as the workspace counts them now (`slate_share_views`): the Gallery's copy. */
  viewers: v.number(),
});

export type GalleryCard = v.InferOutput<typeof GalleryCardSchema>;

const SharedAs = { share: Name, workspace: Name, slate: Name, handle: Name };

/**
 * The workspace's word to the Gallery about one share: sent on listing on/off, revoke, re-key, mode change and each
 * new published revision, and again for every live share when the Gallery refills. Listed only for a live share in
 * `own` mode that its owner listed (the Gallery lists nothing else: §2), with its card and its link, the app's page for
 * the share; unlisted, the share alone.
 */
export const GalleryListingSyncSchema = v.variant('listed', [
  v.object({
    /** Its `slate_shares.id`. */
    ...SharedAs,
    listed: v.literal(true),
    url: v.pipe(v.string(), v.minLength(1)),
    card: GalleryCardSchema,
  }),
  v.object({ ...SharedAs, listed: v.literal(false) }),
]);

export type GalleryListingSync = v.InferOutput<typeof GalleryListingSyncSchema>;
