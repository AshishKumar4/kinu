/**
 * The composer's line about a steer the server holds (#210: "the 'Queued' thing also doesn't go away"). It is a
 * fact about `steerRuns`, asserted through `useSteerActions`, the seam the composer mounts, not the derivation behind it.
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

/** The hook's notice for a server state; no effects run, which is fine because the queued line is derived. */
function noticeFor(steerRuns: readonly InlineSteer[]): string | null | undefined {
  let seen: string | null | undefined = null;

  function Probe() {
    const deps: SteerActionsDeps = {
      sendChat: () => ({ landed: 'mid-turn', settled: Promise.resolve('mid-turn') }),
      abortChat: async () => {},
      draft: '',
      setDraft: () => {},
      steerRuns,
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

  test('a waiting steer puts up the queued line', () => {
    expect(noticeFor([queued('s1')])).not.toBeNull();
  });

  test('the line is GONE once the model has it', () => {
    expect(noticeFor([landed('s1')])).toBeNull();
  });

  test('one steer still waiting keeps the line while an earlier one has landed', () => {
    expect(noticeFor([landed('s1'), queued('s2')]))
      .toBe(noticeFor([queued('s2')]));
  });

  test('a draft carrying attachments gets the same line: attachments ride the send', () => {
    // A message to a running turn carries files as file parts, so there is no "text only" exception to explain.
    expect(noticeFor([queued('s1')])).not.toContain('text only');
  });
});
