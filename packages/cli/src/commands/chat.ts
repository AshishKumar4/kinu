import { existsSync } from 'node:fs';
import * as readline from 'node:readline';
import { agentDbPath, resolveAgentRef } from '../config.js';
import { resolveAgentTarget } from '../agent-target.js';
import { createAgentClient } from '../client-factory.js';
import { runTuiChat } from '../tui/chat-app.js';
import { runChatLoop } from '../chat-loop.js';
import { ensureLocalDaemonRunning } from './daemon.js';
import { printError, ACCENT, DIM } from '../display.js';
import { listKnownAgents } from '../agent-list.js';
import { runHomeTui } from '../tui/home-app.js';

export async function chatCommand(name: string | undefined, opts: {
  model?: string; baseUrl?: string; auth?: string; classic?: boolean; initialPrompt?: string;
  continue?: boolean; resume?: boolean; session?: string; sessionDir?: string; noSession?: boolean; fork?: string;
}): Promise<void> {
  // No name: let user pick from existing agents
  if (!name) {
    if (!opts.classic && process.stdin.isTTY && process.stdout.isTTY) {
      const action = await runHomeTui(opts);
      if (action.type === 'open-agent') {
        await chatCommand(action.name, { ...opts, initialPrompt: action.initialPrompt });
      }
      return;
    }
    const agents = listKnownAgents();
    if (agents.length === 0) {
      printError('No agents found.', 'Run proteus in a terminal to create one from a mission.');
      process.exit(1);
    }
    if (agents.length === 1) {
      name = agents[0]!.name;
    } else {
      console.log(`\n${DIM('Select an agent:')}`);
      agents.forEach((a, i) => console.log(`  ${ACCENT(String(i + 1))} ${a.label}`));
      console.log('');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>(resolve => rl.question(`${DIM('Agent #: ')}`, resolve));
      rl.close();
      const idx = parseInt(answer, 10) - 1;
      if (idx < 0 || idx >= agents.length) {
        printError('Invalid selection.');
        process.exit(1);
      }
      name = agents[idx]!.name;
    }
  }

  if (!resolveAgentRef(name) && !existsSync(agentDbPath(name))) {
    printError(`Agent "${name}" not found.`, `Create it with: proteus create ${name}`);
    process.exit(1);
  }

  const target = resolveAgentTarget(name);
  if (target.mode === 'local') ensureLocalDaemonRunning();
  const client = createAgentClient(target, opts);
  const hydrateHistory = target.mode === 'cloud'
    ? !opts.initialPrompt
    : Boolean(opts.session || opts.continue || opts.resume || opts.fork);

  if (opts.classic || !process.stdin.isTTY || !process.stdout.isTTY) {
    await runChatLoop({ client, initialPrompt: opts.initialPrompt });
  } else {
    await runTuiChat({ client, hydrateHistory, initialPrompt: opts.initialPrompt });
  }
}
