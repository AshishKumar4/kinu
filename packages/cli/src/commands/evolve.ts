import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { runMCTS, DEFAULT_CONFIG, type MCTSProgressEvent, type SearchNode } from '@kinu/core';
import type { AgentRuntime, SessionWriter, SessionMessage } from '@kinu/core';
import { openWorkspaceCLI } from '@kinu/cli-backend';
import { CONFIG_PATH, agentDbPath, createCodexAuthStore, resolveAgentRef, resolveLLMConfig, resolveProviderCredentials } from '../config';
import {
  printSearchTree, printError, createSpinner,
  BRAND, DIM, OK, WARN, ACCENT, MUTED,
} from '../display';
import { renderThrownChain } from '@kinu/core/obs';

export async function evolveCommand(name: string, opts: {
  budget?: string; branches?: string; maxCost?: string; model?: string; baseUrl?: string; auth?: string;
}): Promise<void> {
  const configured = resolveAgentRef(name);
  if (configured?.mode === 'cloud') {
    console.log(`\n${DIM('Cloud workspace evolution runs in the Durable Object backend after turns.')}`);
    console.log(`${DIM('Use:')} ${ACCENT(`proteus run ${configured.name} "improve yourself"`)}\n`);
    return;
  }
  name = configured?.localName ?? configured?.name ?? name;
  const dbPath = agentDbPath(name);
  if (!existsSync(dbPath)) {
    printError(`Workspace "${name}" not found.`, `Create it with: proteus create ${name}`);
    process.exit(1);
  }

  // One set of defaults: the engine's (core DEFAULT_CONFIG.mcts). The CLI
  // used to half them silently — a weaker search than every other caller ran.
  const budget = opts.budget !== undefined ? parseInt(opts.budget, 10) : DEFAULT_CONFIG.mcts.budget;
  const branches = opts.branches !== undefined ? parseInt(opts.branches, 10) : DEFAULT_CONFIG.mcts.branches;
  const maxCostUSD = opts.maxCost !== undefined ? Number(opts.maxCost) : DEFAULT_CONFIG.mcts.maxCostUSD;
  const llmConfig = resolveLLMConfig(opts);
  const codexAuthStore = createCodexAuthStore();
  const db = new Database(dbPath);
  const { rt, info } = await openWorkspaceCLI(db, dbPath, {
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

  const spinner = createSpinner('Starting MCTS exploration...');
  spinner.start();

  // Failed branches score 0 by design (the engine's allSettled), so a run whose
  // model calls all failed still returns a number. Count them to qualify it.
  let failed = 0;

  try {
    const result = await runMCTS(rt, session, task, {
      budget, branches, maxCostUSD,
      onProgress: (event) => {
        if (event.type === 'branch-failed') failed++;
        const line = formatMctsProgress(event, budget);
        if (line.sink === 'status') spinner.update(line.text);
        else spinner.note(line.text);
      },
    });
    spinner.stop('Exploration complete');

    const nodes = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes ORDER BY depth, created_at`;
    printSearchTree(nodes);

    if (result.converged) {
      console.log(`${OK('✓')} Converged — winner score: ${ACCENT(result.winnerValue.toFixed(3))}`);
    } else {
      console.log(`${WARN('○')} Did not converge — best score: ${ACCENT(result.winnerValue.toFixed(3))}`);
    }
    if (failed > 0) {
      console.log(`${WARN('!')} ${plural(failed, 'branch failure')} — those branches scored 0, so this result understates the ideas.`);
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
    printError(
      renderThrownChain({ cause: err }),
      failed > 0
        ? `${plural(failed, 'branch failure')} preceded it — see the lines above.`
        : undefined,
    );
    process.exitCode = 1;
  }

  console.log('');
  db.close();
}

interface ProgressLine {
  /** `status` replaces the live spinner text; `log` stays in the scrollback. */
  sink: 'status' | 'log';
  text: string;
}

const PHASE_LABEL = {
  explore: 'exploring',
  evaluate: 'evaluating',
  reflect: 'reflecting on',
} as const;

/** Render one search event for the terminal. Pure — the sink decides where it goes. */
export function formatMctsProgress(event: MCTSProgressEvent, totalBudget: number): ProgressLine {
  switch (event.type) {
    case 'phase':
      return {
        sink: 'status',
        text: `${iterationTag(event.iteration, totalBudget)} ${PHASE_LABEL[event.phase]} ${plural(event.branches, 'branch', 'branches')}...`,
      };
    case 'branch-failed':
      return {
        sink: 'log',
        text: `  ${WARN('!')} ${iterationTag(event.iteration, totalBudget)} branch ${MUTED(event.branchId)} ` +
          `${DIM(`(${event.stage})`)} ${event.error}`,
      };
    case 'grounding-unavailable':
      return {
        sink: 'log',
        text: `  ${WARN('!')} ${iterationTag(event.iteration, totalBudget)} cannot run ${event.language}; ` +
          `score is unverified ${DIM(`(runnable: ${event.canRun.join(', ')})`)}`,
      };
    case 'iteration-complete':
      return {
        sink: 'log',
        text: `  ${OK('•')} ${iterationTag(event.iteration, totalBudget)} done ` +
          DIM(`scores ${event.scores.map(s => s.toFixed(2)).join(', ')}`),
      };
  }
}

function iterationTag(current: number, total: number): string {
  return DIM(`[${current}/${total}]`);
}

function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

function createEvolveSession(rt: AgentRuntime): SessionWriter {
  const messages: Array<{ id: string; parentId?: string | null; role: string; content: string }> = [];
  return {
    async appendMessage(msg: SessionMessage, parentId?: string | null) {
      const content = msg.parts.map(p => p.text).join('');
      messages.push({ id: msg.id, parentId, role: msg.role, content });
      void rt.storage.sql`INSERT INTO messages (id, session_id, parent_id, role, content)
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
  };
}
