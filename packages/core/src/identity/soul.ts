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

function textFromData(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (data === null || data === undefined) return '';
  return String(data);
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

export function readSoul(sql: SqlExecutor): string | null {
  try {
    const rows = sql<{ data: unknown }>`
      SELECT data FROM vfs_files
      WHERE path = ${SOUL_PATH}
      ORDER BY chunk_index ASC
    `;
    const text = rows.map((row) => textFromData(row.data)).join('');
    return text.trim() ? text : null;
  } catch {
    try {
      const rows = sql<{ data: unknown }>`
        SELECT data FROM vfs_files WHERE path = ${SOUL_PATH} LIMIT 1
      `;
      const text = textFromData(rows[0]?.data);
      return text.trim() ? text : null;
    } catch {
      return null;
    }
  }
}

export function writeSoul(sql: SqlExecutor, markdown: string): void {
  const now = Date.now();
  const size = new TextEncoder().encode(markdown).byteLength;
  sql`DELETE FROM vfs_files WHERE path = ${SOUL_PATH}`;
  try {
    sql`
      INSERT INTO vfs_files (path, chunk_index, parent_path, data, is_dir, size, mtime)
      VALUES (${SOUL_PATH}, ${0}, ${''}, ${markdown}, ${0}, ${size}, ${now})
    `;
  } catch {
    sql`
      INSERT OR REPLACE INTO vfs_files (path, data, is_dir, size, mtime)
      VALUES (${SOUL_PATH}, ${markdown}, ${0}, ${size}, ${now})
    `;
  }
}

export function seedSoul(sql: SqlExecutor, input: { name: string; mission?: string }): string {
  const soul = renderSoulMarkdown(input);
  writeSoul(sql, soul);
  return soul;
}
