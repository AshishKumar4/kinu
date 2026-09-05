import { listLocalAgentNames } from '../agent-list';
import { loadConfigFile, resolveAgentRef } from '../config';
import { ACCENT, DIM, OK, WARN } from '../display';
import { findTranscriptPath, listCliSessions } from '../session';

/** `kinu transcripts` — list recorded terminal-transcript artifacts. These
 *  JSONL files are diagnostics and export material only; they are never
 *  conversations to reopen. */
export async function transcriptsCommand(agentName: string | undefined, opts: {
  transcriptDir?: string;
  path?: boolean;
  show?: string;
}): Promise<void> {
  const names = resolveAgentNames(agentName);
  if (names.length === 0) {
    console.log(DIM('No workspaces found.'));
    return;
  }

  for (const name of names) {
    if (names.length > 1) console.log(`\n${ACCENT(name)}`);
    if (opts.show) {
      const path = findTranscriptPath(name, opts.show, opts);
      if (!path) {
        console.log(WARN('  Transcript not found.'));
      } else {
        console.log(opts.path ? path : `${OK('transcript')} ${ACCENT(opts.show)} ${DIM(path)}`);
      }
      continue;
    }

    const transcripts = listCliSessions(name, opts);
    if (transcripts.length === 0) {
      console.log(DIM('  No transcripts recorded yet.'));
      continue;
    }
    for (const t of transcripts.slice(0, 30)) {
      const first = t.firstUserText ? ` ${DIM('-')} ${t.firstUserText.replace(/\s+/g, ' ')}` : '';
      const pathText = opts.path ? ` ${DIM(t.path)}` : '';
      console.log(`  ${ACCENT(t.id)} ${DIM(`${t.entries} entries`)}${first}${pathText}`);
    }
    if (transcripts.length > 30) console.log(DIM(`  … and ${transcripts.length - 30} more`));
  }
}

function resolveAgentNames(input: string | undefined): string[] {
  if (input) {
    const configured = resolveAgentRef(input);
    return [configured?.name ?? input];
  }
  const cfg = loadConfigFile();
  const names = new Set<string>();
  for (const [name, agent] of Object.entries(cfg.agents ?? {})) names.add(agent.name || name);
  // Project-scoped refs, then the workspaces no project claims yet: a
  // transcript recorded before placement existed is still worth listing.
  for (const name of listLocalAgentNames()) names.add(name);
  return [...names].sort();
}
