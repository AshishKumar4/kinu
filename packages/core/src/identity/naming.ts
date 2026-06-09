import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured.js';

/** URL-safe slug for stable agent ids. */
export function slugifyName(text: string): string {
  return text.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
}

export interface SuggestedAgentIdentity {
  name: string;
  displayName: string;
  nameOrigin: 'auto' | 'user';
}

/** Deterministic provisional display title: first non-empty line, collapsed. */
export function deriveAgentTitle(text: string): string {
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  return firstLine.replace(/\s+/g, ' ').slice(0, 60);
}

export function resolveAgentTitle(opts: {
  explicit?: string;
  existing?: string;
  purpose?: string;
  slug: string;
}): string {
  return (opts.explicit && opts.explicit.trim())
    || (opts.existing && opts.existing.trim())
    || deriveAgentTitle(opts.purpose ?? '')
    || opts.slug;
}

export function createAgentNameFromMission(mission: string, id: string): string {
  const slug = cleanAgentSlug(extractPersonaName(mission) ?? 'agent') || 'agent';
  return `${slug}-${id.slice(0, 6)}`;
}

export function fallbackAgentIdentity(mission: string, id: string): SuggestedAgentIdentity {
  const persona = extractPersonaName(mission);
  const title = cleanAgentTitle(persona ?? 'Agent') || 'Agent';
  return {
    name: `${cleanAgentSlug(persona ?? 'agent') || 'agent'}-${id.slice(0, 6)}`,
    displayName: title || 'Agent',
    nameOrigin: 'auto',
  };
}

export function agentIdentityPrompt(mission: string): string {
  return [
    'Name a Proteus agent from this opening mission.',
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

export function parseAgentIdentityOutput(raw: string, id: string): SuggestedAgentIdentity | null {
  const parsed = extractJsonObject(raw);
  if (!isRecord(parsed)) return null;
  const title = cleanAgentTitle(typeof parsed.title === 'string' ? parsed.title : '');
  const slug = cleanAgentSlug(typeof parsed.slug === 'string' ? parsed.slug : title);
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

function cleanAgentTitle(value: string): string {
  return value
    .replace(/^["'#\s]+|["'\s.]+$/g, '')
    .replace(/\b(agent|assistant|ai|bot|helper)\b$/i, '')
    .replace(/\s+/g, ' ')
    .slice(0, 60)
    .trim();
}

function cleanAgentSlug(value: string): string {
  return slugifyName(value.replace(/\b(agent|assistant|ai|bot|helper)\b/gi, '')) || slugifyName(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
