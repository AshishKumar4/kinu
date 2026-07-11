import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured.js';

/** URL-safe slug for stable workspace ids. */
export function slugifyName(text: string): string {
  return text.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
}

export interface SuggestedWorkspaceIdentity {
  name: string;
  displayName: string;
  nameOrigin: 'auto' | 'user';
}

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
  const slug = cleanSlug(extractPersonaName(mission) ?? 'workspace') || 'workspace';
  return `${slug}-${id.slice(0, 6)}`;
}

export function fallbackWorkspaceIdentity(mission: string, id: string): SuggestedWorkspaceIdentity {
  const persona = extractPersonaName(mission);
  const title = cleanTitle(persona ?? 'Workspace') || 'Workspace';
  return {
    name: `${cleanSlug(persona ?? 'workspace') || 'workspace'}-${id.slice(0, 6)}`,
    displayName: title || 'Workspace',
    nameOrigin: 'auto',
  };
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
