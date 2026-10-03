import { readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
// LocalAgentSession over the real CLI runtime and a fake model: its host lifecycle and turn review.
import { describe, test, expect } from 'bun:test';
import { AwaitedList, createMockFetch, handClock, present, scratchDir, scratchPath, toolExecute, scriptedTurnModel } from '@kinu.run/test-utils';
import { initWorkspaceSchema, JobOutputFrameSchema, WORKSPACE_SKILLS_DIR, workspaceSkillPath } from '@kinu.run/core';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { APICallError, type LanguageModel } from 'ai';
import { TestLanguageModelV2 } from './test-language-model';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import {
  DEFAULT_WORKERS_AI_MODEL_SPEC, MAX_CONCURRENT_DETACHED_JOBS, BackgroundJobStore, backgroundJobNotice, JsonObjectSchema, WORKSPACE_RUN_ID, BACKGROUND_POLICY, profileCatalogDigest, readActivityLog, type JsonObject, type ProfileCatalogEnvelope, createAgentSelfProvider, InstructionApprovalStore, instructionDigest, createProviderRegistry, createModelsDevCatalogSource,
} from '@kinu.run/core';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession, type LocalAgentSessionOpts, type SessionEvent } from '../src/local-session';
import { type LocalModelResolver } from '../src/model-resolver';
import { createNodeCodemodeToolFactory } from '../src/codemode-tool-factory';
import * as v from 'valibot';
import { resolverRest, namedSpec, listLocalAB, tierAuthority, agentSelfRest, DUMMY_LLM, type PromptMessage, fakeModel, hangingModel, capturingModel, historyCapturingModel, transcript, setup, hub, fireTimer, codemodeModel, toolSequenceModel, setupWithResolver, joining, passGrace, captureSettleTimings, jobColumn, turnStarts, FOCUSED_SKILL, FOCUSED_PATH, writeFocusedSkill, messageText, runThenAnswerModel, } from './helpers/local-session';

const jobStatus = (db: Database, id: string) => jobColumn(db, id, 'status');

const jobError = (db: Database, id: string) => jobColumn(db, id, 'error');

describe('LocalAgentSession — BackendHost + lifecycle', () => {
  test('turn activity is durably recorded through the shared activity-log interface', async () => {
    const { session, rt } = setup();

    try {
      await session.send('record this turn', { id: crypto.randomUUID() });
      const rows = readActivityLog(rt.storage.sql, rt.actor, 20);

      expect(rows.filter((row) => row.event === 'first_chunk')).toHaveLength(1);
      expect(rows.filter((row) => row.event === 'step_finish')).toHaveLength(1);
      expect(rows.every((row) => row.createdAt > 0 && row.elapsedMs >= 0)).toBe(true);
    } finally {
      await session.end();
    }
  });

  test('deferred approval survives a session restart and grants one execution across both runtime surfaces', async () => {
    const { db, rt, session, events } = setup();
    const command = 'git push --force origin main';
    const shell = rt.shell;
    const router = rt.executionRouter;

    if (!shell || !router) throw new Error('local runtime must expose both execution surfaces');

    const executed: string[] = [];

    router.register({
      name: 'sandbox', kind: 'sandbox', capabilities: new Set(['shell']), filesOwner: 'agent', isAvailable: () => true,
      homeDir: async () => '/', connect: async () => {}, disconnect: async () => {},
      tools: { exec: { description: 'record execution', execute: async (input) => {
        executed.push(String(input));

        return 'executed';
      } } },
    });

    const exec = router.getProvider('sandbox')?.tools.exec;

    if (!exec) throw new Error('sandbox.exec is missing');

    const first = await shell.exec(command);
    const [parked] = await session.listDeferredApprovals();

    if (!parked) throw new Error('unattended command was not queued');

    expect(first.exitCode).not.toBe(0);
    expect(first.stderr).toContain(`NOT RUN: queued for owner approval (${parked.id})`);
    expect(JSON.stringify(await exec.execute(command))).toContain('NOT RUN: queued for owner approval');
    expect(await session.listDeferredApprovals()).toHaveLength(2);
    const sandboxAction = (await session.listDeferredApprovals()).find((action) => action.executor === 'sandbox');

    if (!sandboxAction) throw new Error('sandbox command was not queued');

    expect(executed).toEqual([]);
    expect(events.items).toContainEqual({ type: 'broadcast', event: { type: 'pending_actions_changed' } });
    await session.end();

    const reopened = new LocalAgentSession({ rt, db, model: fakeModel('noted'), noAutoEvolve: true, onEvent: (event) => events.push(event) });

    try {
      expect(await reopened.listDeferredApprovals()).toEqual([parked, sandboxAction]);
      expect(await reopened.decideDeferredApprovals([parked.id, sandboxAction.id, sandboxAction.id], 'approved'))
        .toEqual({ decided: [parked.id, sandboxAction.id] });
      expect(executed).toEqual([]);
      await exec.execute(command);
      expect(executed).toEqual([command]);
      await exec.execute(command);
      expect(executed).toEqual([command]);
      const [next] = await reopened.listDeferredApprovals();

      expect(next?.id).not.toBe(parked.id);
      expect(next?.command).toBe(command);
      expect(reopened.getRunEvents(WORKSPACE_RUN_ID).some((event) => event.type === 'approval_consumed'))
        .toBe(true);
    } finally {
      await reopened.end();
    }
  });

  test('on a placed workspace a recursive delete waits for the user, and "always" lets the next one run', async () => {
    const project = scratchDir('local-session-placed');
    mkdirSync(join(project, 'build'));
    mkdirSync(join(project, 'dist'));
    const db = new Database(scratchPath('local-session-placed', 'agent.db'));
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const rt = createCLIRuntime(db, { llm: DUMMY_LLM, cwd: project });
    const session = new LocalAgentSession({ rt, db, model: fakeModel('noted'), onEvent: () => {}, noAutoEvolve: true });
    const shell = present(rt.shell, 'the placed shell');

    try {
      const first = await shell.exec('rm -rf build');
      const parked = present((await session.listDeferredApprovals())[0], 'the parked delete');

      expect(first.stderr).toContain(`NOT RUN: queued for owner approval (${parked.id})`);
      expect(existsSync(join(project, 'build'))).toBe(true);
      expect(await session.decideDeferredApprovals([parked.id], 'always')).toEqual({ decided: [parked.id] });

      expect((await shell.exec('rm -rf dist')).exitCode).toBe(0);
      expect(existsSync(join(project, 'dist'))).toBe(false);
      expect(await session.listDeferredApprovals()).toEqual([]);
    } finally {
      await session.end();
    }
  });

  test('deferred approval retains interactive denial and never queues deny_all commands', async () => {
    const { rt, session } = setup();
    const shell = rt.shell;

    if (!shell) throw new Error('local runtime must expose its shell');

    try {
      const detach = session.setShellApprovalHandler(async () => 'deny');
      const command = 'git push --force origin main';
      const denied = await shell.exec(command);

      expect(denied.exitCode).not.toBe(0);
      expect(await session.listDeferredApprovals()).toEqual([]);
      detach();
      session.setShellApprovalMode('deny_all');
      expect((await shell.exec(command)).stderr).toContain('deny_all');
      expect(await session.listDeferredApprovals()).toEqual([]);
      session.setShellApprovalMode('strict');
      expect((await shell.exec(command)).stderr).toContain('queued for owner approval');
      expect(await session.listDeferredApprovals()).toHaveLength(1);
    } finally {
      await session.end();
    }
  });

  test('always-active skills round-trip through actor_config', () => {
    const { session } = setup();
    expect(session.getAlwaysActiveSkills()).toEqual([]);
    session.setAlwaysActiveSkills(['debugging', 'review']);
    expect(session.getAlwaysActiveSkills()).toEqual(['debugging', 'review']);
    session.setAlwaysActiveSkills([]);
    expect(session.getAlwaysActiveSkills()).toEqual([]);
  });

  test('shell approval mode round-trips through actor_config', () => {
    const { session } = setup();
    expect(session.getShellApprovalMode()).toEqual({ mode: 'strict' });
    expect(session.setShellApprovalMode('allow_all')).toEqual({ ok: true, mode: 'allow_all' });
    expect(session.getShellApprovalMode()).toEqual({ mode: 'allow_all' });
    expect(session.setShellApprovalMode('deny_all')).toEqual({ ok: true, mode: 'deny_all' });
    expect(session.getShellApprovalMode()).toEqual({ mode: 'deny_all' });
  });

  test('a runtime lane after a completed public session turn sees revised profile authority', async () => {
    let tierModel = 'local/a';

    const resolver: LocalModelResolver = {
      normalizeSpecSync: spec => namedSpec(spec) ?? 'local/a',
      resolveModel: spec => fakeModel(spec ?? 'local/a'),
      listProviders: async () => [],
      listModels: async () => ({ models: ['a', 'b'].map(id => ({
        provider: 'local', id, label: id, capabilities: ['streaming' as const],
      })), failures: [] }),
      modelInfo: async () => null,
      ...resolverRest,
    };

    const { session, rt } = setupWithResolver(resolver, { profileAuthority: tierAuthority(() => tierModel) });
    await session.send('complete turn A', { id: crypto.randomUUID() });
    tierModel = 'local/b';
    const seen: string[] = [];
    rt.setModelForRoute?.(route => ({
      async *stream() { yield ''; },
      complete: async () => {
        seen.push(route.model);

        return 'classified';
      },
    }));
    await rt.fastLlm?.complete('an operation between chat turns');

    expect(seen).toEqual(['local/b']);
    await session.end();
  });

  test('a provider connected in another process reaches the next turn, with no restart and no TTL', async () => {
    // Another process editing ~/.kinu/config.json is invisible to the session; that is why a revision exists.
    let connected = ['local/a'];
    let sweeps = 0;
    let revision = 1;

    const resolver: LocalModelResolver = {
      normalizeSpecSync: (spec) => namedSpec(spec) ?? 'local/a',
      resolveModel: (spec) => fakeModel(spec === 'local/b' ? 'from b' : 'from a'),
      listProviders: async () => [],
      listModels: async () => {
        sweeps += 1;

        return {
          models: connected.map((spec) => {
            const [provider, id] = spec.split('/');

            return { provider, id, label: id, capabilities: ['streaming' as const] };
          }),
          failures: [],
        };
      },
      modelInfo: async () => null,
      ...resolverRest,
    };

    let tierModel = 'local/a';

    const { session, events } = setupWithResolver(resolver, {
      profileAuthority: tierAuthority(() => tierModel),
      providerRevision: () => revision,
    });

    await session.send('first', { id: crypto.randomUUID() });
    expect(sweeps).toBe(1);

    await session.send('second', { id: crypto.randomUUID() });
    expect(sweeps).toBe(1);

    connected = ['local/a', 'local/b'];
    tierModel = 'local/b';
    revision += 1;

    await session.send('third', { id: crypto.randomUUID() });

    // Without the signal, the stale-but-complete listing makes `local/b` unlisted, which resolution refuses.
    expect(sweeps).toBe(2);

    const answers = events.items.filter((event) => event.type === 'turn-end')
      .map((event) => event.type === 'turn-end' ? event.turn.assistantResponse : '');

    expect(answers).toEqual(['from a', 'from a', 'from b']);
  });

  test('the account default tier drives the next turn model', async () => {
    const resolver: LocalModelResolver = {
      normalizeSpecSync: (spec) => namedSpec(spec) ?? 'local/a',
      resolveModel: (spec) => fakeModel(spec === 'local/b' ? 'from b' : 'from a'),
      listProviders: async () => [],
      listModels: listLocalAB,
      modelInfo: async () => null,
      ...resolverRest,
    };

    const catalog = { roles: {}, tiers: { default: { model: 'local/b' } } };

    const envelope: ProfileCatalogEnvelope = {
      authority: { kind: 'local' },
      version: 1,
      digest: profileCatalogDigest(catalog),
      catalog,
    };

    const { session, events } = setupWithResolver(resolver, {
      profileAuthority: () => envelope,
    });

    await session.send('first', { id: crypto.randomUUID() });
    const firstTurn = events.items.find((event) => event.type === 'turn-end');

    if (!firstTurn || firstTurn.type !== 'turn-end') throw new Error('first turn-end event was not emitted');
    expect(firstTurn.turn.assistantResponse).toBe('from b');
  });

  test('a pinned model is the model the next turn runs on, not the account default', async () => {
    // CLI half of the model pin cf also proves; without the resolver override the turn answers 'from a'.
    const resolver: LocalModelResolver = {
      normalizeSpecSync: (spec) => namedSpec(spec) ?? 'local/a',
      resolveModel: (spec) => fakeModel(spec === 'local/b' ? 'from b' : 'from a'),
      listProviders: async () => [],
      listModels: listLocalAB,
      modelInfo: async () => null,
      ...resolverRest,
    };

    const catalog = { roles: {}, tiers: { default: { model: 'local/a' } } };

    const envelope: ProfileCatalogEnvelope = {
      authority: { kind: 'local' },
      version: 1,
      digest: profileCatalogDigest(catalog),
      catalog,
    };

    const { session, events } = setupWithResolver(resolver, {
      profileAuthority: () => envelope,
    });

    expect(session.setModel('local/b')).toEqual({ ok: true, spec: 'local/b' });
    await session.send('hello', { id: crypto.randomUUID() });
    const turn = events.items.find((event) => event.type === 'turn-end');

    if (!turn || turn.type !== 'turn-end') throw new Error('turn-end event was not emitted');
    expect(turn.turn.assistantResponse).toBe('from b');
  });

  test('tier reasoning effort merges with prompt-cache options', async () => {
    let providerOptions: LanguageModelV2CallOptions['providerOptions'];
    const base = fakeModel('reasoned');

    const model = new TestLanguageModelV2({
      provider: base.provider, modelId: base.modelId, doGenerate: base.doGenerate,
      doStream: async (options) => {
        providerOptions = options.providerOptions;

        return base.doStream(options);
      },
    });

    const resolver: LocalModelResolver = {
      normalizeSpecSync: () => 'openai/gpt-5.5',
      resolveModel: () => model,
      listProviders: async () => [],
      listModels: async () => ({
        models: [{ provider: 'openai', id: 'gpt-5.5', label: 'gpt', capabilities: ['streaming'] }],
        failures: [],
      }),
      modelInfo: async () => null,
      ...resolverRest,
    };

    const catalog = {
      roles: {},
      tiers: { default: { model: 'openai/gpt-5.5', reasoningEffort: 'high' as const } },
    };

    const envelope: ProfileCatalogEnvelope = {
      authority: { kind: 'local' },
      version: 1,
      digest: profileCatalogDigest(catalog),
      catalog,
    };

    const { session } = setupWithResolver(resolver, { profileAuthority: () => envelope });

    await session.send('think hard', { id: crypto.randomUUID() });
    expect(providerOptions).toEqual({
      openai: {
        promptCacheKey: expect.any(String),
        reasoningEffort: 'high',
      },
    });
    expect(session.getReasoningEffort()).toEqual({ effort: null });
    expect(session.setReasoningEffort('low')).toEqual({ ok: true, effort: 'low' });
    expect(session.getReasoningEffort()).toEqual({ effort: 'low' });
  });

  test('a Responses catalog model replays a tool step\'s text and reasoning whole, at the chosen effort', async () => {
    // #30: Muse restated its plan every step: its earlier steps went out as `item_reference` ids the gateway
    // keeps nothing behind, and the Extra high effort never reached the request.
    const said = 'Got it, you want the first line. Reading notes.md now.';
    const usage = { input_tokens: 9, output_tokens: 9, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 3 } };
    const created = (id: string) => ({ type: 'response.created', response: { id, created_at: 1, model: 'muse-spark-1.3-contributor' } });
    const done = { type: 'response.completed', response: { incomplete_details: null, usage } };

    const toolStep = [
      created('resp_1'),
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', encrypted_content: null } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENCRYPTED-1' } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1' } },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: said },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg_1' } },
      { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'file', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 2, delta: '{"action":"read","path":"notes.md"}' },
      { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'file', arguments: '{"action":"read","path":"notes.md"}', status: 'completed' } },
      done,
    ];

    const answerStep = [
      created('resp_2'),
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_2' } },
      { type: 'response.output_text.delta', item_id: 'msg_2', delta: 'The first line is hello.' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_2' } },
      done,
    ];

    const requests: JsonObject[] = [];

    const mock = createMockFetch([
      { match: 'models.dev/api.json', respond: { body: { 'opencode-go': {
        id: 'opencode-go', npm: '@ai-sdk/openai-compatible', api: 'https://opencode.test/zen/go/v1',
        models: { 'muse-spark-1.3-contributor': { id: 'muse-spark-1.3-contributor', tool_call: true, reasoning: true, provider: { npm: '@ai-sdk/openai' } } },
      } } } },
      { match: '/zen/go/v1/responses', respond: (request) => {
        requests.push(v.parse(JsonObjectSchema, JSON.parse(request.body ?? '{}')));
        const events = requests.length === 1 ? toolStep : answerStep;

        return { headers: { 'content-type': 'text/event-stream' }, body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') };
      } },
    ]);

    const registry = createProviderRegistry();
    registry.registerDynamic(createModelsDevCatalogSource());
    const spec = 'opencode-go/muse-spark-1.3-contributor';

    const model = registry.resolve(spec, {
      env: {}, sessionAffinity: 'kinu-test', fetch: mock.fetch,
      getAuth: async () => ({ headers: { Authorization: 'Bearer key' } }),
      hasCredential: async () => true,
      listCredentialKeys: async () => ['opencode-go.bearer'],
    });

    const resolver: LocalModelResolver = {
      normalizeSpecSync: () => spec,
      resolveModel: () => model,
      listProviders: async () => [],
      listModels: async () => ({ models: [], failures: [] }),
      modelInfo: async () => null,
      ...resolverRest,
    };

    const catalog = { roles: {}, tiers: { default: { model: spec, reasoningEffort: 'xhigh' as const } } };

    const envelope: ProfileCatalogEnvelope = {
      authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog,
    };

    const { rt, session } = setupWithResolver(resolver, { profileAuthority: () => envelope });
    await writeText(rt.storage.vfs, 'notes.md', 'hello\nworld\n');
    await session.send('What is the first line of notes.md?', { id: crypto.randomUUID() });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ store: false, reasoning: { effort: 'xhigh' }, include: ['reasoning.encrypted_content'] });
    expect(JSON.stringify(requests[1]?.input)).not.toContain('item_reference');
    expect(requests[1]?.input).toEqual(expect.arrayContaining([
      { type: 'reasoning', encrypted_content: 'ENCRYPTED-1', summary: [] },
      { role: 'assistant', content: [{ type: 'output_text', text: said }] },
    ]));
  });

  test('a stored effort the listed model does not declare reaches the provider as one it does', async () => {
    let sent: unknown;

    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async (options) => {
        sent = options.providerOptions;

        return fakeModel('ok').doStream(options);
      },
    });

    const resolver: LocalModelResolver = {
      normalizeSpecSync: () => 'openai/gpt-x',
      resolveModel: () => model,
      listProviders: async () => [],
      // The listing declares low, medium and high for the model, as a catalog would.
      listModels: async () => ({
        models: [{ provider: 'openai', id: 'gpt-x', label: 'GPT X', reasoningEfforts: ['low', 'medium', 'high'] }],
        failures: [],
      }),
      modelInfo: async () => null,
      ...resolverRest,
    };

    const catalog = { roles: {}, tiers: { default: { model: 'openai/gpt-x', reasoningEffort: 'xhigh' as const } } };

    const envelope: ProfileCatalogEnvelope = {
      authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog,
    };

    const { session } = setupWithResolver(resolver, { profileAuthority: () => envelope });
    await session.send('hello', { id: crypto.randomUUID() });

    expect(sent).toMatchObject({ openai: { reasoningEffort: 'high' } });
  });

  test('a fallback is sent the level the tier wants as the fallback declares it, and a model declaring none is sent none', async () => {
    const sent = new Map<string, string | null>();
    const OpenAIOptions = v.object({ openai: v.object({ reasoningEffort: v.optional(v.string()) }) });

    const listening = (modelId: string, refuse: boolean) => new TestLanguageModelV2({
      provider: 'fake',
      modelId,
      doStream: async (options) => {
        sent.set(modelId, v.parse(OpenAIOptions, options.providerOptions).openai.reasoningEffort ?? null);

        if (!refuse) return fakeModel('ok').doStream(options);

        throw new APICallError({ message: 'payment required', url: 'https://x.example/v1', requestBodyValues: {}, statusCode: 402, isRetryable: false });
      },
    });

    const models = new Map([
      ['openai/gpt-x', listening('gpt-x', true)], ['openai/gpt-y', listening('gpt-y', true)], ['openai/gpt-z', listening('gpt-z', false)],
    ]);

    const resolver: LocalModelResolver = {
      normalizeSpecSync: (spec) => spec?.trim() ?? 'openai/gpt-x',
      resolveModel: (spec) => models.get(spec ?? '') ?? listening('unknown', true),
      listProviders: async () => [],
      listModels: async () => ({
        models: [
          { provider: 'openai', id: 'gpt-x', reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
          { provider: 'openai', id: 'gpt-y', reasoningEfforts: ['low', 'medium', 'high'] },
          { provider: 'openai', id: 'gpt-z', reasoningEfforts: [] },
        ],
        failures: [],
      }),
      modelInfo: async () => null,
      ...resolverRest,
    };

    const catalog = { roles: {}, tiers: { default: { model: 'openai/gpt-x', reasoningEffort: 'xhigh' as const, fallbacks: ['openai/gpt-y', 'openai/gpt-z'] } } };

    const envelope: ProfileCatalogEnvelope = {
      authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog,
    };

    const { session } = setupWithResolver(resolver, { profileAuthority: () => envelope });
    await session.send('hello', { id: crypto.randomUUID() });

    expect(Object.fromEntries(sent)).toEqual({ 'gpt-x': 'xhigh', 'gpt-y': 'high', 'gpt-z': null });
  });

  /** A session over a resolver whose complete listing is `models`, with the machine's Defaults at `defaults` and
   *  the workspace pinned to `pin`; `sent` names every model a request went to. */
  const listedAs = (
    models: Awaited<ReturnType<LocalModelResolver['listModels']>>['models'],
    placement: { readonly pin?: string; readonly defaults?: string },
  ) => {
    const sent: string[] = [];

    const resolver: LocalModelResolver = {
      normalizeSpecSync: (spec) => spec?.trim() ?? DEFAULT_WORKERS_AI_MODEL_SPEC,
      resolveModel: (spec) => {
        sent.push(spec ?? '');

        return fakeModel('answered');
      },
      listProviders: async () => [],
      listModels: async () => ({ models, failures: [] }),
      modelInfo: async () => null,
      ...resolverRest,
    };

    const catalog = { roles: {}, tiers: { default: { model: placement.defaults ?? DEFAULT_WORKERS_AI_MODEL_SPEC } } };

    const opened = setupWithResolver(resolver, {
      profileAuthority: () => ({ authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog }),
    });

    if (placement.pin !== undefined) opened.rt.actor.config.setModel(placement.pin);

    return { ...opened, sent };
  };

  const errorsOf = (events: AwaitedList<SessionEvent>) => events.items.flatMap((event) => (event.type === 'error' ? [event.message] : []));

  test('a workspace pinned to a model its provider no longer lists is refused, naming the pin, and nothing is sent to it', async () => {
    const { session, events, sent } = listedAs([{ provider: 'openai', id: 'gpt-live' }], { pin: 'openai/retired' });
    await session.send('hello', { id: crypto.randomUUID() });

    expect(errorsOf(events)).toEqual([expect.stringContaining('model "openai/retired" configured for the default tier is unavailable')]);
    expect(sent).not.toContain('openai/retired');
    await session.end();
  });

  test('a default model its provider no longer lists runs on Kinu\'s default, and the person is told which model runs and why', async () => {
    const { session, events, sent } = listedAs([{ provider: 'openai', id: 'gpt-live' }], { defaults: 'openai/retired' });
    await session.send('hello', { id: crypto.randomUUID() });

    const told = events.items.flatMap((event) => (event.type === 'broadcast' && event.event.type === 'model_fallback' ? [event.event] : []));

    expect(told).toEqual([{ type: 'model_fallback', message: `${DEFAULT_WORKERS_AI_MODEL_SPEC} took over from openai/retired: its provider no longer lists it` }]);
    expect(session.getRunEvents(session.listRuns().items[0].runId).filter((row) => row.type === 'model_fallback'))
      .toMatchObject([{ from: 'openai/retired', to: DEFAULT_WORKERS_AI_MODEL_SPEC }]);
    expect(sent).toContain(DEFAULT_WORKERS_AI_MODEL_SPEC);
    expect(sent).not.toContain('openai/retired');
    await session.end();
  });

  test('a model on an endpoint whose listing is empty is sent, as an empty listing proves nothing', async () => {
    const { session, events, sent } = listedAs([], { pin: 'openai-compatible/house-model' });
    await session.send('hello', { id: crypto.randomUUID() });

    expect(errorsOf(events)).toEqual([]);
    expect(sent).toContain('openai-compatible/house-model');
    await session.end();
  });

  test('an explicit tier applies to one turn and is consumed', async () => {
    const resolver: LocalModelResolver = {
      normalizeSpecSync: (spec) => namedSpec(spec) ?? 'local/a',
      resolveModel: (spec) => fakeModel(spec === 'local/b' ? 'from b' : 'from a'),
      listProviders: async () => [],
      listModels: listLocalAB,
      modelInfo: async () => null,
      ...resolverRest,
    };

    const catalog = {
      roles: {},
      tiers: {
        default: { model: 'local/a' },
        deep: { model: 'local/b' },
      },
    };

    const envelope: ProfileCatalogEnvelope = {
      authority: { kind: 'local' },
      version: 1,
      digest: profileCatalogDigest(catalog),
      catalog,
    };

    const { session, events } = setupWithResolver(resolver, { profileAuthority: () => envelope });

    await session.send('deep once', { id: crypto.randomUUID(), tier: 'deep' });
    await session.send('then default', { id: crypto.randomUUID() });

    const turns = events.items.filter((event) => event.type === 'turn-end');
    expect(turns.map((event) => event.type === 'turn-end' ? event.turn.assistantResponse : null))
      .toEqual(['from b', 'from a']);
  });

  test('broadcast fans out as a SessionEvent', async () => {
    const { session, events } = setup();
    session.host.broadcast({ type: 'job_update', jobId: 'x' });
    await session.flushEvents();
    const b = events.items.find((event) => event.type === 'broadcast');

    if (!b || b.type !== 'broadcast') throw new Error('broadcast event was not emitted');
    expect(b.event.type).toBe('job_update');
  });

  test('one-shot timer triggers publish timer events and wake a programmatic turn', async () => {
    const { db, session, events } = setup('handled timer');
    const fireAt = Date.now() + 60_000;

    const created = await session.createTimerTrigger({
      atMs: fireAt,
      label: 'follow-up',
      payload: { reason: 'test' },
      trust: 'owner',
    });

    expect(created.kind).toBe('timer_oneshot');
    expect(created.nextFireAt).toBe(fireAt);
    expect(hub(db).triggers()[0].next_fire_at).toBe(fireAt);

    const outcome = await session.fireDueTriggers(fireAt);
    expect(outcome.fired).toBe(1);
    await events.until((frames) => frames.some((e) => e.type === 'turn-start' && e.kind === 'programmatic'));

    const recent = hub(db).recent({ variant: 'timer', limit: 5 });
    expect(recent).toHaveLength(1);
    expect(recent[0].trust).toBe('owner');
    expect(recent[0].payload).toMatchObject({
      trigger_id: created.id,
      scheduled_fire_at: fireAt,
      label: 'follow-up',
      user_payload: { reason: 'test' },
    });
    expect(turnStarts(events)[0].text).toContain('[timer]');
    expect(hub(db).pending()).toEqual([]);

    const trigger = present(hub(db).triggers().find((t) => t.id === created.id), 'the created trigger row');

    expect(trigger.state).toBe('revoked');
    expect(trigger.next_fire_at).toBeNull();
    expect(trigger.last_fire_at).toBe(fireAt);
    expect(trigger.fire_count).toBe(1);
  });

  test('daemon-style tick: flushPendingDrains runs the fired trigger turn before end()', async () => {
    // fireDueTriggers only arms the ~250ms debounced drain and end() makes it skip, so the daemon must flush before end.
    const { db, session, events } = setup('handled timer');
    const fireAt = Date.now() + 60_000;
    await session.createTimerTrigger({ atMs: fireAt, label: 'wake', trust: 'owner' });

    const outcome = await session.fireDueTriggers(fireAt);
    expect(outcome.fired).toBe(1);
    await session.flushPendingDrains();

    const starts = turnStarts(events);
    expect(starts.some((s) => s.kind === 'programmatic')).toBe(true);
    expect(events.items.some((e) => e.type === 'turn-end')).toBe(true);
    expect(hub(db).pending()).toEqual([]);
    await session.end();
  });

  test('flushPendingDrains is a no-op once the session has ended', async () => {
    const { session, events } = setup('handled timer');
    await session.createTimerTrigger({ atMs: Date.now() + 60_000, label: 'wake', trust: 'owner' });
    await session.fireDueTriggers(Date.now() + 60_000);
    await session.end();
    const endedAt = events.items.length;
    await session.flushPendingDrains();
    expect(events.items.slice(endedAt)).toEqual([]);
  });

  // KINU-020 (local): a drain binds events to a synthetic `evt-…` turn under a recovery lease, the only durable record
  // that a running turn still owes an answer.
  function eventRow(db: Database): { id: string; turn_id: string | null; consumed_at: number | null } {
    const row = db.query<{ id: string; turn_id: string | null; consumed_at: number | null }, []>(
      `SELECT id, turn_id, consumed_at FROM agent_log WHERE kind = 'event'`,
    ).get();

    if (!row) throw new Error('no event row');

    return row;
  }

  test('a drain turn that reaches disk closes its delivery lease', async () => {
    const { db, session, events } = setup('handled event');
    await fireTimer(session, 'external wake');
    await session.flushPendingDrains();
    await events.until((frames) => frames.some((e) => e.type === 'turn-end'));

    const row = eventRow(db);
    expect(row.turn_id).toMatch(/^evt-/u);
    expect(row.consumed_at).toBeNull();
    await session.end();
  });

  test('an event delivery a dead process left leased is reclaimed and re-delivered', async () => {
    const { db, rt, session } = setup('handled event');
    await fireTimer(session, 'external wake');
    const published = eventRow(db).id;
    await session.end();
    db.query(`UPDATE agent_log SET turn_id = 'evt-dead', step_idx = 0, consumed_at = 5 WHERE id = ?`)
      .run(published);

    const events = new AwaitedList<SessionEvent>();

    const next = new LocalAgentSession({
      rt, db, model: fakeModel('recovered event'), onEvent: (e) => events.push(e), noAutoEvolve: true,
    });

    expect(hub(db).pending()).toEqual([]);

    next.reclaimStrandedEventDeliveries();
    expect(hub(db).pending().map((e) => e.id)).toEqual([published]);
    await next.flushEvents();
    expect(events.items.some((e) => e.type === 'background' && e.event === 'events_reclaimed')).toBe(true);

    await next.flushPendingDrains();
    expect(turnStarts(events).some((s) => s.kind === 'programmatic')).toBe(true);
    const row = eventRow(db);
    expect(row.turn_id).toMatch(/^evt-/u);
    expect(row.turn_id).not.toBe('evt-dead');
    expect(row.consumed_at).toBeNull();
    await next.end();
  });

  test('the reclaim leaves an answered delivery alone — one event, one turn', async () => {
    const { db, rt, session, events } = setup('handled event');
    await fireTimer(session, 'external wake');
    await session.flushPendingDrains();
    await events.until((frames) => frames.some((e) => e.type === 'turn-end'));
    await session.end();

    const nextEvents = new AwaitedList<SessionEvent>();

    const next = new LocalAgentSession({
      rt, db, model: fakeModel('should not run'), onEvent: (e) => nextEvents.push(e), noAutoEvolve: true,
    });

    next.reclaimStrandedEventDeliveries();
    await next.flushPendingDrains();

    expect(hub(db).pending()).toEqual([]);
    expect(turnStarts(nextEvents)).toEqual([]);
    expect(eventRow(db).consumed_at).toBeNull();
    await next.end();
  });

  test('cron timer triggers reschedule after firing', async () => {
    const { db, session, events } = setup('handled cron');
    const created = await session.createTimerTrigger({ cron: '*/5 * * * *', label: 'heartbeat' });
    const nextFireAt = present(created.nextFireAt, 'the cron trigger next fire time');

    expect(created.kind).toBe('timer_cron');
    expect(nextFireAt).toBeGreaterThan(Date.now());

    const outcome = await session.fireDueTriggers(nextFireAt);
    expect(outcome.fired).toBe(1);
    await events.until((frames) => frames.some((e) => e.type === 'turn-start' && e.kind === 'programmatic'));

    const trigger = present(hub(db).triggers().find((t) => t.id === created.id), 'the created trigger row');

    expect(trigger.state).toBe('active');
    expect(trigger.last_fire_at).toBe(created.nextFireAt);
    expect(trigger.fire_count).toBe(1);
    expect(trigger.next_fire_at).toBeGreaterThan(nextFireAt);
    session.cancelTrigger(created.id, 'owner');
  });

  test('Node execute fallback exposes the local agent.schedule namespace', async () => {
    const received: Array<{ atMs?: number; label?: string }> = [];

    const codemodeTool = createNodeCodemodeToolFactory({
      extraProviders: [createAgentSelfProvider({
        proposeCurriculumTasks: async () => [],
        listCurriculumTasks: async () => [],
        setCurriculumTaskStatus: async () => ({ ok: true }),
        createTimerTrigger: async (opts) => {
          received.push({ atMs: opts.atMs, label: opts.label });

          return { id: 'trg-local', kind: opts.cron ? 'timer_cron' : 'timer_oneshot', nextFireAt: opts.atMs ?? 123 };
        },
        cancelTrigger: async () => ({ ok: true, changed: true }),
        jobResult: async () => null,
        listBackgroundJobs: async () => [],
        ...agentSelfRest,
      })],
    })({ native: {}, external: () => ({}), craftedTools: () => [], providers: [] });

    const result = await toolExecute<{ code: string }, unknown>(codemodeTool)({
      code: "return await agent.schedule({ atMs: Date.now() + 60000, label: 'local wake' });",
    });

    expect(result).toMatchObject({ result: { id: 'trg-local', kind: 'timer_oneshot' } });
    expect(received[0]?.label).toBe('local wake');
    expect(received[0]?.atMs).toBeGreaterThan(Date.now());
  });

  test('Node execute fallback exposes agent.compactNow, arming the ladder for the next turn', async () => {
    let arms = 0;

    const codemodeTool = createNodeCodemodeToolFactory({
      extraProviders: [createAgentSelfProvider({
        proposeCurriculumTasks: async () => [],
        listCurriculumTasks: async () => [],
        setCurriculumTaskStatus: async () => ({ ok: true }),
        createTimerTrigger: async () => ({ id: 'trg-local', kind: 'timer_oneshot', nextFireAt: 1 }),
        cancelTrigger: async () => ({ ok: true, changed: true }),
        jobResult: async () => null,
        listBackgroundJobs: async () => [],
        ...agentSelfRest,
        armCompactNow: () => { arms++; },
      })],
    })({ native: {}, external: () => ({}), craftedTools: () => [], providers: [] });

    const result = await toolExecute<{ code: string }, unknown>(codemodeTool)({
      code: 'return await agent.compactNow();',
    });

    expect(result).toMatchObject({ result: { armed: true, appliesAt: 'next-turn-assembly' } });
    expect(arms).toBe(1);
  });

  test('an UNAPPROVED skill activates but sets no tool policy', async () => {
    let captured: string[] = [];
    const { rt, session } = setup('ok', capturingModel('ok', (t) => { captured = t; }));
    await writeFocusedSkill(rt);
    new InstructionApprovalStore(
      rt.storage.sql,
      rt.actor,
      `local:${realpathSync(process.cwd())}`,
    )
      .revoke(FOCUSED_PATH);
    await session.send('/focused remember this', { id: crypto.randomUUID() });
    // An agent-written skill's `allowed_tools` is not policy until approved.
    expect(captured).toContain('memory');
    expect(captured.length).toBeGreaterThan(1);
  });

  test('an APPROVED skill filters the turn toolset to allowed_tools', async () => {
    let captured: string[] = [];
    const { rt, session } = setup('ok', capturingModel('ok', (t) => { captured = t; }));
    await writeFocusedSkill(rt);
    // Approval binds the whole raw file: front matter controls `allowed_tools`.
    new InstructionApprovalStore(
      rt.storage.sql,
      rt.actor,
      `local:${realpathSync(process.cwd())}`,
    )
      .approve(FOCUSED_PATH, instructionDigest(FOCUSED_SKILL));

    await session.send('/focused remember this', { id: crypto.randomUUID() });
    expect(new Set(captured)).toEqual(new Set(['memory']));
  });

  test('the person\u2019s request is the last user-role message the model reads; this turn\u2019s runtime context rides before it', async () => {
    // Runtime news after the request reads as the turn itself: a model answered it and ignored the request.
    let prompt: PromptMessage[] = [];
    const { rt, session } = setup('ok', historyCapturingModel('ok', (messages) => { prompt = messages; }));
    await writeFocusedSkill(rt);
    await session.send('/focused remember this', { id: crypto.randomUUID() });

    const users = prompt.filter((message) => message.role === 'user').map(messageText);
    const activation = users.findIndex((text) => text.includes('- focused: explicit /focused'));

    expect(activation).toBeGreaterThanOrEqual(0);
    expect(users.slice(activation + 1)).toHaveLength(2);
    expect(users[activation + 1]).toContain('Focus on memory only.');
    expect(users.at(-1)).toBe('/focused remember this');
  });

  // A body in the system prompt rewrote the cached prefix on the turn it arrived and again on the next. The skill
  // restricts no tool: a restriction changes the tool list, and with it the prompt's tool sections, by design.
  test('a /skill turn carries the approved body before its request, leaves the system prompt alone, and the next turn drops it', async () => {
    const prompts: PromptMessage[][] = [];
    const { rt, session } = setup('ok', historyCapturingModel('ok', (messages) => { prompts.push(messages); }));
    const path = workspaceSkillPath('tidy');
    await rt.storage.vfs.mkdir(`${WORKSPACE_SKILLS_DIR}/tidy`, { recursive: true });
    await writeText(rt.storage.vfs, path, '---\nname: tidy\ndescription: keep notes tidy\n---\nSort the notes first.\n');
    const reviewed = present(await session.readInstructionApproval(path), 'the tidy skill');
    expect((await session.approveInstruction(path, reviewed.digest)).ok).toBe(true);

    for (const text of ['plain first', '/tidy sort these', 'plain after']) await session.send(text, { id: crypto.randomUUID() });

    const system = (prompt: PromptMessage[] | undefined) => present(prompt, 'a request').filter((message) => message.role === 'system').map(messageText);
    const users = (prompt: PromptMessage[] | undefined) => present(prompt, 'a request').filter((message) => message.role === 'user').map(messageText);
    const [plain, tidy, after] = [prompts[0], prompts[1], prompts.at(-1)];

    expect(system(tidy)).toEqual(system(plain));
    expect(system(after)).toEqual(system(plain));
    expect(users(tidy).at(-1)).toBe('/tidy sort these');
    expect(users(tidy).at(-2)).toContain('### tidy (explicit /tidy)\n\nSort the notes first.');
    expect(users(after).join('\n')).not.toContain('Sort the notes first.');
    await session.end();
  });

  test('approval refuses bytes changed after the owner reviewed them', async () => {
    const { rt, session } = setup('ok');
    await writeFocusedSkill(rt);
    const path = FOCUSED_PATH;
    const reviewed = await session.readInstructionApproval(path);

    if (reviewed === null) throw new Error('expected focused skill');

    await writeText(rt.storage.vfs, path, `${FOCUSED_SKILL}\n# changed after review\n`);
    const result = await session.approveInstruction(path, reviewed.digest);

    expect(result.ok).toBe(false);

    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toContain('changed');
  });

  test('a scripted agent follows the skills index and loads the slates body on its first call', async () => {
    const results: string[] = [];
    let step = 0;
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

    const model = scriptedTurnModel({ doGenerate: (options) => {
      step += 1;

      if (step === 1) {
        const system = options.prompt.find((message) => message.role === 'system')?.content ?? '';
        // The path the prompt's own index gives for `slates`, not one this test knows.
        const path = /\*\*slates\*\* `([^`]+)`/u.exec(system)?.[1] ?? 'the index names no path';

        return {
          content: [{ type: 'tool-call', toolCallId: 'load-skill', toolName: 'file', input: JSON.stringify({ action: 'read', path }) }],
          finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [],
        };
      }

      for (const message of options.prompt) {
        if (message.role !== 'tool') continue;

        for (const part of message.content) if (part.type === 'tool-result') results.push(JSON.stringify(part.output));
      }

      return { content: [{ type: 'text', text: 'done' }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] };
    } });

    const { session } = setup('ok', model);
    await session.send('Build a small 2048 game I can play here.', { id: crypto.randomUUID() });

    expect(results).toHaveLength(1);
    expect(results[0]).toContain('class Slate extends SlateObject');
  });

  test('recoverBackgroundJobs fails + wakes an orphaned job of a non-resumable kind, clears stale fibers', async () => {
    const { db, rt, session, events } = setup();
    // `shell` has partial side effects, so it declines resume and fails. Both rows are under the recovering actor:
    // `detectOrphanedFibers` reads only this actor's lanes (fiber.ts:59) and every actor mints the same `bg:*` names.
    db.exec(`INSERT INTO background_jobs (actor_id, id, kind, work_mode, status, created_at) VALUES ('${rt.actor.actorId}', 'bgjob-x', 'shell', 'build', 'running', 1)`);
    db.exec(`INSERT INTO fibers (actor_id, id, name, snapshot, created_at) VALUES ('${rt.actor.actorId}', 'f1', 'bg:run', '{"phase":"running","jobId":"bgjob-x","kind":"shell"}', 1)`);

    await session.recoverBackgroundJobs();

    await session.settleBackgroundWork();
    await session.flushPendingDrains();
    expect(jobStatus(db, 'bgjob-x')).toBe('failed');
    expect(jobError(db, 'bgjob-x')).toContain('interrupted');
    expect(db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM fibers`).get()?.c).toBe(0);
    expect(db.query(`SELECT COUNT(*) c FROM fibers WHERE id='f1'`).get()).toEqual({ c: 0 });
    expect(events.items.some((e) => e.type === 'turn-start' && e.kind === 'programmatic' && e.event === 'background_job')).toBe(true);
  });

  test('recoverBackgroundJobs fails an orphaned agents job whose row names an action the tool no longer has', async () => {
    const { db, rt, session } = setup();

    for (const [id, fiber, action] of [['bgjob-fork', 'f4', 'fork'], ['bgjob-probe', 'f5', 'probe']] as const) {
      const input = JSON.stringify({ action, task: 'finish the interrupted exploration' });
      db.exec(`INSERT INTO background_jobs (actor_id, id, kind, work_mode, status, input_json, created_at) VALUES ('${rt.actor.actorId}', '${id}', 'agents', 'build', 'running', '${input}', 1)`);
      db.exec(`INSERT INTO fibers (actor_id, id, name, snapshot, created_at) VALUES ('${rt.actor.actorId}', '${fiber}', 'bg:agents', '{"phase":"running","jobId":"${id}","kind":"agents"}', 1)`);
    }

    await session.recoverBackgroundJobs();
    // Recovered in row order, so the fork row is settled by the time the probe row is.
    await session.settleBackgroundWork();

    // `fork` is refused exactly as an action the tool never had.
    expect({ status: jobStatus(db, 'bgjob-fork'), error: jobError(db, 'bgjob-fork') })
      .toEqual({ status: 'failed', error: jobError(db, 'bgjob-probe') });
  });

  test('end() waits for a detached job to settle instead of closing the database under it', async () => {
    const { db, rt, session } = setup('unused', fakeModel('slow answer'));
    const input = JSON.stringify({ action: 'swarm', preset: 'ideate', task: 'finish the interrupted exploration' });
    db.exec(`INSERT INTO background_jobs (actor_id, id, kind, work_mode, status, input_json, created_at) VALUES ('${rt.actor.actorId}', 'bgjob-s', 'agents', 'build', 'running', '${input}', 1)`);
    db.exec(`INSERT INTO fibers (actor_id, id, name, snapshot, created_at) VALUES ('${rt.actor.actorId}', 'f3', 'bg:agents', '{"phase":"running","jobId":"bgjob-s","kind":"agents"}', 1)`);

    await session.recoverBackgroundJobs();
    expect(jobStatus(db, 'bgjob-s')).toBe('running');

    await session.end();
    expect(jobStatus(db, 'bgjob-s')).toBe('completed');
    expect(db.query(`SELECT COUNT(*) c FROM fibers`).get()).toEqual({ c: 0 });
  });

  test('settleBackgroundWork drives a detached job\'s wake turn to completion', async () => {
    // A one-shot `kinu exec` must not close before the wake turn a background job triggers; settleBackgroundWork drains both.
    const { db, rt, session, events } = setup('synthesized the background result');
    db.exec(`INSERT INTO background_jobs (actor_id, id, kind, work_mode, status, created_at) VALUES ('${rt.actor.actorId}', 'bgjob-w', 'shell', 'build', 'running', 1)`);
    db.exec(`INSERT INTO fibers (actor_id, id, name, snapshot, created_at) VALUES ('${rt.actor.actorId}', 'fw', 'bg:run', '{"phase":"running","jobId":"bgjob-w","kind":"shell"}', 1)`);

    await session.recoverBackgroundJobs();
    await session.settleBackgroundWork();

    const order = events.items.filter((e) => e.type === 'turn-start' || e.type === 'turn-end');
    const wakeStartIdx = order.findIndex((e) => e.type === 'turn-start' && e.kind === 'programmatic' && e.event === 'background_job');
    expect(wakeStartIdx).toBeGreaterThanOrEqual(0);
    const noticeAt = events.items.findIndex((event) => event.type === 'background' && event.event === 'background_job_notice');
    const wakeAt = events.items.findIndex((event) => event.type === 'turn-start' && event.event === 'background_job');
    expect(noticeAt).toBeGreaterThanOrEqual(0);
    expect(noticeAt).toBeLessThan(wakeAt);
    expect(JSON.stringify(events.items[noticeAt])).toContain('bgjob-w failed');
    expect(order.slice(wakeStartIdx + 1).some((e) => e.type === 'turn-end')).toBe(true);
    expect(db.query(`SELECT COUNT(*) c FROM fibers`).get()).toEqual({ c: 0 });
  });

  test('settleBackgroundWork gives up on work that never settles, and leaves it running', async () => {
    // `kinu exec` must not block on a detached server-style `shell` fiber that never settles.
    const clock = handClock();

    const { db, rt, session, events } = setup('unused', hangingModel(), {
      backgroundPolicy: { detachAfterMs: 10_000, settleGraceMs: 150, wakesAfterTurn: true }, clock,
    });

    const input = JSON.stringify({ action: 'swarm', preset: 'ideate', task: 'start the server' });
    db.exec(`INSERT INTO background_jobs (actor_id, id, kind, work_mode, status, input_json, created_at) VALUES ('${rt.actor.actorId}', 'bgjob-hang', 'agents', 'build', 'running', '${input}', 1)`);
    db.exec(`INSERT INTO fibers (actor_id, id, name, snapshot, created_at) VALUES ('${rt.actor.actorId}', 'fh', 'bg:agents', '{"phase":"running","jobId":"bgjob-hang","kind":"agents"}', 1)`);

    await session.recoverBackgroundJobs();
    expect(jobStatus(db, 'bgjob-hang')).toBe('running');

    const settled = session.settleBackgroundWork();
    await joining(events);
    passGrace(clock, 150);
    await settled;

    expect(jobStatus(db, 'bgjob-hang')).toBe('running');
    expect(events.items.some((e) => e.type === 'background' && e.event === 'bg_jobs_abandoned')).toBe(true);
  });

  test('abandoning work says it will be resumed on this machine, unattended, and how to stop it', async () => {
    const { db, rt, session, events } = setup('unused', hangingModel(), {
      backgroundPolicy: { detachAfterMs: 10_000, settleGraceMs: 50, wakesAfterTurn: true },
    });

    const input = JSON.stringify({ action: 'swarm', preset: 'ideate', task: 'edit the target file' });
    db.exec(`INSERT INTO background_jobs (actor_id, id, kind, label, work_mode, status, input_json, created_at)
      VALUES ('${rt.actor.actorId}', 'bgjob-quiet', 'agents', 'mcts: edit the target file', 'build', 'running', '${input}', 1)`);
    db.exec(`INSERT INTO fibers (actor_id, id, name, snapshot, created_at) VALUES ('${rt.actor.actorId}', 'fq', 'bg:agents', '{"phase":"running","jobId":"bgjob-quiet","kind":"agents"}', 1)`);
    await session.recoverBackgroundJobs();

    const stderrLines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { stderrLines.push(args.map(String).join(' ')); };

    try {
      await session.settleBackgroundWork();
    } finally {
      console.error = originalError;
    }

    const notice = events.items.find((e) => e.type === 'background' && e.event === 'bg_jobs_abandoned');
    const message = notice?.type === 'background' ? notice.message : '';
    expect(message).toContain('bgjob-quiet');
    expect(message).toContain('mcts: edit the target file');
    expect(message).toContain('local scheduler daemon');
    expect(message).toContain('writes files');
    expect(message).toMatch(/kinu jobs \S+ cancel <id>/);
    expect(stderrLines.some((line) => line.includes('bgjob-quiet'))).toBe(true);
  });

  // Main's queue, 2026-10-02: a long build showed nothing in the TUI until it finished.
  test("a detached command's output reaches the session's clients as job frames before the job settles", async () => {
    // Still running when its zero window passes, so a job takes it.
    const command = "echo compiled; echo 'warn: chunk size' 1>&2; sleep 0.2; echo built";

    const { session, events } = setup('unused', toolSequenceModel([{ name: 'shell', input: { command, why: 'build' } }]), {
      // A zero window: the call becomes a job because it has not finished, not because time passed.
      backgroundPolicy: { detachAfterMs: 0, settleGraceMs: 60_000, wakesAfterTurn: true },
    });

    await session.send('build it', { id: crypto.randomUUID() });
    await session.settleBackgroundWork();

    const frames = events.items.flatMap((event) => {
      const frame = event.type === 'broadcast' ? v.safeParse(JobOutputFrameSchema, event.event) : null;

      return frame?.success === true ? [frame.output] : [];
    });

    const printed = { stdout: '', stderr: '' };

    for (const { chunks } of frames) for (const { stream, text } of chunks) printed[stream] += text;

    expect(frames.map(({ seq }) => seq)).toEqual(frames.map((_, index) => index + 1));
    expect(printed).toEqual({ stdout: 'compiled\nbuilt\n', stderr: 'warn: chunk size\n' });

    const settledAt = events.items.findIndex((event) => event.type === 'background' && event.event === 'background_job_notice');
    const lastFrameAt = events.items.map((event) => event.type === 'broadcast' && v.is(JobOutputFrameSchema, event.event)).lastIndexOf(true);
    expect(lastFrameAt).toBeGreaterThanOrEqual(0);
    expect(lastFrameAt).toBeLessThan(settledAt);
    await session.end();
  });

  test('end() releases the session when a fiber will never settle', async () => {
    const clock = handClock();

    const { db, rt, session, events } = setup('unused', hangingModel(), {
      backgroundPolicy: { detachAfterMs: 10_000, settleGraceMs: 150, wakesAfterTurn: true }, clock,
    });

    const input = JSON.stringify({ action: 'swarm', preset: 'ideate', task: 'start the server' });
    db.exec(`INSERT INTO background_jobs (actor_id, id, kind, work_mode, status, input_json, created_at) VALUES ('${rt.actor.actorId}', 'bgjob-e', 'agents', 'build', 'running', '${input}', 1)`);
    db.exec(`INSERT INTO fibers (actor_id, id, name, snapshot, created_at) VALUES ('${rt.actor.actorId}', 'fe', 'bg:agents', '{"phase":"running","jobId":"bgjob-e","kind":"agents"}', 1)`);

    await session.recoverBackgroundJobs();
    const ended = session.end();
    await joining(events);
    passGrace(clock, 150);
    await ended;
    expect(jobStatus(db, 'bgjob-e')).toBe('running');
  });

  test('a one-shot drain then close pays the grace once, not twice', async () => {
    // settleBackgroundWork() then end() on the same job share one deadline, so end() arms no second grace.
    const clock = handClock();

    const { db, rt, session, events } = setup('unused', hangingModel(), {
      backgroundPolicy: { detachAfterMs: 10_000, settleGraceMs: 2_000, wakesAfterTurn: true }, clock,
    });

    const input = JSON.stringify({ action: 'swarm', preset: 'ideate', task: 'start the server' });
    db.exec(`INSERT INTO background_jobs (actor_id, id, kind, work_mode, status, input_json, created_at) VALUES ('${rt.actor.actorId}', 'bgjob-2x', 'agents', 'build', 'running', '${input}', 1)`);
    db.exec(`INSERT INTO fibers (actor_id, id, name, snapshot, created_at) VALUES ('${rt.actor.actorId}', 'f2x', 'bg:agents', '{"phase":"running","jobId":"bgjob-2x","kind":"agents"}', 1)`);

    await session.recoverBackgroundJobs();
    const settled = session.settleBackgroundWork();
    await joining(events);
    passGrace(clock, 2_000);
    await settled;

    const secondGrace = clock.whenArmed(2).then(() => 'a second grace');
    expect(await Promise.race([session.end().then(() => 'ended'), secondGrace])).toBe('ended');
  });

  test('a long tool call runs inline under a policy whose threshold it does not cross', async () => {
    const { db, session, events } = setup(
      'unused',
      codemodeModel('await new Promise(r => setTimeout(r, 120));\n"computed inline"'),
      { backgroundPolicy: { detachAfterMs: 10_000, settleGraceMs: 150, wakesAfterTurn: true } },
    );

    await session.send('do the long thing', { id: crypto.randomUUID() });

    expect(events.items.some((e) => e.type === 'background' && e.event === 'bg_job_started')).toBe(false);
    expect(db.query(`SELECT COUNT(*) c FROM background_jobs`).get()).toEqual({ c: 0 });
    const result = events.items.find((event) => event.type === 'tool-result');
    expect(JSON.stringify(result?.result)).toContain('computed inline');
  });

  test('the CLI sandbox binds state.* as the shared docstring promises', async () => {
    // The shared `eval` description promises `state.set`/`state.get`; the CLI factory list must bind the provider.
    const { session, events } = setup(
      'unused',
      codemodeModel('await state.set("probe", "found")\nawait state.get("probe")'),
      { backgroundPolicy: { detachAfterMs: 10_000, settleGraceMs: 150, wakesAfterTurn: true } },
    );

    await session.send('remember this', { id: crypto.randomUUID() });
    const result = events.items.find((event) => event.type === 'tool-result');
    expect(JSON.stringify(result?.result)).toContain('found');
  });

  test('the same call detaches once it crosses the policy threshold', async () => {
    const { db, rt, session, events } = setup(
      'unused',
      codemodeModel('await new Promise(r => setTimeout(r, 200));\nreturn "computed late";'),
      { backgroundPolicy: { detachAfterMs: 20, settleGraceMs: 5_000, wakesAfterTurn: true } },
    );

    await session.send('do the long thing', { id: crypto.randomUUID() });
    await session.settleBackgroundWork();

    expect(events.items.some((e) => e.type === 'background' && e.event === 'bg_job_started')).toBe(true);
    expect(db.query(`SELECT COUNT(*) c FROM background_jobs`).get()).toEqual({ c: 1 });
    const [job] = new BackgroundJobStore(rt.storage.sql, rt.actor).list(2);

    if (!job) throw new Error('detached job is missing');

    const notices = events.items.filter((event) => event.type === 'background' && event.event === 'background_job_notice');
    expect(notices).toEqual([{ type: 'background', event: 'background_job_notice', message: backgroundJobNotice(job).body }]);
    expect(JSON.stringify(notices)).toContain('computed late');
  });

  test('past the concurrent-job cap a crossing call stays foreground and settles', async () => {
    const { db, rt, session, events } = setup(
      'unused',
      codemodeModel('await new Promise(r => setTimeout(r, 200));\n"never detached"'),
      { backgroundPolicy: { detachAfterMs: 20, settleGraceMs: 500, wakesAfterTurn: true } },
    );

    for (let i = 0; i < MAX_CONCURRENT_DETACHED_JOBS; i++) {
      db.exec(`INSERT INTO background_jobs (actor_id, id, kind, work_mode, status, created_at) VALUES ('${rt.actor.actorId}', 'busy-${i}', 'shell', 'build', 'running', 1)`);
    }

    await session.send('start another one', { id: crypto.randomUUID() });

    expect(db.query(`SELECT COUNT(*) c FROM background_jobs`).get()).toEqual({ c: MAX_CONCURRENT_DETACHED_JOBS });
    expect(events.items.some((e) => e.type === 'background' && e.event === 'bg_job_started')).toBe(false);
    expect(events.items.some((e) => e.type === 'background' && e.event === 'bg_job_refused')).toBe(true);
    const result = events.items.find((event) => event.type === 'tool-result');
    const text = JSON.stringify(result?.result);
    expect(text).toContain('never detached');
    expect(text).not.toContain('CANCELLED');
  });

  test('toolNames exposes the full surface (agents/memory parity); end() resolves', async () => {
    const { session } = setup();
    const names = session.toolNames();

    for (const t of ['shell', 'eval', 'memory', 'agents']) expect(names).toContain(t);
    expect(names).not.toContain('skills');
    expect(names).not.toContain('fact');
    await session.send('hi', { id: crypto.randomUUID() });
    await session.end();
  });

  test('a native file read authorizes workspace.writeFile in the same CLI turn', async () => {
    const model = toolSequenceModel([
      { name: 'file', input: { action: 'read', path: 'shared.txt' } },
      {
        name: 'eval',
        input: { code: 'return await workspace.writeFile("shared.txt", "changed by codemode");' },
      },
    ]);

    const { rt, session } = setup('unused', model);
    await writeText(rt.storage.vfs, 'shared.txt', 'original');

    await session.send('read it natively, then replace it through codemode', { id: crypto.randomUUID() });

    expect(await readText(rt.storage.vfs, 'shared.txt'))
      .toBe('changed by codemode');
  });

  test('a workspace.readFile authorizes native file write in the same CLI turn', async () => {
    const model = toolSequenceModel([
      {
        name: 'eval',
        input: { code: 'return await workspace.readFile("shared.txt");' },
      },
      {
        name: 'file',
        input: { action: 'write', path: 'shared.txt', content: 'changed by native file' },
      },
    ]);

    const { rt, session } = setup('unused', model);
    await writeText(rt.storage.vfs, 'shared.txt', 'original');

    await session.send('read it through codemode, then replace it natively', { id: crypto.randomUUID() });

    expect(await readText(rt.storage.vfs, 'shared.txt'))
      .toBe('changed by native file');
  });

  test('a background job that settles WHILE the same multi-step turn is still running reaches the model at its next step — no polling required', async () => {
    // Does the wake reach a later step of the same streamText turn without the model polling agent.jobResult?
    // Third step's model-bound messages are captured.
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    const capturedSteps: PromptMessage[][] = [];
    let step = 0;

    const model: LanguageModel = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async (options) => {
        step += 1;
        capturedSteps.push(options.prompt);

        if (step === 2) {
          await new Promise((r) => setTimeout(r, 150));
        }

        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });

              if (step === 1) {
                controller.enqueue({
                  toolCallId: 'call-1', type: 'tool-call', toolName: 'eval',
                  input: JSON.stringify({ code: 'await new Promise(r => setTimeout(r, 60)); return "slow-done";' }),
                });
                controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
              } else if (step === 2) {
                controller.enqueue({
                  toolCallId: 'call-2', type: 'tool-call', toolName: 'eval',
                  input: JSON.stringify({ code: '"noop"' }),
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

    const { session } = setup('unused', model, { backgroundPolicy: { detachAfterMs: 10, settleGraceMs: 5_000, wakesAfterTurn: true } });
    await session.send('do the slow thing then finish', { id: crypto.randomUUID() });

    expect(step).toBeGreaterThanOrEqual(3);
    const thirdStepMessages = capturedSteps[2];

    const injectedTexts = thirdStepMessages
      .filter((m) => m.role === 'user')
      .map((m) => JSON.stringify(m.content));

    const wakeText = injectedTexts.find((t) => t.includes('Background') && t.includes('completed'));

    expect(wakeText).toBeDefined();
    expect(wakeText).toContain('eval');
    expect(wakeText).toContain("agent.jobResult('");
    await session.end();
  });
});

describe('LocalAgentSession — turn rating review (Hermes-style forked review)', () => {
  function setupWithEvolution(
    reads: 'accepted' | 'corrected',
    opts: { oneShot?: boolean; model?: LanguageModel } = {},
  ) {
    const db = new Database(scratchPath('local-session-review', 'agent.db'));
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const rt = createCLIRuntime(db, { llm: DUMMY_LLM });
    // The rating rides rt.decide and the reflection rt.llm.complete; both are stubbed so the review runs offline.
    const completions: string[] = [];

    const reviewLlm = {
      stream: rt.llm.stream.bind(rt.llm),
      complete: async (prompt: string) => {
        completions.push(prompt);

        return 'verify the cluster name before rotating keys';
      },
    };

    rt.decide = async ({ state }) => {
      completions.push(state);

      return { answers: reads === 'corrected'
        ? { satisfaction: { type: 'score', score: 0.5 }, corrected: { type: 'noul', noul: 0.95 }, wrong: { type: 'choice', choice: 'misunderstood' } }
        : { satisfaction: { type: 'score', score: 3.6 }, corrected: { type: 'noul', noul: 0.02 }, wrong: { type: 'choice', choice: 'nothing' } },
      usage: {} };
    };

    Object.defineProperty(rt, 'llm', { value: reviewLlm });
    const events = new AwaitedList<SessionEvent>();

    const sessionOpts: LocalAgentSessionOpts = {
      rt, db,
      model: opts.model ?? fakeModel('rotated the production keys'),
      onEvent: (e) => events.push(e),
    };

    if (opts.oneShot) {
      sessionOpts.oneShot = true;
      sessionOpts.backgroundPolicy = BACKGROUND_POLICY['one-shot'];
    }

    const session = new LocalAgentSession(sessionOpts);
    rt.setModelForRoute?.(() => reviewLlm);

    return { db, rt, session, events, completions, reviewLlm };
  }

  const ratings = (db: Database) => db.query<{ c: number }, []>('SELECT count(*) AS c FROM turn_ratings').get()?.c;

  test('the next user message rates the previous turn into the durable rating ledger', async () => {
    const { db, rt, session } = setupWithEvolution('corrected');

    await session.send('please rotate the API keys for the staging cluster', { id: crypto.randomUUID() });
    await session.send('no — I said STAGING, you rotated production', { id: crypto.randomUUID() });

    await session.end();

    const row = db.query<{ score: number; source: string; turn_id: string; followup: string }, []>(
      'SELECT score, source, turn_id, followup FROM turn_ratings',
    ).get();

    if (!row) throw new Error('turn rating row is missing');
    expect(row.score).toBe(1.5);
    expect(row.source).toBe('model');
    expect(row.followup).toContain('STAGING');

    const firstAssistant = (await transcript(rt)).find((entry) => entry.role === 'assistant');

    if (!firstAssistant) throw new Error('first assistant entry is missing');
    expect(row.turn_id).toBe(firstAssistant.id);

    expect(db.query<{ c: number }, []>(
      `SELECT count(*) AS c FROM lessons WHERE status = 'corroborated'`,
    ).get()?.c).toBe(1);
  });

  test('trivial turns (greetings) skip the rating entirely', async () => {
    const { db, session, completions } = setupWithEvolution('accepted');

    await session.send('hi', { id: crypto.randomUUID() });
    await session.send('thanks!', { id: crypto.randomUUID() });
    await session.end();
    expect(ratings(db)).toBe(0);
    expect(completions).toEqual([]);
  });

  // `kinu exec` is one process per turn, so the evolution window and pending review must outlive the session object.
  test('the window and the pending review survive end() — the next run rates the turn', async () => {
    const { db, rt, session, reviewLlm } = setupWithEvolution('corrected');

    await session.send('please summarize the deployment runbook for me', { id: crypto.randomUUID() });
    await session.end();

    expect(ratings(db)).toBe(0);
    expect(db.query<{ c: number }, []>(
      `SELECT count(*) AS c FROM completed_turns WHERE in_window = 1`,
    ).get()?.c).toBe(1);

    const next = new LocalAgentSession({ rt, db, model: fakeModel('here is the runbook'), onEvent: () => {} });
    rt.setModelForRoute?.(() => reviewLlm);
    await next.send('no — that summary missed the rollback step entirely', { id: crypto.randomUUID() });
    await next.end();

    expect(db.query<{ score: number; source: string }, []>('SELECT score, source FROM turn_ratings').get())
      .toEqual({ score: 1.5, source: 'model' });
    expect(db.query<{ c: number }, []>(
      `SELECT count(*) AS c FROM completed_turns WHERE in_window = 1`,
    ).get()?.c).toBe(2);
  });

  // A one-shot process defers its review rather than joining it; joining cost more than the turn itself.
  test('a one-shot end() waits ~0ms on the turn lane while the review sits durably owed', async () => {
    const { db, session, completions } = setupWithEvolution('accepted', { oneShot: true, model: runThenAnswerModel() });

    await session.send('run the build and report', { id: crypto.randomUUID() });

    const timings = await captureSettleTimings(() => session.end());

    // The settle-timings line is quiet under 1s; the proof of no join is that no review call was issued.
    if (timings) expect(timings.evolutionMs).toBeLessThan(100);
    expect(completions).toEqual([]);
    expect(ratings(db)).toBe(0);
    expect(db.query<{ c: number }, []>(`SELECT count(*) AS c FROM completed_turns WHERE review = 'queued'`).get()?.c)
      .toBeGreaterThanOrEqual(1);
  });

  test('the next open runs the deferred review, and with no reply nothing is rated', async () => {
    const { db, rt, session } = setupWithEvolution('corrected', { oneShot: true, model: runThenAnswerModel() });

    await session.send('run the build and report', { id: crypto.randomUUID() });
    await session.end();
    const owed = db.query<{ c: number }, []>(`SELECT count(*) AS c FROM completed_turns WHERE review = 'queued'`).get()?.c ?? 0;
    expect(owed).toBeGreaterThanOrEqual(1);

    const events = new AwaitedList<SessionEvent>();

    const next = new LocalAgentSession({
      rt, db, model: fakeModel('here is the runbook'), onEvent: (e) => events.push(e),
    });

    await next.recoverBackgroundJobs();

    // A one-shot turn has no follow-up: its tools ran, and that rates nothing.
    expect(ratings(db)).toBe(0);
    expect(db.query<{ c: number }, []>(`SELECT count(*) AS c FROM completed_turns WHERE review = 'queued'`).get()?.c).toBe(0);
    expect(events.items.some((e) => e.type === 'evolution' && e.event === 'deferred_reviews_drained')).toBe(true);
    await next.end();
  });

  test('a corrupt deferred row is refused at the next open — no rating is invented', async () => {
    const { db, rt } = setupWithEvolution('accepted');
    // A real owned row (owner as `deferTurnReview` supplies it) with only a truncated `turn`; a missing owner would
    // hit NOT NULL instead, a different refusal.
    db.query(`INSERT INTO completed_turns (actor_id, id, turn, followup, in_window, review, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(rt.actor.actorId, 'rev-corrupt', '{truncated', null, 0, 'queued', 1);

    const events = new AwaitedList<SessionEvent>();

    const next = new LocalAgentSession({
      rt, db, model: fakeModel('ok'), onEvent: (e) => events.push(e),
    });

    await next.recoverBackgroundJobs();

    expect(ratings(db)).toBe(0);
    expect(db.query<{ c: number }, []>(`SELECT count(*) AS c FROM completed_turns WHERE review = 'queued'`).get()?.c).toBe(0);

    const drained = events.items.flatMap((e) =>
      e.type === 'evolution' && e.event === 'deferred_reviews_drained' ? [e.message] : []);

    expect(drained).toEqual(['0 deferred turn review(s) run, 1 unreadable row(s) dropped']);
    await next.end();
  });

  test('a one-shot open does NOT re-drive — the cost would only move to the next task', async () => {
    const { db, rt, session } = setupWithEvolution('accepted', { oneShot: true });

    await session.send('write the report', { id: crypto.randomUUID() });
    await session.end();
    expect(db.query<{ c: number }, []>(`SELECT count(*) AS c FROM completed_turns WHERE review = 'queued'`).get()?.c).toBe(1);

    const nextExec = new LocalAgentSession({
      rt, db, model: fakeModel('ok'), onEvent: () => {}, oneShot: true,
      backgroundPolicy: BACKGROUND_POLICY['one-shot'],
    });

    await nextExec.recoverBackgroundJobs();
    expect(db.query<{ c: number }, []>(`SELECT count(*) AS c FROM completed_turns WHERE review = 'queued'`).get()?.c).toBe(1);
    expect(ratings(db)).toBe(0);
    await nextExec.end();
  });
});
