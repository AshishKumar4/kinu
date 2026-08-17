/**
 * AGENTS.md rendering — the one prompt block for the agents.md open standard.
 * Backends discover the files (CLI: walk up from cwd; CF: agent VFS root +
 * active sandbox workspace) and feed them here ordered root-most → nearest.
 *
 * Precedence follows the standard: the file nearest the working directory
 * wins on conflict, root-most files provide defaults. The char cap is spent
 * nearest-first so a giant root file can never crowd out the closest one;
 * anything cut is truncated/omitted with an explicit note.
 */

import type { VFS } from '../types/primitives.js';
import type { ExecutorProvider } from '../execution/types.js';

export interface AgentsMdFile {
  /** Where the file was found — shown to the model as provenance. */
  path: string;
  content: string;
}

export const AGENTS_MD_MAX_CHARS = 24_000;

/** Minimum budget worth spending on a truncated file — below this the file is
 *  omitted outright instead of contributing a useless fragment. */
const MIN_TRUNCATED_CHARS = 500;

interface RenderedFile {
  path: string;
  body: string;
}

/**
 * Render the AGENTS.md prompt section. `files` must be ordered root-most
 * first, nearest last. Returns '' when nothing renders.
 */
export function renderAgentsMdSection(
  files: ReadonlyArray<AgentsMdFile>,
  maxChars = AGENTS_MD_MAX_CHARS,
): string {
  const present = files
    .map((f) => ({ path: f.path, content: f.content.trim() }))
    .filter((f) => f.content.length > 0);
  if (present.length === 0) return '';

  // Spend the budget nearest-first; render root-first.
  let remaining = Math.max(0, maxChars);
  const kept = new Map<string, RenderedFile>();
  const omitted: string[] = [];
  for (const file of [...present].reverse()) {
    if (file.content.length <= remaining) {
      kept.set(file.path, { path: file.path, body: file.content });
      remaining -= file.content.length;
    } else if (remaining >= MIN_TRUNCATED_CHARS) {
      kept.set(file.path, {
        path: file.path,
        body: file.content.slice(0, remaining) +
          `\n… [truncated: ${file.content.length - remaining} more chars in ${file.path}]`,
      });
      remaining = 0;
    } else {
      omitted.push(file.path);
    }
  }

  const parts = [
    '## Project instructions (AGENTS.md)',
    'These instructions come from AGENTS.md files in the workspace (agents.md convention). Follow them for project work; when they conflict, the file closest to the working directory wins.',
  ];
  if (omitted.length > 0) {
    parts.push(`(${omitted.length} broader AGENTS.md file(s) omitted by the size cap: ${omitted.join(', ')})`);
  }
  for (const file of present) {
    const entry = kept.get(file.path);
    if (entry) parts.push(`### ${entry.path}`, entry.body);
  }
  return parts.join('\n\n');
}

/**
 * AGENTS.md discovery for cloud workspaces: the canonical workspace provides
 * defaults, and an already-active sandbox contributes its own project rules as
 * the nearest file. Each file is read from the environment that owns its bytes;
 * discovery never provisions a sandbox. A file that is not there is skipped; a
 * read that fails is not reported as an absence.
 */
export async function collectWorkspaceAgentsMd(
  vfs: VFS,
  sandbox?: ExecutorProvider,
): Promise<AgentsMdFile[]> {
  const out: AgentsMdFile[] = [];
  const read = async (files: VFS, path: string, label: string): Promise<void> => {
    if (!await files.exists(path)) return;
    const raw = await files.readFile(path, { encoding: 'utf8' });
    const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw;
    if (text.trim()) out.push({ path: label, content: text });
  };
  await read(vfs, 'AGENTS.md', 'AGENTS.md (workspace)');
  if (sandbox?.getStatus?.().active && sandbox.files) {
    await read(sandbox.files, '/workspace/AGENTS.md', '/workspace/AGENTS.md (sandbox)');
  }
  return out;
}
