import { existsSync } from 'node:fs';
import * as readline from 'node:readline';
import {
  agentDbPath,
  requireAuthConfig,
  resolveAgentRef,
} from '../config.js';
import { createDefaultTuiSession, runTuiChat } from '../tui/chat-app.js';
import { runChatLoop } from '../chat-loop.js';
import { ensureLocalDaemonRunning } from './daemon.js';
import { printError, ACCENT, DIM } from '../display.js';
import { runCloudChatLoop } from '../cloud-chat-loop.js';
import { runCloudTuiChat } from '../tui/cloud-chat-app.js';
import { createCliSession } from '../session.js';
import { listKnownAgents } from '../agent-list.js';
import { runHomeTui } from '../tui/home-app.js';
import { openLocalTuiAgent } from '../tui/local-agent.js';

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

  const configured = name ? resolveAgentRef(name) : null;
  if (configured?.mode === 'cloud') {
    const auth = requireAuthConfig();
    const session = createCliSession(configured.name, opts);
    const cloudOpts = {
      origin: auth.origin,
      token: auth.token,
      agentName: configured.name,
      cloudName: configured.cloudName ?? configured.name,
      session,
      sessionOptions: opts,
      hydrateTranscript: Boolean(opts.session || opts.continue || opts.resume || opts.fork),
      initialPrompt: opts.initialPrompt,
      model: opts.model,
      baseUrl: opts.baseUrl,
      auth: opts.auth,
    };
    if (opts.classic || !process.stdin.isTTY || !process.stdout.isTTY) await runCloudChatLoop(cloudOpts);
    else await runCloudTuiChat(cloudOpts);
    return;
  }
  if (configured?.mode === 'local') name = configured.localName ?? configured.name;

  const dbPath = agentDbPath(name);
  if (!existsSync(dbPath)) {
    printError(`Agent "${name}" not found.`, `Create it with: proteus create ${name}`);
    process.exit(1);
  }

  ensureLocalDaemonRunning();
  const local = openLocalTuiAgent(name, opts);

  // Use TUI by default, fall back to classic readline with --classic flag
  // or when stdin is not a TTY (piped input)
  const session = createDefaultTuiSession(name, opts);
  if (opts.classic || !process.stdin.isTTY) {
    await runChatLoop({ ...local, ...session });
  } else {
    await runTuiChat({
      ...local,
      ...session,
      sessionOptions: opts,
      hydrateTranscript: Boolean(opts.session || opts.continue || opts.resume || opts.fork),
      initialPrompt: opts.initialPrompt,
    });
  }
  local.close();
}
