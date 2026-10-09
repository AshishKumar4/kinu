import type { KeyEvent } from '@opentui/core';
import { useAppContext } from '@opentui/react';
import { useLayoutEffect, useRef } from 'react';

/**
 * opentui's `useKeyboard`, subscribed while its screen commits rather than after the screen paints, so a screen a
 * person can see already hears their keys. opentui's subscribes in a passive effect, which can run after the first
 * frame: under load the home screen drew its mission box, took a typed mission into the focused input, and dropped the
 * Ctrl+L sent right after it, since only the input was listening (the CLI suite on armada, 2026-10-08).
 *
 * A child subscribes before its parent, as before, so a step that claims a key it answers still sees it first.
 */
export function useKeyboard(handler: (key: KeyEvent) => void): void {
  const { keyHandler } = useAppContext();
  const latest = useRef(handler);

  useLayoutEffect(() => {
    latest.current = handler;
  });

  useLayoutEffect(() => {
    const heard = (key: KeyEvent) => {
      latest.current(key);
    };

    keyHandler?.on('keypress', heard);

    return () => {
      keyHandler?.off('keypress', heard);
    };
  }, [keyHandler]);
}
