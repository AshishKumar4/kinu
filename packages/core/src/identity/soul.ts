/**
 * SOUL.md — the agent's identity document, stored at the VFS root.
 *
 * The soul is an ordinary vfs_files entry written through the canonical
 * SqliteFS encoding, so every VFS consumer (file manager, workspace shell,
 * shared scratch) reads the same bytes. Unlike the pre-SOUL.md `agent_soul`
 * table (creation-only), SOUL.md is deliberately mutable: the user edits it
 * via the backend setSoul RPC and the agent can evolve it through its own
 * file tools.
 *
 * readSoul is a pure read: read-only consumers (`proteus list`, `proteus
 * status`) open the database readonly, so a read must never write. The
 * one-time repairs for pre-existing agents live in migrateSoulStorage, which
 * the write-capable workspace-open paths run:
 *   - `agent_soul` table (pre-b7fefa1) → rendered SOUL.md, table dropped.
 *   - TEXT-typed SOUL.md rows (written by the broken raw-SQL writer that
 *     shipped with b7fefa1) → rewritten as canonical BLOBs, which is what
 *     SqliteFS needs (it decodes TEXT `data` as legacy base64).
 */

import { concatBuffers, rowDataToBytes, writeVfsFileSync } from '@proteus/agent-utils/vfs';
import type { SqlExecutor } from '../types/primitives.js';

export const SOUL_PATH = 'SOUL.md';

/** Missions the renderer writes when a workspace was created without one.
 *  They describe Proteus itself, so nothing workspace-specific — a title, a
 *  summary — can be derived from them. */
const PLACEHOLDER_MISSIONS = [
  'Help the user by reading real context, using available tools, coordinating parallel heads for breadth and staffing subordinates for multi-part or long-running work, saving durable facts and memory, and improving reusable capabilities over time.',
  'Help the user with the work they assign.',
] as const;

export const DEFAULT_SOUL_MD = [
  '# Proteus',
  '',
  'Proteus is a self-evolving agent runtime.',
  '',
  '## Mission',
  '',
  PLACEHOLDER_MISSIONS[0],
].join('\n');

/** True when the mission carries no workspace-specific intent: empty, or one
 *  of the generic missions seeded for a workspace created without one.
 *  Compared on a prefix because `summarizeSoul` truncates long missions. */
export function isPlaceholderMission(mission: string | null | undefined): boolean {
  const text = mission?.trim() ?? '';
  if (!text) return true;
  const key = missionKey(text);
  return PLACEHOLDER_MISSIONS.some((placeholder) => missionKey(placeholder) === key);
}

function missionKey(mission: string): string {
  return mission.replace(/\s+/g, ' ').trim().slice(0, 40);
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ') || 'Proteus';
}

function normalizeMission(mission?: string): string {
  return mission?.trim() || PLACEHOLDER_MISSIONS[1];
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

type SoulRow = { data: string | ArrayBuffer | Uint8Array | null };

function selectSoulRows(sql: SqlExecutor): SoulRow[] {
  return sql<SoulRow>`
    SELECT data FROM vfs_files
    WHERE path = ${SOUL_PATH} AND is_dir = 0
    ORDER BY chunk_index ASC
  `;
}

/** TEXT rows carry the markdown verbatim (the pre-fix writer bound it as a
 *  string); canonical rows are UTF-8 BLOB chunks. */
function decodeSoulRows(rows: SoulRow[]): string {
  if (rows.some((row) => typeof row.data === 'string')) {
    return rows.map((row) => (typeof row.data === 'string' ? row.data : '')).join('');
  }
  return new TextDecoder().decode(concatBuffers(rows.map((row) => rowDataToBytes(row.data))));
}

export function readSoul(sql: SqlExecutor): string | null {
  const rows = selectSoulRows(sql);
  if (rows.length === 0) return hasLegacyAgentSoul(sql) ? renderLegacyAgentSoul(sql) : null;
  const text = decodeSoulRows(rows);
  return text.trim() ? text : null;
}

export function writeSoul(sql: SqlExecutor, markdown: string): void {
  writeVfsFileSync(sql, SOUL_PATH, markdown);
}

export function seedSoul(sql: SqlExecutor, input: { name: string; mission?: string }): string {
  const soul = renderSoulMarkdown(input);
  writeSoul(sql, soul);
  return soul;
}

/**
 * Bring pre-canonical soul storage up to date. Idempotent, and it writes —
 * run it from the workspace-open paths (right after schema init), never from
 * a read path.
 */
export function migrateSoulStorage(sql: SqlExecutor): void {
  const rows = selectSoulRows(sql);
  if (rows.length > 0) {
    if (rows.some((row) => typeof row.data === 'string')) writeSoul(sql, decodeSoulRows(rows));
    return;
  }
  if (!hasLegacyAgentSoul(sql)) return;
  const soul = renderLegacyAgentSoul(sql);
  if (soul) writeSoul(sql, soul);
  sql`DROP TABLE agent_soul`;
}

function hasLegacyAgentSoul(sql: SqlExecutor): boolean {
  return sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_soul'
  `.length > 0;
}

/** Render the pre-SOUL.md `agent_soul` purpose as SOUL.md markdown. Callers
 *  must have confirmed the table exists. */
function renderLegacyAgentSoul(sql: SqlExecutor): string | null {
  const purpose = sql<{ purpose: string | null }>`
    SELECT purpose FROM agent_soul LIMIT 1
  `[0]?.purpose?.trim();
  if (!purpose) return null;

  const name = sql<{ name: string | null }>`
    SELECT name FROM workspace_identity LIMIT 1
  `[0]?.name ?? '';
  return renderSoulMarkdown({ name, mission: purpose });
}
