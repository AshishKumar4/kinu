import { readText, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
// SOUL.md is an ordinary file of the workspace, and the only copy of the soul: every agent edits it, the owner
// too, and the next turn reads what it holds.

import * as v from 'valibot';
import type { AgentSignal } from '../types/signals';
import { WORKSPACE_ROOT } from '../vfs/workspace-path';

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

/** The workspace's SOUL.md: main's home holds it, wherever the reader's own home is. */
export const SOUL_FILE = `${WORKSPACE_ROOT}/${SOUL_PATH}`;

/** Null when absent, blank, or anything but a file (a link is not followed); one lookup when absent, as every turn asks. */
export async function readSoul(vfs: VFS): Promise<string | null> {
  if ((await vfs.stat(SOUL_FILE, { follow: false }))?.type !== 'file') return null;
  const text = v.parse(v.string(), await readText(vfs, SOUL_FILE));

  return text.trim() ? text : null;
}



/** The first soul, from the workspace's name and stated purpose; `write` puts it in SOUL.md. */
export async function seedSoul(
  input: { name: string; mission?: string }, write: (content: string) => Promise<void>,
): Promise<string> {
  const soul = renderSoulMarkdown(input);
  await write(soul);

  return soul;
}

/** Summarized from SOUL.md: null before one is written, or when it says nothing a summary keeps. */
export function missionOf(soul: string | null): string | null {
  const mission = summarizeSoul(soul);

  return mission === '' ? null : mission;
}
