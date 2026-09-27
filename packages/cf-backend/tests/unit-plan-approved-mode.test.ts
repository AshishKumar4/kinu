/**
 * A plan awaiting decision leaves the composer in the mode the owner chose, with Auto open; its approval
 * turns the composer to Auto. Hooks run under React's client reconciler (their effects set the mode);
 * the composer is read from its static markup by role and state.
 */
import './helpers/ui-module-globals';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlanReview } from '@kinu.run/core';
import { Composer } from '../src/components/Composer';
import { useConversationUiState, usePlanApprovedMode, type ConversationUiState } from '../src/hooks/use-conversation-ui-state';

const PENDING: PlanReview = {
  id: 'plan-lane', sessionId: 'default', revision: 1, content: '# Prompt edits', status: 'pending',
  annotations: [], feedback: null, handoffAccepted: false, createdAt: 1, updatedAt: 1,
};

const KEYS = ['window', 'IS_REACT_ACT_ENVIRONMENT'] as const;

const saved = new Map(KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

const media = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

beforeAll(() => {
  Object.assign(globalThis, { window: { matchMedia: media, HTMLIFrameElement: class {}, document: { activeElement: null } }, IS_REACT_ACT_ENVIRONMENT: true });
});

afterAll(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
});

/** Whether each of the mode group's buttons is disabled, in order. */
async function modeButtonsDisabled(ui: ConversationUiState): Promise<boolean[]> {
  const html = renderToStaticMarkup(createElement(Composer, {
    value: 'fix the typo', onValueChange: () => {}, onSend: () => {}, placeholder: '', disabled: false,
    liveness: { kind: 'idle' } as const, onStop: () => {},
    mode: { value: ui.mode, onChange: ui.setMode },
  }));

  const disabled: boolean[] = [];
  await new HTMLRewriter()
    .on('[role="group"] button', { element(button) { disabled.push(button.hasAttribute('disabled')); } })
    .transform(new Response(html))
    .text();

  return disabled;
}

describe('the composer under a pending plan', () => {
  test('a pending or dismissed plan leaves Auto chosen and open; an approval returns a Plan composer to Auto', async () => {
    const listens = { addEventListener() {}, removeEventListener() {} };
    const container: Element = Object.create(null, Object.getOwnPropertyDescriptors({ nodeType: 1, tagName: 'DIV', namespaceURI: null, ownerDocument: listens, ...listens }));
    const root = createRoot(container);
    let ui: ConversationUiState | null = null;

    function Pane({ plan }: { plan: PlanReview }): null {
      const state = useConversationUiState('workspace-plan-gate');
      ui = state;
      usePlanApprovedMode(plan, state.setMode);

      return null;
    }

    const read = () => {
      if (ui === null) throw new Error('the pane did not render');

      return ui;
    };

    const show = (status: PlanReview['status']) => act(async () => { root.render(createElement(Pane, { plan: { ...PENDING, status } })); });

    await show('pending');
    expect(read().mode).toBe('build');
    expect(await modeButtonsDisabled(read())).toEqual([false, false]);

    await show('dismissed');
    expect(read().mode).toBe('build');
    expect(await modeButtonsDisabled(read())).toEqual([false, false]);

    await act(async () => { read().setMode('plan'); });
    await show('approved');
    expect(read().mode).toBe('build');

    await act(async () => { root.unmount(); });
  });
});
