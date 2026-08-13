import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured.js';
import { isPlaceholderMission } from './soul.js';

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

/**
 * The workspace's permanent address — its URL segment and, on the cloud
 * backend, the Durable Object name. Nothing can ever change it.
 *
 * So it is derived from the id and NOTHING else. A slug cut from the creating
 * prompt is a name chosen before anyone knows the good one: the title the
 * workspace settles on arrives a model call later, leaving `my-personal-jarvis-830c2d`
 * addressing a workspace called "Jarvis" forever — and pinning whatever the
 * operator happened to type into a URL they may go on to share.
 */
export function workspaceSlug(id: string): string {
  return memorableFallbackIdentity(id).name;
}

/** Deterministic title for a mission: a stated persona name wins, then the
 *  mission's own opening line. Empty when the mission yields neither. */
export function workspaceTitleFromMission(mission: string): string {
  const persona = extractPersonaName(mission);
  return (persona && cleanTitle(persona)) || cleanTitle(deriveWorkspaceTitle(mission));
}

/** Deterministic identity for a new workspace: a neutral permanent slug, and
 *  the best title the mission alone yields — which the generated title then
 *  upgrades. The adjective-noun display name is the last resort for an
 *  empty/unusable mission. */
export function fallbackWorkspaceIdentity(mission: string, id: string): SuggestedWorkspaceIdentity {
  const memorable = memorableFallbackIdentity(id);
  return {
    name: memorable.name,
    displayName: workspaceTitleFromMission(mission) || memorable.displayName,
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
 *  Generation failures are swallowed: the deterministic title stands. */
export async function applyWorkspaceTitle(
  state: WorkspaceTitleState,
  effects: {
    persist: (title: string) => void | Promise<void>;
    suggest?: (mission: string) => Promise<string | null>;
  },
): Promise<string | null> {
  const plan = planWorkspaceTitle(state);
  if (!plan) return null;
  let title: string | null = null;
  if (plan.provisional) {
    await effects.persist(plan.provisional);
    title = plan.provisional;
  }
  try {
    const suggested = (await effects.suggest?.(plan.mission))?.trim();
    if (suggested && suggested !== title) {
      await effects.persist(suggested);
      title = suggested;
    }
  } catch { /* the deterministic title stands */ }
  return title;
}

/** System prompt paired with workspaceTitlePrompt — shared by the CLI's
 *  local naming call and the server's cloud display-name generation. */
export const WORKSPACE_TITLE_SYSTEM_PROMPT = 'You create short, useful names for persistent agent workspaces.';

export function workspaceTitlePrompt(mission: string): string {
  return [
    'Title a Proteus workspace from the mission it was created for.',
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
  let parsed: unknown;
  try {
    parsed = extractJsonObject(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  return cleanTitle(typeof parsed.title === 'string' ? parsed.title : '') || null;
}

function extractPersonaName(mission: string): string | null {
  const match = mission.match(/\b(?:you are|call you|named)\s+([A-Za-z][A-Za-z0-9_-]{1,30})\b/i);
  return match?.[1] ?? null;
}

function memorableFallbackIdentity(id: string): { name: string; displayName: string } {
  const hex = id.replace(/-/g, '').toLowerCase();
  const adjective = FALLBACK_ADJECTIVES[Number.parseInt(hex.slice(0, 2), 16) % FALLBACK_ADJECTIVES.length];
  const noun = FALLBACK_NOUNS[Number.parseInt(hex.slice(2, 4), 16) % FALLBACK_NOUNS.length];
  const suffix = hex.slice(0, 4);
  return {
    name: `${adjective}-${noun}-${suffix}`,
    displayName: `${capitalize(adjective)} ${capitalize(noun)}`,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
