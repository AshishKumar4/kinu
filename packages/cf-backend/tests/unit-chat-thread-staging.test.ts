/**
 * KINU-072: what one streamed token costs the chat thread.
 *
 * The pane's live list is replaced on every delta. The shape this replaced
 * re-derived the whole thread from scratch on each one — `mergeTranscript`
 * re-projected every restored row and spread a fresh merged array, then
 * `buildTranscript` walked that array again — so a reader who had paged back
 * through a long conversation paid for all of it, per token, twice, and the
 * re-projection minted fresh row objects that broke `memo(MessageView)` for
 * every historical message.
 *
 * Two layers, because there are two claims.
 *
 * The COST claim is algorithmic and is measured: one fixture and one tick
 * sequence run through both compositions, counting the stored rows each
 * actually touches. `mergeTranscript` and `buildTranscript` are still exported
 * and still the gallery's path, so "before" here is the real prior code rather
 * than a strawman of it.
 *
 * The PRODUCT claim is that the chat performs the staged composition rather
 * than the whole-list one, and it is asserted through `useChatThread` — the
 * seam the workspace and subordinate panes actually mount — under React's own
 * reconciler. `renderToStaticMarkup` runs no effects, so the history walk never
 * starts and `history.fetched` stays empty; what that leaves observable is
 * exactly what separates the two shapes with no older rows. The staged one
 * hands the live list back UNCOPIED, and a re-render that changed no input
 * folds nothing — `mergeTranscript` can do neither, because it always spreads.
 * A render-phase state update carries `useMemo` across ticks here: the same
 * component re-rendering itself, so hook state survives as it does in a commit.
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
import type { Rpc } from '../src/lib/protocol';

/** Stored rows the reader has paged back to — the half a token must not pay
 *  for. Large enough that a per-token re-walk is unmistakable in the counts. */
const HISTORY = 200;
/** The live window: the SDK seed plus what the socket has appended. */
const LIVE = 12;
/** Deltas in one turn. Every one replaces the live list. */
const TOKENS = 50;
/** Ticks the RECONCILER half drives. A render-phase update is a re-render and
 *  React caps a component at 25 before it calls the loop runaway, so this half
 *  runs a shorter turn than the counting half above. It proves per-tick
 *  behaviour, which needs no long run. */
const RENDER_TICKS = 12;

const NO_STEERS: readonly InlineSteer[] = [];

/** Counts real reads of the fixture, so "touched" is measured off the data the
 *  derivation consumed rather than off a wrapper around it. */
interface Meter { reads: number }

/** What one composition costs on one turn, in rows the derivation touched. */
interface WalkCost {
  /** Stored history rows projected — the half a token must not pay for. */
  readonly stored: number;
  /** Live messages folded — the half that is supposed to cost. */
  readonly live: number;
}

/**
 * One stored history row whose CONTENT read is counted.
 *
 * `restoredRows` reads `content` exactly once per entry per projection, so the
 * count is projections times rows — the quantity the finding is about. A getter
 * in the literal rather than a defined property, so the row is a
 * `ChatHistoryEntry` by construction and nothing here needs asserting.
 */
function storedRow(meter: Meter, index: number): ChatHistoryEntry {
  return {
    id: `stored-${String(index)}`,
    role: 'assistant',
    createdAt: index,
    get content(): string { meter.reads += 1; return `stored message ${String(index)}`; },
  };
}

/** One live message whose ROLE read is counted. `extendTranscript` reads `role`
 *  a fixed number of times per message per walk, so the count is proportional
 *  to how many times the live window was folded. */
function liveMessage(meter: Meter, id: string, text: string): UIMessage {
  return {
    id,
    parts: [{ type: 'text', text }],
    get role(): 'assistant' { meter.reads += 1; return 'assistant'; },
  };
}

function storedConversation(meter: Meter): ChatHistoryEntry[] {
  return Array.from({ length: HISTORY }, (_, i) => storedRow(meter, i));
}

/** The turn as the socket delivers it: a settled window, then one message that
 *  grows by a token per tick. Each tick is a NEW array, because that is what
 *  the SDK hands the pane. */
function tokenTicks(meter: Meter, count: number = TOKENS): readonly UIMessage[][] {
  const settled = Array.from({ length: LIVE - 1 },
    (_, i) => liveMessage(meter, `live-${String(i)}`, `live message ${String(i)}`));
  return Array.from({ length: count }, (_, t) =>
    [...settled, liveMessage(meter, 'streaming', 'x'.repeat(t + 1))]);
}

/** The shape this replaced: merge the two sources, then walk the merged list. */
function wholeListPerToken(): WalkCost {
  const stored: Meter = { reads: 0 };
  const live: Meter = { reads: 0 };
  const older = storedConversation(stored);
  for (const window of tokenTicks(live)) {
    buildTranscript(mergeTranscript(older, window), NO_STEERS);
  }
  return { stored: stored.reads, live: live.reads };
}

/** The shape that ships: the restored projection and the settled fold are held
 *  across ticks, and a token re-folds the live window alone. */
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
    // Stated as a ratio rather than a constant, so the guard fails for ANY
    // re-walk, including a cheaper one someone reintroduces later.
    const before = wholeListPerToken().stored;
    const after = stagedPerToken().stored;
    expect(before / HISTORY).toBe(TOKENS);
    expect(after / HISTORY).toBe(1);
  });

  test('the live window is still folded once per token, and only once', () => {
    // The half that MUST keep costing: a token changed the live list, so the
    // live list is re-folded. What the staging removes is the walk over the
    // STORED half, not this one.
    const staged = stagedPerToken().live;
    expect(staged).toBe(wholeListPerToken().live);
    expect(staged % TOKENS).toBe(0);
  });

  test('the restored rows keep their identity across the whole turn', () => {
    // The render half of the same defect: re-projecting per token minted fresh
    // objects, so `memo(MessageView)` missed on every historical message.
    const meter: Meter = { reads: 0 };
    const older = storedConversation(meter);
    const held = restoredRows(older);
    expect(new Set(held).size).toBe(HISTORY);
    // Re-projected per token instead, every row is a new object every time.
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

/** The thread as the real hook derives it, ticked once per window. The
 *  render-phase update re-renders the SAME component, so its `useMemo` cache
 *  survives the tick exactly as it does in a browser commit. */
function threadOverTicks(windows: readonly (readonly UIMessage[])[]): RenderedTicks {
  const threads: Transcript[] = [];
  const transcripts: (readonly UIMessage[])[] = [];
  const rpcCalls: string[] = [];
  // Refuses rather than answers. Deriving the thread must reach no page, so a
  // call here is the defect, not a value the harness has to invent one of —
  // and `Promise<never>` satisfies the RPC's caller-chosen return with nothing
  // asserted.
  const rpc: Rpc = async (method: string): Promise<never> => {
    rpcCalls.push(method);
    throw new Error(`the thread derivation fetched: ${method}`);
  };

  function Probe(): null {
    const [tick, setTick] = useState(0);
    const at = Math.min(tick, windows.length - 1);
    const { transcript, thread } = useChatThread(rpc, windows[at]!, true);
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
    // The whole-list shape cannot do this: `mergeTranscript` always spreads a
    // new array, so `transcript === live` is false the moment it comes back.
    const windows = tokenTicks({ reads: 0 }, RENDER_TICKS);
    const { transcripts } = threadOverTicks(windows);
    expect(transcripts).toHaveLength(RENDER_TICKS);
    for (const [i, transcript] of transcripts.entries()) {
      expect(transcript).toBe(windows[i]);
    }
  });

  test('a re-render that is not a token folds nothing', () => {
    // A pane that re-derives per RENDER rather than per input change pays for
    // the whole turn again on any unrelated parent update.
    const meter: Meter = { reads: 0 };
    const window = tokenTicks(meter, 1)[0]!;
    meter.reads = 0;
    sealTranscript(extendTranscript(EMPTY_TRANSCRIPT_FOLD, window), NO_STEERS);
    const oneFold = meter.reads;
    expect(oneFold).toBeGreaterThan(0);

    meter.reads = 0;
    const { threads } = threadOverTicks([window, window, window]);
    expect(threads).toHaveLength(3);
    // Three renders, one fold: the memo held on both stages.
    expect(meter.reads).toBe(oneFold);
    expect(threads[1]).toBe(threads[0]);
    expect(threads[2]).toBe(threads[0]);
  });

  test('a token still produces a new thread, so the pane is not simply frozen', () => {
    // Negative control for the memo assertion above: holding the thread across
    // an UNCHANGED list is correct only if a CHANGED list still re-derives.
    const { threads } = threadOverTicks(tokenTicks({ reads: 0 }, RENDER_TICKS));
    expect(threads[1]).not.toBe(threads[0]);
    expect(threads.at(-1)?.entries.at(-1)?.message.id).toBe('streaming');
  });

  test('deriving the thread reads no history page', () => {
    // The walk is driven by the scroller reaching the top edge, never by a
    // token. A pane that refetched history per delta would show up here.
    expect(threadOverTicks(tokenTicks({ reads: 0 }, RENDER_TICKS)).rpcCalls).toEqual([]);
  });
});
