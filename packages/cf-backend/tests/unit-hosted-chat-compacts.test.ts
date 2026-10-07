/**
 * A hosted agent's chat runs the one ChatSession every actor's turns run on, so it compacts as the workspace's own chat
 * does: a turn its provider refuses as too long folds the agent's earlier turns and runs once more on the summary.
 * Before the hosted chat ran ChatSession in its own isolate, a hire's turns never compacted.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { actorConnectionTag } from '@kinu.run/core';
import { asPane } from './helpers/agents-sdk';
import { driveUntil, gatewayWorkspace } from './helpers/actor-harness';
import { chatCompletion, GATEWAY_MODEL, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';

const QUESTIONS = ['What does the parser read first?', 'Where are tokens buffered?', 'Which pass resolves names?', 'Summarize the fix plan.'];

/** The window the agent's model is listed with: its prompt and tools fit, three long answers on top do not. */
const WINDOW = 16_000;

/** About 1,500 tokens: three of them on top of the agent's prompt overrun {@link WINDOW}. */
const ANSWER = `The parser walks the token stream once, buffering lookahead in a ring. ${'It keeps every token it peeks at, in order. '.repeat(140)}`;

const TOO_LONG = { error: { message: `This model's maximum context length is ${WINDOW} tokens. However, your messages resulted in 17000 tokens.` } };

const textOf = (run: RecordedGatewayRun): string => JSON.stringify(requestOf(run).messages);

/** A compaction summarizer's ask: a turn or a prefix rolled into the fixed schema it names. */
const SUMMARY_ASK = /context replay|handoff summary/u;

/** What a fold keeps of the agent's long answers. */
const FOLDED = 'The parser reads the token stream once, with a lookahead ring.';

/** The schema the ask names, filled: its first section holds what the agent said, every other `(none)`. */
function filledSchema(ask: string): string {
  const headings = ask.split('\n').filter((line) => line.startsWith('## '));

  return headings.map((heading, index) => `${heading}\n- ${index === 0 ? FOLDED : '(none)'}`).join('\n\n');
}

test('a hosted chat refused as too long compacts its earlier turns and answers on the summary', async () => {
  const summaries: string[] = [];
  const last: string[] = [];
  let refused = 0;

  const gateway = stubAiBinding((run) => {
    const text = textOf(run);

    const ask = JSON.stringify(requestOf(run).messages[0]?.content ?? '');

    if (SUMMARY_ASK.test(ask)) {
      summaries.push(text);

      return chatCompletion(run, filledSchema(v.parse(v.string(), requestOf(run).messages[0]?.content)));
    }

    if (!text.includes(QUESTIONS[3] ?? '')) return chatCompletion(run, ANSWER);

    last.push(text);

    // Whichever way the fold comes (measured before the call, or forced by this refusal), the answer waits for it.
    if (!text.includes(FOLDED)) {
      refused += 1;

      return Response.json(TOO_LONG, { status: 400 });
    }

    return chatCompletion(run, 'Plan: buffer less, resolve names in the same pass.');
  });

  const workspace = gatewayWorkspace(gateway);

  workspace.agent.harnessCatalogModels({ [GATEWAY_MODEL]: { contextWindow: WINDOW } });
  await workspace.agent.setSoul('# Purpose\n\nExplain the parser.');
  // Added as the owner adds one, and chatted with in its own pane.
  const { subordinate } = await workspace.agent.createSubordinateAgent();
  const pane = [actorConnectionTag(subordinate.actorId ?? '')];

  for (const question of QUESTIONS) {
    await asPane(pane, () => workspace.agent.send(question, crypto.randomUUID()));
    await workspace.agent.harnessSettleDetached();
  }

  await driveUntil(workspace, 'the agent never answered on a folded history', () => last.some((text) => text.includes(FOLDED)));

  // The summarizer was asked over the agent's own earlier turns, and the answered request carries their summaries in
  // place of the long answers; a provider refusal is retried at most once.
  expect(summaries.length).toBeGreaterThan(0);
  const answered = last.find((text) => text.includes(FOLDED)) ?? '';

  expect(answered.length).toBeLessThan(Math.min(...last.filter((text) => !text.includes(FOLDED)).map((text) => text.length)));
  expect(refused).toBeLessThanOrEqual(1);
});

const HIRE_ASK = 'Have someone check the lexer.';

const HIRE_BRIEF = 'Check the lexer for stray tokens.';

const SEARCH_ASK = 'Search for a faster tokenizer.';

const SEARCH_TASK = 'Name one way to tokenize faster.';

const STILL = 'Are you still with me?';

/** Whether a request answers a tool call it made: its turn's next step. */
const answeredTool = (run: RecordedGatewayRun): boolean => requestOf(run).messages.at(-1)?.role === 'tool';

test("an added agent's chat compacts, hires, starts a search, and keeps answering", async () => {
  const nodes: string[] = [];
  const asked = { hire: 0, node: nodes, report: 0, still: 0 };
  let refused = 0;

  const gateway = stubAiBinding((run) => {
    const text = textOf(run);
    const ask = JSON.stringify(requestOf(run).messages[0]?.content ?? '');

    if (SUMMARY_ASK.test(ask)) return chatCompletion(run, filledSchema(v.parse(v.string(), requestOf(run).messages[0]?.content)));

    // The hire's own chat, and a swarm node's turn: each runs in its own isolate on the one assembly.
    if (text.includes(HIRE_BRIEF) && !text.includes(HIRE_ASK)) {
      asked.hire += 1;

      return chatCompletion(run, 'The lexer is clean.');
    }

    if (text.includes(SEARCH_TASK) && !text.includes(SEARCH_ASK)) {
      asked.node.push(text);

      return chatCompletion(run, 'Use a lookup table for single-byte tokens.');
    }

    if (text.includes('[subordinate_report]') && !answeredTool(run)) asked.report += 1;

    if (text.includes(STILL)) {
      asked.still += 1;

      return chatCompletion(run, 'Still here, with the lexer checked and the search running.');
    }

    if (text.includes(SEARCH_ASK) && !text.includes('swarm_0')) {
      return toolCallCompletion(run, { tool: 'agents', args: { action: 'swarm', task: SEARCH_TASK, preset: 'ideate', branches: 1, depth: 1 } }, 'swarm_0');
    }

    if (text.includes(HIRE_ASK) && !text.includes('hire_0')) {
      // The first ask overruns the window: the fold runs, and the retried turn hires.
      if (!text.includes(FOLDED)) {
        refused += 1;

        return Response.json(TOO_LONG, { status: 400 });
      }

      return toolCallCompletion(run, { tool: 'agents', args: { action: 'hire', role: 'task', mission: HIRE_BRIEF } }, 'hire_0');
    }

    return chatCompletion(run, answeredTool(run) ? 'Done.' : ANSWER);
  });

  const workspace = gatewayWorkspace(gateway);

  workspace.agent.harnessCatalogModels({ [GATEWAY_MODEL]: { contextWindow: WINDOW } });
  await workspace.agent.setSoul('# Purpose\n\nExplain and improve the parser.');
  const { subordinate } = await workspace.agent.createSubordinateAgent();
  const pane = [actorConnectionTag(subordinate.actorId ?? '')];

  const say = async (text: string): Promise<void> => {
    await asPane(pane, () => workspace.agent.send(text, crypto.randomUUID()));
    await workspace.agent.harnessSettleDetached();
  };

  for (const question of QUESTIONS.slice(0, 3)) await say(question);
  await say(HIRE_ASK);
  await driveUntil(workspace, "the hire's report never reached the agent", () => asked.report > 0);
  await say(SEARCH_ASK);
  await driveUntil(workspace, 'the search never ran its node', () => asked.node.length > 0);
  await say(STILL);
  await driveUntil(workspace, 'the agent stopped answering', () => asked.still > 0);

  expect(refused).toBe(1);
  expect(asked.hire).toBeGreaterThan(0);
  // The node starts with its task and the actor's own instructions, as every actor's turn is assembled.
  expect(asked.node[0]).toContain(SEARCH_TASK);
});
