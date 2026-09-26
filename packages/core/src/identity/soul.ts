// SOUL.md is a file, edited via setSoul; its mission is mirrored onto `workspace_identity` by
// {@link writeSoul} alone, so listings never open (and mutate) a filesystem.

import * as v from 'valibot';
import { WORKSPACE_SOUL_DDL } from './schema';
import type { SqlRow } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { AgentSignal } from '../types/signals';
import type { SqlDatabase } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { SqlExecutor, VFS } from '../types/primitives';

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

/** Shared by {@link summarizeSoul} and its streaming twin so they cannot drift. */
function clampSummary(text: string, maxLength: number): string {
  const summary = text.replace(/\s+/g, ' ').trim();

  if (summary.length <= maxLength) return summary;

  return `${summary.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function summarizeSoul(markdown: string | null | undefined, maxLength = 220): string {
  return clampSummary(soulSummaryFromMarkdown(markdown ?? ''), maxLength);
}

const SOUL_SCAN_CHUNK_BYTES = 64 * 1024;

/** {@link summarizeSoul} over bytes, in bounded memory without decoding a whole copy. */
export function summarizeSoulBytes(bytes: Uint8Array, maxLength = 220): string {
  const decoder = new TextDecoder();
  const scan = new SoulSummaryScan(maxLength);

  for (let at = 0; at < bytes.byteLength; at += SOUL_SCAN_CHUNK_BYTES) {
    const end = Math.min(at + SOUL_SCAN_CHUNK_BYTES, bytes.byteLength);
    scan.read(decoder.decode(bytes.subarray(at, end), { stream: true }));
  }

  scan.read(decoder.decode());

  return scan.summary();
}

/** {@link soulSummaryFromMarkdown}'s rules, a chunk at a time. */
class SoulSummaryScan {
  private readonly cap: number;
  private line = '';
  private lineOverflowed = false;
  private lineStarted = false;
  private spacePending = false;
  private inMission = false;
  private missionSeen = false;
  private mission = '';
  private firstContent: string | null = null;

  constructor(private readonly maxLength: number) {
    this.cap = maxLength + 8;
  }

  read(text: string): void {
    let at = 0;

    for (;;) {
      const newline = text.indexOf('\n', at);

      if (newline < 0) {
        this.feed(text.slice(at));

        return;
      }

      this.feed(text.slice(at, newline));
      this.endLine();
      at = newline + 1;
    }
  }

  summary(): string {
    this.endLine();
    const chosen = this.mission !== '' ? this.mission : this.firstContent ?? '';

    return clampSummary(chosen, this.maxLength);
  }

  private feed(piece: string): void {
    if (piece === '') return;
    const collapsed = piece.replace(/\s+/g, ' ');
    const body = collapsed.trim();

    if (body === '') {
      this.spacePending = this.spacePending || this.lineStarted;

      return;
    }

    if (this.lineStarted && (this.spacePending || collapsed.startsWith(' '))) this.append(' ');
    this.append(body);
    this.lineStarted = true;
    this.spacePending = collapsed.endsWith(' ');
  }

  private append(text: string): void {
    const room = this.cap - this.line.length;

    if (room <= 0) {
      this.lineOverflowed = true;

      return;
    }

    if (text.length > room) this.lineOverflowed = true;
    this.line += text.slice(0, room);
  }

  private endLine(): void {
    const line = this.line;
    const overflowed = this.lineOverflowed;
    this.line = '';
    this.lineOverflowed = false;
    this.lineStarted = false;
    this.spacePending = false;

    if (this.inMission) {
      if (/^##\s/.test(line)) {
        this.inMission = false;

        return;
      }

      if (line === '') return;

      if (this.mission.length >= this.cap) return;
      this.mission = this.mission === '' ? line : `${this.mission} ${line}`;

      if (this.mission.length > this.cap) this.mission = this.mission.slice(0, this.cap);

      return;
    }

    // Only the first heading opens it, as `findIndex` does; an overflowed line is not a heading.
    if (!this.missionSeen && !overflowed && line.toLowerCase() === '## mission') {
      this.missionSeen = true;
      this.inMission = true;

      return;
    }

    if (this.firstContent === null && line !== '' && !line.startsWith('#')) {
      this.firstContent = line;
    }
  }
}

/** Null when absent; asked, not caught. */
export async function readSoul(vfs: VFS): Promise<string | null> {
  if (!await vfs.exists(SOUL_PATH)) return null;

  if ((await vfs.lstat?.(SOUL_PATH))?.isSymlink === true) return null;
  const text = v.parse(v.string(), await vfs.readFile(SOUL_PATH, { encoding: 'utf8' }));

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

export function ownerMissionOf(reads: SoulReads): string | null {
  if (reads.soul !== null) return summarizeSoul(reads.soul);


  if (reads.identity === null) return null;

  return summarizeSoul(renderSoulMarkdown(reads.identity));
}

export function storeDurableSoulDb(db: SqlDatabase, markdown: string): void {
  db.exec(WORKSPACE_SOUL_DDL);
  db.exec(`INSERT INTO workspace_soul (id, markdown) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET markdown = excluded.markdown`, markdown);
}

