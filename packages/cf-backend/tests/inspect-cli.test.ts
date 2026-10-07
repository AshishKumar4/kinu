/**
 * `kinu` inspecting a workspace, end to end: the real CLI reads the real orchestrator's answers over the route the CLI
 * calls, or a local workspace's database, and prints rows. Defends: an enveloped read left unformatted, an event row
 * carrying the fields that stay inside the workspace, and a timeline missing a turn's calls, failure or review.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as v from 'valibot';
import { initWorkspaceSchema } from '@kinu.run/core';
import { runToExit, scratchDir, scriptedTurnModel, workspaceDatabase, type ScriptedTurnOptions, type ScriptedTurnResult } from '@kinu.run/test-utils';
import { driveUntil, eventsOver, gatewayWorkspace, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';
import { LocalAgentSession } from '../../cli-backend/src/local-session';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../../cli-backend/src/runtime';

const CLI = resolve(import.meta.dir, '../../cli/bin/cli.ts');

const RpcSchema = v.object({ method: v.string(), args: v.array(v.unknown()) });

const LimitSchema = v.optional(v.number());

const FilterSchema = v.optional(v.object({ limit: v.optional(v.number()), variant: v.optional(v.string()), since: v.optional(v.number()) }));

const EventRowSchema = v.looseObject({ id: v.string(), variant: v.string(), ingress: v.string() });

/** The reads the inspect commands make, answered by the orchestrator itself. */
function answer(agent: HarnessOrchestratorAgent, method: string, args: readonly unknown[]): Promise<readonly object[]> {
  switch (method) {
    case 'listRecentEvents': return agent.listRecentEvents(v.parse(FilterSchema, args[0]));
    case 'getRunTimeline': return agent.getRunTimeline(v.parse(FilterSchema, args[0]));
    case 'getHeadRuns': return agent.getHeadRuns(v.parse(LimitSchema, args[0]));
    case 'getGepaRuns': return agent.getGepaRuns(v.parse(LimitSchema, args[0]));
    case 'getExecutors': return agent.getExecutors();
    default: return Promise.reject(new Error(`the fixture route serves no ${method}`));
  }
}

/** The turn both backends run: a file written, then one that is not there read, then an answer. */
const CALLS = [
  { tool: 'file', args: { action: 'write', path: 'notes/plan.md', content: 'ship it' } },
  { tool: 'file', args: { action: 'read', path: 'notes/missing.md' } },
] as const;

const TASK = 'Write the plan, then read the missing notes.';

/** The cloud workspace's model: each step calls the next of `CALLS`, counted by the tool results it has seen. */
const gateway = stubAiBinding((run) => {
  const step = requestOf(run).messages.filter((message) => message.role === 'tool').length;
  const call = CALLS[step];

  return call === undefined ? chatCompletion(run, 'Done.') : toolCallCompletion(run, call, `call-${String(step)}`);
});

/** The local workspace's model, on the same script. */
const local = scriptedTurnModel({ doGenerate: (options: ScriptedTurnOptions): ScriptedTurnResult => {
  const step = options.prompt.filter((message) => message.role === 'tool').length;
  const call = CALLS[step];
  const usage = { inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 3, text: 3, reasoning: undefined } };

  return call === undefined
    ? { content: [{ type: 'text', text: 'Done.' }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] }
    : { content: [{ type: 'tool-call', toolCallId: `call-${String(step)}`, toolName: call.tool, input: JSON.stringify(call.args) }], finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [] };
} });

let server: ReturnType<typeof Bun.serve> | undefined;

const home = scratchDir('inspect-cli-home');

/** Opens the local workspace `name` under `home` as a process would, sends `text` as its user, and closes it. */
async function localTurn(name: string, text: string): Promise<void> {
  mkdirSync(join(home, name), { recursive: true });
  const db = workspaceDatabase(join(home, name, 'agent.db'));
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { cwd: LOCAL_FOLDER, llm: { name: 'workers-ai', baseURL: 'http://127.0.0.1:9/v1', headers: {}, model: '@cf/zai-org/glm-5.3' } });
  const session = new LocalAgentSession({ rt, db, model: local, onEvent: () => {} });

  rt.actor.config.setLearning(true);

  try {
    await session.send(text, { id: crypto.randomUUID() });
    await session.settleBackgroundWork();
  } finally {
    await session.end();
    db.close();
  }
}

const LOCAL_FOLDER = scratchDir('inspect-cli-local-folder');

beforeAll(async () => {
  const workspace = gatewayWorkspace(gateway);
  const { agent, db } = workspace;
  const ended = (): number => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_events WHERE type = 'run_end'").get()?.n ?? 0;

  await workspace.started;
  await agent.runTaskFromMcp(TASK);
  await driveUntil(workspace, 'the cloud turn never ended', () => ended() > 0);
  await localTurn('localtest', TASK);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: { localtest: {
    name: 'localtest', mode: 'local', localName: 'localtest', cwd: LOCAL_FOLDER, workspaceId: 'localtest', createdAt: '', updatedAt: '',
  } }, aliases: {} }));

  eventsOver(db).publish({ descriptor: {
    ingress: 'chat_ws', variant: 'chat', payload: { text: 'a row to render' },
    operator_user_id: 'harness-owner', session_id: 'harness-session',
  }, now: 1_700_000_000_000 });

  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { method, args } = v.parse(RpcSchema, await request.json());

      return Response.json({ result: await answer(agent, method, args) });
    },
  });
});

afterAll(async () => { await server?.stop(true); });

function kinu(...args: string[]) {
  return runToExit([process.execPath, CLI, ...args], {
    cwd: scratchDir('inspect-cli-project'),
    env: { ...process.env, KINU_HOME: home, KINU_TOKEN: 'ptc_test', KINU_ORIGIN: `http://localhost:${String(server?.port)}` },
  });
}

describe('kinu inspecting a populated cloud workspace', () => {
  test('every list command prints the rows the orchestrator answers', async () => {
    for (const command of ['events', 'timeline', 'heads', 'gepa', 'executors']) {
      const run = await kinu(command, 'cloudtest');

      expect([command, run.exitCode, run.stderr]).toEqual([command, 0, '']);
    }

    expect((await kinu('events', 'cloudtest')).stdout).toContain('chat chat_ws');
  });

  test('the timeline after a working turn shows its trigger, each call, the failed one, its tokens and its evolution', async () => {
    const SpanSchema = v.looseObject({
      ts: v.number(), kind: v.string(), label: v.string(), source: v.string(), rawType: v.optional(v.string()),
      detail: v.optional(v.string()), elapsedMs: v.optional(v.number()),
    });

    const spans = v.parse(v.array(SpanSchema), JSON.parse((await kinu('timeline', 'cloudtest', '--json')).stdout));
    const of = (rawType: string) => spans.filter((span) => span.rawType === rawType);

    expect(spans.map((span) => span.ts)).toEqual(spans.map((span) => span.ts).sort((a, b) => a - b));
    expect(of('run_start')).toEqual([expect.objectContaining({ kind: 'trigger', detail: TASK })]);
    expect(of('tool_call_end').map((span) => [span.kind, span.label])).toEqual([['tool-call', 'file'], ['tool-call', 'file failed']]);
    expect(of('tool_call_end').every((span) => typeof span.elapsedMs === 'number')).toBe(true);
    expect(of('tool_call_end')[1]?.detail).toContain('ENOENT');
    expect(of('turn_end')[0]?.detail).toMatch(/^\d+ in \+ \d+ out tok$/u);
    expect(of('run_end').map((span) => span.label)).toEqual(['Run ended (completed)']);
    expect(of('turn_complete')).toEqual([expect.objectContaining({ kind: 'llm-turn', source: 'evolution', label: expect.stringContaining('2 tool calls') })]);

    const printed = await kinu('timeline', 'cloudtest');

    expect(printed.stdout).toContain('file failed');
    expect(printed.stdout).toContain('trigger');
  });

  // The local timeline lists its rows raw and newest first; the cloud's are core's spans, oldest first.
  test('a local workspace\'s timeline carries the same turn, and its review once the user answers', async () => {
    const RowSchema = v.looseObject({ kind: v.string(), ts: v.number(), payload: v.optional(v.unknown()), message: v.optional(v.string()) });
    const CallSchema = v.looseObject({ name: v.string(), outcome: v.looseObject({ success: v.boolean() }) });
    const timeline = async () => v.parse(v.array(RowSchema), JSON.parse((await kinu('timeline', 'localtest', '--json')).stdout));
    const rows = await timeline();

    expect(rows.map((row) => row.ts)).toEqual(rows.map((row) => row.ts).sort((a, b) => b - a));
    expect(rows.filter((row) => row.kind === 'run:run_start').map((row) => v.parse(v.looseObject({ userMessage: v.string() }), row.payload).userMessage)).toEqual([TASK]);
    // Newest first: the failed read, then the write.
    expect(rows.filter((row) => row.kind === 'run:tool_call_end').map((row) => v.parse(CallSchema, row.payload)).map((call) => [call.name, call.outcome.success]))
      .toEqual([['file', false], ['file', true]]);
    // A user's turn is rated by their next message, so it is reviewed then, not as it ends.
    expect(rows.filter((row) => row.kind.startsWith('evolution:'))).toEqual([]);
    await localTurn('localtest', 'Thanks.');

    expect((await timeline()).filter((row) => row.kind === 'evolution:turn_complete').map((row) => row.message))
      .toEqual([expect.stringMatching(/2 tool calls .* had errors/u)]);
  });

  test('an event row reaches the CLI without the fields that stay inside the workspace', async () => {
    const run = await kinu('events', 'cloudtest', '--json');
    const rows = v.parse(v.array(EventRowSchema), JSON.parse(run.stdout));

    expect(rows.map((row) => [row.variant, row.ingress])).toEqual([['chat', 'chat_ws']]);
    expect(rows.filter((row) => 'dedupe_key' in row || 'reply_channel' in row)).toEqual([]);
  });
});
