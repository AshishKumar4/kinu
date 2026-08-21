/**
 * AGENTS.md discovery for the local backend — walk up from cwd to the
 * filesystem root collecting every AGENTS.md on the way (the agents.md
 * standard's nearest-file-wins chain). Returns root-most first, nearest
 * last — the order core's renderAgentsMdSection expects.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AgentsMdFile } from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';

export function discoverAgentsMd(cwd: string): AgentsMdFile[] {
  const files: AgentsMdFile[] = [];
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, 'AGENTS.md');
    const content = tolerate(() => readFileSync(candidate, 'utf8'), 'enoent');
    if (content?.trim()) files.push({ path: candidate, content });
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return files.reverse();
}
