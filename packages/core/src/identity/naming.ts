import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured';
import * as v from 'valibot';
import { isPlaceholderMission } from './soul';
import { tolerate } from '../obs/index';

const WorkspaceTitleSchema = v.object({ title: v.string() });

/** URL-safe slug for stable workspace ids. */
export function slugifyName(text: string): string {
  return text.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
}

export interface SuggestedWorkspaceIdentity {
  name: string;
  displayName: string;
  nameOrigin: 'auto' | 'user';
}

const FALLBACK_ADJECTIVES = [
  'amber',
  'ashen',
  'balanced',
  'burnished',
  'calm',
  'cedar',
  'clear',
  'brisk',
  'copper',
  'crafted',
  'earthen',
  'evergreen',
  'fieldstone',
  'grounded',
  'handwrought',
  'hardy',
  'hearthlit',
  'honest',
  'ironwood',
  'luminous',
  'maple',
  'measured',
  'mellow',
  'mossy',
  'oak',
  'patient',
  'pine',
  'quiet',
  'river',
  'rugged',
  'sage',
  'seasoned',
  'steady',
  'stone',
  'sunlit',
  'timber',
  'verdant',
  'walnut',
  'warm',
  'weathered',
] as const;

const FALLBACK_NOUNS = [
  'anvil',
  'arbor',
  'ash',
  'basin',
  'bench',
  'birch',
  'brook',
  'cairn',
  'cedar',
  'chisel',
  'copper',
  'cove',
  'elm',
  'field',
  'forge',
  'grove',
  'harbor',
  'hawk',
  'hearth',
  'hemlock',
  'hill',
  'heron',
  'kiln',
  'lantern',
  'maple',
  'mill',
  'oak',
  'pine',
  'plane',
  'quarry',
  'ridge',
  'river',
  'stone',
  'timber',
  'trail',
  'valley',
  'walnut',
  'willow',
  'workshop',
  'yard',
] as const;

/** Deterministic provisional display title: first non-empty line, collapsed. */
export function deriveWorkspaceTitle(text: string): string {
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  return firstLine.replace(/\s+/g, ' ').slice(0, 60);
}

export function resolveWorkspaceTitle(opts: {
  explicit?: string;
  existing?: string;
  purpose?: string;
  slug: string;
}): string {
  return (opts.explicit && opts.explicit.trim())
    || (opts.existing && opts.existing.trim())
    || deriveWorkspaceTitle(opts.purpose ?? '')
    || opts.slug;
}

/** How much of the mission the permanent address carries, before its id
 *  suffix. Whole words only: an address people share must not end mid-word. */
const SLUG_STEM_MAX_CHARS = 24;

/**
 * The workspace's permanent address — its URL segment and, on the cloud
 * backend, the Durable Object name. Nothing can ever change it.
 *
 * It is the mission's own words plus an id suffix. The words are the same
 * deterministic title {@link workspaceTitleFromMission} yields, available
 * synchronously at creation, so the address says what the workspace is FOR
 * from its first millisecond; the suffix is what keeps it unique and keeps it
 * valid after the title is regenerated or the owner renames the workspace.
 * The adjective-noun pair is what a mission with no usable words gets, and
 * nothing else — reaching it means there was nothing to name the workspace
 * after.
 *
 * The suffix reads id digits the adjective and noun do not. Sharing them made
 * the ENTIRE slug a function of the first four hex digits: 65,536 possible
 * addresses platform-wide, on a globally-named Durable Object namespace, where
 * a collision makes the second owner's create fail in `claimOwner` with
 * "owned by a different user".
 */
export function workspaceSlug(mission: string, id: string): string {
  const hex = id.replace(/-/g, '').toLowerCase();
  const { adjective, noun } = memorableWords(hex);
  return `${missionSlugStem(mission) || `${adjective}-${noun}`}-${hex.slice(4, 12)}`;
}

/** Deterministic title for a mission: a stated persona name wins, then the
 *  mission's own opening line. Empty when the mission yields neither. */
export function workspaceTitleFromMission(mission: string): string {
  const persona = extractPersonaName(mission);
  return (persona && cleanTitle(persona)) || cleanTitle(deriveWorkspaceTitle(mission));
}

/** Deterministic identity for a new workspace: a mission-derived permanent
 *  slug, and the best title the mission alone yields — which the generated
 *  title then upgrades. The adjective-noun pair is the last resort for both,
 *  and only an empty or unwordable mission reaches it. */
export function fallbackWorkspaceIdentity(mission: string, id: string): SuggestedWorkspaceIdentity {
  const { adjective, noun } = memorableWords(id.replace(/-/g, '').toLowerCase());
  return {
    name: workspaceSlug(mission, id),
    displayName: workspaceTitleFromMission(mission) || `${capitalize(adjective)} ${capitalize(noun)}`,
    nameOrigin: 'auto',
  };
}

/** A workspace's stored naming state, as both backends keep it: the raw slug
 *  the workspace is addressed by, the shown title, how that title came about,
 *  and the mission to title from (the opening request, or SOUL.md's mission). */
export interface WorkspaceTitleState {
  slug: string;
  displayName: string | null;
  nameOrigin: 'user' | 'auto' | null;
  mission: string;
}

export interface WorkspaceTitlePlan {
  /** Deterministic title to persist immediately, or null when the shown title
   *  is already presentable and only the LLM step can improve it. */
  provisional: string | null;
  mission: string;
}

/** A title nobody chose: absent, or an echo of the raw slug — which is what
 *  workspaces created before mission-derived titling still carry. */
export function isPlaceholderWorkspaceTitle(displayName: string | null | undefined, slug: string): boolean {
  const shown = displayName?.trim() ?? '';
  return shown.length === 0 || shown === slug.trim();
}

/** Decide whether a workspace should be auto-titled, and from what.
 *
 *  `null` means leave it alone: the operator named it (`nameOrigin: 'user'`),
 *  there is no mission to title from, or it already carries a title it was
 *  deliberately given. Otherwise the workspace either never had a title
 *  generated (`nameOrigin: null`) or is still showing its raw slug — the
 *  legacy shape this heals. */
export function planWorkspaceTitle(state: WorkspaceTitleState): WorkspaceTitlePlan | null {
  if (state.nameOrigin === 'user') return null;
  if (isPlaceholderMission(state.mission)) return null;
  const placeholder = isPlaceholderWorkspaceTitle(state.displayName, state.slug);
  if (!placeholder && state.nameOrigin !== null) return null;
  const mission = state.mission.trim();
  return { provisional: (placeholder && workspaceTitleFromMission(mission)) || null, mission };
}

/** Auto-title a workspace: persist the deterministic title at once so the
 *  placeholder never survives a failed model call, then upgrade to the
 *  generated one. `persist` writes the title AND marks its origin 'auto',
 *  which is what makes this one-shot — the plan can no longer match.
 *
 *  A failed generation is not swallowed here. The deterministic title has
 *  already landed by then, so it stands whatever happens next, and the caller
 *  is the one that knows whether a titling failure is worth reporting — a
 *  catch here reported "titled" for a dead review model, an unroutable
 *  provider and a failing `persist` alike. */
export async function applyWorkspaceTitle(
  state: WorkspaceTitleState,
  effects: {
    persist: (title: string) => boolean | void | Promise<boolean | void>;
    suggest?: (mission: string) => Promise<string | null>;
  },
): Promise<string | null> {
  const plan = planWorkspaceTitle(state);
  if (!plan) return null;
  let title: string | null = null;
  if (plan.provisional) {
    const persisted = await effects.persist(plan.provisional);
    if (persisted === false) return null;
    title = plan.provisional;
  }
  const suggested = (await effects.suggest?.(plan.mission))?.trim();
  if (suggested && suggested !== title) {
    const persisted = await effects.persist(suggested);
    if (persisted === false) return null;
    title = suggested;
  }
  return title;
}

/** System prompt paired with workspaceTitlePrompt — shared by the CLI's
 *  local naming call and the server's cloud display-name generation. */
export const WORKSPACE_TITLE_SYSTEM_PROMPT = 'You create short, useful names for persistent agent workspaces.';

export function workspaceTitlePrompt(mission: string): string {
  return [
    'Title a Kinu workspace from the mission it was created for.',
    '',
    'Return a concise JSON object with:',
    '- title: 1-5 words, Title Case, specific to the mission or persona.',
    '- Prefer a stated persona name such as "Jarvis" over copying the whole sentence.',
    '- Do not include generic suffixes like agent, assistant, ai, bot, or helper unless they are part of a proper name.',
    '',
    jsonObjectOnlyInstruction(),
    '',
    `Mission:\n${mission.slice(0, 1200)}`,
  ].join('\n');
}

/** The title out of a {@link workspaceTitlePrompt} response, or null when the
 *  model returned nothing usable. Only a title: the slug is not the model's to
 *  choose (see {@link workspaceSlug}). */
export function parseWorkspaceTitle(raw: string): string | null {
  // The one failure a title parse tolerates: the model did not return JSON.
  const parsed = tolerate(() => extractJsonObject(raw), 'malformed-input');
  if (parsed === undefined) return null;
  const title = v.safeParse(WorkspaceTitleSchema, parsed);
  if (!title.success) return null;
  return cleanTitle(title.output.title) || null;
}

function extractPersonaName(mission: string): string | null {
  const match = mission.match(/\b(?:you are|call you|named)\s+([A-Za-z][A-Za-z0-9_-]{1,30})\b/i);
  return match?.[1] ?? null;
}

/** The mission's words for the permanent address, cut to whole words within
 *  {@link SLUG_STEM_MAX_CHARS}. Not {@link slugifyName}: its hard character cap
 *  can end a slug mid-word, which is fine for a transient id and wrong for an
 *  address the owner shares. The first word is the one exception — a mission
 *  that is a single 400-character token has no whole-word answer, and the
 *  address still has to fit a workspace name. Empty when the mission has no
 *  [a-z0-9] words at all. */
function missionSlugStem(mission: string): string {
  let stem = '';
  for (const word of workspaceTitleFromMission(mission).toLowerCase().split(/[^a-z0-9]+/)) {
    if (!word) continue;
    if (!stem) {
      stem = word.slice(0, SLUG_STEM_MAX_CHARS);
      continue;
    }
    if (stem.length + 1 + word.length > SLUG_STEM_MAX_CHARS) break;
    stem += `-${word}`;
  }
  return stem;
}

/** The memorable pair a workspace with nothing to be named after gets. */
function memorableWords(hex: string) {
  return {
    adjective: FALLBACK_ADJECTIVES[Number.parseInt(hex.slice(0, 2), 16) % FALLBACK_ADJECTIVES.length],
    noun: FALLBACK_NOUNS[Number.parseInt(hex.slice(2, 4), 16) % FALLBACK_NOUNS.length],
  };
}

function capitalize(word: string): string {
  return word[0].toUpperCase() + word.slice(1);
}

function cleanTitle(value: string): string {
  return value
    .replace(/^["'#\s]+|["'\s.]+$/g, '')
    .replace(/\b(agent|assistant|ai|bot|helper)\b$/i, '')
    .replace(/\s+/g, ' ')
    .slice(0, 60)
    .trim();
}
