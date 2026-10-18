/**
 * The composer's line about a steer the server holds (#210: "the 'Queued' thing also doesn't go away"). It is a
 * fact about `steerRuns`, asserted through `useSteerActions`, the seam the composer mounts, not the derivation behind it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { sendLanding, type InlineSteer } from '@kinu.run/core';
import type { ComposerNotice } from '../src/components/Composer';
import { useSteerActions, type SteerActionsDeps } from '../src/hooks/use-steer-actions';
import { chatSessionTurns, orchestratorHarness, storedChat } from './helpers/actor-harness';

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
});

const KEYS = ['window', 'IS_REACT_ACT_ENVIRONMENT'] as const;

const saved = Object.fromEntries(KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

beforeAll(() => {
  Object.assign(globalThis, { window: { HTMLIFrameElement: class {}, document: { activeElement: null } }, IS_REACT_ACT_ENVIRONMENT: true });
});

afterAll(() => {
  for (const key of KEYS) {
    const descriptor = saved[key];

    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
});

test('a send that reaches the actor after its turn ends runs once and leaves the composer clear', async () => {
  const harness = orchestratorHarness();
  const { agent } = harness;
  const turns = chatSessionTurns(agent);
  const next = turns.park();
  const listens = { addEventListener() {}, removeEventListener() {} };
  const container: Element = Object.create(null, Object.getOwnPropertyDescriptors({ nodeType: 1, tagName: 'DIV', namespaceURI: null, ownerDocument: listens, ...listens }));
  const root = createRoot(container);
  let current: { readonly send: () => void; readonly draft: string; readonly notice: ComposerNotice | null } | undefined;
  let sends = 0;
  let landing: Promise<'mid-turn' | 'turn'> | undefined;

  function Composer(): null {
    const [draft, setDraft] = useState('Use the other parser.');

    const actions = useSteerActions({
      draft, setDraft, steerRuns: [],
      abortChat: async () => { await agent.cancelCurrentWork(); },
      sendChat: (text) => {
        sends += 1;
        const id = 'parser-follow-up';
        landing = sendLanding({ open: () => true, awaitSend: (sent) => agent.awaitSend(sent) }, agent.send(text, id), id);

        return { landed: 'mid-turn', settled: landing };
      },
    });

    current = { send: actions.send, notice: actions.notice, draft };

    return null;
  }

  try {
    await act(async () => { root.render(createElement(Composer)); });
    await act(async () => {
      if (current === undefined) throw new Error('the composer has not mounted');
      current.send();
      await next;
      await turns.settle({ messageId: 'parser-answer', text: 'The parser is changed.' });
      await landing;
    });
    const messages = await storedChat(harness);

    expect({
      sends,
      userMessages: messages.filter((message) => message.role === 'user').map((message) => message.parts),
      answers: messages.filter((message) => message.role === 'assistant').flatMap((message) => message.parts.flatMap((part) => part.type === 'text' ? [part.text] : [])),
      draft: current?.draft,
      notice: current?.notice,
    }).toEqual({
      sends: 1,
      userMessages: [[{ type: 'text', text: 'Use the other parser.' }]],
      answers: ['The parser is changed.'],
      draft: '', notice: null,
    });
  } finally {
    await act(async () => { root.unmount(); });
  }
});
