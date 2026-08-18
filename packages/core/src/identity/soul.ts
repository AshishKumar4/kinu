/**
 * SOUL.md — the agent's identity document, a real file in the workspace
 * filesystem.
 *
 * It is deliberately a FILE and not a row: the owner edits it through the
 * setSoul RPC, while `file`, `workspace.readFile` and `grep` all read that one
 * path. Hosted backends may supply an owner-only writer so the agent's shared
 * workspace tools cannot mutate its own governing identity.
 *
 * Its MISSION, separately, is a column on `workspace_identity`. That is not a
 * second copy of the document — it is the one line a listing needs, maintained
 * by {@link writeSoul} and by nothing else. The alternative was to boot a whole
 * filesystem to render `proteus list`, which both costs a filesystem per
 * workspace listed and MUTATES each one on the way past (the process-generation
 * counter advances on every open). A listing must not do either.
 */

import * as v from 'valibot';
import type { AgentSignal } from '../types/signals.js';
import type { SqlExecutor, VFS } from '../types/primitives.js';

export const SOUL_PATH = 'SOUL.md';

/** Missions the renderer writes when a workspace was created without one.
 *  They describe Proteus itself, so nothing workspace-specific — a title, a
 *  summary — can be derived from them. */
const PLACEHOLDER_MISSIONS = [
  'Help the user by reading real context, using available tools, coordinating parallel heads for breadth and hiring subordinates for multi-part or long-running work, saving durable facts and memory, and improving reusable capabilities over time.',
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

/** The `proteusEvent` a workspace's own first turn carries. */
export const WORKSPACE_CREATED_EVENT = 'workspace_created';

/**
 * The workspace's first turn — the agent answering its own soul, with nobody
 * having typed anything yet.
 *
 * The mission is NOT repeated in the text. It is a standing identity and it is
 * already the opening bytes of the system prompt (SOUL.md → `soulOverride`), so
 * quoting it back would both duplicate it and stage it as something the owner
 * said. What the turn adds is the one fact the prompt cannot carry: that the
 * workspace has just opened and the next move is the agent's.
 *
 * `requiresOwnTurn` because a genesis turn is a turn, not an aside spliced into
 * whatever raced it (a peer's task, an inbound email).
 *
 * Null for a placeholder mission — there is nothing to act on, and a first turn
 * on one can only produce a greeting nobody asked for.
 */
export function workspaceGenesisSignal(mission: string | null | undefined): AgentSignal | null {
  if (isPlaceholderMission(mission)) return null;
  return {
    kind: WORKSPACE_CREATED_EVENT,
    requiresOwnTurn: true,
    text: [
      'This workspace has just been created. This is its first turn and nobody has typed anything yet.',
      '',
      'Act on the mission in your soul. If it names work to do, start it now and report what you found. If it is a standing brief, say how you read it and ask the one question that most changes what you do first.',
    ].join('\n'),
  };
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
 *
 * "No soul" is asked, not caught: a workspace whose SOUL.md is unreadable for
 * any other reason — a broken VFS, a storage failure mid-turn — must not read
 * as an agent that simply has no purpose yet.
 */
export async function readSoul(vfs: VFS): Promise<string | null> {
  if (!await vfs.exists(SOUL_PATH)) return null;
  const text = v.parse(v.string(), await vfs.readFile(SOUL_PATH, { encoding: 'utf8' }));
  return text.trim() ? text : null;
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
export async function writeSoul(
  vfs: VFS,
  sql: SqlExecutor,
  markdown: string,
  writeFile?: (path: string, content: string) => Promise<void>,
): Promise<void> {
  if (writeFile) await writeFile(SOUL_PATH, markdown);
  else await vfs.writeFile(SOUL_PATH, markdown);
  void sql`UPDATE workspace_identity SET mission = ${summarizeSoul(markdown)}`;
}

export async function seedSoul(
  vfs: VFS, sql: SqlExecutor, input: { name: string; mission?: string },
): Promise<string> {
  const soul = renderSoulMarkdown(input);
  await writeSoul(vfs, sql, soul);
  return soul;
}
