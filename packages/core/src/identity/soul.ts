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
 * readSoul performs two one-time migrations for pre-existing agents:
 *   - `agent_soul` table (pre-b7fefa1) → rendered SOUL.md, table dropped.
 *   - TEXT-typed SOUL.md rows (written by the broken raw-SQL writer that
 *     shipped with b7fefa1) → recovered and rewritten as canonical BLOBs.
 */

import { concatBuffers, rowDataToBytes, writeVfsFileSync } from '@proteus/agent-utils/vfs';
import type { SqlExecutor } from '../types/primitives.js';

export const SOUL_PATH = 'SOUL.md';

export const DEFAULT_SOUL_MD = [
  '# Proteus',
  '',
  'Proteus is a self-evolving agent runtime.',
  '',
  '## Mission',
  '',
  'Help the user by reading real context, using available tools, coordinating parallel heads when useful, saving durable facts and memory, and improving reusable capabilities over time.',
].join('\n');

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ') || 'Proteus';
}

function normalizeMission(mission?: string): string {
  return mission?.trim() || 'Help the user with the work they assign.';
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

export function readSoul(sql: SqlExecutor): string | null {
  const rows = sql<SoulRow>`
    SELECT data FROM vfs_files
    WHERE path = ${SOUL_PATH} AND is_dir = 0
    ORDER BY chunk_index ASC
  `;
  if (rows.length === 0) return migrateLegacyAgentSoul(sql);

  // Rows bound as TEXT by the pre-fix writer: recover the markdown and
  // rewrite it through the canonical BLOB encoding.
  if (rows.some((row) => typeof row.data === 'string')) {
    const text = rows.map((row) => (typeof row.data === 'string' ? row.data : '')).join('');
    writeSoul(sql, text);
    return text.trim() ? text : null;
  }

  const bytes = concatBuffers(rows.map((row) => rowDataToBytes(row.data)));
  const text = new TextDecoder().decode(bytes);
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

/** One-time migration from the pre-SOUL.md `agent_soul` table: render the
 *  legacy purpose into SOUL.md via the canonical writer, then drop the table.
 *  Returns the migrated markdown, or null when no legacy soul exists. */
function migrateLegacyAgentSoul(sql: SqlExecutor): string | null {
  const legacyTable = sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_soul'
  `;
  if (legacyTable.length === 0) return null;

  const purpose = sql<{ purpose: string | null }>`
    SELECT purpose FROM agent_soul LIMIT 1
  `[0]?.purpose?.trim();
  if (!purpose) {
    sql`DROP TABLE agent_soul`;
    return null;
  }

  const name = sql<{ name: string | null }>`
    SELECT name FROM workspace_identity LIMIT 1
  `[0]?.name ?? '';
  const soul = renderSoulMarkdown({ name, mission: purpose });
  writeSoul(sql, soul);
  sql`DROP TABLE agent_soul`;
  return soul;
}
