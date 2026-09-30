import { exists, readText, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
// SOUL.md is a file, edited via setSoul; its mission is mirrored onto `workspace_identity` by
// {@link writeSoul} alone, so listings never open (and mutate) a filesystem.

import * as v from 'valibot';
import { WORKSPACE_SOUL_DDL } from './schema';
import type { SqlRow } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { AgentSignal } from '../types/signals';
import type { SqlDatabase } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { SqlExecutor } from '../types/primitives';

export const SOUL_PATH = 'SOUL.md';

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



/** The mission off the identity row, readable without opening a filesystem. */
export function readMission(sql: SqlExecutor): string | null {
  const mission = sql<{ mission: string | null }>`
    SELECT mission FROM workspace_identity LIMIT 1
  `[0]?.mission?.trim();

  return mission === undefined || mission === '' ? null : mission;
}

/** The one writer of soul and mission; `seal` is `writeWorkspaceSoul`. */
export async function writeSoul(
  sql: SqlExecutor,
  markdown: string,
  seal: (content: string) => Promise<void>,
): Promise<void> {
  await seal(markdown);
  void sql`UPDATE workspace_identity SET mission = ${summarizeSoul(markdown)}`;
}

export async function seedSoul(
  sql: SqlExecutor, input: { name: string; mission?: string },
  seal: (content: string) => Promise<void>,
): Promise<string> {
  const soul = renderSoulMarkdown(input);
  await writeSoul(sql, soul, seal);

  return soul;
}

const IdentityRow = v.object({ name: v.string(), mission: v.optional(v.string(), '') });

const SoulRow = v.object({ markdown: v.string() });

function soulText(row: SqlRow): string {
  return v.parse(SoulRow, row).markdown;
}

export interface SoulReads {
  readonly soulTable: boolean;
  readonly soul: string | null;
  readonly identity: { name: string; mission: string } | null;
}

export const UNVERIFIED_SOUL_PATH = 'SOUL.md.unverified';

function soulReadsDb(db: SqlDatabase): SoulReads {
  const has = (table: string): boolean =>
    [...db.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, table)].length > 0;

  const soulRows = has('workspace_soul') ? [...db.exec(`SELECT markdown FROM workspace_soul WHERE id = 1`)] : [];

  const soul = soulRows.length === 0 ? null : soulText(soulRows[0]);

  const identity = has('workspace_identity')
    ? v.safeParse(IdentityRow, [...db.exec(`SELECT * FROM workspace_identity LIMIT 1`)][0])
    : { success: false as const };

  return {
    soulTable: has('workspace_soul'),
    soul,
    identity: identity.success ? { name: identity.output.name, mission: identity.output.mission } : null,
  };
}

export function soulReadsSql(sql: SqlExecutor): SoulReads {
  const [soulRow] = sql<SqlRow>`SELECT markdown FROM workspace_soul WHERE id = 1`;

  const soul = soulRow === undefined ? null : soulText(soulRow);

  const identity = v.safeParse(IdentityRow, sql<SqlRow>`SELECT * FROM workspace_identity LIMIT 1`[0]);

  return {
    soulTable: sql<SqlRow>`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_soul'`.length > 0,
    soul,
    identity: identity.success ? { name: identity.output.name, mission: identity.output.mission } : null,
  };
}

export function ownerSoulDb(db: SqlDatabase, kernelHeld: string | null): { soul: string; seeded: boolean } | null {
  const reads = soulReadsDb(db);

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

/** Null when the soul says nothing a summary keeps (a heading alone, whitespace), as {@link readMission} reads it. */
export function ownerMissionOf(reads: SoulReads): string | null {
  const markdown = reads.soul ?? (reads.identity === null ? null : renderSoulMarkdown(reads.identity));
  const mission = summarizeSoul(markdown);

  return mission === '' ? null : mission;
}

export function storeDurableSoulDb(db: SqlDatabase, markdown: string): void {
  db.exec(WORKSPACE_SOUL_DDL);
  db.exec(`INSERT INTO workspace_soul (id, markdown) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET markdown = excluded.markdown`, markdown);
}

