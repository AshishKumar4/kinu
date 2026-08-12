/**
 * SOUL.md — the agent's identity document, a real file in the workspace
 * filesystem.
 *
 * It is deliberately a FILE and not a row: the user edits it through the setSoul
 * RPC, and the agent evolves it with its own file tools, so it has to live where
 * `file`, `workspace.readFile` and `grep` can all reach it by one path.
 *
 * Its MISSION, separately, is a column on `workspace_identity`. That is not a
 * second copy of the document — it is the one line a listing needs, maintained
 * by {@link writeSoul} and by nothing else. The alternative was to boot a whole
 * filesystem to render `proteus list`, which both costs a filesystem per
 * workspace listed and MUTATES each one on the way past (the process-generation
 * counter advances on every open). A listing must not do either.
 */

import type { SqlExecutor, VFS } from '../types/primitives.js';

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

/**
 * The soul document, or null when the workspace has none.
 *
 * Reads the file, so it needs a filesystem — which every caller inside a turn
 * has. A read-only inspection (`proteus list`, `proteus status`) deliberately
 * does not call this: it reads {@link readMission} instead.
 */
export async function readSoul(vfs: VFS): Promise<string | null> {
  try {
    const text = await vfs.readFile(SOUL_PATH, { encoding: 'utf8' });
    return typeof text === 'string' && text.trim() ? text : null;
  } catch {
    return null;
  }
}

/**
 * The workspace's mission, straight off its identity row.
 *
 * The one datum a listing needs, readable without opening a filesystem — and
 * therefore without writing to the database it is only reading.
 */
export function readMission(sql: SqlExecutor): string | null {
  const mission = sql<{ mission: string | null }>`
    SELECT mission FROM workspace_identity LIMIT 1
  `[0]?.mission?.trim();
  return mission || null;
}

/**
 * Write the soul, and refresh the mission a listing reads.
 *
 * The single writer of both. Keeping the refresh here rather than at each call
 * site is what stops the row from drifting away from the document: there is no
 * path that changes one without the other.
 */
export async function writeSoul(vfs: VFS, sql: SqlExecutor, markdown: string): Promise<void> {
  await vfs.writeFile(SOUL_PATH, markdown);
  sql`UPDATE workspace_identity SET mission = ${summarizeSoul(markdown)}`;
}

export async function seedSoul(
  vfs: VFS, sql: SqlExecutor, input: { name: string; mission?: string },
): Promise<string> {
  const soul = renderSoulMarkdown(input);
  await writeSoul(vfs, sql, soul);
  return soul;
}
