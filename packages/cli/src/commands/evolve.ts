import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { runMCTS, type SearchNode } from '@proteus/core';
import type { AgentRuntime, SessionWriter, SessionMessage } from '@proteus/core';
import { openAgentCLI } from '@proteus/cli-backend';
import { CONFIG_PATH, agentDbPath, createCodexAuthStore, resolveAgentRef, resolveLLMConfig, resolveProviderCredentials } from '../config.js';
import {
  printSearchTree, printError, createSpinner,
  BRAND, DIM, OK, WARN, ACCENT, MUTED,
} from '../display.js';

export async function evolveCommand(name: string, opts: {
  budget?: string; branches?: string; model?: string; baseUrl?: string; auth?: string;
}): Promise<void> {
  const configured = resolveAgentRef(name);
  if (configured?.mode === 'cloud') {
    console.log(`\n${DIM('Cloud agent evolution runs in the Durable Object backend after turns.')}`);
    console.log(`${DIM('Use:')} ${ACCENT(`proteus run ${configured.name} "improve yourself"`)}\n`);
    return;
  }
  name = configured?.localName ?? configured?.name ?? name;
  const dbPath = agentDbPath(name);
  if (!existsSync(dbPath)) {
    printError(`Agent "${name}" not found.`, `Create it with: proteus create ${name}`);
    process.exit(1);
  }

  const budget = parseInt(opts.budget ?? '2', 10);
  const branches = parseInt(opts.branches ?? '2', 10);
  const llmConfig = resolveLLMConfig(opts);
  const codexAuthStore = createCodexAuthStore();
  const db = new Database(dbPath);
  const { rt, info } = openAgentCLI(db, dbPath, {
    llm: llmConfig,
    providerCredentials: resolveProviderCredentials(),
    codexAuthStore,
    codexConfigPath: CONFIG_PATH,
  });

  console.log('');
  console.log(`${BRAND} ${DIM('— Evolution')}`);
  console.log(`  ${DIM('Agent:')}    ${ACCENT(name)}`);
  console.log(`  ${DIM('Budget:')}   ${budget} iterations, ${branches} branches`);
  console.log(`  ${DIM('Mission:')}  ${info.purpose.slice(0, 60)}`);
  console.log('');

  const session = createEvolveSession(rt);

  const task = `Given my purpose: "${info.purpose}", identify one specific improvement I could make ` +
    `to be more effective. Consider: new tools I could learn, knowledge gaps, or workflow improvements.`;

  const spinner = createSpinner('Running MCTS exploration...');
  spinner.start();

  try {
    const result = await runMCTS(rt, session, task, { budget, branches, maxCostUSD: 5 });
    spinner.stop('Exploration complete');

    const nodes = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes ORDER BY depth, created_at`;
    printSearchTree(nodes);

    if (result.converged) {
      console.log(`${OK('✓')} Converged — winner score: ${ACCENT(result.winnerValue.toFixed(3))}`);
    } else {
      console.log(`${WARN('○')} Did not converge — best score: ${ACCENT(result.winnerValue.toFixed(3))}`);
    }

    const memory = await rt.memory.read('memory/MEMORY.md');
    if (memory?.includes('Failure lesson') || memory?.includes('Successful approach')) {
      console.log(DIM('  Reflections stored in memory.'));
    }

    const tools = rt.craftStore.list();
    if (tools.length > 0) {
      console.log(DIM(`\n  Crafted tools: ${tools.length}`));
      for (const t of tools) {
        console.log(`    ${ACCENT(t.name)} ${DIM('—')} ${MUTED(t.description.slice(0, 50))}`);
      }
    }
  } catch (err) {
    spinner.fail('Evolution failed');
    printError((err as Error).message);
  }

  console.log('');
  db.close();
}

function createEvolveSession(rt: AgentRuntime): SessionWriter {
  const messages: Array<{ id: string; parentId?: string | null; role: string; content: string }> = [];
  return {
    async appendMessage(msg: SessionMessage, parentId?: string | null) {
      const content = msg.parts.map(p => p.text).join('');
      messages.push({ id: msg.id, parentId, role: msg.role, content });
      rt.storage.sql`INSERT INTO messages (id, session_id, parent_id, role, content)
        VALUES (${msg.id}, ${'evolve'}, ${parentId ?? null}, ${msg.role}, ${content})`;
    },
    getHistory(leafId?: string | null) {
      if (!leafId) return messages.map(m => ({ role: m.role, content: m.content }));
      const result: Array<{ role: string; content: string }> = [];
      let current = messages.find(m => m.id === leafId);
      while (current) {
        result.unshift({ role: current.role, content: current.content });
        current = current.parentId ? messages.find(m => m.id === current!.parentId) : undefined;
      }
      return result;
    },
    async compact() {},
  };
}
