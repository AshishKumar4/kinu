/**
 * The composer's line about a steer the server is holding.
 *
 * The report (#210): "the 'Queued' thing also doesn't go away". It was written
 * into component state by the keypress and cleared by nothing, so a composer
 * promised to deliver words the model had already read and answered — under a
 * thread that was, in the same screenshot, labelling that steer "steered
 * mid-turn". The two rows contradicted each other.
 *
 * The line is a fact about `steerRuns`, so it is read from `steerRuns`.
 *
 * Asserted through `useSteerActions`, which is the seam the composer actually
 * mounts, rather than through the derivation behind it. That is the difference
 * between proving the rule and proving the product uses it: the derivation was
 * always correct in isolation, and the defect was a composer reading somewhere
 * else. Rendering the hook is what catches that.
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useSteerActions, type SteerActionsDeps } from '../src/hooks/use-steer-actions';
import type { InlineSteer } from '@kinu.run/core';

const queued = (id: string): InlineSteer =>
  ({ id, text: 'use the swarm for this', state: 'queued', atStep: null });
const landed = (id: string, atStep = 3): InlineSteer =>
  ({ id, text: 'use the swarm for this', state: 'landed', atStep });

/** The composer's notice, as the hook hands it over for a given server state.
 *
 *  `renderToStaticMarkup` runs the hook for real — `useState`, `useMemo` and
 *  every dependency the composer passes — and hands back what a reader would
 *  see. No effects run, and none are needed: the queued line is derived, which
 *  is the property under test. */
function noticeFor(steerRuns: readonly InlineSteer[], hasAttachments = false): string | null {
  let seen: string | null = null;
  function Probe() {
    const deps: SteerActionsDeps = {
      steerChat: async () => 'mid-turn',
      abortChat: async () => [],
      sendChat: () => {},
      draft: '',
      setDraft: () => {},
      hasAttachments,
      steerRuns,
      messageIds: [],
    };
    const { notice } = useSteerActions(deps);
    seen = notice === null ? null : notice.text;
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return seen;
}

describe('the queued line, as the composer receives it', () => {
  test('there is nothing to say when no steer is waiting', () => {
    expect(noticeFor([])).toBeNull();
  });

  test('a waiting steer says it lands at the next step', () => {
    expect(noticeFor([queued('s1')])).toBe("Queued — it lands at the agent's next step.");
  });

  test('the line is GONE once the model has it', () => {
    // The defect, stated as the property that closes it: the same steer, one
    // broadcast later, and the composer has nothing left to promise.
    expect(noticeFor([landed('s1')])).toBeNull();
  });

  test('one steer still waiting keeps the line while an earlier one has landed', () => {
    expect(noticeFor([landed('s1'), queued('s2')]))
      .toBe("Queued — it lands at the agent's next step.");
  });

  test('a draft carrying attachments says what a steer cannot take with it', () => {
    expect(noticeFor([queued('s1')], true)).toContain('a steer carries text only');
  });
});
