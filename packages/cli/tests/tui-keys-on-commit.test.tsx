/** @jsxImportSource @opentui/react */
/**
 * A screen hears its keys from the commit that draws it (`use-keys.ts`). A key here is sent from a layout effect of a
 * component committed after the screen: as a person's key lands the moment the frame does, before any passive effect
 * of that commit has run. With opentui's own `useKeyboard` the screen is not yet listening then, and the key is lost.
 */
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot, flushSync } from '@opentui/react';
import { expect, test } from 'bun:test';
import { useLayoutEffect } from 'react';

import { useKeyboard } from '../src/tui/use-keys';

type Mounted = Awaited<ReturnType<typeof createTestRenderer>>;

function mount(node: React.ReactNode, setup: Mounted): () => void {
  const root = createRoot(setup.renderer);

  flushSync(() => { root.render(node); });

  return () => {
    flushSync(() => { root.unmount(); });
    setup.renderer.destroy();
  };
}

test('a key sent as the screen commits reaches the screen', async () => {
  const setup = await createTestRenderer({ width: 40, height: 4 });
  const heard: string[] = [];

  function Screen() {
    useKeyboard((key) => { heard.push(`${key.ctrl ? 'ctrl+' : ''}${key.name}`); });

    return <text>What is this workspace for?</text>;
  }

  function Typist() {
    useLayoutEffect(() => { setup.mockInput.pressKey('l', { ctrl: true }); }, []);

    return null;
  }

  const unmount = mount(<><Screen /><Typist /></>, setup);

  expect(heard).toEqual(['ctrl+l']);
  unmount();
});

// The home screen's setup steps claim the keys they answer (`onboarding.tsx`) before the home screen reads them.
test('a nested screen hears a key before the screen around it, which sees it claimed', async () => {
  const setup = await createTestRenderer({ width: 40, height: 4 });
  const order: string[] = [];

  function Step() {
    useKeyboard((key) => {
      order.push('step');
      key.preventDefault();
    });

    return <text>Base URL</text>;
  }

  function Home() {
    useKeyboard((key) => { order.push(key.defaultPrevented ? 'home saw it claimed' : 'home took it'); });

    return <box><Step /></box>;
  }

  const unmount = mount(<Home />, setup);

  setup.mockInput.pressKey('x');
  expect(order).toEqual(['step', 'home saw it claimed']);
  unmount();
});
