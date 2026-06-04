import { existsSync, statSync } from 'node:fs';
import * as readline from 'node:readline';
import { Database } from 'bun:sqlite';
import { openAgentCLI } from '@proteus/cli-backend';
import { agentDbPath, listAgentDirs, resolveLLMConfig, resolveMcpServers } from '../config.js';
import { runTuiChat } from '../tui/chat-app.js';
import { runChatLoop } from '../chat-loop.js';
import { printError, ACCENT, DIM } from '../display.js';

export async function chatCommand(name: string | undefined, opts: {
  model?: string; baseUrl?: string; auth?: string; classic?: boolean;
}): Promise<void> {
  // No name: let user pick from existing agents
  if (!name) {
    const agents = listAgentDirs();
    if (agents.length === 0) {
      printError('No agents found.', 'Create one with: proteus create <name>');
      process.exit(1);
    }
    if (agents.length === 1) {
      name = agents[0]!;
    } else {
      console.log(`\n${DIM('Select an agent:')}`);
      agents.forEach((a, i) => console.log(`  ${ACCENT(String(i + 1))} ${a}`));
      console.log('');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>(resolve => rl.question(`${DIM('Agent #: ')}`, resolve));
      rl.close();
      const idx = parseInt(answer, 10) - 1;
      if (idx < 0 || idx >= agents.length) {
        printError('Invalid selection.');
        process.exit(1);
      }
      name = agents[idx]!;
    }
  }

  const dbPath = agentDbPath(name);
  if (!existsSync(dbPath)) {
    printError(`Agent "${name}" not found.`, `Create it with: proteus create ${name}`);
    process.exit(1);
  }

  const llmConfig = resolveLLMConfig(opts);
  const mcpServers = resolveMcpServers();
  const db = new Database(dbPath);
  const { rt, info } = openAgentCLI(db, dbPath, { llm: llmConfig });
  const dbSize = statSync(dbPath).size;
  const refreshInfo = () => openAgentCLI(db, dbPath, { llm: llmConfig }).info;

  // Use TUI by default, fall back to classic readline with --classic flag
  // or when stdin is not a TTY (piped input)
  if (opts.classic || !process.stdin.isTTY) {
    await runChatLoop({ rt, db, info, dbSize, llmConfig, refreshInfo, mcpServers });
  } else {
    await runTuiChat({ rt, db, info, dbSize, llmConfig, refreshInfo, noAutoEvolve: false, mcpServers });
  }
  db.close();
}
