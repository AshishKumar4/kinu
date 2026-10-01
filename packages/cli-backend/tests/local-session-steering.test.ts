import { exists, readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
// LocalAgentSession over the real CLI runtime and a fake model: steering, durable sends, branches and the run-event log.
import { describe, test, expect } from 'bun:test';
import { present, scratchDir, scratchPath, toolExecute, scriptedTurnModel, unobservedSearchSeams } from '@kinu.run/test-utils';
import { KinuError } from '@kinu.run/core/obs';
import { agentAffinityKey, initWorkspaceSchema } from '@kinu.run/core';
import { Database } from 'bun:sqlite';
import { APICallError } from 'ai';
import type { ToolExecutionOptions } from 'ai';
import { TestLanguageModelV2 } from './test-language-model';
import type { LanguageModelV2CallOptions, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { inWorkMode } from '@kinu.run/core';
import {
  DEFAULT_WORKERS_AI_MODEL_ID, DEFAULT_WORKERS_AI_MODEL_SPEC, createAgentsCodemodeProvider, initAlternateTakesTable, recordBranchTakeSet, CHAT_SESSION_ID, JsonObjectSchema, WORKSPACE_RUN_ID, usageTotal, profileCatalogDigest, BUILTIN_ROLE_DEFINITIONS, STEER_METADATA_KEY, STEER_STEP_METADATA_KEY, type AgentsToolDeps, type JsonObject, type JsonValue, type ModelCallSink, type ProfileCatalogEnvelope, defaultLoopOrigin, MergeOutputSchema, SWARM_PRESET_DOCTRINE,
} from '@kinu.run/core';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import { cloudProxyBaseURL, createLocalModelResolver, type LocalModelResolver } from '../src/model-resolver';
import { createNodeCodemodeToolFactory } from '../src/codemode-tool-factory';
import { nodeSeatFactory } from './actor-fixture';
import * as v from 'valibot';
import { recordSessionEvent, resolverRest, namedSpec, textStream, gatedFactCallStream, abortableTextStream, headStreamFrames, DUMMY_LLM, type PromptMessage, fakeModel, historyCapturingModel, systemCapturingModel, workspaceRuntime, failAssistantEntryWrite, transcript, setup, hub, fireTimer, codemodeModel, toolSequenceModel, searchingModel, SEARCH_ASK, codingSearchModel, setupWithResolver, waitFor, jobResult, turnStarts, steerStatuses, writeFocusedSkill, messageText, runThenAnswerModel, gateTurn, } from './helpers/local-session';

describe('LocalAgentSession.steer — mid-turn steering (Hermes steer-drain)', () => {
  /** Call #1 streams a gated `fact` call so a test can steer before the step boundary; call #2 answers. Captures every prompt. */
  function toolThenAnswerModel(answer: string) {
    const prompts: PromptMessage[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    let calls = 0;

    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async (options) => {
        prompts.push(options.prompt);
        calls += 1;

        if (calls === 1) {
          return {
            stream: gatedFactCallStream('call-1', gate, usage),
            response: { headers: {} },
          };
        }

        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'text-start', id: '0' });
              controller.enqueue({ type: 'text-delta', id: '0', delta: answer });
              controller.enqueue({ type: 'text-end', id: '0' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
              controller.close();
            },
          }),
          response: { headers: {} },
        };
      },
    });

    return { model, prompts, release };
  }

  function gatedTextModel(answer: string) {
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '0' });
            controller.enqueue({ type: 'text-delta', id: '0', delta: answer });
            abortSignal?.addEventListener('abort', () => {
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            }, { once: true });
            await gate;

            if (abortSignal?.aborted) return;
            controller.enqueue({ type: 'text-end', id: '0' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
            controller.close();
          },
        }),
        response: { headers: {} },
      }),
    });

    return { model, release };
  }

  const userTexts = (prompt: PromptMessage[]) =>
    prompt
      .filter((message): message is Extract<PromptMessage, { role: 'user' }> => message.role === 'user')
      .map((message) => message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(''));

  test('two rapid steers drain into ONE merged user message at the step boundary, after the tool results', async () => {
    const { model, prompts, release } = toolThenAnswerModel('done, checked both');
    const { rt, session, events } = setup('unused', model);

    const turn = session.send('main question', { id: crypto.randomUUID() });
    await waitFor(events, () => events.some((e) => e.type === 'tool-call'));
    const steerX = session.send('also check X', { id: crypto.randomUUID() });
    const steerY = session.send('and Y', { id: crypto.randomUUID() });
    release();
    await turn;
    expect(await steerX).toBe('mid-turn');
    expect(await steerY).toBe('mid-turn');

    expect(prompts.length).toBe(2);
    const second = prompts[1];
    const injected = userTexts(second).filter((text) => text.includes('also check X'));
    expect(injected).toEqual(['also check X\n\nand Y']);
    const roles = second.map((m) => m.role);
    expect(roles.indexOf('tool')).toBeGreaterThan(-1);
    expect(roles.lastIndexOf('user')).toBeGreaterThan(roles.lastIndexOf('tool'));

    expect(turnStarts(events)).toHaveLength(1);

    // One durable row per steer so the walk-back fork pivot can match each; only the model injection merges.
    const rows = await transcript(rt);

    expect(rows.map((row) => row.role)).toEqual(['user', 'user', 'user', 'assistant']);
    expect(rows[1].content).toBe('also check X');
    expect(rows[2].content).toBe('and Y');
    await session.end();
  });

  test('a steer word for word the request lands after it; this turn\u2019s runtime context stays before the request', async () => {
    const prompts: PromptMessage[][] = [];
    const gate = Promise.withResolvers<void>();
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

    // Two tool steps, so the third re-reads the landed steer from durable history, then an answer.
    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async (options) => {
        prompts.push(options.prompt);

        if (prompts.length > 2) return fakeModel('done').doStream(options);

        return { stream: gatedFactCallStream(`call-${String(prompts.length)}`, prompts.length === 1 ? gate.promise : Promise.resolve(), usage), response: { headers: {} } };
      },
    });

    const { rt, session, events } = setup('unused', model);
    await writeFocusedSkill(rt);

    const turn = session.send('/focused remember this', { id: crypto.randomUUID() });
    await waitFor(events, () => events.some((e) => e.type === 'tool-call'));
    const steer = session.send('/focused remember this', { id: crypto.randomUUID() });
    gate.resolve();
    await turn;
    expect(await steer).toBe('mid-turn');

    const third = present(prompts[2], 'the step after the steer landed');
    const roles = third.map((message) => message.role);
    const activation = third.findIndex((message) => messageText(message).includes('- focused: explicit /focused'));
    const landed = third.map((message) => message.role === 'user' ? messageText(message) : null).lastIndexOf('/focused remember this');

    expect(landed).toBeGreaterThan(roles.indexOf('tool'));
    expect(activation).toBeGreaterThanOrEqual(0);
    expect(activation).toBeLessThan(roles.indexOf('tool'));
    expect(messageText(present(third[activation + 1], 'the request'))).toBe('/focused remember this');
    await session.end();
  });

  test('a background event reaches the LIVE turn at its next step, alongside a user steer', async () => {
    // A platform wake and a user steer land at the same next step: the wake is model-visible only, the steer is durable.
    const { model, prompts, release } = toolThenAnswerModel('handled both');
    const { db, rt, session, events } = setup('unused', model);

    const turn = session.send('main question', { id: crypto.randomUUID() });
    await waitFor(events, () => events.some((e) => e.type === 'tool-call'));
    expect(session.turnInFlight()).toBe(true);
    const steer = session.send('also check X', { id: crypto.randomUUID() });
    await fireTimer(session, 'mail from bob');
    await session.flushPendingDrains();
    release();
    await turn;
    expect(await steer).toBe('mid-turn');

    const second = prompts[1];
    const injected = userTexts(second).filter((text) => text.includes('also check X') || text.includes('mail from bob'));
    expect(injected).toHaveLength(2);
    expect(injected[0]).toBe('also check X');
    expect(injected[1]).toContain('mail from bob');
    const roles = second.map((m) => m.role);
    expect(roles.lastIndexOf('user')).toBeGreaterThan(roles.lastIndexOf('tool'));

    expect(turnStarts(events)).toHaveLength(1);
    expect(hub(db).pending()).toEqual([]);

    const rows = await transcript(rt);

    expect(rows.map((row) => row.content)).toContain('also check X');
    expect(rows.some((row) => row.content.includes('mail from bob'))).toBe(false);
    await session.end();
  });

  test('turnInFlight is false once the stream is over, so a late signal starts its own turn', async () => {
    const { session, events } = setup('answered');
    expect(session.turnInFlight()).toBe(false);
    await session.send('question', { id: crypto.randomUUID() });
    expect(session.turnInFlight()).toBe(false);

    await fireTimer(session, 'arrived after the turn');
    await session.flushPendingDrains();
    await waitFor(events, () => turnStarts(events).length >= 2);
    expect(turnStarts(events)[1].kind).toBe('programmatic');
    await session.end();
  });

  test('a steer with no remaining step boundary runs as the immediate next user turn', async () => {
    const { model, release } = gatedTextModel('first answer');
    const { rt, session, events } = setup('unused', model);

    const turn = session.send('first question', { id: crypto.randomUUID() });
    await waitFor(events, () => events.some((e) => e.type === 'text-delta'));
    const steer = session.send('follow up please', { id: crypto.randomUUID() });
    release();
    await turn;
    await waitFor(events, () => events.filter((e) => e.type === 'turn-end').length >= 2);
    expect(await steer).toBe('turn');

    const starts = turnStarts(events);
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({ kind: 'user', text: 'follow up please' });

    const rows = await transcript(rt);

    expect(rows.map((row) => `${row.role}:${row.content}`)).toContain('user:follow up please');
    await session.end();
  });

  test('a send with no active turn runs as a turn of its own', async () => {
    const { session } = setup('idle');
    expect(await session.send('nothing running', { id: crypto.randomUUID() })).toBe('turn');
  });

  test('interrupt drops pending steers — no surprise follow-up turn — and returns them to the caller', async () => {
    const { model } = gatedTextModel('never finishes');
    const { session, events } = setup('unused', model);

    const turn = session.send('long task', { id: crypto.randomUUID() });
    await waitFor(events, () => events.some((e) => e.type === 'text-delta'));
    const steer = session.send('change of plans', { id: crypto.randomUUID() });
    await waitFor(events, () => steerStatuses(events).some((s) => s.status === 'queued'));
    // Surfaces already showed the steer as sent; the dropped text returns so they can restore the composer.
    expect(session.interrupt()).toEqual(['change of plans']);
    await expect(steer).rejects.toThrow(/stopped before the agent read this message/);
    await turn;
    await session.settleBackgroundWork();

    expect(turnStarts(events)).toHaveLength(1);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    await session.end();
  });

  test('a landed steer persists as its own stamped user row, and every status is broadcast', async () => {
    // Steer provenance and lifecycle: `steer_status` live, and the two metadata keys after reload.
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    const toolStep = Promise.withResolvers<void>();
    let calls = 0;

    // Call #1 withholds its step boundary (the drain window); call #2 stays open until abort, a window with no boundary left.
    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async ({ abortSignal }) => {
        calls += 1;

        if (calls === 1) {
          return {
            stream: new ReadableStream({
              async start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] });
                controller.enqueue({
                  type: 'tool-call', toolCallId: 'call-1', toolName: 'fact',
                  input: JSON.stringify({ action: 'recall', key: 'probe' }),
                });
                await toolStep.promise;
                controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
                controller.close();
              },
            }),
            response: { headers: {} },
          };
        }

        return {
          stream: abortableTextStream('1', 'on it', abortSignal),
          response: { headers: {} },
        };
      },
    });

    const { rt, session, events } = setup('unused', model);
    const turn = session.send('main question', { id: crypto.randomUUID() });
    await waitFor(events, () => events.some((e) => e.type === 'tool-call'));

    const steer = session.send('also check X', { id: crypto.randomUUID() });
    await waitFor(events, () => steerStatuses(events).length > 0);
    expect(steerStatuses(events).map((s) => [s.status, s.text]))
      .toEqual([['queued', 'also check X']]);
    const steerId = steerStatuses(events)[0]?.steerId;
    expect(steerId).toBeTruthy();

    toolStep.resolve();
    await waitFor(events, () => steerStatuses(events).some((s) => s.status === 'landed'));
    const landed = steerStatuses(events).find((s) => s.status === 'landed');

    if (!landed) throw new Error('the landed steer was never announced');
    expect(landed.steerId).toBe(steerId);
    expect(landed.text).toBe('also check X');
    expect(await steer).toBe('mid-turn');
    expect(landed.atStep).toBeDefined();
    expect(landed.atStep).toBeGreaterThanOrEqual(0);

    await waitFor(events, () => events.some((e) => e.type === 'text-delta'));
    const second = session.send('and Y', { id: crypto.randomUUID() });
    await waitFor(events, () => steerStatuses(events).filter((s) => s.status === 'queued').length === 2);
    expect(session.interrupt()).toEqual(['and Y']);
    await expect(second).rejects.toThrow(/stopped before the agent read this message/);
    await turn;

    expect(steerStatuses(events).map((s) => s.status))
      .toEqual(['queued', 'landed', 'queued', 'returned']);
    const returned = steerStatuses(events).filter((s) => s.status === 'returned');
    expect(returned.map((s) => s.text)).toEqual(['and Y']);
    expect(returned[0]?.steerId).not.toBe(steerId);

    // A steer key without the step key reads as an ordinary user turn; describeLandedSteers stamps both.
    const row = await rt.stores.history.transcript(CHAT_SESSION_ID).project(steerId ?? '');

    if (!row) throw new Error('the landed steer left no durable entry');
    expect(row.role).toBe('user');
    expect(row.content).toBe('also check X');
    expect(row.metadata).toMatchObject({
      [STEER_METADATA_KEY]: true,
      [STEER_STEP_METADATA_KEY]: landed.atStep,
    });
    expect(rt.storage.sql<{ c: number }>`SELECT count(*) AS c FROM conversation_entries
      WHERE actor_id = ${rt.actor.actorId} AND id = ${returned[0]?.steerId ?? ''}`[0]?.c).toBe(0);
    expect((await transcript(rt)).some((entry) => entry.content === 'and Y')).toBe(false);

    await session.end();
  });

  test('an interrupted turn leaves a history the next turn can be assembled from', async () => {
    // Interrupting mid-tool-call must not poison the session with `AI_MissingToolResultsError` from the SDK's prompt assembly.
    // Call #1 withholds its step boundary, the window Ctrl+C lands in.
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prompts: PromptMessage[][] = [];
    let calls = 0;

    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async (options) => {
        prompts.push(options.prompt);
        calls += 1;

        if (calls === 1) {
          return {
            stream: gatedFactCallStream('call_ed15d29f352a4735e6b01b5', gate, usage),
            response: { headers: {} },
          };
        }

        return {
          stream: textStream('still here', usage),
          response: { headers: {} },
        };
      },
    });

    const { session, events } = setup('unused', model);
    const turn = session.send('check the repo', { id: crypto.randomUUID() });
    await waitFor(events, () => events.some((e) => e.type === 'tool-call'));
    session.interrupt();
    release();
    await turn;
    expect(events.some((e) => e.type === 'error')).toBe(true);

    const before = prompts.length;
    await session.send('what did you find?', { id: crypto.randomUUID() });
    expect(prompts.length).toBeGreaterThan(before);

    // The interrupted call gets a terminal result. Assert the destination-normalized id pairing, not the provider literal,
    // which replay rekeys.
    const last = prompts.at(-1) ?? [];

    const callIds = last.flatMap((message) => message.role === 'assistant' && Array.isArray(message.content)
      ? message.content.flatMap((part) => part.type === 'tool-call' ? [part.toolCallId] : []) : []);

    const results = last.flatMap((message) => message.role === 'tool'
      ? message.content.filter((part) => part.type === 'tool-result') : []);

    expect(callIds.length).toBeGreaterThan(0);
    expect(results.map((r) => r.toolCallId)).toEqual(callIds);
    await session.end();
  });

  test('a mid-stream failure keeps drained steers in the live context for the next turn', async () => {
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prompts: PromptMessage[][] = [];
    let calls = 0;

    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async (options) => {
        prompts.push(options.prompt);
        calls += 1;

        if (calls === 1) {
          return {
            stream: gatedFactCallStream('call-1', gate, usage),
            response: { headers: {} },
          };
        }

        if (calls === 2) {
          return {
            stream: new ReadableStream({
              start(controller) { controller.error(new Error('provider exploded')); },
            }),
            response: { headers: {} },
          };
        }

        return {
          stream: textStream('recovered', usage),
          response: { headers: {} },
        };
      },
    });

    const { session, events } = setup('unused', model);
    const turn = session.send('main question', { id: crypto.randomUUID() });
    await waitFor(events, () => events.some((e) => e.type === 'tool-call'));
    const steer = session.send('do it differently', { id: crypto.randomUUID() });
    release();
    await turn;
    expect(await steer).toBe('mid-turn');
    expect(events.some((e) => e.type === 'error')).toBe(true);

    await session.send('follow-up', { id: crypto.randomUUID() });
    const last = present(prompts.at(-1), 'the last model prompt');
    const texts = userTexts(last);
    expect(texts).toContain('do it differently');
    await session.end();
  });

  test('a user-origin enqueueTurn lands at the queue FRONT, carrying its files', async () => {
    // The seam's rerun (a user turn) is admitted ahead of waiting programmatic injects, with its attachment as a file part.
    const { model, prompts, release } = toolThenAnswerModel('done');
    const { session, events } = setup('unused', model);

    const turn = session.send('main question', { id: crypto.randomUUID() });
    await waitFor(events, () => events.some((e) => e.type === 'tool-call'));

    const programTurn = session.enqueueTurn({ text: 'background fact', metadata: { kinuEvent: 'event_drain' } });

    const userTurn = session.enqueueTurn({
      origin: 'user',
      text: 'the operator said this',
      files: [{ filename: 'shot.png', mediaType: 'image/png', url: 'data:image/png;base64,AA' }],
    });

    release();
    await turn;
    await waitFor(events, () => turnStarts(events).length >= 3);

    expect(turnStarts(events).map((s) => [s.kind, s.text])).toEqual([
      ['user', 'main question'],
      ['user', 'the operator said this'],
      ['programmatic', 'background fact'],
    ]);

    // Match the steer's words, not position: the tail user message is the workspace-instructions block.
    const userTurnPrompt = prompts[2];

    const steerMessage = present(
      userTurnPrompt.find((m) => m.role === 'user' && JSON.stringify(m).includes('the operator said this')),
      'the steer message in the user turn prompt',
    );

    expect(steerMessage.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'file', data: 'AA', mediaType: 'image/png', filename: 'shot.png',
      }),
    ]));

    await expect(programTurn).resolves.toEqual({ status: 'queued' });
    await expect(userTurn).resolves.toEqual({ status: 'queued' });
    await session.end();
  });
});

describe('LocalAgentSession — a pending send is durable before it is acknowledged', () => {
  /** Reservations: `pending_steers` mirrors the cf table; each row is an acknowledgement a process alone could lose. */
  const pendingSends = (db: Database) => db.query<{
    id: string; turn_id: string | null; mode: string; text: string;
  }, []>(`SELECT id, turn_id, mode, text FROM pending_steers ORDER BY seq`).all();

  /** Call #1 parks on `stepGate`; call #2 drains the steer then parks on `endGate`: landed but uncommitted. */
  function drainWindowModel(answer: string) {
    const prompts: PromptMessage[][] = [];
    const stepGate = Promise.withResolvers<void>();
    const endGate = Promise.withResolvers<void>();
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    let calls = 0;

    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async (options) => {
        prompts.push(options.prompt);
        calls += 1;

        if (calls === 1) {
          return {
            stream: new ReadableStream({
              async start(controller) {
                options.abortSignal?.addEventListener('abort', () => {
                  controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                }, { once: true });
                controller.enqueue({ type: 'stream-start', warnings: [] });
                controller.enqueue({
                  type: 'tool-call', toolCallId: 'call-1', toolName: 'fact',
                  input: JSON.stringify({ action: 'recall', key: 'probe' }),
                });
                await stepGate.promise;
                controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
                controller.close();
              },
            }),
            response: { headers: {} },
          };
        }

        return {
          stream: new ReadableStream({
            async start(controller) {
              options.abortSignal?.addEventListener('abort', () => {
                controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              }, { once: true });
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'text-start', id: '0' });
              await endGate.promise;
              controller.enqueue({ type: 'text-delta', id: '0', delta: answer });
              controller.enqueue({ type: 'text-end', id: '0' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
              controller.close();
            },
          }),
          response: { headers: {} },
        };
      },
    });

    return { model, prompts, stepGate, endGate };
  }

  function gatedTextModel(answer: string) {
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    const gate = Promise.withResolvers<void>();

    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '0' });
            controller.enqueue({ type: 'text-delta', id: '0', delta: answer });
            abortSignal?.addEventListener('abort', () => {
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            }, { once: true });
            await gate.promise;

            if (abortSignal?.aborted) return;
            controller.enqueue({ type: 'text-end', id: '0' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
            controller.close();
          },
        }),
        response: { headers: {} },
      }),
    });

    return { model, release: gate.resolve };
  }

  test('a mid-turn send is in SQLite before send() resolves, and the drain retires it', async () => {
    const { model, stepGate, endGate } = drainWindowModel('done');
    const { db, rt, session, events } = setup('unused', model);

    const turn = session.send('main question', { id: crypto.randomUUID() });
    await waitFor(events, () => events.some((e) => e.type === 'tool-call'));

    // The write is the acceptance: read it at this microtask boundary so order, not timing, is asserted.
    const steer = session.send('also check X', { id: crypto.randomUUID() });
    const pending = pendingSends(db);
    // The opening send's idle row (turn_id NULL, retired when this turn commits) and the steer bound to the running turn.
    expect(pending).toHaveLength(2);
    const bound = pending.find((row) => row.text === 'also check X');
    expect(bound?.mode).toBe('build');
    expect(bound?.turn_id).not.toBeNull();

    stepGate.resolve();
    expect(await steer).toBe('mid-turn');
    await waitFor(events, () => steerStatuses(events).some((s) => s.status === 'landed'));
    endGate.resolve();
    await turn;

    expect(pendingSends(db)).toEqual([]);

    const row = (await transcript(rt)).filter((entry) => entry.content === 'also check X');

    expect(row.map((entry) => entry.role)).toEqual(['user']);
    await session.end();
  });

  test("a landed steer's durable row exists at the step boundary, not only at turn end", async () => {
    const { model, stepGate, endGate } = drainWindowModel('done');
    const { db, rt, session, events } = setup('unused', model);

    const turn = session.send('main question', { id: crypto.randomUUID() });
    await waitFor(events, () => events.some((e) => e.type === 'tool-call'));
    const steer = session.send('also check X', { id: crypto.randomUUID() });
    stepGate.resolve();
    expect(await steer).toBe('mid-turn');

    // The drain ran and the turn is parked on endGate: a process dying here must not lose the landed row.
    await waitFor(events, () => steerStatuses(events).some((s) => s.status === 'landed'));
    const landed = present(steerStatuses(events).find((s) => s.status === 'landed'), 'the landed steer status');
    const landedId = present(landed.steerId, 'the landed steer id');

    expect(rt.storage.sql<{ c: number }>`SELECT count(*) AS c FROM conversation_entries
      WHERE actor_id = ${rt.actor.actorId} AND id = ${landedId} AND role = 'user'`[0]?.c).toBe(1);
    expect(pendingSends(db).map((row) => row.text)).toEqual(['main question']);

    endGate.resolve();
    await turn;
    await session.end();
  });

  test('a send a dead process acknowledged before the drain is restored into the next turn', async () => {
    const { model } = drainWindowModel('stuck forever');
    const { db, rt, session, events } = setup('unused', model);

    const turn = session.send('main question', { id: crypto.randomUUID() });
    await waitFor(events, () => events.some((e) => e.type === 'tool-call'));
    const lost = session.send('lost mid-turn', { id: crypto.randomUUID() });
    await waitFor(events, () => pendingSends(db).length === 2);
    expect(pendingSends(db).map((row) => row.text)).toEqual(['main question', 'lost mid-turn']);

    const nextEvents: SessionEvent[] = [];
    const nextPrompts: PromptMessage[][] = [];

    const next = new LocalAgentSession({
      rt, db, model: historyCapturingModel('the next answer', (m) => { nextPrompts.push(m); }),
      noAutoEvolve: true, onEvent: (e) => recordSessionEvent(nextEvents, e),
    });

    await next.send('the next turn', { id: crypto.randomUUID() });
    await waitFor(nextEvents, () => nextEvents.some((e) => e.type === 'turn-end'));
    expect(turnStarts(nextEvents).map((s) => [s.kind, s.text])).toEqual([
      ['user', 'main question'],
    ]);

    const first = nextPrompts[0];

    const texts = first
      .filter((m): m is Extract<PromptMessage, { role: 'user' }> => m.role === 'user')
      .flatMap((m) => m.content.filter((p) => p.type === 'text').map((p) => p.text));

    expect(texts.some((t) => t.includes('lost mid-turn'))).toBe(true);
    expect(pendingSends(db)).toEqual([]);

    const steered = (await transcript(rt)).filter((entry) => entry.content === 'lost mid-turn');

    expect(steered).toHaveLength(1);
    expect(await rt.stores.history.transcript(CHAT_SESSION_ID).metadata(steered[0].id))
      .toMatchObject({ [STEER_METADATA_KEY]: true });

    session.interrupt();
    await expect(lost).rejects.toThrow(/stopped before the agent read this message/);
    await turn;
    await session.end();
    await next.end();
  });

  test('an idle-queued send survives the process dying before its turn committed', async () => {
    const { model } = drainWindowModel('the dead turn');
    const { db, rt, session, events } = setup('unused', model);

    const turn = session.send('queued behind nothing', { id: crypto.randomUUID() });
    await waitFor(events, () => events.some((e) => e.type === 'turn-start'));
    const pending = pendingSends(db);
    expect(pending).toHaveLength(1);
    expect(pending[0].text).toBe('queued behind nothing');
    expect(pending[0].turn_id).toBeNull();

    // Process death: the gate never releases; the next session re-enters the message in seq order as its own turn.
    const nextEvents: SessionEvent[] = [];

    const next = new LocalAgentSession({
      rt, db, model: fakeModel('re-run answer'), noAutoEvolve: true,
      onEvent: (e) => recordSessionEvent(nextEvents, e),
    });

    const followUp = next.send('the follow-up', { id: crypto.randomUUID() });
    await waitFor(nextEvents, () => nextEvents.some((e) => e.type === 'turn-end'));
    expect(await followUp).toBe('mid-turn');
    expect(turnStarts(nextEvents).map((s) => [s.kind, s.text])).toEqual([
      ['user', 'queued behind nothing'],
    ]);
    expect(pendingSends(db)).toEqual([]);

    const rows = (await transcript(rt)).map((entry) => `${entry.role}:${entry.content}`);

    expect(rows).toContain('user:queued behind nothing');
    expect(rows).toContain('user:the follow-up');

    session.interrupt();
    await turn;
    await session.end();
    await next.end();
  });

  test('an interrupt retires the pending row — a restart does not re-deliver a returned steer', async () => {
    const { model, release } = gatedTextModel('never finishes');
    const { db, rt, session, events } = setup('unused', model);

    const turn = session.send('long task', { id: crypto.randomUUID() });
    await waitFor(events, () => events.some((e) => e.type === 'text-delta'));
    const steer = session.send('change of plans', { id: crypto.randomUUID() });
    await waitFor(events, () => pendingSends(db).length === 2);
    expect(pendingSends(db).map((row) => row.text)).toEqual(['long task', 'change of plans']);

    expect(session.interrupt()).toEqual(['change of plans']);
    await expect(steer).rejects.toThrow(/stopped before the agent read this message/);
    await turn;
    expect(pendingSends(db)).toEqual([]);

    const next = new LocalAgentSession({
      rt, db, model: fakeModel('should not re-run'), noAutoEvolve: true, onEvent: () => {},
    });

    await next.send('something else', { id: crypto.randomUUID() });
    expect((await transcript(rt)).some((entry) => entry.content === 'change of plans')).toBe(false);

    release();
    await session.end();
    await next.end();
  });

  test('a refused send retires its reservation — a restart cannot re-deliver what was rejected', async () => {
    const { db, rt, session } = setup('unused');
    session.setDriverGate(() => ({ reason: 'unavailable', error: 'another process is driving' }));

    // Acknowledged before the lease refused, so the reservation dies with the refusal the caller saw.
    await expect(session.send('not mine to run', { id: crypto.randomUUID() })).rejects.toThrow('another process is driving');
    expect(pendingSends(db)).toEqual([]);

    const next = new LocalAgentSession({
      rt, db, model: fakeModel('must not run'), noAutoEvolve: true, onEvent: () => {},
    });

    expect(await next.send('real work', { id: crypto.randomUUID() })).toBe('turn');
    expect((await transcript(rt)).some((entry) => entry.content === 'not mine to run')).toBe(false);

    await session.end();
    await next.end();
  });
});

describe('LocalAgentSession — Evolution Changelog parity', () => {
  test('digest assembles from the real local ledgers; viewing zeroes unseen', async () => {
    const { rt, session } = setup('quiet');
    rt.craftStore.create({
      name: 'local_helper', description: 'a locally crafted helper',
      code: 'async () => 1',
    });
    void rt.storage.sql`INSERT INTO agent_facts (actor_id, key, value_json, confidence, source, last_observed_at)
                        VALUES (${rt.actor.actorId}, 'editor', '"helix"', 0.8, 'sleep_time_compute', ${Date.now()})`;

    const view = session.getEvolutionChangelog();
    const tool = present(view.entries.find((entry) => entry.kind === 'tool'), 'the crafted-tool changelog entry');
    const facts = present(view.entries.find((entry) => entry.kind === 'fact'), 'the learned-fact changelog entry');

    expect(tool.summary).toBe('Created a tool: local helper');
    expect(facts.summary).toBe('Learned 1 thing about your environment');
    expect(facts.items?.map((entry) => entry.summary)).toEqual(['Your editor is helix']);
    expect(view.unseenCount).toBe(2);

    session.markChangelogSeen();
    expect(session.getEvolutionChangelog().unseenCount).toBe(0);
    await session.end();
  });

  test('revert by id forgets the fact for real; a crafted tool is informational and has no revert', async () => {
    const { rt, session } = setup('quiet');
    rt.craftStore.create({
      name: 'kept_tool', description: 'stays', code: 'async () => 2',
    });
    void rt.storage.sql`INSERT INTO agent_facts (actor_id, key, value_json, confidence, source, last_observed_at)
                        VALUES (${rt.actor.actorId}, 'stale', '"value"', 1.0, NULL, ${Date.now()})`;

    const view = session.getEvolutionChangelog();
    const tool = present(view.entries.find((e) => e.kind === 'tool'), 'the crafted-tool changelog entry');
    const facts = present(view.entries.find((e) => e.kind === 'fact'), 'the learned-fact changelog entry');

    // A crafted tool is not owner-approvable: its Journal entry carries no revert action.
    expect(tool.revert).toBeUndefined();
    expect((await session.revertChangelogEntry(tool.id)).ok).toBe(false);
    expect(rt.craftStore.get('kept_tool')).toBeTruthy();

    expect((await session.revertChangelogEntry(facts.id)).ok).toBe(true);
    expect(rt.storage.sql`SELECT * FROM agent_facts WHERE key = 'stale'`).toHaveLength(0);

    expect(session.getEvolutionChangelog().entries.filter((e) => e.revert)).toHaveLength(0);
    const again = await session.revertChangelogEntry(facts.id);
    expect(again.ok).toBe(false);
    await session.end();
  });
});

describe('LocalAgentSession — Alternate Takes parity', () => {
  /** A steer branch's take set on the turn that answered: the live answer first, the branch's second. */
  async function answeredWithTakes(session: ReturnType<typeof setup>['session'], rt: ReturnType<typeof createCLIRuntime>) {
    initAlternateTakesTable(rt.storage.execRaw);
    await session.send('solve it', { id: crypto.randomUUID() });
    const turnId = present((await transcript(rt)).filter((entry) => entry.role === 'assistant').at(-1), 'the last assistant entry').id;

    const set = present(recordBranchTakeSet(rt.storage.sql, rt.actor, {
      task: 'pick a strategy', turnId, sessionId: 'default', liveText: 'go with approach A', branchText: 'go with approach B',
    }), 'the take set');

    return { set, win: set.candidates[0].nodeId, alt: set.candidates[1].nodeId };
  }

  test('picking the branch writes the take_pick ledger row and queues the continuation', async () => {
    const { session, rt, events } = setup('answered with A');
    const { set, alt } = await answeredWithTakes(session, rt);

    const result = await session.pickAlternateTake(set.id, alt);
    expect(result).toMatchObject({ outcome: 'corrected', changedAnswer: true, continuationQueued: true });

    const row = rt.storage.sql<{ outcome: string; source: string; followup: string | null; turn_id: string }>`
      SELECT outcome, source, followup, turn_id FROM turn_outcomes`[0];

    expect(row).toMatchObject({ outcome: 'corrected', source: 'take_pick', followup: 'go with approach B', turn_id: set.turnId });

    await waitFor(events, () => turnStarts(events).some((s) => s.kind === 'programmatic' && s.event === 'take_pick'));
    const continuation = present(turnStarts(events).find((s) => s.event === 'take_pick'), 'the take_pick continuation turn');

    expect(continuation.text).toContain('go with approach B');
    await waitFor(events, () => events.filter((e) => e.type === 'turn-end').length === 2);
    await session.end();
  });

  test('confirming the answered take records acceptance and queues nothing', async () => {
    const { session, rt, events } = setup('answered with A');
    const { set, win } = await answeredWithTakes(session, rt);

    const result = await session.pickAlternateTake(set.id, win);
    expect(result).toMatchObject({ outcome: 'accepted', changedAnswer: false, continuationQueued: false });
    expect(rt.storage.sql<{ source: string }>`SELECT source FROM turn_outcomes`[0].source).toBe('take_pick');
    expect(turnStarts(events).every((s) => s.kind === 'user')).toBe(true);
    await session.end();
  });
});

describe('LocalAgentSession.branch — Steer-as-Branch (mid-turn parallel redirect)', () => {
  /** doStream serves the live turn (one delta, then held); doGenerate serves the branch head's inference. */
  function branchableModel(liveAnswer: string, branchAnswer: () => string) {
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const streamPrompts: PromptMessage[][] = [];
    let streams = 0;

    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      // The live turn is the first stream: method cannot distinguish kinds, and `session.send` opens it before `session.branch`.
      doStream: async ({ prompt, abortSignal }) => {
        streams += 1;

        if (streams > 1) {
          const text = branchAnswer();

          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] });
                controller.enqueue({ type: 'text-start', id: 'b' });
                controller.enqueue({ type: 'text-delta', id: 'b', delta: text });
                controller.enqueue({ type: 'text-end', id: 'b' });
                controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
                controller.close();
              },
            }),
            response: { headers: {} },
          };
        }

        streamPrompts.push(prompt);

        return {
          stream: new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'text-start', id: '0' });
              controller.enqueue({ type: 'text-delta', id: '0', delta: liveAnswer });
              abortSignal?.addEventListener('abort', () => {
                controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              }, { once: true });
              await gate;

              if (abortSignal?.aborted) return;
              controller.enqueue({ type: 'text-end', id: '0' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
              controller.close();
            },
          }),
          response: { headers: {} },
        };
      },
      doGenerate: async () => ({
        content: [{ type: 'text', text: branchAnswer() }],
        finishReason: 'stop',
        usage,
        warnings: [],
      }),
    });

    return { model, release, streamPrompts };
  }

  type BranchStatus = { type: 'branch_status'; status: string; branchId: string; task: string; message?: string; takeSetId?: string; turnId?: string };

  const branchEvents = (events: SessionEvent[]): BranchStatus[] =>
    events
      .filter((e): e is Extract<SessionEvent, { type: 'broadcast' }> => e.type === 'broadcast')
      .map((e) => e.event)
      .filter((e): e is BranchStatus => e.type === 'branch_status');

  test('branch while running settles into a claimed two-candidate takes set; the live turn is never touched', async () => {
    const { model, release, streamPrompts } = branchableModel('the live answer', () => 'the branch answer');
    const { rt, session, events } = setup('unused', model);

    const turn = session.send('original question', { id: crypto.randomUUID() });
    await waitFor(events, () => events.some((e) => e.type === 'text-delta'));
    expect(session.branch('what about the other approach?')).toBe(true);
    await session.flushEvents();
    expect(branchEvents(events)).toMatchObject([{ status: 'running', task: 'what about the other approach?' }]);

    release();
    await turn;
    await waitFor(events, () => branchEvents(events).some((e) => e.status === 'settled'));

    expect(turnStarts(events)).toHaveLength(1);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const turnEnd = events.find((event) => event.type === 'turn-end');

    if (!turnEnd || turnEnd.type !== 'turn-end') throw new Error('turn-end event was not emitted');
    expect(turnEnd.turn.assistantResponse).toBe('the live answer');
    expect(streamPrompts).toHaveLength(1);

    const set = present(session.latestAlternateTakes(), 'the alternate takes set');
    expect(set.candidates.map((c) => c.text)).toEqual(['the live answer', 'the branch answer']);
    expect(set.candidates.map((c) => c.origin)).toEqual(['live', 'branch']);
    expect(set.winnerNodeId).toBe(set.candidates[0].nodeId);

    const assistant = (await transcript(rt)).filter((entry) => entry.role === 'assistant').at(-1);

    if (!assistant) throw new Error('assistant entry is missing');
    const assistantId = assistant.id;
    expect(set.turnId).toBe(assistantId);
    const settled = present(branchEvents(events).find((e) => e.status === 'settled'), 'the settled branch event');

    expect(settled).toMatchObject({ takeSetId: set.id, turnId: assistantId });
    await session.end();
  });

  test('picking the branch records corrected + queues the continuation turn', async () => {
    const { model, release } = branchableModel('the live answer', () => 'the branch answer');
    const { rt, session, events } = setup('unused', model);

    const turn = session.send('original question', { id: crypto.randomUUID() });
    await waitFor(events, () => events.some((e) => e.type === 'text-delta'));
    session.branch('try it the other way');
    release();
    await turn;
    await waitFor(events, () => branchEvents(events).some((e) => e.status === 'settled'));

    const set = present(session.latestAlternateTakes(), 'the alternate takes set');
    const branchCandidate = present(set.candidates.find((c) => c.origin === 'branch'), 'the branch candidate take');
    const result = await session.pickAlternateTake(set.id, branchCandidate.nodeId);
    expect(result).toMatchObject({ outcome: 'corrected', changedAnswer: true, continuationQueued: true });

    const ledger = rt.storage.sql<{ outcome: string; source: string; followup: string | null }>`
      SELECT outcome, source, followup FROM turn_outcomes`[0];

    expect(ledger).toMatchObject({ outcome: 'corrected', source: 'take_pick', followup: 'the branch answer' });

    await waitFor(events, () => turnStarts(events).some((s) => s.kind === 'programmatic' && s.event === 'take_pick'));
    expect(present(turnStarts(events).find((s) => s.event === 'take_pick'), 'the take_pick continuation turn').text)
      .toContain('the branch answer');
    await waitFor(events, () => events.filter((e) => e.type === 'turn-end').length === 2);
    await session.end();
  });

  test('a failing branch head yields NO takes set and an honest error broadcast', async () => {
    const { model, release } = branchableModel('the live answer', () => { throw new Error('head model exploded'); });
    const { session, events } = setup('unused', model);

    const turn = session.send('original question', { id: crypto.randomUUID() });
    await waitFor(events, () => events.some((e) => e.type === 'text-delta'));
    expect(session.branch('redirect')).toBe(true);
    release();
    await turn;
    await waitFor(events, () => branchEvents(events).some((e) => e.status === 'error'));

    expect(present(branchEvents(events).find((e) => e.status === 'error'), 'the branch error event').message)
      .toContain('head model exploded');
    expect(session.latestAlternateTakes()).toBeNull();
    const turnEnd = events.find((event) => event.type === 'turn-end');

    if (!turnEnd || turnEnd.type !== 'turn-end') throw new Error('turn-end event was not emitted');
    expect(turnEnd.turn.assistantResponse).toBe('the live answer');
    await session.end();
  });

  test('an interrupted live turn discards the branch — no takes set', async () => {
    let releaseBranch!: () => void;
    const branchGate = new Promise<void>((resolve) => { releaseBranch = resolve; });
    const { model } = branchableModel('never finishes', () => 'unused');
    model.doGenerate = async () => {
      await branchGate;

      return {
        content: [{ type: 'text', text: 'late branch answer' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    };

    const { session, events } = setup('unused', model);

    const turn = session.send('long task', { id: crypto.randomUUID() });
    await waitFor(events, () => events.some((e) => e.type === 'text-delta'));
    expect(session.branch('redirect')).toBe(true);
    session.interrupt();
    await turn;
    await waitFor(events, () => branchEvents(events).some((e) => e.status === 'error'));
    releaseBranch();

    expect(present(branchEvents(events).find((e) => e.status === 'error'), 'the branch error event').message)
      .toContain('did not complete');
    expect(session.latestAlternateTakes()).toBeNull();
    await session.end();
  });

  test('branch with no active turn returns false', () => {
    const { session } = setup('idle');
    expect(session.branch('nothing running')).toBe(false);
    expect(session.branch('   ')).toBe(false);
  });

  test('a branch of a turn under a mission budget charges that mission', async () => {
    const { model, release } = branchableModel('the live answer', () => 'the branch answer');
    const { session, events } = setup('unused', model);
    session.budget.declare('q3', { tokens: 1_000_000 });

    // A scheduled wake is the turn a mission labels: its trigger names the label, its drain turn runs under it.
    const fireAt = Date.now() + 60_000;
    await session.createTimerTrigger({ atMs: fireAt, label: 'nightly review', trust: 'owner', missionLabel: 'q3' });
    await session.fireDueTriggers(fireAt);
    await waitFor(events, () => events.some((e) => e.type === 'text-delta'));
    expect(session.branch('check the release notes instead')).toBe(true);
    release();
    await waitFor(events, () => branchEvents(events).some((e) => e.status === 'settled'));

    // The live turn's call and the branch head's: a fork of a budgeted turn cannot spend outside its budget.
    expect(session.budget.snapshot('q3').map((mission) => mission.calls)).toEqual([2]);
    await session.end();
  });
});

describe('LocalAgentSession — signed-in cloud proxy turn (zero BYO keys)', () => {
  const TOKEN = ['ptc_', '0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz'].join('');

  function sseCompletion(model: string, deltas: string[]): Response {
    const chunk = (choice: JsonObject, extra: JsonObject = {}) =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model,
        choices: [{ index: 0, ...choice }], ...extra,
      })}\n\n`;

    const body = [
      chunk({ delta: { role: 'assistant', content: deltas[0] }, finish_reason: null }),
      ...deltas.slice(1).map((delta) => chunk({ delta: { content: delta }, finish_reason: null })),
      chunk({ delta: {}, finish_reason: 'stop' }, { usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } }),
      'data: [DONE]\n\n',
    ].join('');

    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }

  test('a user turn streams through /api/user/ai/v1 with the CLI bearer + affinity pin', async () => {
    const completions: Array<{
      auth: string | null;
      affinity: string | null;
      model: JsonValue | undefined;
      stream: JsonValue | undefined;
    }> = [];

    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const path = new URL(request.url).pathname;

        if (path === '/api/cli/models') {
          return Response.json({
            models: [{
              spec: DEFAULT_WORKERS_AI_MODEL_SPEC, label: 'DeepSeek V4 Pro 0813', provider: 'workers-ai',
              capabilities: ['tools', 'streaming', 'reasoning'], contextWindow: 1048576,
            }],
            failures: [],
          });
        }

        if (path === '/api/user/ai/v1/chat/completions') {
          const body = v.parse(JsonObjectSchema, await request.json());
          completions.push({
            auth: request.headers.get('authorization'),
            affinity: request.headers.get('x-session-affinity'),
            model: body.model,
            stream: body.stream,
          });

          return sseCompletion(v.parse(v.string(), body.model), ['local ', 'cloud turn']);
        }

        return new Response(`unexpected: ${path}`, { status: 500 });
      },
    });

    try {
      const origin = `http://127.0.0.1:${server.port}`;

      const resolver = createLocalModelResolver({
        llm: {
          name: 'workers-ai',
          baseURL: cloudProxyBaseURL(origin),
          headers: { Authorization: `Bearer ${TOKEN}` },
          model: DEFAULT_WORKERS_AI_MODEL_ID,
        },
        credentials: {},
        cloud: { origin, token: TOKEN },
      });

      const { rt, session, events } = setupWithResolver(resolver);
      expect(session.getEffectiveModelSpec()).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);

      await session.send('hi from the device', { id: crypto.randomUUID() });

      const streamed = events
        .filter((event): event is Extract<SessionEvent, { type: 'text-delta' }> => event.type === 'text-delta')
        .map((event) => event.delta)
        .join('');

      expect(streamed).toBe('local cloud turn');
      const turnEnd = events.find((event) => event.type === 'turn-end');

      if (!turnEnd || turnEnd.type !== 'turn-end') throw new Error('turn-end event was not emitted');
      expect(turnEnd.turn.assistantResponse).toBe('local cloud turn');
      expect(turnEnd.turn.hadError).toBe(false);
      expect((await transcript(rt)).map((entry) => entry.role)).toEqual(['user', 'assistant']);

      expect(completions).toEqual([{
        auth: `Bearer ${TOKEN}`,
        affinity: agentAffinityKey(rt.actor.name),
        model: DEFAULT_WORKERS_AI_MODEL_ID,
        stream: true,
      }]);

      const { models } = await session.listAvailableModels();
      const deepseek = models.find((m) => m.provider === 'workers-ai' && m.id === DEFAULT_WORKERS_AI_MODEL_ID);
      expect(deepseek?.contextWindow).toBe(1048576);
    } finally {
      await server.stop(true);
    }
  });
});

describe('LocalAgentSession — the durable run-event log', () => {
  // A one-shot run or benchmark container destroys the database on exit, so each row also reaches the frontend from the one recorder.
  test('every recorded row is forwarded to the frontend as it is written', async () => {
    const { session, events } = setup('hello there');
    await session.send('hi', { id: crypto.randomUUID() });

    const runId = session.listRuns().items[0].runId;

    const streamed = events
      .filter((e): e is Extract<SessionEvent, { type: 'run-event' }> => e.type === 'run-event')
      .map((e) => e.event);

    expect(streamed).toEqual(session.getRunEvents(runId));

    await session.end();
  });

  test('a search lands in the ledger with what it produced and what it cost', async () => {
    // Head phases must be durable locally, as on the DO. A search detaches at spawn, so the run ledger holds the dispatch
    // and the settled job row the outcome; the dispatch row is found by tool, not recency.
    const { db, session, events: liveEvents } = setup('unused', searchingModel());
    await session.send('go', { id: crypto.randomUUID() });
    await session.settleBackgroundWork();

    const streams = headStreamFrames(liveEvents);

    const activity = liveEvents.flatMap((event) => event.type === 'broadcast' && event.event.type === 'head_activity'
      ? [v.parse(v.object({ headId: v.string() }), event.event).headId]
      : []);

    expect(streams.length).toBeGreaterThan(0);

    for (const frame of streams) expect(activity).toContain(frame.headId);

    const events = session.listRuns().items.flatMap((r) => session.getRunEvents(r.runId));

    const dispatch = present(
      events.find((e): e is Extract<typeof events[number], { type: 'tool_call_end' }> =>
        e.type === 'tool_call_end' && e.name === 'agents'),
      'the agents tool_call_end ledger row',
    );

    expect(dispatch.args).toMatchObject({
      action: 'swarm', task: 'explore two angles', preset: 'ideate', branches: 2, depth: 1,
    });

    const job = v.parse(
      v.object({ id: v.string(), status: v.string() }),
      db.query(`SELECT id, status FROM background_jobs WHERE kind = 'agents'`).get(),
    );

    expect(job.status).toBe('completed');
    const rawJobResult = jobResult(db, job.id);
    expect(JSON.stringify(dispatch.result)).toContain(job.id);

    const settled = v.parse(
      v.object({
        report: v.object({ stop: v.string(), expansions: v.number(), tokens: v.number() }),
        candidates: v.array(v.object({ artifact: v.string() })),
      }),
      JSON.parse(rawJobResult),
    );

    expect(settled.report.stop).toBe('settled');
    expect(settled.report.expansions).toBe(2);
    expect(settled.candidates).toHaveLength(2);
    expect(settled.report.tokens).toBeGreaterThan(0);

    // What the search cost is what the spend ledger bills: a `swarm` row per node, summing to its tokens.
    const billed = [WORKSPACE_RUN_ID, ...session.listRuns().items.map((r) => r.runId)]
      .flatMap((runId) => session.getRunEvents(runId))
      .flatMap((e) => (e.type === 'model_call' && e.source === 'swarm' ? [e.usage] : []));

    expect(billed).toHaveLength(settled.report.expansions);
    expect(billed.reduce((sum, usage) => sum + (usage === undefined ? 0 : usageTotal(usage) ?? 0), 0))
      .toBe(settled.report.tokens);

    await session.end();
  });

  test('a search node runs code and is offered the web', async () => {
    // Defends: a node offered an `eval` that refuses as unconfigured, and no `web`, because the swarm was built without either.
    const { model, nodeCalls } = codingSearchModel();
    const { session } = setup('unused', model);
    await session.send(SEARCH_ASK, { id: crypto.randomUUID() });
    await session.settleBackgroundWork();

    const opening = nodeCalls.find((call) => !call.prompt.some((message) => message.role === 'tool'));
    const answered = nodeCalls.find((call) => call.prompt.some((message) => message.role === 'tool'));

    expect(opening?.tools?.map((offered) => offered.name)).toEqual(expect.arrayContaining(['eval', 'web']));
    expect(JSON.stringify(answered?.prompt.filter((message) => message.role === 'tool'))).toContain('42');

    await session.end();
  });

  test('a turn that dies before its stream exists still terminates: error, turn-end, run_end', async () => {
    // A throw in per-turn setup (model resolution, skills, system prompt) must fail the opened run, not exit 0 silently.
    const { db, rt } = workspaceRuntime();

    // Which production setup call failed was never isolated; the pin is that the region has a failure path.
    const failing = {
      ...rt,
      memory: {
        ...rt.memory,
        tail: async () => { throw new Error('Failed after 3 attempts. Last error: Too Many Requests'); },
      },
    };

    const events: SessionEvent[] = [];

    const session = new LocalAgentSession({
      rt: failing, db, model: fakeModel('never reached'),
      onEvent: (e) => recordSessionEvent(events, e), noAutoEvolve: true,
    });

    await session.send('write the target file', { id: crypto.randomUUID() });

    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].type === 'error' && errors[0].message).toContain('Too Many Requests');

    const ends = events.filter((e) => e.type === 'turn-end');
    expect(ends).toHaveLength(1);
    expect(ends[0].type === 'turn-end' && ends[0].turn.hadError).toBe(true);

    const runs = session.listRuns().items;
    expect(runs).toHaveLength(1);
    const runEvents = session.getRunEvents(runs[0].runId);
    expect(runEvents.at(-1)?.type).toBe('run_end');
    const end = runEvents.find((e) => e.type === 'run_end');
    expect(end?.reason).toBe('error');
    expect(end?.error).toContain('Too Many Requests');

    await session.end();
  });

  test('the turn is durable before turn-end publishes it', async () => {
    // KINU-022: the row must be written before `turn-end` is published.
    const { db, rt } = workspaceRuntime();
    const durableAtPublish: Array<string | null> = [];

    const session = new LocalAgentSession({
      rt, db, model: fakeModel('the rollback step is in the runbook'), noAutoEvolve: true,
      onEvent: (e) => {
        if (e.type !== 'turn-end') return;

        const entry = rt.storage.sql<{ id: string }>`SELECT id FROM conversation_entries
          WHERE actor_id = ${rt.actor.actorId} AND role = 'assistant'`[0];

        durableAtPublish.push(entry?.id ?? null);
      },
    });

    await session.send('where is the rollback step?', { id: crypto.randomUUID() });

    expect(durableAtPublish).toHaveLength(1);
    const published = durableAtPublish[0];

    if (published === null || published === undefined) throw new Error('turn-end published an answer the conversation did not hold');
    expect((await rt.stores.history.transcript(CHAT_SESSION_ID).project(published))?.content)
      .toBe('the rollback step is in the runbook');

    await session.end();
  });

  test('a turn whose persistence fails publishes no answer', async () => {
    // KINU-022: a persist failure must not still hand observers a final result no restart can read.
    const { db, rt } = workspaceRuntime();
    const events: SessionEvent[] = [];

    failAssistantEntryWrite(db);

    const session = new LocalAgentSession({
      rt,
      db, model: fakeModel('the rollback step is in the runbook'),
      onEvent: (e) => recordSessionEvent(events, e), noAutoEvolve: true,
    });

    await session.send('where is the rollback step?', { id: crypto.randomUUID() });

    expect(events.filter((e) => e.type === 'text-delta').length).toBeGreaterThan(0);
    const ends = events.filter((e) => e.type === 'turn-end');
    expect(ends).toHaveLength(1);
    const end = ends[0];

    if (!end || end.type !== 'turn-end') throw new Error('turn-end is missing');
    expect(end.turn.assistantResponse).toBe('');
    expect(end.turn.hadError).toBe(true);
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].type === 'error' && errors[0].message).toContain('disk image is malformed');

    expect(rt.storage.sql<{ id: string }>`SELECT id FROM conversation_entries
      WHERE actor_id = ${rt.actor.actorId} AND role = 'assistant'`).toEqual([]);
    const runs = session.listRuns().items;
    expect(runs).toHaveLength(1);
    const runEnd = session.getRunEvents(runs[0].runId).find((e) => e.type === 'run_end');
    expect(runEnd?.reason).toBe('error');

    await session.end();
  });

  test('a drain turn whose answer never reached disk keeps its delivery lease open', async () => {
    // KINU-020: only a durable turn closes the lease; an answerless turn leaves it open for the next reclaim.
    const { db, rt } = workspaceRuntime();
    const leaseAtTurnEnd: Array<number | null> = [];

    failAssistantEntryWrite(db);

    const session = new LocalAgentSession({
      rt,
      db, model: fakeModel('handled event'), noAutoEvolve: true,
      onEvent: (e) => {
        if (e.type !== 'turn-end') return;
        leaseAtTurnEnd.push(db
          .query<{ consumed_at: number | null }, []>(`SELECT consumed_at FROM agent_log WHERE kind = 'event'`)
          .get()?.consumed_at ?? null);
      },
    });

    await fireTimer(session, 'external wake');
    await session.flushPendingDrains();

    expect(leaseAtTurnEnd.length).toBeGreaterThanOrEqual(1);
    expect(leaseAtTurnEnd[0]).not.toBeNull();
    await session.end();
  });

  test('a turn records a replayable run in run_events', async () => {
    // Parity with the DO's run_events (list_run_events / SSE Last-Event-ID resume) over the same SQLite.
    const { session } = setup('hello there');
    await session.send('hi', { id: crypto.randomUUID() });

    const runs = session.listRuns().items;
    expect(runs).toHaveLength(1);
    expect(runs[0].eventCount).toBeGreaterThan(0);

    const events = session.getRunEvents(runs[0].runId);
    // The `model_operation` pair brackets its step, so a call that never returned names itself.
    expect(events.map((e) => e.type)).toEqual([
      'run_start', 'turn_start', 'profile_resolution', 'context_admitted', 'model_operation',
      'step_finish', 'model_operation',
      'turn_end', 'run_end',
    ]);

    const start = events[0];

    if (!start || start.type !== 'run_start') throw new Error('run_start event is missing');
    expect(start.caused_by).toBe('chat');
    expect(start.userMessage).toBe('hi');
    expect(start.turn).toMatchObject({ kind: 'user', text: 'hi' });

    const end = events.at(-1);

    if (!end || end.type !== 'run_end') throw new Error('run_end event is missing');
    expect(end.reason).toBe('completed');
    expect(end.error).toBeUndefined();

    expect(events.map((e) => e.eventIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(session.getRunEvents(runs[0].runId, { since: 7 }).map((e) => e.type))
      .toEqual(['turn_end', 'run_end']);

    await session.end();
  });

  test('a programmatic turn records its trigger, and each turn is its own run', async () => {
    const { session, events } = setup('done');
    await session.send('first', { id: crypto.randomUUID() });
    await session.enqueueTurn({ text: 'job finished', metadata: { kinuEvent: 'background_job' } });
    await waitFor(events, () => session.listRuns().items.length === 2);

    const runs = session.listRuns().items;
    expect(new Set(runs.map((r) => r.runId)).size).toBe(2);

    const causes = runs.map((r) => {
      const start = session.getRunEvents(r.runId)[0];

      return start?.type === 'run_start' ? start.caused_by : null;
    });

    expect(causes.sort((a, b) => (a ?? '').localeCompare(b ?? ''))).toEqual(['background_job', 'chat']);

    await session.end();
  });

  test('a failed turn seals the run with the provider error text', async () => {
    const exploding = new TestLanguageModelV2({
      provider: 'fake', modelId: 'fake-model',
      doStream: async () => { throw new Error('upstream is on fire'); },
    });

    const { session } = setup('unused', exploding);
    await session.send('hi', { id: crypto.randomUUID() });

    const run = session.listRuns().items[0];
    const end = session.getRunEvents(run.runId).at(-1);
    expect(end?.type).toBe('run_end');
    expect(end).toMatchObject({ reason: 'error', error: expect.stringContaining('upstream is on fire') });

    await session.end();
  });

  test("a user's Stop seals the run 'aborted', with no error sentence", async () => {
    // closeRun reports facts and classifyRunEnd owns the vocabulary: an interrupt is an interruption, not an error.
    const stalling = new TestLanguageModelV2({
      provider: 'fake', modelId: 'fake-model',
      doStream: async ({ abortSignal }) => ({
        stream: abortableTextStream('0', 'partial ', abortSignal),
        response: { headers: {} },
      }),
    });

    const { session, events } = setup('unused', stalling);
    const turn = session.send('long task', { id: crypto.randomUUID() });
    await waitFor(events, () => events.some((e) => e.type === 'text-delta'));
    session.interrupt();
    await turn;

    const run = session.listRuns().items[0];

    if (!run) throw new Error('the interrupted turn recorded no run');
    const end = session.getRunEvents(run.runId).at(-1);

    if (!end || end.type !== 'run_end') throw new Error('run_end event is missing');
    expect(end.reason).toBe('aborted');
    expect(end.error).toBeUndefined();
    expect(events.some((e) => e.type === 'error')).toBe(true);

    await session.end();
  });

  /** The judge, fast tier, reflection seam and heads' merge are built before the session, which installs itself as
   *  their ledger; capture that sink. A box, because TypeScript narrows a callback-assigned `let` to `never`. */
  interface SinkSlot { sink: ModelCallSink | null }

  function capturedSink() {
    const { db, rt } = workspaceRuntime();
    const captured: SinkSlot = { sink: null };

    const session = new LocalAgentSession({
      rt: { ...rt, setModelCallSink: (sink) => { captured.sink = sink; } },
      db, model: fakeModel('unused'), onEvent: () => {}, noAutoEvolve: true,
    });

    return { session, captured };
  }

  test('a non-turn model call lands as its own row, and a silent provider stays unmeasured', async () => {
    const { session, captured } = capturedSink();
    expect(captured.sink).not.toBeNull();

    captured.sink?.({ source: 'judge', usage: { input: 41, output: 7 }, spec: 'anthropic/claude-x' });
    captured.sink?.({ source: 'fast', usage: {} });

    const rows = session.getRunEvents(WORKSPACE_RUN_ID).filter((e) => e.type === 'model_call');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source: 'judge', usage: { input: 41, output: 7 }, spec: 'anthropic/claude-x',
    });
    expect(rows[1]).toMatchObject({ source: 'fast', usage: {} });
    expect(rows[0]).not.toHaveProperty('usd');
    expect(rows[1]).not.toHaveProperty('usd');

    await session.end();
  });

  test('a call made during a turn is filed under that run, not the workspace bucket', async () => {
    const { db, rt } = workspaceRuntime();
    const captured: SinkSlot = { sink: null };

    const model = new TestLanguageModelV2({
      provider: 'fake', modelId: 'fake-model',
      doStream: async (options) => {
        captured.sink?.({ source: 'reflection', usage: { input: 3 } });

        return fakeModel('answered').doStream(options);
      },
    });

    const session = new LocalAgentSession({
      rt: { ...rt, setModelCallSink: (sink) => { captured.sink = sink; } },
      db, model, onEvent: () => {}, noAutoEvolve: true,
    });

    await session.send('hi', { id: crypto.randomUUID() });

    const runId = session.listRuns().items[0].runId;
    expect(runId).not.toBe(WORKSPACE_RUN_ID);
    expect(session.getRunEvents(runId).filter((e) => e.type === 'model_call'))
      .toMatchObject([{ source: 'reflection', usage: { input: 3 } }]);
    expect(session.getRunEvents(WORKSPACE_RUN_ID)).toEqual([]);

    await session.end();
  });

  test("a mid-turn row is priced against the ONE spelling of the turn's model, whatever the tier catalog wrote", async () => {
    // The catalog names the tier by bare alias, the resolver in full; the ledger must price the full spelling, as cf does.
    const { db, rt } = workspaceRuntime();
    const captured: SinkSlot = { sink: null };

    const model = new TestLanguageModelV2({
      provider: 'fake', modelId: 'fake-model',
      doStream: async (options) => {
        captured.sink?.({
          source: 'fast', usage: { input: 1_000_000, output: 0 }, spec: 'openai-compatible/house-model',
        });

        return fakeModel('answered').doStream(options);
      },
    });

    const resolver: LocalModelResolver = {
      normalizeSpecSync: (spec) => {
        const trimmed = spec?.trim() ?? '';

        return trimmed === '' || trimmed === 'house-model' ? 'openai-compatible/house-model' : trimmed;
      },
      resolveModel: () => model,
      listProviders: async () => [],
      listModels: async () => ({ models: [], failures: [{ provider: 'openai-compatible', reason: 'offline' }] }),
      modelInfo: async () => ({
        id: 'house-model', label: 'house', capabilities: ['tools', 'streaming'],
        cost: { input: 2, output: 8 },
      }),
      ...resolverRest,
    };

    const catalog = { roles: {}, tiers: { default: { model: 'house-model' } } };

    const envelope: ProfileCatalogEnvelope = {
      authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog,
    };

    const session = new LocalAgentSession({
      rt: { ...rt, setModelCallSink: (sink) => { captured.sink = sink; } },
      db, model: fakeModel('fallback'), modelResolver: resolver, profileAuthority: () => envelope,
      onEvent: () => {}, noAutoEvolve: true,
    });

    await session.send('hi', { id: crypto.randomUUID() });

    const runId = session.listRuns().items[0].runId;
    const rows = session.getRunEvents(runId).filter((e) => e.type === 'model_call');
    expect(rows).toMatchObject([{ source: 'fast', spec: 'openai-compatible/house-model', usd: 2 }]);
    expect(session.getEffectiveModelSpec()).toBe('openai-compatible/house-model');
    await session.end();
  });

  test('a step a fallback served is priced at that model\'s rate, in its row and in the mission it debits', async () => {
    const { db, rt } = workspaceRuntime();

    const refused = new TestLanguageModelV2({
      provider: 'fake', modelId: 'house-model',
      doStream: async () => {
        throw new APICallError({
          message: 'payment required', url: 'https://house.example/v1', requestBodyValues: {}, statusCode: 402, isRetryable: false,
        });
      },
    });

    const backup = fakeModel('from backup', { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 });
    const BACKUP = 'openai-compatible/backup-model';

    const resolver: LocalModelResolver = {
      normalizeSpecSync: (spec) => {
        const trimmed = spec?.trim() ?? '';

        return trimmed === '' || trimmed === 'house-model' ? 'openai-compatible/house-model' : trimmed;
      },
      resolveModel: (spec) => (spec === BACKUP ? backup : refused),
      listProviders: async () => [],
      listModels: async () => ({ models: [], failures: [{ provider: 'openai-compatible', reason: 'offline' }] }),
      // The backup costs ten times the turn's own model, so a step priced at the wrong rate is off by ten.
      modelInfo: async (spec) => ({
        id: spec ?? '', label: 'house', capabilities: ['tools', 'streaming'],
        cost: spec === BACKUP ? { input: 20, output: 80 } : { input: 2, output: 8 },
      }),
      ...resolverRest,
    };

    const catalog = { roles: {}, tiers: { default: { model: 'house-model', fallbacks: [BACKUP] } } };

    const envelope: ProfileCatalogEnvelope = {
      authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog,
    };

    const events: SessionEvent[] = [];

    const session = new LocalAgentSession({
      rt, db, model: fakeModel('fallback'), modelResolver: resolver, profileAuthority: () => envelope,
      onEvent: (event) => recordSessionEvent(events, event), noAutoEvolve: true,
    });

    session.budget.declare('q3', {});
    const fireAt = Date.now() + 60_000;
    await session.createTimerTrigger({ atMs: fireAt, label: 'nightly review', trust: 'owner', missionLabel: 'q3' });
    await session.fireDueTriggers(fireAt);
    await waitFor(events, () => events.some((event) => event.type === 'turn-end'));

    const runId = session.listRuns().items[0].runId;
    const rows = session.getRunEvents(runId);
    expect(rows.filter((row) => row.type === 'model_fallback')).toMatchObject([{ from: 'openai-compatible/house-model', to: BACKUP }]);
    expect(rows.filter((row) => row.type === 'step_finish'))
      .toMatchObject([{ usage: { input: 1_000_000, output: 0 }, usd: 20, modelId: 'fake-model' }]);
    expect(session.budget.snapshot('q3')[0]?.spent.usd).toBe(20);
    await session.end();
  });

  test('a fallback the catalog refuses to price leaves the turn to start, and the turn\'s own model answers it', async () => {
    const { db, rt } = workspaceRuntime();
    const BACKUP = 'openai-compatible/backup-model';

    const resolver: LocalModelResolver = {
      normalizeSpecSync: (spec) => {
        const trimmed = spec?.trim() ?? '';

        return trimmed === '' || trimmed === 'house-model' ? 'openai-compatible/house-model' : trimmed;
      },
      resolveModel: () => fakeModel('from the house'),
      listProviders: async () => [],
      listModels: async () => ({ models: [], failures: [{ provider: 'openai-compatible', reason: 'offline' }] }),
      // A profile may name a fallback on a provider this machine has not connected.
      modelInfo: async (spec) => {
        if (spec === BACKUP) throw new KinuError('denied', 'the backup provider is not connected');

        return { id: spec ?? '', label: 'house', capabilities: ['tools', 'streaming'], cost: { input: 2, output: 8 } };
      },
      ...resolverRest,
    };

    const catalog = { roles: {}, tiers: { default: { model: 'house-model', fallbacks: [BACKUP] } } };

    const envelope: ProfileCatalogEnvelope = {
      authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog,
    };

    const events: SessionEvent[] = [];

    const session = new LocalAgentSession({
      rt, db, model: fakeModel('fallback'), modelResolver: resolver, profileAuthority: () => envelope,
      onEvent: (event) => recordSessionEvent(events, event), noAutoEvolve: true,
    });

    await session.send('hi', { id: crypto.randomUUID() });
    const turnEnd = events.find((event) => event.type === 'turn-end');

    if (!turnEnd || turnEnd.type !== 'turn-end') throw new Error('turn-end event was not emitted');
    expect(turnEnd.turn.assistantResponse).toBe('from the house');
    await session.end();
  });
});

// agents.* in the node codemode sandbox: the real `new Function` sandbox over real bindings. Searches run their branches
// in this process, so the model is the seam every search is scripted through.

describe('agents.* codemode namespace — node sandbox', () => {
  function sandboxWith(deps: AgentsToolDeps) {
    const tool = createNodeCodemodeToolFactory({
      extraProviders: [createAgentsCodemodeProvider(() => deps)],
    })({ native: {}, craftedTools: () => ({}), providers: [] });

    return (code: string, options?: ToolExecutionOptions) =>
      toolExecute<{ code: string }, JsonValue>(tool)({ code }, options);
  }

  interface SearchSandbox {
    deps: AgentsToolDeps;
    calls: Array<{ prompt: string; signal?: AbortSignal }>;
  }

  function searchSandbox(answer = 'one approach'): SearchSandbox {
    const calls: SearchSandbox['calls'] = [];
    const base = fakeModel(answer);

    const record = (options: LanguageModelV2CallOptions) => {
      calls.push({ prompt: JSON.stringify(options.prompt), signal: options.abortSignal });
    };

    const model = new TestLanguageModelV2({
      provider: base.provider,
      modelId: base.modelId,
      doGenerate: async (options) => {
        record(options);

        return base.doGenerate(options);
      },
      doStream: async (options) => {
        record(options);

        return base.doStream(options);
      },
    });

    const db = new Database(':memory:');
    // Production initializer: a swarm node claims a working revision in the workspace's tables
    // (without it, `no such table: actor_working_revisions`).
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const rt = createCLIRuntime(db, { llm: DUMMY_LLM });

    return { deps: { mode: 'build', swarm: { rt, model, hostNode: nodeSeatFactory(rt), ...unobservedSearchSeams() } }, calls };
  }

  test('a script searches, branches on the result, and returns its own synthesis', async () => {
    const { deps, calls } = searchSandbox();
    const run = sandboxWith(deps);

    const result = await run(`
      const angles = ['auth', 'billing'];
      const searched = await Promise.all(angles.map((a) => agents.swarm({
        task: 'review ' + a, preset: 'ideate', branches: 2, depth: 1,
      })));
      const ran = searched.filter((s) => !s.reason && s.report.expansions === 2);
      return { count: ran.length, branches: ran.map((s) => s.caps.branches.value) };
    `);

    expect(result).toEqual({ result: { count: 2, branches: [2, 2] } });
    const asked = calls.map((call) => call.prompt).join('\n');
    expect(asked).toContain('review auth');
    expect(asked).toContain('review billing');
  });

  test('a sandbox search runs in-process, and one with no preset is refused', async () => {
    const { deps, calls } = searchSandbox();
    const run = sandboxWith(deps);

    const dispatched = v.parse(
      v.object({ result: v.object({ preset: v.string(), report: v.object({ expansions: v.number() }) }) }),
      await run(`return await agents.swarm({ task: 'pick an approach', preset: 'ideate', branches: 2, depth: 1 });`),
    );

    expect(dispatched.result.preset).toBe('ideate');
    expect(dispatched.result.report.expansions).toBe(2);
    const expanded = calls.length;
    expect(expanded).toBeGreaterThan(0);

    // `preset` cannot be invented, so a call without one is refused before expanding, naming the field.
    const refusal = {
      success: false, reason: 'bad_input',
      error: 'swarm needs `preset`: the shape of the search (no role catalog is wired here to take its default from). '
        + SWARM_PRESET_DOCTRINE.join(' '),
    };

    await expect(run(`return await agents.swarm({ task: 'pick an approach' });`)).rejects.toEqual(expect.objectContaining({
      outcome: { ...refusal, failures: [{ ...refusal, tool: 'agents', action: 'swarm' }] },
    }));
    expect(calls).toHaveLength(expanded);
  });

  test('a search refusal is a value the script can branch on, not a sandbox failure', async () => {
    const { deps, calls } = searchSandbox();

    // `ideate` is flat, so an objective on it is refused; the script reads the refusal as a return value.
    const result = await sandboxWith(deps)(`
      const searched = await agents.swarm({
        task: 't', preset: 'ideate',
        objective: {
          kind: 'scalar', metric: 'ms', unit: 'ms', direction: 'minimise',
          scale: 'linear', target: 1, verify: { kind: 'exec-ratio', spec: {} },
        },
      });
      return searched.error ? 'recovered: ' + searched.error.includes('no value signal') : 'no error';
    `);

    expect(result).toEqual({
      result: 'recovered: true',
      failures: [{
        tool: 'agents', action: 'swarm', success: false, reason: 'bad_input',
        error: '`ideate` is flat and has no value signal by design; an objective here would be measured and then ignored, which is a silent lie about what the run did. Use preset:"optimise" to measure something, or drop `objective`.',
      }],
    });
    expect(calls).toEqual([]);
  });

  test('the turn abort signal reaches a search started inside the sandbox', async () => {
    // Agent nodes poll rather than honour `abortSignal`, so observe the run's stop reason: a pre-cancelled turn expands nothing.
    const { deps, calls } = searchSandbox();
    const controller = new AbortController();
    controller.abort();

    const result = v.parse(
      v.object({ result: v.object({ report: v.object({ stop: v.string(), expansions: v.number() }) }) }),
      await sandboxWith(deps)(
        `return await agents.swarm({ task: 't', preset: 'ideate', branches: 2, depth: 1 });`,
        { abortSignal: controller.signal, toolCallId: 'swarm-abort-test', messages: [] },
      ),
    );

    expect(result.result.report.stop).toBe('aborted');
    expect(result.result.report.expansions).toBe(0);
    expect(calls).toEqual([]);
  });

  test('ungated actions are structurally absent from the local sandbox', async () => {
    const { deps } = searchSandbox();

    const result = await sandboxWith(deps)(
      'return { members: Object.keys(agents), hire: typeof agents.hire, swarm: typeof agents.swarm };',
    );

    // A standalone local turn wires only the exploration substrate; LocalAgentHost adds durable subordinate and peer routing.
    expect(result).toEqual({ result: { members: ['swarm'], hire: 'undefined', swarm: 'function' } });
  });

  test('a live session turn gets the namespace, gated to what it actually wired', async () => {
    const { rt, session, events } = setup('done', codemodeModel(`
      await workspace.writeFile('probe/agents.json', JSON.stringify({
        members: Object.keys(agents), swarm: typeof agents.swarm, hire: typeof agents.hire,
      }));
      return 'probed';
    `));

    await session.send('what can you delegate to?', { id: crypto.randomUUID() });
    expect(events.some((e) => e.type === 'tool-result' && e.toolName === 'eval' && e.success)).toBe(true);
    const probe = await readText(rt.storage.vfs, 'probe/agents.json');
    expect(JSON.parse(String(probe))).toEqual({
      members: ['swarm'], swarm: 'function', hire: 'undefined',
    });
    await session.end();
  });

  test('a standalone local Plan turn is admitted and its codemode sandbox is closed', async () => {
    const probeCode = (path: string) => `
      await workspace.writeFile('${path}', JSON.stringify({ workspaceType: typeof workspace }));
      return 'probed';
    `;

    // Admitted: this session is the review surface (`submit_plan`, `decidePlanReview`).
    const plan = setup('done', codemodeModel(probeCode('probe/plan-tools.json')));
    await plan.session.send('research a plan', { id: crypto.randomUUID(), mode: 'plan' });
    expect(plan.events.filter((event) => event.type === 'tool-result' && event.toolName === 'eval'))
      .toMatchObject([{ success: false, reason: 'denied' }]);
    expect(await exists(plan.rt.storage.vfs, 'probe/plan-tools.json')).toBe(false);
    await plan.session.end();

    const build = setup('done', codemodeModel(probeCode('probe/build-tools.json')));
    await build.session.send('implement the change', { id: crypto.randomUUID() });

    const buildProbe = JSON.parse(String(await readText(build.rt.storage.vfs, 'probe/build-tools.json')));

    expect(buildProbe).toEqual({ workspaceType: 'object' });
    await build.session.end();
  });
});

describe('LocalAgentSession — the one-shot completion gate', () => {
  test('a one-shot turn that did work gets one more turn carrying state the HARNESS read', async () => {
    const { session, events } = setup('unused', runThenAnswerModel(), { oneShot: true });
    await session.send('write the report', { id: crypto.randomUUID() });
    await session.settleBackgroundWork();

    const gate = present(gateTurn(events), 'the completion-gate turn');

    expect(gate.text).toContain('[Runtime check');
    expect(gate.text).toContain('write the report');
    expect(gate.text).toContain('$ pwd');
    expect(gate.text).toContain('$ ls -la');

    expect(turnStarts(events).filter((t) => t.event === 'completion_gate')).toHaveLength(1);
    await session.end();
  });

  test('the gate is not armed on the interactive surface, where a human is the check', async () => {
    const { session, events } = setup('unused', runThenAnswerModel());
    await session.send('write the report', { id: crypto.randomUUID() });
    await session.settleBackgroundWork();

    expect(gateTurn(events)).toBeUndefined();
    await session.end();
  });

  test('a turn that called no tools is not gated — it left no state to check', async () => {
    const { session, events } = setup('just answering', undefined, { oneShot: true });
    await session.send('what is 2 + 2', { id: crypto.randomUUID() });
    await session.settleBackgroundWork();

    expect(gateTurn(events)).toBeUndefined();
    await session.end();
  });

  test('a failed turn is not gated — it already reported the failure', async () => {
    const exploding = new TestLanguageModelV2({
      provider: 'fake', modelId: 'fake-model',
      doStream: async () => { throw new Error('upstream is on fire'); },
    });

    const { session, events } = setup('unused', exploding, { oneShot: true });
    await session.send('write the report', { id: crypto.randomUUID() });
    await session.settleBackgroundWork();

    expect(gateTurn(events)).toBeUndefined();
    await session.end();
  });

  test('the confirming turn records whether the re-look converted into real work', async () => {
    const { session } = setup('unused', runThenAnswerModel('tool'), { oneShot: true });
    await session.send('write the report', { id: crypto.randomUUID() });
    await session.settleBackgroundWork();

    const gateRun = present(
      session.listRuns().items
        .map((r) => session.getRunEvents(r.runId))
        .find((evs) => evs.some((e) => e.type === 'completion_gate')),
      'the run carrying the completion gate',
    );

    expect(gateRun.find((e) => e.type === 'completion_gate')).toMatchObject({ converted: true });
    await session.end();
  });

  test('a re-look that only re-asserts is recorded as an honest non-conversion', async () => {
    const { session } = setup('unused', runThenAnswerModel('text'), { oneShot: true });
    await session.send('write the report', { id: crypto.randomUUID() });
    await session.settleBackgroundWork();

    const rows = session.listRuns().items
      .flatMap((r) => session.getRunEvents(r.runId))
      .filter((e) => e.type === 'completion_gate');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ converted: false });
    await session.end();
  });
});

// Asserted on the system prompt the model is actually handed (`systemCapturingModel`).
describe('LocalAgentSession — provenance and durable roles reach the model', () => {
  test('a background-job wake carries the resume guidance, naming its job, in the dynamic context, not in the prefix', async () => {
    // jobs/runner.ts stamps kinuMode and the job beside the wake's kinuEvent; the guidance must still reach the model,
    // from the dynamic context so a wake between chat turns leaves the cacheable prefix intact.
    let observed: PromptMessage[] = [];
    const { session } = setup('ok', historyCapturingModel('ok', (messages) => { observed = messages; }));
    await session.enqueueTurn({
      text: 'job bgjob-1 finished',
      metadata: { kinuEvent: 'background_job', kinuMode: 'build', jobId: 'bgjob-1', kind: 'agents', status: 'completed' },
    });

    const system = observed
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');

    const turnMessages = observed.filter((message) => message.role !== 'system').map(messageText);
    expect(system).not.toContain('Fetch its result first');
    expect(system).not.toContain('## Why this turn runs');
    expect(present(turnMessages.at(-2), 'the block before the wake')).toContain('a background job finished (job bgjob-1, agents, completed)');
    expect(turnMessages.at(-1)).toBe('job bgjob-1 finished');
    await session.end();
  });

  test('an ordinary turn carries neither overlay, and no Turn mode line', async () => {
    let system = '';
    const { session } = setup('ok', systemCapturingModel('ok', (s) => { system = s; }));
    await session.send('do it', { id: crypto.randomUUID() });
    expect(system).not.toContain('Background-resume mode');
    expect(system).not.toContain('Turn mode');
    await session.end();
  });

  test('a role the agent sets through `tasks` is in the next turn\'s system prompt', async () => {
    const { db, rt } = workspaceRuntime();
    const events: SessionEvent[] = [];

    const setter = new LocalAgentSession({
      rt, db, noAutoEvolve: true, onEvent: (e) => recordSessionEvent(events, e),
      model: toolSequenceModel([{ name: 'tasks', input: { action: 'mode', role: 'researcher' } }]),
    });

    await setter.send('work carefully from here', { id: crypto.randomUUID() });
    await setter.end();

    let system = '';

    const next = new LocalAgentSession({
      rt, db, noAutoEvolve: true, onEvent: (e) => recordSessionEvent(events, e),
      model: systemCapturingModel('ok', (s) => { system = s; }),
    });

    await next.send('carry on', { id: crypto.randomUUID() });
    expect(system).toContain('Role: Researcher');
    expect(system).toContain(BUILTIN_ROLE_DEFINITIONS.researcher.instructions);
    await next.end();
  });

  test('a custom SOUL.md reaches the model request, re-read each turn', async () => {
    // The soul is read per turn from its row, so an owner edit lands next request.
    const { db, rt } = workspaceRuntime();

    const ownerEdit = (markdown: string): void => {
      db.exec('CREATE TABLE IF NOT EXISTS workspace_soul (id INTEGER PRIMARY KEY CHECK (id = 1), markdown TEXT NOT NULL)');
      db.prepare('INSERT INTO workspace_soul (id, markdown) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET markdown = excluded.markdown').run(markdown);
    };

    ownerEdit('# Soul\n\nYou are Atlas. Hold the owner\'s stated intent above the letter of the ask.');
    let system = '';

    const session = new LocalAgentSession({
      rt, db, noAutoEvolve: true, onEvent: () => {},
      model: systemCapturingModel('ok', (s) => { system = s; }),
    });

    await session.send('first turn', { id: crypto.randomUUID() });
    expect(system).toContain('You are Atlas.');

    ownerEdit('# Soul\n\nYou are Rhea. Prefer deleting code over adding it.');
    await session.send('second turn', { id: crypto.randomUUID() });
    expect(system).toContain('You are Rhea.');
    expect(system).not.toContain('You are Atlas.');
    await session.end();
  });
});

describe('LocalAgentSession — delegation roles + head-runtime root wiring', () => {
  test('a fresh multi-part ask is steered toward nothing', async () => {
    const { session } = setup('ok', fakeModel('ok'));
    await session.send('add caching to the api and update the docs', { id: crypto.randomUUID() });
    expect(session.steering.snapshot()).toEqual([]);
    await session.end();
  });

  const MERGE_ANSWER = '{"narrative":"one angle, checked","selected_decisions":[],'
    + '"unresolved_questions":[],"recommendations":["ship it"]}';

  /** Asserted on the runtime a model rebind installs: per-search `resolveModel` (else `agents swarm` model is a silent
   *  no-op), merge routed through the local binder, and the session's spend sinks. */
  test('the head runtime a model rebind installs resolves per-search models and reports its merge to the session', async () => {
    const asked: string[] = [];

    const resolver: LocalModelResolver = {
      normalizeSpecSync: (spec) => namedSpec(spec) ?? 'local/chat',
      resolveModel: (spec) => {
        if (spec) asked.push(spec);

        return fakeModel(MERGE_ANSWER);
      },
      listProviders: async () => [],
      listModels: async () => ({
        models: [{ provider: 'local', id: 'chat', label: 'chat', capabilities: ['streaming' as const] }],
        failures: [],
      }),
      modelInfo: async () => null,
      ...resolverRest,
    };

    const { session, events } = setupWithResolver(resolver);

    const runtime = session.headRuntime;

    const head = await runtime.spawnHead({
      id: 'h-fork', rootId: 'r1', parentId: null, depth: 0, mode: 'build',
      task: 'look at the parser', rationale: 'because', inheritedContext: [],
      budget: { maxDepth: 2, spawnedAt: Date.now() },
      loop: defaultLoopOrigin('swarm'), mergeStrategy: 'synthesize', model: 'local/fork',
    });

    await head.run();

    const frames = headStreamFrames(events);

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame.headId === 'h-fork' && frame.kind === 'text')).toBe(true);
    expect(frames.map((frame) => frame.delta).join('')).toBe(MERGE_ANSWER);
    expect(events.some((event) => event.type === 'broadcast' && event.event.type === 'head_activity')).toBe(true);
    // Without `resolveModel` every fork ran the session's model.
    expect(asked).toContain('local/fork');

    asked.length = 0;
    await runtime.mergeLLM('merging the findings of 1 head', MergeOutputSchema);
    expect(asked.length).toBe(1);
    expect(asked[0]).not.toBe('local/fork');

    await session.flushEvents();
    const rows = events.flatMap((event) => event.type === 'run-event' ? [event.event] : []);
    expect(rows.some((row) => row.type === 'model_call' && row.source === 'judge')).toBe(true);
    expect(rows.some((row) => row.type === 'model_operation' && row.source === 'judge')).toBe(true);
    await session.end();
  });
});

test('an authorized Build turn queued behind Plan regains native file authority', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let step = 0;
  const base = fakeModel('done');

  const model = new TestLanguageModelV2({
    provider: 'fake', modelId: 'fake-model', doGenerate: (options) => base.doGenerate(options),
    doStream: async (options) => {
      const current = step++;

      if (current === 0) { entered.resolve(); await release.promise; }

      if (current % 2 !== 0) return base.doStream(options);

      return { stream: new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'tool-call', toolCallId: 'file-' + current, toolName: 'file', input: JSON.stringify({ action: 'write', path: '/home/main/queued-build.txt', content: 'authorized Build' }) });
          controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } });
          controller.close();
        },
      }) };
    },
  });

  const { session, rt, events } = setup('done', model);
  await session.setRole('planner');
  const plan = inWorkMode('plan', () => session.send('Inspect without changes.', { id: crypto.randomUUID() }));
  await entered.promise;
  await session.setRole('task');
  release.resolve();
  await plan;
  await session.send('Now implement the change.', { id: crypto.randomUUID() });
  expect(await readText(rt.storage.vfs, '/home/main/queued-build.txt')).toBe('authorized Build');
  const writes = events.filter((event) => event.type === 'tool-result' && event.toolName === 'file');
  expect(writes).toHaveLength(2);
  expect(writes[0]).toMatchObject({ success: false, reason: 'denied' });
  expect(writes[1]).toMatchObject({ success: true });
  await session.end();
});

test('the actual local turn executes its selected version instead of the mutable live alias', async () => {
  const model = scriptedTurnModel({ doGenerate: () => { throw new Error('the custom program must not start the default model'); } });
  const { db, rt, session, events } = setup('unused', model);
  const files = rt.agentStateVfs ?? rt.storage.vfs;
  const selected = 'async function run() { await host.emit({ type: "text_delta", text: "selected version one" }); }';
  const changed = 'async function run() { await host.emit({ type: "text_delta", text: "wrong live alias" }); }';
  await files.mkdir('scaffold', { recursive: true });
  await writeText(files, rt.identity.scaffold.path + '.v1', selected);
  db.query("UPDATE scaffold_versions SET status = 'historical' WHERE actor_id = ? AND status = 'current'")
    .run(rt.actor.actorId);
  db.query("INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status) VALUES (?, 1, 1, 'selected source proof', 'current')")
    .run(rt.actor.actorId);
  rt.identity.scaffold.read = async () => changed;

  try {
    await session.send('run the selected program', { id: crypto.randomUUID() });
    expect(events.filter(event => event.type === 'text-delta').map(event => event.delta).join('')).toBe('selected version one');
    expect(model.doStreamCalls).toHaveLength(0);
  } finally {
    await session.end();
    db.close();
  }
});

describe('LocalAgentSession — a workspace bound to a directory', () => {
  test('tells the model its files are local:// in a system prompt that stays byte-identical across turns', async () => {
    const root = scratchDir('local-session-bound-prefix');
    const db = new Database(scratchPath('local-session-bound-prefix', 'agent.db'));
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const rt = createCLIRuntime(db, { llm: DUMMY_LLM, cwd: root });
    const systems: string[] = [];

    const session = new LocalAgentSession({
      rt, db, model: systemCapturingModel('ok', (system) => { systems.push(system); }),
      onEvent: () => {}, noAutoEvolve: true, cwd: root,
    });

    try {
      await session.send('first', { id: crypto.randomUUID() });
      await session.send('second', { id: crypto.randomUUID() });
    } finally {
      await session.end();
      db.close();
    }

    expect(systems.length).toBeGreaterThanOrEqual(2);
    expect(new Set(systems).size).toBe(1);
    expect(systems[0]).toContain('`local://` for this workspace');
  });
});