import { extractJsonObject, jsonObjectOnlyInstruction } from '../providers/structured';
import * as v from 'valibot';
import { isPlaceholderMission } from './soul';
import { tolerate } from '../obs/index';
import type { AgentConfigStore } from '../config/store';
import type { ActorHandle } from './actor-handle';
import { nanoid } from '../utils/nanoid';

const WorkspaceTitleSchema = v.object({ title: v.string() });

/** URL-safe slug capped at 24 chars. Private: callers mint names via {@link mintSubordinateName}. */
function slugifyName(text: string): string {
  return text.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
}

/** Slugified role plus a random suffix so children of one role never collide; stays within `spawnSubordinate`'s 64-char lowercase contract. */
export function mintSubordinateName(role: string): string {
  return `${slugifyName(role) || 'subordinate'}-${nanoid(6)}`;
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
  // A blank title at any level falls through to the next source.
  const explicit = opts.explicit?.trim();

  if (explicit !== undefined && explicit !== '') return explicit;
  const existing = opts.existing?.trim();

  if (existing !== undefined && existing !== '') return existing;
  const derived = deriveWorkspaceTitle(opts.purpose ?? '');

  if (derived !== '') return derived;

  return opts.slug;
}

/** DNS label (63) minus the 32 the preview label spends on port, handle and token (`preview/nimbus-preview-host.ts`). Refused, not truncated: a truncated address names a different workspace. */
const WORKSPACE_ADDRESS_MAX = 31;

const WorkspaceAddressSchema = v.pipe(v.string(), v.maxLength(WORKSPACE_ADDRESS_MAX), v.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/));

/** Why a name cannot be a workspace address (and preview hostname label), or null. Lowercase only: DNS folds case. */
export function workspaceAddressRefusal(name: string): string | null {
  if (v.safeParse(WorkspaceAddressSchema, name).success) return null;

  return `the workspace name "${name}" cannot be a preview hostname label`
    + ` (a label holds lowercase letters, digits and hyphens, at most ${WORKSPACE_ADDRESS_MAX} characters, and carries no case)`;
}

/**
 * Permanent address: memorable pair plus id suffix; mission text never goes in URLs, DO names or logs.
 * The suffix uses id digits the words do not, or only 65,536 addresses exist.
 */
export function workspaceSlug(id: string): string {
  const hex = id.replace(/-/g, '').toLowerCase();
  const { adjective, noun } = memorableWords(hex);

  return `${adjective}-${noun}-${hex.slice(4, 12)}`;
}

/** A stated persona name wins, then the mission's opening line; empty when neither. */
function workspaceTitleFromMission(mission: string): string {
  const persona = extractPersonaName(mission);
  const named = persona === null ? '' : cleanTitle(persona);

  if (named !== '') return named;

  return cleanTitle(deriveWorkspaceTitle(mission));
}

/** Neutral permanent slug plus the best title the mission yields. */
export function fallbackWorkspaceIdentity(mission: string, id: string): SuggestedWorkspaceIdentity {
  const { adjective, noun } = memorableWords(id.replace(/-/g, '').toLowerCase());

  return {
    name: workspaceSlug(id),
    displayName: workspaceTitleFromMission(mission) || `${capitalize(adjective)} ${capitalize(noun)}`,
    nameOrigin: 'auto',
  };
}

/** Who a shown title came from: 'user' is never replaced automatically; 'auto' is system-written. Matches the `user_workspaces` CHECK. */
export type NameOrigin = 'user' | 'auto';

/** Only 'user' is the owner's; unknown legacy values count as 'auto'. */
export function nameOriginOf(stored: string): NameOrigin {
  return stored === 'user' ? 'user' : 'auto';
}

export interface WorkspaceTitleState {
  slug: string;
  displayName: string | null;
  nameOrigin: NameOrigin | null;
  mission: string;
  /** Shown title is a new actor's stand-in, so the model's name may replace it. Never stored; the caller knows it from context. */
  standIn?: boolean;
}

export interface WorkspaceTitlePlan {
  /** Title to persist immediately, or null when only the model names it. */
  provisional: string | null;
  mission: string;
}

/** FNV-1a of the slug as eight hex digits, for the word tables. */
function slugHex(slug: string): string {
  let hash = 0x811c9dc5;

  for (const unit of new TextEncoder().encode(slug)) hash = Math.imul(hash ^ unit, 0x01000193) >>> 0;

  return hash.toString(16).padStart(8, '0');
}

/** Default actor name fixed by its slug; a placeholder, so the first message may replace it. */
export function codenameFor(slug: string): string {
  const { adjective, noun } = memorableWords(slugHex(slug));

  return `${capitalize(adjective)} ${capitalize(noun)}`;
}

/** Absent, the raw slug, or the slug's codename. */
export function isPlaceholderWorkspaceTitle(displayName: string | null | undefined, slug: string): boolean {
  const shown = displayName?.trim() ?? '';

  return shown.length === 0 || shown === slug.trim() || shown === codenameFor(slug);
}

/**
 * Only a system-written title may be auto-replaced; an unrecorded origin counts as the owner's.
 * Checked again on every `persist`: a manual rename can land while the model is thinking.
 */
export function autoTitleMayReplace(currentOrigin: NameOrigin | null | undefined): boolean {
  return currentOrigin === 'auto';
}

/** Race check plus write for a config-backed actor; false means the owner claimed the title first. */
export function persistAutoTitle(
  config: Pick<AgentConfigStore, 'getNameOrigin' | 'setDisplayNameOrigin'>, title: string,
): boolean {
  if (!autoTitleMayReplace(config.getNameOrigin())) return false;
  config.setDisplayNameOrigin(title, 'auto');

  return true;
}

/**
 * Title policy for actors with no chat `auto_title` effect. Admission calls without `suggest` (a model call would delay handoff);
 * the runner calls again with `suggest` once the turn ends. Returns whether the shown title changed.
 */
export async function titleActorFromMessage(
  actor: Pick<ActorHandle, 'name' | 'config'>,
  message: string,
  suggest?: (mission: string) => Promise<string | null>,
): Promise<boolean> {
  const config = actor.config;
  const displayName = config.getDisplayName();

  const effects: Parameters<typeof applyWorkspaceTitle>[1] = {
    persist: (title) => persistAutoTitle(config, title),
  };

  if (suggest) effects.suggest = suggest;

  const titled = await applyWorkspaceTitle({
    slug: actor.name,
    displayName,
    nameOrigin: config.getNameOrigin(),
    mission: message,
    standIn: displayName === workspaceTitleFromMission(message.trim()),
  }, effects);

  return titled !== null;
}

/** Null means leave the title alone. A placeholder gets the deterministic stand-in first; a stand-in gets only the model's name. */
export function planWorkspaceTitle(state: WorkspaceTitleState): WorkspaceTitlePlan | null {
  if (!autoTitleMayReplace(state.nameOrigin)) return null;

  if (isPlaceholderMission(state.mission)) return null;
  const placeholder = isPlaceholderWorkspaceTitle(state.displayName, state.slug);

  if (!placeholder && state.standIn !== true) return null;
  const mission = state.mission.trim();

  return { provisional: placeholder ? workspaceTitleFromMission(mission) || null : null, mission };
}

/**
 * Persist the stand-in first so a placeholder never survives a failed model call, then the model's name.
 * Generation errors propagate: the caller decides whether a titling failure matters.
 */
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

  if (suggested && suggested !== (title ?? state.displayName)) {
    const persisted = await effects.persist(suggested);

    if (persisted === false) return null;
    title = suggested;
  }

  return title;
}

/** System prompt paired with workspaceTitlePrompt. */
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

/** Null when the model returned nothing usable. The slug is not the model's to choose. */
export function parseWorkspaceTitle(raw: string): string | null {
  const parsed = tolerate(() => extractJsonObject(raw), 'malformed-input');

  if (parsed === undefined) return null;
  const title = v.safeParse(WorkspaceTitleSchema, parsed);

  if (!title.success) return null;

  return cleanTitle(title.output.title) || null;
}

/** `complete` takes the system prompt separately because `LLM.complete` has no system channel. Model errors propagate. */
export async function suggestWorkspaceTitle(
  complete: (system: string, prompt: string) => Promise<string>,
  mission: string,
): Promise<string | null> {
  return parseWorkspaceTitle(await complete(WORKSPACE_TITLE_SYSTEM_PROMPT, workspaceTitlePrompt(mission)));
}

function extractPersonaName(mission: string): string | null {
  const match = mission.match(/\b(?:you are|call you|named)\s+([A-Za-z][A-Za-z0-9_-]{1,30})\b/i);

  return match?.[1] ?? null;
}

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

/** Shared by the throwing gate and the predicate so they cannot drift. */
const WORKSPACE_NAME = /^[a-zA-Z0-9._-]{1,64}$/;

/** Predicate form, so a malformed name is refused here instead of surfacing as a DO error indistinguishable from an outage. */
export function isWorkspaceName(name: string): boolean {
  return WORKSPACE_NAME.test(name);
}

export function validateWorkspaceName(name: string): void {
  if (!isWorkspaceName(name)) {
    throw new Error('Invalid workspace name. Use alphanumerics, dot, underscore and dash only (max 64 chars).');
  }
}
