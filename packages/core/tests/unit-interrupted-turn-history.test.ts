// An interrupted turn must leave a history a follow-up turn can be built from.
//
// Observed in production (2026-08-16, workspace "Principal ML Researcher"): the
// owner interrupted a turn mid-tool-call and the session stopped being usable —
// `The last turn failed / Tool result is missing for tool call
// call_ed15d29f352a4735e6b01b5.` on every attempt, including `Retry last
// message`. That error is `AI_MissingToolResultsError`, thrown by the AI SDK's
// own prompt assembly (ai/src/prompt/convert-to-language-model-prompt.ts)
// CLIENT-side, before any request: an assistant `tool-call` with no matching
// `tool-result` cannot be turned into a provider prompt. So the failure is a
// pure function of the persisted history, which is why retrying reproduces it
// byte for byte forever.
//
// These tests drive the REAL turn engine against a local scripted provider (no
// live model calls), interrupt it exactly between a tool call and its result,
// and then assert the two things that matter:
//
//   1. the history runChat hands back is one the SDK will assemble — checked by
//      actually running the follow-up turn, not by inspecting shapes;
//   2. the interrupted call carries a terminal result that says what happened,
//      so the next turn knows the call was cut rather than believing it never
//      happened.
//
// Cut the wire (drop `settleUnpairedToolCalls` from chat.ts or from
// assembleTurnMessages) and the follow-up turn throws
// AI_MissingToolResultsError, which is what test 1 and test 3 assert against.
import { describe, test, expect } from 'bun:test';
import { stepCountIs, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { runChat, INTERRUPTED_TURN, type ChatEvent } from '../src/chat';
import { INTERRUPTED_TOOL_RESULT } from '../src/prompting/interrupted-tool-calls';
import { createChatModel } from '../src/llm';

const SSE_HEADERS = { 'content-type': 'text/event-stream' };
const ORPHAN_ID = 'call_ed15d29f352a4735e6b01b5';

function sse(events: string[]): string {
  return events.map((e) => `data: ${e}\n\n`).join('');
}

/** Text + one `run` call, finishing on tool_calls — the shape a turn is in when
 *  the owner presses stop. */
function toolStep(id: string): Response {
  return new Response(sse([
    JSON.stringify({ choices: [{ delta: { content: 'checking the tree' } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [
      { index: 0, id, type: 'function', function: { name: 'run', arguments: '{"command":"git status"}' } },
    ] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    '[DONE]',
  ]), { headers: SSE_HEADERS });
}

function textStep(text: string): Response {
  return new Response(sse([
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 3, total_tokens: 33 } }),
    '[DONE]',
  ]), { headers: SSE_HEADERS });
}

const tools: ToolSet = {
  run: tool({
    description: 'shell',
    inputSchema: z.object({ command: z.string() }),
    execute: async ({ command }: { command: string }) => `ran: ${command}`,
  }),
};

/** One scripted provider serving a scripted sequence of responses, plus the
 *  prompts it was actually sent (the evidence that a follow-up request left the
 *  process at all). */
function scriptedProvider(script: ReadonlyArray<() => Response>) {
  const prompts: unknown[] = [];
  let call = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      prompts.push(await req.json());
      const at = Math.min(call, script.length - 1);
      call += 1;
      return script[at]?.() ?? textStep('done');
    },
  });
  return {
    prompts,
    model: createChatModel({
      kind: 'openai-compat', name: 'openrouter',
      baseURL: `http://localhost:${server.port}/v1`,
      headers: { Authorization: 'Bearer test' }, modelId: 'test-model',
    }),
    stop: () => server.stop(true),
  };
}

/** Run one turn, interrupting it the instant the tool call is announced — the
 *  window the owner hit. Returns the events and the turn's history. */
async function interruptedTurn(
  model: LanguageModel,
  history: ModelMessage[],
): Promise<{ events: ChatEvent[]; threw: string | null; persisted: ModelMessage[] }> {
  const abort = new AbortController();
  const events: ChatEvent[] = [];
  let threw: string | null = null;
  const persisted = [...history];
  try {
    for await (const ev of runChat({
      model, system: 'sys', history, tools, stopWhen: stepCountIs(20), signal: abort.signal,
    })) {
      events.push(ev);
      if (ev.type === 'tool-call') abort.abort();
      if (ev.type === 'done') persisted.push(...ev.responseMessages);
    }
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  return { events, threw, persisted };
}

describe('a turn interrupted between a tool call and its result', () => {
  test('leaves a history the NEXT turn can actually be assembled from', async () => {
    const provider = scriptedProvider([() => toolStep(ORPHAN_ID), () => textStep('carrying on')]);
    try {
      const first = await interruptedTurn(provider.model, [{ role: 'user', content: 'check the repo' }]);
      // The turn is recorded as unfinished, and its history is kept anyway.
      expect(first.threw).toBe('The turn was interrupted before it finished.');
      expect(first.events.some((e) => e.type === 'done')).toBe(true);

      // The follow-up turn: the whole point. Before this fix, `streamText`
      // threw AI_MissingToolResultsError here and never issued a request.
      first.persisted.push({ role: 'user', content: 'what did you find?' });
      const replies: string[] = [];
      for await (const ev of runChat({
        model: provider.model, system: 'sys', history: first.persisted, tools, stopWhen: stepCountIs(20),
      })) {
        if (ev.type === 'done') replies.push(ev.text);
      }
      expect(replies.join('')).toContain('carrying on');
      // Two requests reached the provider: the interrupted turn's, and the
      // follow-up's. A history the SDK refuses to assemble produces one.
      expect(provider.prompts.length).toBe(2);
    } finally {
      provider.stop();
    }
  }, 20_000);

  test('records the interruption as the call\'s result, not as a call that never happened', async () => {
    const provider = scriptedProvider([() => toolStep(ORPHAN_ID)]);
    try {
      const { persisted } = await interruptedTurn(provider.model, [{ role: 'user', content: 'check the repo' }]);

      // The call the caller was handed is in the record...
      const calls = persisted.flatMap((m) => m.role === 'assistant' && Array.isArray(m.content)
        ? m.content.filter((p) => p.type === 'tool-call') : []);
      expect(calls.map((c) => c.toolCallId)).toEqual([ORPHAN_ID]);

      // ...and so is a terminal result for it, saying it was cut off. The model
      // must not be told the tool did not run: it may have.
      const results = persisted.flatMap((m) => m.role === 'tool'
        ? m.content.filter((p) => p.type === 'tool-result') : []);
      expect(results.map((r) => r.toolCallId)).toEqual([ORPHAN_ID]);
      expect(results[0]?.output).toEqual({ type: 'error-text', value: INTERRUPTED_TOOL_RESULT });
      expect(INTERRUPTED_TOOL_RESULT).toContain('Whether it ran is unknown');
    } finally {
      provider.stop();
    }
  }, 20_000);

  test('keeps the completed steps the interrupt did not touch', async () => {
    // Interrupt on the SECOND call: step one ran a tool and finished cleanly,
    // and that work must survive into the record rather than being discarded
    // with the turn.
    const provider = scriptedProvider([() => toolStep('call_first'), () => toolStep(ORPHAN_ID)]);
    try {
      const abort = new AbortController();
      const persisted: ModelMessage[] = [{ role: 'user', content: 'check the repo' }];
      let calls = 0;
      const cutTurn = async (): Promise<void> => {
        for await (const ev of runChat({
          model: provider.model, system: 'sys', history: [...persisted], tools, stopWhen: stepCountIs(20),
          signal: abort.signal,
        })) {
          if (ev.type === 'tool-call') { calls += 1; if (calls === 2) abort.abort(); }
          if (ev.type === 'done') persisted.push(...ev.responseMessages);
        }
      };
      await expect(cutTurn()).rejects.toThrow(INTERRUPTED_TURN);

      const resultsById = new Map(persisted.flatMap((m) => m.role === 'tool'
        ? m.content.filter((p) => p.type === 'tool-result').map((p) => [p.toolCallId, p.output] as const)
        : []));
      // The completed step keeps its REAL result...
      expect(resultsById.get('call_first')).toEqual({ type: 'text', value: 'ran: git status' });
      // ...and only the cut-off call gets the synthetic one.
      expect(resultsById.get(ORPHAN_ID)).toEqual({ type: 'error-text', value: INTERRUPTED_TOOL_RESULT });
    } finally {
      provider.stop();
    }
  }, 20_000);
});

describe('a history that already holds an orphaned call', () => {
  // The already-bricked session: the orphan was persisted before this fix
  // existed (or by the cf turn driver's partial-message persist). Turn assembly
  // is the reconciliation point, so the next turn works without rewriting a
  // single stored row.
  const bricked: ModelMessage[] = [
    { role: 'user', content: 'check the repo' },
    { role: 'assistant', content: [
      { type: 'text', text: 'checking the tree' },
      { type: 'tool-call', toolCallId: ORPHAN_ID, toolName: 'run', input: { command: 'git status' } },
    ] },
    { role: 'user', content: 'hello?' },
  ];

  test('is assembled into a usable request by the shared turn assembly', async () => {
    const provider = scriptedProvider([() => textStep('back with you')]);
    try {
      const replies: string[] = [];
      for await (const ev of runChat({
        model: provider.model, system: 'sys', history: bricked, tools, stopWhen: stepCountIs(20),
      })) {
        if (ev.type === 'done') replies.push(ev.text);
      }
      expect(replies.join('')).toContain('back with you');
      expect(provider.prompts.length).toBe(1);
    } finally {
      provider.stop();
    }
  }, 20_000);

  test('is not rewritten in place — assembly repairs the request, not the record', async () => {
    const provider = scriptedProvider([() => textStep('back with you')]);
    const before = JSON.stringify(bricked);
    try {
      for await (const _ of runChat({
        model: provider.model, system: 'sys', history: bricked, tools, stopWhen: stepCountIs(20),
      })) { /* drain */ }
      expect(JSON.stringify(bricked)).toBe(before);
    } finally {
      provider.stop();
    }
  }, 20_000);
});
