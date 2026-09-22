/** runScaffold with a mock Executor that runs the scaffold's `shell` body and emits canned events. */

import { describe, test, expect } from 'bun:test';
import {
  runScaffold, scaffoldEventText,
  type ScaffoldEvent,
  type ScaffoldEmitFn,
} from '../src/scaffold/executor';
import type { ChatEvent } from '../src/chat';
import type { Executor, ResolvedProvider } from '../src/types/primitives';
import type { JsonObject } from '../src/utils/json';
import { createTestRuntime } from './helpers';

function makeRtWithMockedExecutor(execute: Executor['execute']) {
  const { rt } = createTestRuntime();
  rt.executor = { languages: ['javascript'], execute };

  return rt;
}

function hostProvider(
  providers: Parameters<Executor['execute']>[1],
): ResolvedProvider {
  if (!Array.isArray(providers)) throw new Error('expected resolved providers');
  const host = providers.find((provider) => provider.name === 'host');

  if (!host) throw new Error('no host provider');

  return host;
}

async function* asyncOf(...items: ChatEvent[]): AsyncIterable<ChatEvent> {
  for (const i of items) yield i;
}

describe('runScaffold', () => {
  test('forwards emits through to the emit callback', async () => {
    const events: ScaffoldEvent[] = [];
    const emit: ScaffoldEmitFn = (e) => { events.push(e); };

    const rt = makeRtWithMockedExecutor(async (_code, providers) => {
      const host = hostProvider(providers);
      await host.fns.emit({ type: 'text_delta', text: 'hello ' });
      await host.fns.emit({ type: 'text_delta', text: 'world' });
      await host.fns.emit({ type: 'done', result: { ok: true } });

      return { result: undefined };
    });

    rt.identity.scaffold.read = async () => 'async function run() { /* mocked */ }';

    const result = await runScaffold({
      rt, task: 'sample',
      emit,
      llmStream: () => asyncOf(),
    });

    expect(result.ok).toBe(true);
    expect(result.doneEmitted).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.map((e) => e.type)).toContain('text_delta');
    expect(events.map((e) => e.type)).toContain('done');
  });

  test('captures errors from executor and returns ok=false', async () => {
    const events: ScaffoldEvent[] = [];
    const rt = makeRtWithMockedExecutor(async () => ({ result: undefined, error: 'boom' }));
    rt.identity.scaffold.read = async () => 'async function run() {}';

    const result = await runScaffold({
      rt, task: 'x', emit: (e) => { events.push(e); }, llmStream: () => asyncOf(),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('boom');
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  test('returns ok=false if scaffold code is empty', async () => {
    const events: ScaffoldEvent[] = [];
    const rt = makeRtWithMockedExecutor(async () => ({ result: undefined }));
    rt.identity.scaffold.read = async () => '   ';

    const result = await runScaffold({
      rt, task: 'x', emit: (e) => { events.push(e); }, llmStream: () => asyncOf(),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/empty/i);
  });

  test('synthesizes a done event if scaffold completes without emitting one', async () => {
    const events: ScaffoldEvent[] = [];

    const rt = makeRtWithMockedExecutor(async (_code, providers) => {
      const host = hostProvider(providers);
      await host.fns.emit({ type: 'text_delta', text: 'partial' });

      return { result: undefined };
    });

    rt.identity.scaffold.read = async () => 'async function run() {}';

    const result = await runScaffold({
      rt, task: 'x', emit: (e) => { events.push(e); }, llmStream: () => asyncOf(),
    });

    expect(result.ok).toBe(true);
    // The synthesized 'done' fires after exec completes, so it is not in result.events.
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  test('shadow-mode override uses scaffoldCodeOverride instead of reading rt', async () => {
    const events: ScaffoldEvent[] = [];
    let receivedCode = '';

    const rt = makeRtWithMockedExecutor(async (code) => {
      receivedCode = code;

      return { result: undefined };
    });

    rt.identity.scaffold.read = async () => 'CURRENT SCAFFOLD';

    await runScaffold({
      rt, task: 'x',
      emit: (e) => { events.push(e); },
      llmStream: () => asyncOf(),
      scaffoldCodeOverride: 'PENDING SCAFFOLD',
    });

    expect(receivedCode).toContain('PENDING SCAFFOLD');
    expect(receivedCode).not.toContain('CURRENT SCAFFOLD');
  });

  test('host.callTool dispatches to provided callTool fn', async () => {
    const calls: Array<{ name: string; args: JsonObject }> = [];

    const rt = makeRtWithMockedExecutor(async (_code, providers) => {
      const host = hostProvider(providers);
      const result = await host.fns.callTool('save_note', { content: 'hi' });

      return { result };
    });

    rt.identity.scaffold.read = async () => 'async function run() {}';

    const result = await runScaffold({
      rt, task: 'x',
      emit: () => undefined,
      llmStream: () => asyncOf(),
      callTool: async (name, args) => {
        calls.push({ name, args });

        return 'ok';
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ name: 'save_note', args: { content: 'hi' } }]);
  });
  test('host.llmStream preserves the visible text of native model events', async () => {
    const events: ScaffoldEvent[] = [];

    const rt = makeRtWithMockedExecutor(async (_code, providers) => {
      const host = hostProvider(providers);
      const text = await host.fns.llmStream({ system: 's', messages: [] });

      return { result: text };
    });

    rt.identity.scaffold.read = async () => 'async function run() {}';

    await runScaffold({
      rt, task: 'x',
      emit: (e) => { events.push(e); },
      llmStream: () => asyncOf({ type: 'text-delta', delta: 'one ' }, { type: 'text-delta', delta: 'two ' }, { type: 'text-delta', delta: 'three' }),
    });

    const deltas = events.map(scaffoldEventText).filter(text => text !== null);
    expect(deltas).toEqual(['one ', 'two ', 'three']);
  });

  test('a scaffold run stays pending until the executor completes — no elapsed deadline cuts it', async () => {
    const events: ScaffoldEvent[] = [];
    const gate = Promise.withResolvers<void>();
    let released = false;

    const rt = makeRtWithMockedExecutor(async (_code, providers) => {
      await gate.promise;
      released = true;
      const host = hostProvider(providers);
      await host.fns.emit({ type: 'text_delta', text: 'finally done' });

      return { result: undefined };
    });

    rt.identity.scaffold.read = async () => 'async function run() {}';

    const run = runScaffold({
      rt, task: 'x', emit: (e) => { events.push(e); }, llmStream: () => asyncOf(),
    });

    // No elapsed deadline races the run.
    await Promise.resolve();
    expect(released).toBe(false);

    gate.resolve();
    const result = await run;

    expect(released).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
  });

  test('a throwing generator scaffold emits exactly one error event', async () => {
    const events: ScaffoldEvent[] = [];

    const rt = makeRtWithMockedExecutor(async (code, providers) => {
      const arr: ResolvedProvider[] = Array.isArray(providers)
        ? providers
        : [{ name: 'workspace', fns: providers }];

      try {
        const fn = new Function(...arr.map((p) => p.name), `return (async () => {\n${code}\n})();`);
        await fn(...arr.map((p) => p.fns));

        return { result: undefined };
      } catch (err) {
        return { result: undefined, error: err instanceof Error ? err.message : String(err) };
      }
    });

    const result = await runScaffold({
      rt, task: 'x', emit: (e) => { events.push(e); }, llmStream: () => asyncOf(),
      scaffoldCodeOverride: `async function* run(rt, task) { throw new Error('boom'); }`,
    });

    expect(result.ok).toBe(false);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
  });
});
