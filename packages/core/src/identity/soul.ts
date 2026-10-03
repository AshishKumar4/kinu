import { exists, readText, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
// SOUL.md is a file, edited via setSoul; `workspace_soul` holds its bytes, so a listing reads the mission off that
// row ({@link readMission}) and never opens (and mutates) a filesystem.

import * as v from 'valibot';
import { WORKSPACE_SOUL_DDL } from './schema';
import type { SqlRow } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { AgentSignal } from '../types/signals';
import type { SqlDatabase } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { SqlExecutor, SqlValue } from '../types/primitives';
import { NIMBUS_WORKSPACE_ROOT, workspacePath, WORKSPACE_ROOT } from '../vfs/workspace-path';

export const SOUL_PATH = 'SOUL.md';

export function isWorkspaceSoul(path: string): boolean {
  const named = workspacePath(path, WORKSPACE_ROOT);

  // Nimbus's home links to Kinu's.
  return named === `${WORKSPACE_ROOT}/${SOUL_PATH}` || named === `${NIMBUS_WORKSPACE_ROOT}/${SOUL_PATH}`;
}

/** Generic missions seeded when none was given. */
const PLACEHOLDER_MISSIONS = [
  'Help the user by reading real context, using the available tools, saving durable facts and memory, and improving reusable capabilities over time.',
  'Help the user with the work they assign.',
] as const;

export const DEFAULT_SOUL_MD = [
  '# Kinu',
  '',
  'Kinu is a self-evolving agent runtime.',
  '',
  '## Mission',
  '',
  PLACEHOLDER_MISSIONS[0],
].join('\n');

/** Empty or a seeded placeholder, compared by prefix. */
export function isPlaceholderMission(mission: string | null | undefined): boolean {
  const text = mission?.trim() ?? '';

  if (!text) return true;
  const key = missionKey(text);

  return PLACEHOLDER_MISSIONS.some((placeholder) => missionKey(placeholder) === key);
}

function missionKey(mission: string): string {
  return mission.replace(/\s+/g, ' ').trim().slice(0, 40);
}

export const WORKSPACE_CREATED_EVENT = 'workspace_created';

/**
 * The workspace's first turn. The mission is not quoted (it already opens the system prompt);
 * an operator message arriving first consumes this offer. Null for a placeholder mission.
 */
export function workspaceGenesisSignal(mission: string | null | undefined): AgentSignal | null {
  if (isPlaceholderMission(mission)) return null;

  return {
    kind: WORKSPACE_CREATED_EVENT,
    yieldsToUserMessage: true,
    text: [
      'This workspace has just been created. This is its first turn and nobody has typed anything yet.',
      '',
      'Act on the mission in your soul. If it names work to do, start it now and report what you found. If it is a standing brief, say how you read it and ask the one question that most changes what you do first.',
    ].join('\n'),
  };
}

/** The name before anything titles a workspace; never the slug, which reads as a name. */
export const UNTITLED_WORKSPACE_NAME = 'Kinu';

function normalizeName(name: string): string {
  const collapsed = name.trim().replace(/\s+/g, ' ');

  return collapsed === '' ? UNTITLED_WORKSPACE_NAME : collapsed;
}

function normalizeMission(mission?: string): string {
  const stated = mission?.trim();

  return stated === undefined || stated === '' ? PLACEHOLDER_MISSIONS[1] : stated;
}

export function renderSoulMarkdown(input: { name: string; mission?: string }): string {
  return [
    `# ${normalizeName(input.name)}`,
    '',
    '## Mission',
    '',
    normalizeMission(input.mission),
  ].join('\n');
}

function soulSummaryFromMarkdown(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const missionIndex = lines.findIndex((line) => /^##\s+mission\s*$/i.test(line.trim()));

  if (missionIndex >= 0) {
    const missionLines: string[] = [];

    for (const line of lines.slice(missionIndex + 1)) {
      if (/^##\s+/.test(line.trim())) break;
      const trimmed = line.trim();

      if (trimmed) missionLines.push(trimmed);
    }

    const mission = missionLines.join(' ').trim();

    if (mission) return mission;
  }

  const firstContent = lines
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'));

  return firstContent ?? '';
}

export function summarizeSoul(markdown: string | null | undefined, maxLength = 220): string {
  const summary = soulSummaryFromMarkdown(markdown ?? '').replace(/\s+/g, ' ').trim();

  if (summary.length <= maxLength) return summary;

  return `${summary.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

/** Null when absent; asked, not caught. */
export async function readSoul(vfs: VFS): Promise<string | null> {
  if (!await exists(vfs, SOUL_PATH)) return null;

  if ((await vfs.stat(SOUL_PATH, { follow: false }))?.type === 'symlink') return null;
  const text = v.parse(v.string(), await readText(vfs, SOUL_PATH));

  return text.trim() ? text : null;
}



/** The mission every listing shows: summarized from the owner's soul, readable without opening a filesystem. */
export function readMission(sql: SqlExecutor): string | null {
  return ownerMissionOf(soulReadsSql(sql));
}

/** The first soul, from the workspace's name and stated purpose; `seal` is `writeWorkspaceSoul`, the one writer. */
export async function seedSoul(
  input: { name: string; mission?: string }, seal: (content: string) => Promise<void>,
): Promise<string> {
  const soul = renderSoulMarkdown(input);
  await seal(soul);

  return soul;
}

const IdentityRow = v.object({ name: v.string() });

const SoulRow = v.object({ markdown: v.string() });

function soulText(row: SqlRow): string {
  return v.parse(SoulRow, row).markdown;
}

export interface SoulReads {
  readonly soulTable: boolean;
  readonly soul: string | null;
  readonly identity: { name: string } | null;
}

export const UNVERIFIED_SOUL_PATH = 'SOUL.md.unverified';

/** One statement's rows, untyped: each read parses its own. */
type SoulRows = (query: string, ...bindings: SqlValue[]) => readonly SqlRow[];

/** The one read of the soul and identity rows; a table not yet made reads as absent. */
function soulReads(rows: SoulRows): SoulReads {
  const has = (table: string): boolean => rows(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, table).length > 0;
  const soulTable = has('workspace_soul');
  const [soulRow] = soulTable ? rows(`SELECT markdown FROM workspace_soul WHERE id = 1`) : [];
  const identity = has('workspace_identity') ? v.safeParse(IdentityRow, rows(`SELECT name FROM workspace_identity LIMIT 1`)[0]) : null;

  return {
    soulTable,
    soul: soulRow === undefined ? null : soulText(soulRow),
    identity: identity?.success === true ? { name: identity.output.name } : null,
  };
}

export function soulReadsSql(sql: SqlExecutor): SoulReads {
  return soulReads((query, ...bindings) => {
    const strings = query.split('?');

    return sql<SqlRow>(Object.assign(strings, { raw: strings }), ...bindings);
  });
}

export function ownerSoulDb(db: SqlDatabase, kernelHeld: string | null): { soul: string; seeded: boolean } | null {
  const reads = soulReads((query, ...bindings) => [...db.exec(query, ...bindings)]);

  if (reads.soul !== null) return { soul: reads.soul, seeded: false };

  if (reads.identity === null) return null;

  if (kernelHeld !== null) {
    recordKernelSoul(db, kernelHeld);

    return { soul: kernelHeld, seeded: true };
  }

  const seed = renderSoulMarkdown(reads.identity);
  db.exec(WORKSPACE_SOUL_DDL);
  db.exec(`INSERT INTO workspace_soul (id, markdown) VALUES (1, ?) ON CONFLICT(id) DO NOTHING`, seed);

  return { soul: seed, seeded: true };
}

function recordKernelSoul(db: SqlDatabase, markdown: string): void {

  db.exec(WORKSPACE_SOUL_DDL);
  db.exec(`INSERT INTO workspace_soul (id, markdown) VALUES (1, ?) ON CONFLICT(id) DO NOTHING`, markdown);
}

/** Summarized from the soul the owner wrote: null before one is written, or when it says nothing a summary keeps. */
export function ownerMissionOf(reads: SoulReads): string | null {
  const mission = summarizeSoul(reads.soul);

  return mission === '' ? null : mission;
}

export function storeDurableSoulDb(db: SqlDatabase, markdown: string): void {
  db.exec(WORKSPACE_SOUL_DDL);
  db.exec(`INSERT INTO workspace_soul (id, markdown) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET markdown = excluded.markdown`, markdown);
}

