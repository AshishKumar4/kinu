// Turns no HTTP request opens (an email, a timer) still reach the owner's MCP tools. The HTTP first-hit warm is per
// Worker isolate, so a settled turn warms the connections the next turn needs; a cold UserDO offers no tool before
// that. The flow drives two emails and a timer through a cold workspace whose first warm fails, and follows the tool
// from absent to called.
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { mcpToolKey } from '@kinu.run/core';
import { createRecordingLogger } from '@kinu.run/core/obs';
import { scriptedTurnModel, type ScriptedTurnResult } from '@kinu.run/test-utils';
import {
  chatSessionTurns, fireSoonestWake, improvementLanesRan, nextTurn, orchestratorHarness, tapDiagnostics, until, type RecordedUserPlaneCalls,
} from './helpers/actor-harness';

const KEY = mcpToolKey('tracker', 'find_issue');

afterEach(() => { setSystemTime(); });

const USAGE = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

const said = (text: string): ScriptedTurnResult => ({ content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: undefined }, usage: USAGE, warnings: [] });

test('an email and a timer turn reach the owner\'s MCP tool once a settled turn has warmed it, a failed warm retried', async () => {
  const mcp: NonNullable<RecordedUserPlaneCalls['mcp']> = {
    descriptors: [{
      serverId: 'srv-1', serverName: 'tracker', name: 'find_issue', toolKey: KEY,
      description: 'Find an issue by title.', readOnly: true,
      inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    }],
    calls: [],
    answer: { id: 'ISSUE-7' },
    cold: true,
  };

  const userPlane: RecordedUserPlaneCalls = {
    warmConnections: [], failWarm: new Error('the MCP server refused the connection'), titles: [], profile: { email: 'owner@example.com' }, mcp,
  };

  const { agent, db } = orchestratorHarness(userPlane, { email: { send: async () => ({ messageId: 'receipt' }) } });

  agent.harnessHoldsCapability('harness-token');

  // Each turn's first request says whether the tool was offered; an offered tool is called once through `eval`.
  const offered: boolean[] = [];
  const results: string[] = [];

  agent.modelFactory = () => scriptedTurnModel({ doGenerate: (options) => {
    const prompt = JSON.stringify(options.prompt);
    const answered = options.prompt.some((message) => message.role === 'tool');

    if (answered) {
      results.push(...options.prompt.flatMap((message) => (message.role === 'tool' ? message.content.map((part) => JSON.stringify(part)) : [])));

      return said('found it');
    }

    offered.push(prompt.includes(`tools[\\"${KEY}\\"]`));

    if (!prompt.includes(`tools[\\"${KEY}\\"]`)) return said('no tracker to ask');

    return {
      content: [{ type: 'tool-call', toolCallId: 'find', toolName: 'eval', input: JSON.stringify({ code: `return await tools[${JSON.stringify(KEY)}]({ title: 'login' });` }) }],
      finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE, warnings: [],
    };
  } });

  const logger = createRecordingLogger();
  const restore = tapDiagnostics(logger);
  const settled = () => db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM terminal_effects WHERE status != 'completed'`).get()?.n === 0;

  const email = async (n: number) => {
    await agent.acceptEmailDelivery({
      from: 'owner@example.com', to: 'workspace@kinu.run', subject: `issue ${String(n)}`, body_text: 'find the login issue',
      message_id: `<m-${String(n)}@example.com>`, in_reply_to: null, references: null, attachments: [], now: Date.now(),
    });
    await fireSoonestWake(agent, db);
    await until(() => offered.length >= n && settled(), `turn ${String(n)} settled`);
  };

  // A timer turn is opened by no request at all; it needs no owner address, so it runs unprovisioned too.
  const timer = async (n: number) => {
    await agent.createTimerTrigger({ atMs: Date.now() + 1000, label: 'check the tracker' });

    // Wakes fire soonest first; the timer's is among the next few.
    for (let fired = 0; fired < 4 && offered.length < n; fired++) {
      await fireSoonestWake(agent, db);
      await nextTurn();
    }

    await until(() => offered.length >= n && settled(), `turn ${String(n)} settled`);
  };

  try {
    // Cold: no tool; its settle tries the warm, which fails.
    await email(1);
    await until(() => logger.emitted.some((line) => line.event === 'mcp.settle_warmup_failed'), 'the first warm failed');

    // Still cold; its settle retries the warm, which now lands. Nothing recorded the failure: the connection is the state.
    userPlane.failWarm = null;
    await email(2);
    await until(() => mcp.cold === false, 'the second warm connected');

    // Warmed: the next timer turn is offered the tool and calls it.
    await timer(3);
    await until(() => mcp.calls.length > 0 && results.length > 0, 'the timer turn called the tool');
  } finally {
    restore();
  }

  expect({
    offered,
    // Each asks with this workspace's own token, as the production caller resolves it.
    callers: [...new Set(userPlane.warmConnections.map((caller) => JSON.stringify(caller)))],
    calls: mcp.calls,
    answered: results.some((result) => result.includes('ISSUE-7')),
  }).toEqual({
    offered: [false, false, true],
    callers: [JSON.stringify({ workspaceToken: 'harness-token' })],
    calls: [{ tool: 'find_issue', args: { title: 'login' } }],
    answered: true,
  });
});

// Plan and aborted turns return before the improvement lanes, so the warm is scheduled ahead of that verdict. A
// workspace not yet issued a capability token is an ordinary state: it asks the hub nothing and reports nothing.
test('every settled turn warms the next one\'s connections, whatever its outcome, once the workspace is provisioned', async () => {
  const warmed: Record<string, number> = {};
  const failures: string[] = [];
  const logger = createRecordingLogger();
  const restore = tapDiagnostics(logger);

  for (const outcome of ['completed', 'aborted', 'plan', 'unprovisioned'] as const) {
    const userPlane: RecordedUserPlaneCalls = { warmConnections: [], failWarm: null, titles: [] };
    const { agent, db } = orchestratorHarness(userPlane);

    if (outcome === 'unprovisioned') agent.harnessHoldsNoCapability();
    else agent.harnessHoldsCapability('harness-token');

    if (outcome === 'plan') agent.harnessDrivingUserMessage('Plan it first.', { kinuMode: 'plan' });

    const { messageId } = await chatSessionTurns(agent).settle(outcome === 'aborted'
      ? { messageId: `t-${outcome}`, status: 'aborted' }
      : { messageId: `t-${outcome}`, text: 'done' });

    if (outcome === 'completed') await until(() => improvementLanesRan(db, messageId), 'the improvement lanes ran');
    await nextTurn();
    warmed[outcome] = userPlane.warmConnections.length;
  }

  restore();
  failures.push(...logger.emitted.filter((line) => line.event === 'mcp.settle_warmup_failed').map((line) => line.event));
  expect({ warmed, failures }).toEqual({ warmed: { completed: 1, aborted: 1, plan: 1, unprovisioned: 0 }, failures: [] });
});
