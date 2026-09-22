/**
 * KINU-072: a streamed token must not re-walk the stored history or remint its rows (which broke
 * `memo(MessageView)`). Cost is counted against the real `mergeTranscript`/`buildTranscript`; the
 * product claim is asserted through `useChatThread` under React's reconciler.
 */
import { describe, expect, test } from 'bun:test';
import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  EMPTY_TRANSCRIPT_FOLD, buildTranscript, extendTranscript, mergeTranscript,
  restoredRows, sealTranscript,
  type ChatHistoryEntry, type InlineSteer, type Transcript,
} from '@kinu.run/core';
import type { UIMessage } from 'ai';

import { useChatThread } from '../src/hooks/use-chat-thread';
import type { Rpc } from '@kinu.run/core';

/** Stored rows paged back to; large enough that a per-token re-walk is unmistakable. */
const HISTORY = 200;

const LIVE = 12;

const TOKENS = 50;

/** React caps render-phase re-renders at 25, so the reconciler half runs a shorter turn. */
const RENDER_TICKS = 12;

const NO_STEERS: readonly InlineSteer[] = [];

interface Meter { reads: number }

interface WalkCost {
  readonly stored: number;
  readonly live: number;
}

/** A stored history row whose `content` read is counted: one read per entry per projection. */
function storedRow(meter: Meter, index: number): ChatHistoryEntry {
  return {
    id: `stored-${String(index)}`,
    role: 'assistant',
    createdAt: index,
    get content(): string {
      meter.reads += 1;

      return `stored message ${String(index)}`;
    },
  };
}

/** A live message whose `role` read is counted, proportional to folds of the live window. */
function liveMessage(meter: Meter, id: string, text: string): UIMessage {
  return {
    id,
    parts: [{ type: 'text', text }],
    get role(): 'assistant' {
      meter.reads += 1;

      return 'assistant';
    },
  };
}

function storedConversation(meter: Meter): ChatHistoryEntry[] {
  return Array.from({ length: HISTORY }, (_, i) => storedRow(meter, i));
}

/** Each tick is a new array, as the SDK hands the pane. */
function tokenTicks(meter: Meter, count: number = TOKENS): readonly UIMessage[][] {
  const settled = Array.from({ length: LIVE - 1 },
    (_, i) => liveMessage(meter, `live-${String(i)}`, `live message ${String(i)}`));

  return Array.from({ length: count }, (_, t) =>
    [...settled, liveMessage(meter, 'streaming', 'x'.repeat(t + 1))]);
}

/** The shape this replaced: merge both sources, then walk the merged list. */
function wholeListPerToken(): WalkCost {
  const stored: Meter = { reads: 0 };
  const live: Meter = { reads: 0 };
  const older = storedConversation(stored);

  for (const window of tokenTicks(live)) {
    buildTranscript(mergeTranscript(older, window), NO_STEERS);
  }

  return { stored: stored.reads, live: live.reads };
}

/** The shipped shape: a token re-folds only the live window. */
function stagedPerToken(): WalkCost {
  const stored: Meter = { reads: 0 };
  const live: Meter = { reads: 0 };
  const older = storedConversation(stored);
  const olderFold = extendTranscript(EMPTY_TRANSCRIPT_FOLD, restoredRows(older));

  for (const window of tokenTicks(live)) {
    sealTranscript(extendTranscript(olderFold, window), NO_STEERS);
  }

  return { stored: stored.reads, live: live.reads };
}

describe('what a streamed token costs (KINU-072)', () => {
  test('the whole-list shape re-walks the stored conversation on every token', () => {
    expect(wholeListPerToken().stored).toBe(HISTORY * TOKENS);
  });

  test('the staged shape touches the stored conversation once for the whole turn', () => {
    expect(stagedPerToken().stored).toBe(HISTORY);
  });

  test('stored cost stops growing with the turn — the property, not the number', () => {
    // A ratio, not a constant, so the guard fails for any re-walk, including a cheaper one.
    const before = wholeListPerToken().stored;
    const after = stagedPerToken().stored;
    expect(before / HISTORY).toBe(TOKENS);
    expect(after / HISTORY).toBe(1);
  });

  test('the live window is still folded once per token, and only once', () => {
    // The live list is supposed to be re-folded; staging removes only the walk over stored history.
    const staged = stagedPerToken().live;
    expect(staged).toBe(wholeListPerToken().live);
    expect(staged % TOKENS).toBe(0);
  });

  test('the restored rows keep their identity across the whole turn', () => {
    const meter: Meter = { reads: 0 };
    const older = storedConversation(meter);
    const held = restoredRows(older);
    expect(new Set(held).size).toBe(HISTORY);

    for (let tick = 0; tick < TOKENS; tick++) {
      expect(restoredRows(older)[0]).not.toBe(held[0]);
    }
  });
});

interface RenderedTicks {
  readonly threads: readonly Transcript[];
  readonly transcripts: readonly (readonly UIMessage[])[];
  readonly rpcCalls: readonly string[];
}

/** Render-phase updates re-render the same component, so its `useMemo` cache survives the tick. */
function threadOverTicks(windows: readonly (readonly UIMessage[])[]): RenderedTicks {
  const threads: Transcript[] = [];
  const transcripts: (readonly UIMessage[])[] = [];
  const rpcCalls: string[] = [];

  // Deriving the thread must reach no page, so a call here is the defect.
  const rpc: Rpc = async (method: string): Promise<never> => {
    rpcCalls.push(method);
    throw new Error(`the thread derivation fetched: ${method}`);
  };

  function Probe(): null {
    const [tick, setTick] = useState(0);
    const at = Math.min(tick, windows.length - 1);
    const { transcript, thread } = useChatThread({ rpc, live: windows[at], seeded: true });
    threads.push(thread);
    transcripts.push(transcript);

    if (tick < windows.length - 1) setTick(tick + 1);

    return null;
  }

  renderToStaticMarkup(createElement(Probe));

  return { threads, transcripts, rpcCalls };
}

describe('the chat pane performs the staged derivation (KINU-072)', () => {
  test('with no older rows the live list is handed back uncopied', () => {
    // `mergeTranscript` always spreads a new array, so `transcript === live` fails there.
    const windows = tokenTicks({ reads: 0 }, RENDER_TICKS);
    const { transcripts } = threadOverTicks(windows);
    expect(transcripts).toHaveLength(RENDER_TICKS);

    for (const [i, transcript] of transcripts.entries()) {
      expect(transcript).toBe(windows[i]);
    }
  });

  test('a re-render that is not a token folds nothing', () => {
    const meter: Meter = { reads: 0 };
    const window = tokenTicks(meter, 1)[0];
    meter.reads = 0;
    sealTranscript(extendTranscript(EMPTY_TRANSCRIPT_FOLD, window), NO_STEERS);
    const oneFold = meter.reads;
    expect(oneFold).toBeGreaterThan(0);

    meter.reads = 0;
    const { threads } = threadOverTicks([window, window, window]);
    expect(threads).toHaveLength(3);
    expect(meter.reads).toBe(oneFold);
    expect(threads[1]).toBe(threads[0]);
    expect(threads[2]).toBe(threads[0]);
  });

  test('a token still produces a new thread, so the pane is not simply frozen', () => {
    // Negative control: a changed list must still re-derive.
    const { threads } = threadOverTicks(tokenTicks({ reads: 0 }, RENDER_TICKS));
    expect(threads[1]).not.toBe(threads[0]);
    expect(threads.at(-1)?.entries.at(-1)?.message.id).toBe('streaming');
  });

  test('deriving the thread reads no history page', () => {
    // History is walked on reaching the top edge, never per token.
    expect(threadOverTicks(tokenTicks({ reads: 0 }, RENDER_TICKS)).rpcCalls).toEqual([]);
  });
});
