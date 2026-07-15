import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured.js';

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

export function createWorkspaceNameFromMission(mission: string, id: string): string {
  return fallbackWorkspaceIdentity(mission, id).name;
}

/** Deterministic identity when LLM titling is unavailable: a stated persona
 *  name wins, then a title derived from the mission text itself; the random
 *  adjective-noun pair is the last resort for an empty/unusable mission. */
export function fallbackWorkspaceIdentity(mission: string, id: string): SuggestedWorkspaceIdentity {
  const persona = extractPersonaName(mission);
  if (persona) {
    return {
      name: `${cleanSlug(persona)}-${id.slice(0, 6)}`,
      displayName: cleanTitle(persona),
      nameOrigin: 'auto',
    };
  }
  const title = cleanTitle(deriveWorkspaceTitle(mission));
  const slug = cleanSlug(title);
  if (title && slug) {
    return { name: `${slug}-${id.slice(0, 6)}`, displayName: title, nameOrigin: 'auto' };
  }
  return { ...memorableFallbackIdentity(id), nameOrigin: 'auto' };
}

/** System prompt paired with workspaceIdentityPrompt — shared by the CLI's
 *  local naming call and the server's cloud display-name generation. */
export const WORKSPACE_IDENTITY_SYSTEM_PROMPT = 'You create short, useful names for persistent agent workspaces.';

export function workspaceIdentityPrompt(mission: string): string {
  return [
    'Name a Proteus workspace from this opening mission.',
    '',
    'Return a concise JSON object with:',
    '- title: 1-5 words, Title Case, specific to the mission or persona.',
    '- slug: 1-5 lowercase words joined with hyphens.',
    '- Prefer a stated persona name such as "Jarvis" over copying the whole sentence.',
    '- Do not include generic suffixes like agent, assistant, ai, bot, or helper unless they are part of a proper name.',
    '',
    jsonObjectOnlyInstruction(),
    '',
    `Mission:\n${mission.slice(0, 1200)}`,
  ].join('\n');
}

export function parseWorkspaceIdentityOutput(raw: string, id: string): SuggestedWorkspaceIdentity | null {
  let parsed: unknown;
  try {
    parsed = extractJsonObject(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const title = cleanTitle(typeof parsed.title === 'string' ? parsed.title : '');
  const slug = cleanSlug(typeof parsed.slug === 'string' ? parsed.slug : title);
  if (!title || !slug) return null;
  return {
    name: `${slug}-${id.slice(0, 6)}`,
    displayName: title,
    nameOrigin: 'auto',
  };
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

function cleanSlug(value: string): string {
  return slugifyName(value.replace(/\b(agent|assistant|ai|bot|helper)\b/gi, '')) || slugifyName(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
