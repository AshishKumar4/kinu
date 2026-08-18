import { existsSync } from 'node:fs';
import { agentDbPath, resolveAgentRef } from '../config';
import { resolveAgentTarget } from '../agent-target';
import { createAgentClient } from '../client-factory';
import { runChatLoop } from '../chat-loop';
import { ensureLocalDaemonRunning } from './daemon';
import { printError, ACCENT, DIM } from '../display';
import { listKnownAgents } from '../agent-list';
import { ask } from '../prompt';

export async function chatCommand(name: string | undefined, opts: {
  model?: string; baseUrl?: string; auth?: string; classic?: boolean;
  continue?: boolean; resume?: boolean; session?: string; sessionDir?: string; noSession?: boolean; fork?: string;
}): Promise<void> {
  // No name: let user pick from existing agents
  if (!name) {
    if (!opts.classic && process.stdin.isTTY && process.stdout.isTTY) {
      // Lazy: opentui captures the terminal — it must never load on
      // non-TUI command paths (e.g. the installer's setup prompts).
      const { runHomeTui } = await import('../tui/home-app');
      const action = await runHomeTui(opts);
      if (action.type === 'open-agent') await chatCommand(action.name, opts);
      return;
    }
    const agents = listKnownAgents();
    if (agents.length === 0) {
      printError('No workspaces found.', 'Run proteus in a terminal to create one from a mission.');
      process.exit(1);
    }
    if (agents.length === 1) {
      name = agents[0]!.name;
    } else {
      console.log(`\n${DIM('Select a workspace:')}`);
      agents.forEach((a, i) => console.log(`  ${ACCENT(String(i + 1))} ${a.label}`));
      console.log('');
      const answer = await ask('Workspace #');
      const idx = parseInt(answer, 10) - 1;
      if (idx < 0 || idx >= agents.length) {
        printError('Invalid selection.');
        process.exit(1);
      }
      name = agents[idx]!.name;
    }
  }

  if (!resolveAgentRef(name) && !existsSync(agentDbPath(name))) {
    printError(`Workspace "${name}" not found.`, `Create it with: proteus create ${name}`);
    process.exit(1);
  }

  const target = resolveAgentTarget(name);
  if (target.mode === 'local') ensureLocalDaemonRunning();
  const client = await createAgentClient(target, opts);
  // A cloud workspace keeps its transcript server-side, so opening one always
  // replays it; a local one replays only the recorded session you asked for.
  const hydrateHistory = target.mode === 'cloud'
    || Boolean(opts.session || opts.continue || opts.resume || opts.fork);

  if (opts.classic || !process.stdin.isTTY || !process.stdout.isTTY) {
    await runChatLoop({ client });
  } else {
    const { runTuiChat } = await import('../tui/chat-app');
    await runTuiChat({ client, hydrateHistory });
  }
}
