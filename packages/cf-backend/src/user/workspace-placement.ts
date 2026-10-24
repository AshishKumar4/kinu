// Where a new workspace's object runs: a region every model provider serves, near whoever made it. An object runs where
// it was first reached and never moves, and one first reached from Asia with no hint, or with `apac`, can run in Hong
// Kong, where Anthropic and OpenAI refuse every call (PLATFORM_CATALOG `do.placement.location_hint`).
import * as v from 'valibot';

/** The location hints whose data centers are all in countries the providers serve; never `apac`. */
export const WorkspacePlacementSchema = v.picklist(['wnam', 'enam', 'weur', 'oc']);

export type WorkspacePlacement = v.InferOutput<typeof WorkspacePlacementSchema>;

/** Where a workspace runs whose maker's whereabouts are unknown: an agent's in an older workspace, a request without `cf`. */
export const UNPLACED: WorkspacePlacement = 'weur';

/** West of this longitude, North America's west is nearer than its east. */
const NA_EAST_WEST = -100;

/** What placement reads of Cloudflare's reading of where a request came from (`request.cf`). */
const CreatorSchema = v.looseObject({ continent: v.optional(v.string()), longitude: v.optional(v.string()) });

export type Creator = v.InferOutput<typeof CreatorSchema>;

/** The hint for a workspace made by the request carrying `cf`. */
export function placementFor(cf: Request['cf'] | Creator): WorkspacePlacement {
  const creator = v.safeParse(CreatorSchema, cf);
  const { continent, longitude } = creator.success ? creator.output : {};

  if (continent === 'NA') return Number(longitude) < NA_EAST_WEST ? 'wnam' : 'enam';

  if (continent === 'SA') return 'enam';

  return continent === 'OC' ? 'oc' : UNPLACED;
}
