// A dead provider stream must fail the turn, never fake-complete it.
//
// Observed in the bench (circuit-fibsqrt, 2026-08-08): mid-task, a request
// went silent for ~4 minutes and then the remote closed the socket with no
// frames sent. The AI SDK records that as a normal EMPTY step (finishReason
// 'other', no content) and ends the loop as if the model chose to stop —
// the turn "completed" with hadError:false after 2 steps of a 100+-step
// task. Had the remote NOT closed the socket, nothing in the stack bounds
// the wait (the SDK's chunk timeout only arms after a first chunk), so the
// same failure's non-self-resolving variant stalls the turn indefinitely.
//
// These tests drive runChat through the REAL openai-compatible provider
// against a local scripted server (no live model calls) and pin the
// contract: a model-chosen stop ends the turn; a dead or stalled stream
// throws so the caller records the failure.
import { describe, test, expect } from 'bun:test';
import { stepCountIs, tool, type StopCondition, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  runChat, createChatModel, isRateLimitedTurnError,
  type ChatEvent,
} from '../src/index';
import { ProviderPacer } from '../src/providers/pacing';

/** The openings the two silent-turn messages actually ship with.
 *
 *  Written out rather than imported: the constants are module-scoped now, and
 *  importing them made the classifier's own test compare a value with itself —
 *  rewording either sentence would have kept it green while every stored row
 *  changed shape. Spelled here, a reword fails this file, which is the point. */
const STALLED_OPENING = 'Turn stalled:';
const RATE_LIMITED_OPENING = 'Turn ended by provider rate limiting:';

const SSE_HEADERS = { 'content-type': 'text/event-stream' };

function sse(events: string[]): string {
  return events.map((e) => `data: ${e}\n\n`).join('');
}

/** Step 1: text + one `run` tool call, finishing normally on tool_calls. */
function healthyToolStep(): Response {
  return new Response(sse([
    JSON.stringify({ choices: [{ delta: { content: 'Let me look' } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'tc1', type: 'function', function: { name: 'run', arguments: '{"command":"wc -l"}' } },
    ] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    '[DONE]',
  ]), { headers: SSE_HEADERS });
}

async function driveTurn(
  step2: () => Response,
  opts: { callTimeoutMs?: number; step1?: () => Response; stopWhen?: StopCondition<ToolSet>; pacer?: InstanceType<typeof ProviderPacer> } = {},
) {
  let call = 0;
  // A FRESH pacer per turn: the production default is the isolate-wide
  // singleton, and another test's mandated wait must never classify this
  // turn's silence.
  const server = Bun.serve({
    port: 0,
    async fetch() {
      call += 1;
      return call === 1 ? (opts.step1 ?? healthyToolStep)() : step2();
    },
  });
  const model = createChatModel({
    kind: 'openai-compat', name: 'openrouter',
    baseURL: `http://localhost:${server.port}/v1`,
    headers: { Authorization: 'Bearer test' }, modelId: 'test-model',
  });
  const tools: ToolSet = {
    run: tool({
      description: 'shell',
      inputSchema: z.object({ command: z.string() }),
      execute: async ({ command }: { command: string }) => `ran: ${command}`,
    }),
  };
  const events: ChatEvent[] = [];
  let threw: Error | null = null;
  try {
    for await (const ev of runChat({
      model, system: 'sys', history: [{ role: 'user', content: 'go' }],
      tools,
      stopWhen: opts.stopWhen,
      stopWhen: opts.stopWhen,
      callTimeoutMs: opts.callTimeoutMs,
      pacer: opts.pacer,
    })) events.push(ev);
  } catch (e) {
    threw = e instanceof Error ? e : new Error(String(e));
  } finally {
    server.stop(true);
  }
  return { events, threw, done: events.find((e) => e.type === 'done') };
}

describe('dead provider stream fails the turn', () => {
  test('an empty SSE close mid-task throws instead of fake-completing', async () => {
    const { threw, done } = await driveTurn(() => new Response('', { headers: SSE_HEADERS }));
    expect(done).toBeUndefined();
    expect(threw?.message ?? '').toContain('terminated prematurely');
  });

  test('a [DONE]-only SSE mid-task throws instead of fake-completing', async () => {
    const { threw, done } = await driveTurn(() => new Response(sse(['[DONE]']), { headers: SSE_HEADERS }));
    expect(done).toBeUndefined();
    expect(threw?.message ?? '').toContain('terminated prematurely');
  });

  test('a model-chosen stop with text still completes the turn', async () => {
    const { threw, done } = await driveTurn(() => new Response(sse([
      JSON.stringify({ choices: [{ delta: { content: 'answer' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } }),
      '[DONE]',
    ]), { headers: SSE_HEADERS }));
    expect(threw).toBeNull();
    expect(done && done.type === 'done' ? done.text : '').toContain('answer');
  });

  test('a model-chosen stop WITHOUT content is still a completion, not an error', async () => {
    const { threw, done } = await driveTurn(() => new Response(sse([
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 0, total_tokens: 20 } }),
      '[DONE]',
    ]), { headers: SSE_HEADERS }));
    expect(threw).toBeNull();
    expect(done).toBeDefined();
  });
});

// The detector fires on the CONJUNCTION of an unmapped finish reason and an
// empty step. The cases above cover unmapped+empty (dead) and mapped+content
// (alive); these are the two remaining cells, and they are the ones that would
// take real turns down if the detector ever widened to the reason alone.
// 'other' and 'unknown' are routine for several providers.
describe('an unmapped finish reason alone is not a dead stream', () => {
  test('a step that produced TEXT and finished on "other" completes normally', async () => {
    const { threw, done } = await driveTurn(() => new Response(sse([
      JSON.stringify({ choices: [{ delta: { content: 'a real answer' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'other' }], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } }),
      '[DONE]',
    ]), { headers: SSE_HEADERS }));

    expect(threw).toBeNull();
    expect(done && done.type === 'done' ? done.text : '').toContain('a real answer');
  });

  test('a FINAL step whose only output was a TOOL CALL survives an unmapped reason', async () => {
    // A tool-call step legitimately emits no text, so it is the step most
    // easily mistaken for empty. It has to be the LAST step to be worth
    // asserting — the dead-stream verdict is read once, after the loop, so a
    // mid-turn step could not exercise it and the case would be untestable.
    const toolStepEndingOnOther = () => new Response(sse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'tc9', type: 'function', function: { name: 'run', arguments: '{"command":"ls"}' } },
      ] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'other' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
      '[DONE]',
    ]), { headers: SSE_HEADERS });

    const { threw, events } = await driveTurn(
      () => { throw new Error('the turn must stop after one step'); },
      { step1: toolStepEndingOnOther, stopWhen: stepCountIs(1) },
    );

    expect(threw).toBeNull();
    expect(events.some((e) => e.type === 'tool-call')).toBe(true);
  });
});

describe('stalled provider stream aborts the turn', () => {
  test('a request that never produces a chunk ends the turn inside the silence window', async () => {
    const t0 = performance.now();
    const { threw } = await driveTurn(
      () => new Response(new ReadableStream({ start() { /* stall forever */ } }), { headers: SSE_HEADERS }),
      { callTimeoutMs: 400 },
    );
    expect(threw?.message ?? '').toContain('stalled');
    expect(performance.now() - t0).toBeLessThan(10_000);
  }, 15_000);

  test('a stall keeps the steps that already finished, then reports the stall', async () => {
    // Step 1 ran a tool and finished; step 2 goes silent. The finished step is
    // real work the caller has already rendered and accounted for, so it rides
    // out on `done` — and the turn is STILL reported as failed. Before this,
    // the throw came first and every finished step went with it.
    const { threw, done } = await driveTurn(
      () => new Response(new ReadableStream({ start() { /* stall forever */ } }), { headers: SSE_HEADERS }),
      { callTimeoutMs: 400 },
    );
    expect(threw?.message ?? '').toContain('stalled');
    const messages = done && done.type === 'done' ? done.responseMessages : [];
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(1);
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  }, 15_000);

  test('a slow but live stream does not trip the watchdog', async () => {
    const enc = new TextEncoder();
    const { threw, done } = await driveTurn(
      () => new Response(new ReadableStream({
        async start(c) {
          await new Promise((r) => setTimeout(r, 200));
          c.enqueue(enc.encode(sse([JSON.stringify({ choices: [{ delta: { content: 'slow' } }] })])));
          await new Promise((r) => setTimeout(r, 200));
          c.enqueue(enc.encode(sse([
            JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 } }),
            '[DONE]',
          ])));
          c.close();
        },
      }), { headers: SSE_HEADERS }),
      { callTimeoutMs: 1_000 },
    );
    expect(threw).toBeNull();
    expect(done).toBeDefined();
  }, 15_000);
});

// THE RETRY HALF OF THE SANCTIONED BOUNDS (owner ruling, 2026-08-21): a call the
// silence window killed is re-issued — up to LLM_CALL_MAX_RETRIES times, from the
// last FINISHED step boundary — before the stall surfaces as the turn error.
describe('a timed-out call retries before failing the turn', () => {
  const answer = () => new Response(sse([
    JSON.stringify({ choices: [{ delta: { content: 'answer after retry' } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } }),
    '[DONE]',
  ]), { headers: SSE_HEADERS });
  const stall = () => new Response(new ReadableStream({ start() { /* silent forever */ } }), { headers: SSE_HEADERS });

  test('one timed-out call is re-issued and the turn completes when the retry answers', async () => {
    let stepTwoCalls = 0;
    const { threw, done } = await driveTurn(() => {
      stepTwoCalls += 1;
      return stepTwoCalls === 1 ? stall() : answer();
    }, { callTimeoutMs: 300 });
    expect(stepTwoCalls).toBe(2);
    expect(threw).toBeNull();
    expect(done && done.type === 'done' ? done.text : '').toContain('answer after retry');
  }, 20_000);

  test('the retry resumes from the last FINISHED step boundary', async () => {
    // Step 1 completed (a real tool call + result). Step 2 stalls once; the
    // retried request must carry step 1's messages so the model continues, and
    // the turn must keep step 1's events exactly once — never duplicated by the
    // second attempt, never dropped.
    let stepTwoCalls = 0;
    const { events, threw, done } = await driveTurn(() => {
      stepTwoCalls += 1;
      return stepTwoCalls === 1 ? stall() : answer();
    }, { callTimeoutMs: 300 });
    expect(threw).toBeNull();
    expect(done).toBeDefined();
    // The durable contract: step 1's tool work survives exactly once in the
    // history the caller persists, and the retried call's answer completes.
    const doneEv = done && done.type === 'done' ? done : null;
    expect((doneEv?.responseMessages ?? []).filter((m) => m.role === 'tool')).toHaveLength(1);
    expect((doneEv?.responseMessages ?? []).filter((m) => m.role === 'assistant')).toHaveLength(1);
  }, 20_000);

  test('after LLM_CALL_MAX_RETRIES exhausted attempts, the turn fails naming them', async () => {
    let stepTwoCalls = 0;
    const { threw, done } = await driveTurn(() => {
      stepTwoCalls += 1;
      return stall();
    }, { callTimeoutMs: 200 });
    expect(stepTwoCalls).toBe(4); // the first attempt + LLM_CALL_MAX_RETRIES retries
    expect(threw?.message ?? '').toContain('stalled');
    expect(threw?.message ?? '').toContain('4 attempts');
    expect(done).toBeUndefined();
  }, 20_000);
});

// A PROVIDER-MANDATED WAIT IS NOT A STALL.
//
// Measured on the owner's live workspace (my-personal-assistant-f0e4afa6): an
// `ideate` swarm spawned five nodes against one Cloudflare OAuth credential, the
// account rate-limited them together, and two heads ended `errored` with
// "Turn stalled: nothing flowed for 300s" while a `wrangler tail` on the same
// workspace carried `provider.rate_limited — waiting`. The work was never wedged;
// it was queued behind a rate limit, and nothing in the stack could tell the two
// apart because `withRateLimitRetry` sleeps inside `fetch`, upstream of every
// chunk the watchdog waits for.
//
// These drive the REAL retry layer (createChatModel wraps its fetch in it)
// against a scripted 429, with a mandated wait deliberately LONGER than the stall
// window — the arrangement that used to fail the turn.
describe('a rate-limited turn is not a stalled turn', () => {
  /** Step 2 answers 429 with `Retry-After`, then answers properly. Two responses,
   *  because the retry layer's second attempt is the one that must survive. */
  function rateLimitedThenHealthy(retryAfterSeconds: number): () => Response {
    let served = 0;
    return () => {
      served += 1;
      if (served === 1) {
        return new Response('rate limited', {
          status: 429, headers: { 'Retry-After': String(retryAfterSeconds) },
        });
      }
      return new Response(sse([
        JSON.stringify({ choices: [{ delta: { content: 'answer after the wait' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } }),
        '[DONE]',
      ]), { headers: SSE_HEADERS });
    };
  }

  test('a Retry-After longer than the stall window is waited out, not called a stall', async () => {
    // 1s mandated against a 300ms window. The watchdog fires mid-wait and must
    // push its deadline instead of ending the turn — and must then give the
    // RETRIED request a window of its own, because that request is only issued
    // when the wait ends.
    const { threw, done } = await driveTurn(rateLimitedThenHealthy(1), { callTimeoutMs: 300 });
    expect(threw).toBeNull();
    expect(done && done.type === 'done' ? done.text : '').toContain('answer after the wait');
  }, 20_000);

  test('a turn ended after its mandated wait blames the rate limit, not a wedge', async () => {
    // The other half of the classification: the provider asks for a wait, the
    // wait is taken, and then nothing arrives anyway. That IS a turn ending — but
    // the reason a reader gets must be the rate limit, because a row reading
    // "stalled" sent its reader looking for a wedge that was never there.
    let served = 0;
    const { threw } = await driveTurn(() => {
      served += 1;
      if (served === 1) {
        return new Response('rate limited', { status: 429, headers: { 'Retry-After': '1' } });
      }
      return new Response(new ReadableStream({ start() { /* silent after the wait */ } }), { headers: SSE_HEADERS });
    }, { callTimeoutMs: 300 });
    expect(isRateLimitedTurnError(threw?.message ?? '')).toBe(true);
    expect(threw?.message ?? '').not.toContain(STALLED_OPENING);
  }, 20_000);

  test('an ordinary dead stream still reads as a stall, with no rate limit in sight', async () => {
    // The guard on the classification: nothing declared a wait, so nothing may
    // claim one. Without this a refactor that always blames the provider passes.
    const { threw } = await driveTurn(
      () => new Response(new ReadableStream({ start() { /* stall forever */ } }), { headers: SSE_HEADERS }),
      { callTimeoutMs: 300 },
    );
    expect(threw?.message ?? '').toContain(STALLED_OPENING);
    expect(isRateLimitedTurnError(threw?.message ?? '')).toBe(false);
  }, 20_000);

  test('the classifier reads a reason out of the CHAIN a node records, not just a bare message', async () => {
    // How a node's row actually looks. `runNodeAgent` wraps the turn's failure
    // ("run agent <id> to a report: …"), which is the form the incident's own row
    // carried — so a classifier anchored at the start of the string would have
    // reported every rate-limited node as unexplained.
    expect(isRateLimitedTurnError(
      `run agent n1 to a report: ${RATE_LIMITED_OPENING} the provider asked this turn to wait 60s`,
    )).toBe(true);
    expect(isRateLimitedTurnError(
      `run agent n1 to a report: ${STALLED_OPENING} nothing flowed for 300s`,
    )).toBe(false);
  });
});
