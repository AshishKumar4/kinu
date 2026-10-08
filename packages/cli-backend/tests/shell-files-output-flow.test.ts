/**
 * One CLI turn through the shell, the files and their output: what the workspace row claims runs, a clamped output's
 * advertised remedy restores it, a call to a machine nobody registered is refused, and every call's row carries its
 * duration, the refused one too.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import type { LanguageModelV2CallOptions, LanguageModelV2Prompt } from '@ai-sdk/provider';
import { DEFAULT_TOOL_RESULT_MAX_CHARS, TOOLCHAIN_PROBE_BINARIES, TOOLCHAIN_PROBED_CAPABILITIES, TOOLCHAIN_UNPROBEABLE, initWorkspaceSchema, toolchainCapabilities, type JsonObject } from '@kinu.run/core';
import { scratchDir, scratchPath, workspaceDatabase } from '@kinu.run/test-utils';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession } from '../src/local-session';
import { DUMMY_LLM } from './helpers/local-session';
import { TestLanguageModelV2 } from './test-language-model';

const USAGE = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

const BIG = `awk 'BEGIN { for (i = 0; i < 9000; i++) print "padding log line", i; print "FINAL-ERROR-LINE" }'`;

/** Every tool result the model was shown, in order, as the text it reads. */
function results(prompt: LanguageModelV2Prompt): string[] {
  return prompt.flatMap((message) => (message.role === 'tool' ? message.content.map((part) => JSON.stringify(part.output)) : []));
}

/** A model that runs `steps` in order, each choosing its call from the results it has been shown, then answers. */
function scripted(steps: ReadonlyArray<(shown: string[]) => { name: string; input: JsonObject }>, requests: LanguageModelV2CallOptions[]) {
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async (options) => {
      requests.push(options);
      const shown = results(options.prompt);
      const step = steps[shown.length];
      const call = step?.(shown);

      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });

            if (call) {
              controller.enqueue({ type: 'tool-call', toolCallId: `call-${String(shown.length)}`, toolName: call.name, input: JSON.stringify(call.input) });
              controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: USAGE });
            } else {
              controller.enqueue({ type: 'text-start', id: '0' });
              controller.enqueue({ type: 'text-delta', id: '0', delta: 'done' });
              controller.enqueue({ type: 'text-end', id: '0' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage: USAGE });
            }

            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
}

test('a CLI turn runs what its row claims, restores a clamped output from the path it names, and times every call', async () => {
  const db = workspaceDatabase(scratchPath('shell-files-output-flow', 'agent.db'));
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { cwd: scratchDir('shell-files-output-flow-folder'), llm: DUMMY_LLM });
  rt.actor.config.setLearning(false);

  const requests: LanguageModelV2CallOptions[] = [];
  const offload = (shown: string[]): string => /full result at (\S+?)\]/.exec(shown[1] ?? '')?.[1] ?? 'no-offload-path';

  const model = scripted([
    () => ({ name: 'shell', input: { command: `for b in ${TOOLCHAIN_PROBE_BINARIES.join(' ')}; do command -v "$b" >/dev/null && echo "on-path:$b"; done; true` } }),
    () => ({ name: 'shell', input: { command: BIG } }),
    (shown) => ({ name: 'shell', input: { command: `grep FINAL-ERROR-LINE ${offload(shown)}` } }),
    (shown) => ({ name: 'file', input: { op: 'read', path: offload(shown) } }),
    (shown) => ({ name: 'shell', input: { runtime: 'device', command: `grep FINAL-ERROR-LINE ${offload(shown)}` } }),
  ], requests);

  const session = new LocalAgentSession({ rt, db, model, onEvent: () => {} });

  try {
    await session.send('Check the build log.', { id: crypto.randomUUID() });
    await session.settleBackgroundWork();
  } finally {
    await session.end();
  }

  const shown = results(requests.at(-1)?.prompt ?? []);
  expect(shown).toHaveLength(5);

  // The row claims a toolchain exactly where a binary that runs it answers in the turn's own shell.
  const row = /- workspace: active[^,]*, runs: ([^\\]*)/.exec(JSON.stringify(requests[0]?.prompt))?.[1] ?? '';
  const [claimedPart = '', unmeasured = ''] = row.split(', not measured here: ');
  const probed = new Set<string>(TOOLCHAIN_PROBED_CAPABILITIES);
  const claimed = claimedPart.split(', ').filter((capability) => probed.has(capability));
  const onPath = [...(shown[0] ?? '').matchAll(/on-path:([\w.-]+)/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));

  expect(onPath).toContain('bun');
  expect(claimed.sort()).toEqual(toolchainCapabilities(onPath).sort());
  expect(unmeasured.split(', ')).toEqual(TOOLCHAIN_UNPROBEABLE.map(([capability]) => capability));

  // A clamped output names where it is whole; the shell and the file tool both reach what it left out there.
  const text = (at: number): string => v.parse(v.object({ value: v.string() }), JSON.parse(shown[at] ?? '{}')).value;
  const clamped = text(1);
  const hidden = Array.from({ length: 9000 }, (_, i) => `padding log line ${String(i)}\n`).find((line) => !clamped.includes(line)) ?? '';

  expect(clamped.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS);
  expect(clamped).toContain('[truncated;');
  expect(clamped).toContain('FINAL-ERROR-LINE');
  expect(clamped).not.toContain('runtime "workspace"');
  expect(hidden).not.toBe('');
  expect(text(2)).toContain('FINAL-ERROR-LINE');
  expect(text(3)).toContain(hidden);

  // A machine nobody registered is refused, never routed to a second shell.
  expect(shown[4]).toContain('"reason":"unavailable"');
  expect(shown[4]).not.toContain('FINAL-ERROR-LINE');

  const ends = db.query<{ payload: string }, []>("SELECT payload FROM run_events WHERE type = 'tool_call_end' ORDER BY rowid").all()
    .map(({ payload }) => v.parse(v.object({ name: v.string(), durationMs: v.number() }), JSON.parse(payload)));

  expect(ends.map((end) => end.name)).toEqual(['shell', 'shell', 'shell', 'file', 'shell']);
  expect(ends.every((end) => Number.isFinite(end.durationMs))).toBe(true);
  db.close();
});
