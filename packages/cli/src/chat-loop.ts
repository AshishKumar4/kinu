/**
 * Interactive chat REPL — uses the shared runChat() engine from @proteus/core.
 *
 * Streams text, displays tool calls inline, fires evolution hooks,
 * handles slash commands. Stores full CoreMessage history including
 * tool call/result messages for proper multi-turn context.
 */

import * as readline from 'node:readline';
import { type CoreMessage, type ToolSet } from 'ai';
import type { AgentRuntime, AgentInfo, SearchNode, LLMProviderConfig } from '@proteus/core';
import {
  EvolutionEngine,
  buildBuiltinTools,
  buildSystemPromptSync,
  createChatModel,
  runChat,
  resolveMaxSteps,
  type CompletedTurn,
  type ToolCallRecord,
} from '@proteus/core';
import { createNodeCraftedExecute, createNodeExecuteToolFactory } from '@proteus/cli-backend';
import {
  printChatBanner, printSlashHelp, printAgentStatus,
  printSearchTree, printToolCall, printToolResult,
  printEvolutionEvent, createTypingIndicator,
  ACCENT, DIM, MUTED, ERR, WARN,
} from './display.js';

export interface ChatLoopOpts {
  rt: AgentRuntime;
  info: AgentInfo;
  dbSize: number;
  llmConfig: LLMProviderConfig;
  refreshInfo: () => AgentInfo;
  noAutoEvolve?: boolean;
}

export async function runChatLoop(opts: ChatLoopOpts): Promise<void> {
  const { rt, dbSize, llmConfig, refreshInfo, noAutoEvolve } = opts;
  let info = opts.info;

  const model = createChatModel({
    kind: 'openai-compat',
    name: llmConfig.name,
    baseURL: llmConfig.baseURL,
    headers: llmConfig.headers,
    modelId: llmConfig.model,
  });

  const engine = new EvolutionEngine(rt, { enabled: !noAutoEvolve });
  engine.onEvent(event => printEvolutionEvent(event.type, event.message));

  // v2.0: same 5-tool surface as CF.
  // v2.1(B): craftedToolExecute supplies a Node-side compiler for crafted tools.
  // v2.1(E): createExecuteTool is the Node execute-tools factory — core no
  // longer ships an in-process fallback. A sentinel loader keeps the factory
  // branch active in buildBuiltinTools.
  const tools: ToolSet = buildBuiltinTools({
    rt,
    engine,
    craftedToolExecute: createNodeCraftedExecute(),
    createExecuteTool: createNodeExecuteToolFactory({
      vfs: rt.storage.vfs,
      memory: rt.memory,
      shell: rt.shell,
    }) as never,
    codemodeLoader: { __cli: true } as unknown,
  });

  printChatBanner(info, Object.keys(tools), !noAutoEvolve);

  const prompt = () => `${ACCENT(info.name)} ${DIM('›')} `;
  const rl = readline.createInterface({
    input: process.stdin, output: process.stdout, prompt: prompt(),
  });

  const sessionId = 'chat-' + Date.now();
  const sessionTurns: CompletedTurn[] = [];
  const sessionStart = Date.now();
  const history: CoreMessage[] = [];

  let exiting = false;
  const onExit = async () => {
    if (exiting) return;
    exiting = true;
    if (sessionTurns.length > 0) {
      try {
        // Await session evolution with a 5-second timeout so Ctrl+C doesn't hang
        await Promise.race([
          engine.onSessionComplete({
            sessionId, turns: sessionTurns, startedAt: sessionStart, endedAt: Date.now(),
          }),
          new Promise(resolve => setTimeout(resolve, 5000)),
        ]);
      } catch { /* best effort */ }
    }
    console.log(DIM('\n  Goodbye.\n'));
    rl.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void onExit());

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (!input) { rl.prompt(); continue; }

    if (input.startsWith('/')) {
      const result = await handleSlash(input, rt, info, dbSize, refreshInfo, tools);
      if (result === 'exit') { await onExit(); return; }
      if (result === 'refresh') info = refreshInfo();
      rl.prompt();
      continue;
    }

    const turnStart = Date.now();
    const knowledge = (await rt.memory.read('memory/MEMORY.md'))?.slice(0, 2000) ?? '';
    const executorNames = (rt.executionRouter?.listExecutors() ?? []).map(e => e.name);
    const systemPrompt = buildSystemPromptSync(rt, {
      extraKnowledge: knowledge || undefined,
      registeredExecutors: executorNames,
    });

    history.push({ role: 'user', content: input });

    const turnToolCalls: ToolCallRecord[] = [];
    let hadError = false;
    let fullText = '';
    let stepCount = 0;

    const typing = createTypingIndicator(info.name);
    typing.start();
    let headerPrinted = false;

    try {
      for await (const event of runChat({
        model,
        system: systemPrompt,
        history,
        tools,
        maxSteps: resolveMaxSteps(),
      })) {
        switch (event.type) {
          case 'text-delta':
            if (!headerPrinted) {
              typing.stop();
              process.stdout.write(`\n${ACCENT(info.name)} ${DIM('›')} `);
              headerPrinted = true;
            }
            process.stdout.write(event.delta);
            fullText += event.delta;
            break;

          case 'tool-call':
            typing.stop();
            printToolCall(event.toolName, event.args);
            turnToolCalls.push({ name: event.toolName, args: event.args, result: null });
            break;

          case 'tool-result': {
            printToolResult(event.result);
            const lastCall = turnToolCalls.findLast(tc => tc.name === event.toolName && tc.result === null);
            if (lastCall) lastCall.result = event.result;
            break;
          }

          case 'step-finish':
            stepCount++;
            break;

          case 'done':
            // Append the SDK's response messages to history (includes tool_call/result)
            for (const msg of event.responseMessages) {
              history.push(msg);
            }
            if (!fullText.trim() && event.text.trim()) {
              if (!headerPrinted) {
                typing.stop();
                process.stdout.write(`\n${ACCENT(info.name)} ${DIM('›')} `);
              }
              process.stdout.write(event.text.trim());
              fullText = event.text;
            }
            break;
        }
      }

      if (!headerPrinted) typing.stop();
      console.log('\n');

      // Store in DB
      const msgId = crypto.randomUUID();
      rt.storage.sql`INSERT INTO messages (id, session_id, role, content)
        VALUES (${msgId}, ${sessionId}, ${'user'}, ${input})`;
      rt.storage.sql`INSERT INTO messages (id, session_id, parent_id, role, content)
        VALUES (${crypto.randomUUID()}, ${sessionId}, ${msgId}, ${'assistant'}, ${fullText})`;

      const turn: CompletedTurn = {
        userMessage: input,
        assistantResponse: fullText,
        toolCalls: turnToolCalls,
        steps: stepCount,
        durationMs: Date.now() - turnStart,
        feedback: null,
        hadError,
      };
      sessionTurns.push(turn);
      await engine.onTurnComplete(turn);

    } catch (err) {
      typing.stop();
      hadError = true;
      console.log(`\n${ERR('error')} ${(err as Error).message}\n`);
    }

    rl.prompt();
  }
}

// ── Slash commands ────────────────────────────────────────────────

async function handleSlash(
  input: string, rt: AgentRuntime, info: AgentInfo, dbSize: number,
  refreshInfo: () => AgentInfo, tools: ToolSet,
): Promise<'exit' | 'refresh' | 'ok'> {
  const cmd = input.split(/\s+/)[0]!.toLowerCase();
  switch (cmd) {
    case '/exit': case '/quit': return 'exit';
    case '/status': printAgentStatus(refreshInfo(), dbSize); return 'refresh';
    case '/help': printSlashHelp(); return 'ok';
    case '/tools': {
      console.log(`\n${DIM('Built-in tools:')}`);
      for (const [name, t] of Object.entries(tools)) {
        console.log(`  ${ACCENT(name)} ${DIM('—')} ${(t as { description?: string }).description ?? ''}`);
      }
      const crafted = rt.craftStore.list();
      if (crafted.length > 0) {
        console.log(`\n${DIM('Crafted tools:')}`);
        for (const t of crafted) console.log(`  ${ACCENT(t.name)} ${DIM('—')} ${t.description.slice(0, 60)}`);
      }
      console.log('');
      return 'ok';
    }
    case '/memory': {
      const content = await rt.memory.read('memory/MEMORY.md');
      if (content) console.log(`\n${DIM('memory/MEMORY.md:')}\n${MUTED(content.slice(0, 1500))}\n`);
      else console.log(DIM('  Memory is empty.'));
      return 'ok';
    }
    case '/tree': {
      const nodes = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes ORDER BY depth, created_at`;
      printSearchTree(nodes);
      return 'ok';
    }
    default:
      console.log(WARN(`  Unknown command: ${cmd}. Type /help`));
      return 'ok';
  }
}
