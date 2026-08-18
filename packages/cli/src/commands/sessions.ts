import { existsSync } from 'node:fs';
import { resolveAgentRef, agentDbPath, loadConfigFile, listAgentDirs } from '../config';
import { ACCENT, DIM, OK, WARN } from '../display';
import { exportSessionPath, listCliSessions } from '../session';

export async function sessionsCommand(agentName: string | undefined, opts: {
  sessionDir?: string;
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
      const path = exportSessionPath(name, opts.show, opts);
      if (!path) {
        console.log(WARN('  Session not found.'));
      } else {
        console.log(opts.path ? path : `${OK('session')} ${ACCENT(opts.show)} ${DIM(path)}`);
      }
      continue;
    }

    const sessions = listCliSessions(name, opts);
    if (sessions.length === 0) {
      console.log(DIM('  No sessions recorded yet.'));
      continue;
    }
    for (const s of sessions.slice(0, 30)) {
      const label = s.name ? `${s.id} ${DIM(`"${s.name}"`)}` : s.id;
      const first = s.firstUserText ? ` ${DIM('-')} ${s.firstUserText.replace(/\s+/g, ' ')}` : '';
      const pathText = opts.path ? ` ${DIM(s.path)}` : '';
      console.log(`  ${ACCENT(label)} ${DIM(`${s.entries} entries`)}${first}${pathText}`);
    }
    if (sessions.length > 30) console.log(DIM(`  … and ${sessions.length - 30} more`));
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
  for (const name of listAgentDirs()) {
    if (existsSync(agentDbPath(name))) names.add(name);
  }
  return [...names].sort();
}
