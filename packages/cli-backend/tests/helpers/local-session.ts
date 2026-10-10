import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { expect } from 'bun:test';
import { AwaitedList, createTestActorsOver, createTestSql, readTranscriptRows, scratchPath, type HandClock, type TranscriptRow, scratchDir, workspaceDatabase } from '@kinu.run/test-utils';
import { MissionGovernor } from '@kinu.run/core';
import { initWorkspaceSchema } from '@kinu.run/core';
import { Database } from 'bun:sqlite';
import { type LanguageModel } from 'ai';
import { TestLanguageModelV2 } from '../test-language-model';
import type { LanguageModelV2CallOptions, LanguageModelV2Usage, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import type { LLMProviderConfig } from '@kinu.run/core';
import {
  CHAT_SESSION_ID, profileCatalogDigest, EventLog, TriggerRegistry, listTriggers, type JsonObject, type ProfileCatalogEnvelope, type EventVariant, openWorkspaceMainActor, workspaceSkillPath, WORKSPACE_SKILLS_DIR,
} from '@kinu.run/core';
import { createCLIRuntime, makeSql, makeSqlExec, type CLIRuntime, makeWorkspaceSchemaSql } from '../../src/runtime';
import { LocalAgentSession, type LocalAgentSessionOpts, type SessionEvent } from '../../src/local-session';
import { type LocalModelResolver } from '../../src/model-resolver';
import {
  createLocalProfileAuthority, resolverModelPlane, staticModelPlane, type LocalProfileModelPlane, type ProfileEnvelopeSource,
} from '../../src/profile-authority';
import * as v from 'valibot';

export const resolverRest = {
  judgeCandidates: async () => [],
  getAuth: async () => null,
  attemptFor: async () => null,
  countInputTokens: async () => ({
    kind: 'unsupported' as const,
    provider: 'fake',
    reason: 'the fake resolver stands in for no provider endpoint',
  }),
};

export function namedSpec(spec?: string | null): string | undefined {
  const trimmed = spec?.trim();

  return trimmed === '' ? undefined : trimmed;
}

export const listLocalAB: LocalModelResolver['listModels'] = async () => ({
  models: [
    { provider: 'local', id: 'a', label: 'a', capabilities: ['streaming'] },
    { provider: 'local', id: 'b', label: 'b', capabilities: ['streaming'] },
  ],
  failures: [],
});

export function textStream(delta: string, usage: LanguageModelV2Usage): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'text-start', id: '0' });
      controller.enqueue({ type: 'text-delta', id: '0', delta });
      controller.enqueue({ type: 'text-end', id: '0' });
      controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
      controller.close();
    },
  });
}

/** A `fact` recall call that withholds its step boundary until `gate` settles: the window an interrupt lands in. */
export function gatedFactCallStream(
  toolCallId: string, gate: Promise<void>, usage: LanguageModelV2Usage,
): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream({
    async start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({
        type: 'tool-call', toolCallId, toolName: 'fact',
        input: JSON.stringify({ op: 'recall', key: 'probe' }),
      });
      await gate;
      controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
      controller.close();
    },
  });
}

export function abortableTextStream(
  id: string, delta: string, abortSignal?: AbortSignal,
): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'text-start', id });
      controller.enqueue({ type: 'text-delta', id, delta });
      abortSignal?.addEventListener('abort', () => {
        controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
    },
  });
}

export function tierAuthority(tierModel: () => string): () => ProfileCatalogEnvelope {
  return () => {
    const catalog = { roles: {}, tiers: { default: { model: tierModel() } } };

    return { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog };
  };
}

export function headStreamFrames(events: AwaitedList<SessionEvent>) {
  return events.items.flatMap((event) => event.type === 'broadcast' && event.event.type === 'head_stream'
    ? [v.parse(v.object({ headId: v.string(), kind: v.picklist(['text', 'reasoning']), delta: v.string() }), event.event)]
    : []);
}

/** A governor over its own scratch ledger; the ledger is actor-scoped, so the handle is required to read rows back. */
export function governorDeps() {
  const db = workspaceDatabase(scratchPath('workspace', 'agent.db'));

  return { actor: createTestActorsOver(db).main, storage: createTestSql() };
}

export const agentSelfRest = {
  proposeScaffold: async () => ({ ok: true }),
  listScaffoldVersions: async () => [],
  getQuality: async () => [],
  budget: new MissionGovernor(governorDeps()),
  armCompactNow: () => {},
};

export const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

export type PromptMessage = LanguageModelV2CallOptions['prompt'][number];

export function fakeModel(
  answer: string,
  usage: LanguageModelV2Usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
): TestLanguageModelV2 {
  const [a, b] = [answer.slice(0, answer.length >> 1), answer.slice(answer.length >> 1)];

  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doGenerate: async () => ({
      content: [{ type: 'text', text: answer }],
      finishReason: 'stop' as const,
      usage,
      response: { id: 'r', modelId: 'fake-model', timestamp: new Date() },
      warnings: [],
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: '0' });
          controller.enqueue({ type: 'text-delta', id: '0', delta: a });
          controller.enqueue({ type: 'text-delta', id: '0', delta: b });
          controller.enqueue({ type: 'text-end', id: '0' });
          controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
          controller.close();
        },
      }),
      response: { headers: {} },
    }),
  });
}

/** Non-streaming call never resolves: stand-in for a detached job that is alive and never settles. */
export function hangingModel(): LanguageModel {
  const base = fakeModel('unused');

  return new TestLanguageModelV2({
    provider: base.provider,
    modelId: base.modelId,
    // Both methods hang: every agent kind requests through the streaming path, so hanging only `doGenerate` hangs nothing.
    doStream: () => new Promise<never>(() => { /* never settles */ }),
    doGenerate: () => new Promise<never>(() => { /* never settles */ }),
  });
}

export function capturingModel(answer: string, sink: (toolNames: string[]) => void): LanguageModel {
  const base = fakeModel(answer);

  return new TestLanguageModelV2({
    provider: base.provider,
    modelId: base.modelId,
    doGenerate: base.doGenerate,
    doStream: async (options) => {
      sink((options.tools ?? []).map((t) => t.name));

      return base.doStream(options);
    },
  });
}

export function historyCapturingModel(answer: string, sink: (messages: PromptMessage[]) => void): LanguageModel {
  const base = fakeModel(answer);

  return new TestLanguageModelV2({
    provider: base.provider,
    modelId: base.modelId,
    doGenerate: base.doGenerate,
    doStream: async (options) => {
      sink(options.prompt);

      return base.doStream(options);
    },
  });
}

export function systemCapturingModel(answer: string, sink: (system: string) => void): TestLanguageModelV2 {
  const base = fakeModel(answer);

  return new TestLanguageModelV2({
    provider: base.provider,
    modelId: base.modelId,
    doGenerate: base.doGenerate,
    doStream: async (options) => {
      const system = options.prompt.find(
        (message): message is Extract<PromptMessage, { role: 'system' }> => message.role === 'system',
      );

      sink(system?.content ?? '');

      return base.doStream(options);
    },
  });
}

/** Workspace database and runtime; the only place the bun:sqlite handle is widened to the factory's parameter. */
export function workspaceRuntime() {
  const db = workspaceDatabase(scratchPath('local-session', 'agent.db'));
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });

  return { db, rt };
}

export function failAssistantEntryWrite(db: Database): void {
  db.exec(`CREATE TRIGGER fail_assistant_entry
    BEFORE INSERT ON conversation_entries
    WHEN NEW.role = 'assistant'
    BEGIN
      SELECT RAISE(FAIL, 'database disk image is malformed');
    END`);
}

export function transcript(rt: CLIRuntime, sessionId = CHAT_SESSION_ID): Promise<TranscriptRow[]> {
  return readTranscriptRows(rt.storage.sql, rt.actor, rt.storage.vfs, sessionId);
}

/** The catalog a fresh local workspace bootstraps, with "Beta: swarms" on: the session suites pin the tool as it
 *  stands, as the cf harness does; a suite passes its own `profileAuthority` to turn it off. */
export function swarmsOn(rt: CLIRuntime, plane: LocalProfileModelPlane): ProfileEnvelopeSource {
  const bootstrap = createLocalProfileAuthority({ config: rt.actor.config, plane });

  return async () => {
    const catalog = { ...(await bootstrap.envelope()).catalog, betaSwarms: true };

    return { authority: { kind: 'local' }, version: 0, digest: profileCatalogDigest(catalog), catalog };
  };
}

export function setup(answer = 'hello there', model?: LanguageModel, extra?: Partial<LocalAgentSessionOpts>) {
  const { db, rt } = workspaceRuntime();
  const events = new AwaitedList<SessionEvent>();

  rt.actor.config.setLearning(false);

  const session = new LocalAgentSession({
    rt, db, model: model ?? fakeModel(answer), onEvent: (event) => events.push(event),
    profileAuthority: swarmsOn(rt, staticModelPlane()),
    ...extra,
  });

  return { db, rt, session, events };
}

/** The events hub read over a second handle, as the CLI's inspection reads it; a session exposes no log reader. */
export function hub(db: Database) {
  const sql = makeSqlExec(db);
  // Both rails are actor-scoped; reading without an actor returns an empty set, a false "nothing pending".
  const actor = openWorkspaceMainActor(makeSql(db));
  const log = new EventLog(sql, actor);

  return {
    pending: () => log.pending({ limit: 50 }),
    recent: (opts: { variant?: EventVariant; limit?: number }) => log.query(opts),
    triggers: () => listTriggers(new TriggerRegistry(sql, actor, { scheduleAt: async () => {} })).triggers,
  };
}

export async function fireTimer(session: LocalAgentSession, label: string, fireAt = Date.now() + 60_000) {
  await session.createTimerTrigger({ atMs: fireAt, label, trust: 'owner' });
  await session.fireDueTriggers(fireAt);
}

export function codemodeModel(code: string): LanguageModel {
  return toolSequenceModel([{ name: 'eval', input: { code } }]);
}

export function toolSequenceModel(
  calls: ReadonlyArray<{ name: string; input: JsonObject }>,
  seen?: (options: LanguageModelV2CallOptions) => void,
): TestLanguageModelV2 {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  let step = 0;

  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async (options) => {
      seen?.(options);

      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            const call = calls[step];
            step += 1;

            if (call) {
              controller.enqueue({
                type: 'tool-call',
                toolCallId: `call-${step}`,
                toolName: call.name,
                input: JSON.stringify(call.input),
              });
              controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
            } else {
              controller.enqueue({ type: 'text-start', id: '0' });
              controller.enqueue({ type: 'text-delta', id: '0', delta: 'done' });
              controller.enqueue({ type: 'text-end', id: '0' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
            }

            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
}

export function searchingModel(): LanguageModel {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  const base = fakeModel('head finding');
  let step = 0;

  return new TestLanguageModelV2({
    provider: base.provider,
    modelId: base.modelId,
    doGenerate: base.doGenerate,
    doStream: async () => {
      step += 1;

      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });

            if (step === 1) {
              controller.enqueue({
                type: 'tool-call', toolCallId: 'call-1', toolName: 'agents',
                input: JSON.stringify({
                  op: 'swarm', task: 'explore two angles',
                  preset: 'ideate', branches: 2, depth: 1,
                }),
              });
              controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
            } else {
              controller.enqueue({ type: 'text-start', id: '0' });
              controller.enqueue({ type: 'text-delta', id: '0', delta: 'done' });
              controller.enqueue({ type: 'text-end', id: '0' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
            }

            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
}

/** The owner's words that start a search, and the task its nodes get: kept apart so a node's request is told apart. */
export const SEARCH_ASK = 'Find two ways to speed up the parser.';

export const SEARCH_TASK = 'Name one way to make tokenizing faster.';

/** A single-part tool call, streamed as the provider streams one. */
export function toolCallStream(toolName: string, input: JsonObject, usage: LanguageModelV2Usage): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'tool-call', toolCallId: `${toolName}-0`, toolName, input: JSON.stringify(input) });
      controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
      controller.close();
    },
  });
}

/** The owner's turn starts a two-node search; each node runs `return 6 * 7;`, then answers. Records what nodes were sent. */
export function codingSearchModel() {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  const nodeCalls: LanguageModelV2CallOptions[] = [];

  const model = new TestLanguageModelV2({
    provider: 'fake', modelId: 'fake-model',
    doStream: async (options) => {
      const step = options.prompt.filter((message) => message.role === 'tool').length;

      if (JSON.stringify(options.prompt).includes(SEARCH_ASK)) {
        const stream = step === 0
          ? toolCallStream('agents', { op: 'swarm', task: SEARCH_TASK, preset: 'ideate', branches: 2, depth: 1 }, usage)
          : textStream('Searching.', usage);

        return { stream, response: { headers: {} } };
      }

      nodeCalls.push(options);
      const stream = step === 0 ? toolCallStream('eval', { code: 'return 6 * 7;' }, usage) : textStream('Computed.', usage);

      return { stream, response: { headers: {} } };
    },
  });

  return { model, nodeCalls };
}

export function setupWithResolver(
  resolver: LocalModelResolver,
  extra: Partial<LocalAgentSessionOpts> = {},
) {
  const { db, rt } = workspaceRuntime();
  const events = new AwaitedList<SessionEvent>();

  rt.actor.config.setLearning(false);

  const session = new LocalAgentSession({
    rt, db, model: fakeModel('fallback'), modelResolver: resolver,
    onEvent: (event) => events.push(event),
    profileAuthority: swarmsOn(rt, resolverModelPlane(resolver)),
    ...extra,
  });

  return { db, rt, session, events };
}

/** The session has begun waiting on its background fibers; the grace, if any, is armed by now. */
export function joining(events: AwaitedList<SessionEvent>): Promise<void> {
  return events.until((frames) => frames.some((e) => e.type === 'background' && e.event === 'bg_jobs_settling'));
}

/** The grace armed on `clock` holds through its last millisecond and fires on it. */
export function passGrace(clock: HandClock, graceMs: number): void {
  clock.advance(graceMs - 1);
  expect(clock.armed()).toBe(1);
  clock.advance(1);
  expect(clock.armed()).toBe(0);
}

export const SettleTimingsSchema = v.object({
  event: v.literal('session.settle_timings'),
  fields: v.object({ trackedMs: v.number() }),
});

/**
 * The `session.settle_timings` line `end()` emits. It is quiet under 1s (the --json stderr contract), so null means
 * the tail fit under the threshold; an unparseable line naming the event is a logger defect and throws.
 */
export async function captureSettleTimings(run: () => Promise<void>): Promise<{ trackedMs: number } | null> {
  const original = console.error;
  let timings: { trackedMs: number } | null = null;
  console.error = (...args: unknown[]) => {
    const line = v.safeParse(v.string(), args[0]);

    if (!line.success || !line.output.includes('"session.settle_timings"')) return;
    const parsed = v.parse(SettleTimingsSchema, JSON.parse(line.output));
    timings = { trackedMs: parsed.fields.trackedMs };
  };

  try {
    await run();
  } finally {
    console.error = original;
  }

  return timings;
}

export function jobColumn(db: Database, id: string, column: 'status' | 'error' | 'result'): string {
  const row = db.query<{ v: string | null }, [string]>(
    `SELECT ${column} v FROM background_jobs WHERE id=?`,
  ).get(id);

  return row?.v ?? '';
}

export const jobResult = (db: Database, id: string) => jobColumn(db, id, 'result');

export const kinds = (events: AwaitedList<SessionEvent>) => events.items.map((e) => e.type);

export const turnStarts = (events: AwaitedList<SessionEvent>) =>
  events.items.filter((e): e is Extract<SessionEvent, { type: 'turn-start' }> => e.type === 'turn-start');

export const steerStatuses = (events: AwaitedList<SessionEvent>) => events.items.flatMap((event) =>
  event.type === 'broadcast' && event.event.type === 'steer_status' ? [event.event] : []);

export function isDynamicBlock(text: string): boolean {
  return /^<dynamic_context fingerprint="[0-9a-f]{16}"(?: state="[0-9a-f]{16}")?>\n/.test(text)
    && text.endsWith('\n</dynamic_context>');
}

export function isWorkspaceInstructions(text: string): boolean {
  return text.startsWith('<workspace_instructions>\n')
    && text.endsWith('\n</workspace_instructions>');
}

export const FOCUSED_SKILL =
  '---\nname: focused\ndescription: a memory-only skill\nallowed_tools: [memory]\n---\nFocus on memory only.\n';

export const FOCUSED_PATH = workspaceSkillPath('focused');

/** Written where core names a workspace skill, its `vfs://` path in the space. */
export async function writeFocusedSkill(rt: CLIRuntime): Promise<void> {
  await rt.ownFiles.mkdir(`${WORKSPACE_SKILLS_DIR}/focused`, { recursive: true });
  await writeText(rt.ownFiles, FOCUSED_PATH, FOCUSED_SKILL);
}

export function messageText(message: PromptMessage): string {
  if (message.role === 'system') return message.content;

  return message.content
    .map((part) => part.type === 'text' || part.type === 'reasoning' ? part.text : JSON.stringify(part))
    .join('');
}

/** Completion gate model: one shell command, then an answer. On the gate's return, `confirmWith` 'text' re-asserts
 *  and 'tool' goes back to work. The gate triggers on what the turn did, and the harness reads the evidence. */
export function runThenAnswerModel(confirmWith: 'text' | 'tool' = 'text'): LanguageModel {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  let step = 0;

  const answer = (controller: ReadableStreamDefaultController, text: string) => {
    controller.enqueue({ type: 'text-start', id: '0' });
    controller.enqueue({ type: 'text-delta', id: '0', delta: text });
    controller.enqueue({ type: 'text-end', id: '0' });
    controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
  };

  const call = (controller: ReadableStreamDefaultController, id: string, command: string) => {
    controller.enqueue({ type: 'tool-call', toolCallId: id, toolName: 'shell', input: JSON.stringify({ command }) });
    controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
  };

  return new TestLanguageModelV2({
    provider: 'fake', modelId: 'fake-model',
    doStream: async () => {
      step += 1;
      const at = step;

      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });

            if (at === 1) call(controller, 'call-1', 'echo working > gate-proof.txt');
            else if (at === 2) answer(controller, 'all done, the task is complete');
            else if (at === 3 && confirmWith === 'tool') call(controller, 'call-2', 'echo fixing > gate-proof.txt');
            else answer(controller, 'confirmed');
            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
}

export const gateTurn = (events: AwaitedList<SessionEvent>) =>
  turnStarts(events).find((t) => t.event === 'completion_gate');