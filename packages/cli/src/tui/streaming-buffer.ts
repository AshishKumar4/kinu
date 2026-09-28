import { useCallback, useEffect, useMemo, useRef } from 'react';

type TimeoutHandle = ReturnType<typeof setTimeout>;

const FLUSH_INTERVAL_MS = 50;

interface StreamingBufferController {
  start(): void;
  append(delta: string): void;
  finish(): void;
  clear(): void;
  dispose(): void;
}

/** Structural rather than `typeof setTimeout`: platform timer globals differ in their extras. */
interface StreamingBufferTimers {
  setTimeout(callback: () => void, ms: number): TimeoutHandle;
  clearTimeout(handle: TimeoutHandle): void;
}

export function createStreamingBufferController(
  setStreamingText: (value: string | null) => void,
  timers: StreamingBufferTimers = { setTimeout, clearTimeout },
): StreamingBufferController {
  let buffer = '';
  let timer: TimeoutHandle | null = null;

  const cancelTimer = () => {
    if (timer) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    cancelTimer();
    setStreamingText(buffer);
  };

  const schedule = () => {
    if (timer) return;
    timer = timers.setTimeout(flush, FLUSH_INTERVAL_MS);
  };

  const reset = () => {
    cancelTimer();
    buffer = '';
    setStreamingText(null);
  };

  return {
    start: reset,
    append(delta: string) {
      buffer += delta;
      schedule();
    },
    finish: flush,
    clear: reset,
    dispose: cancelTimer,
  };
}

export function useStreamingBuffer(setStreamingText: (value: string | null) => void) {
  const controllerRef = useRef<StreamingBufferController | null>(null);

  controllerRef.current ??= createStreamingBufferController(setStreamingText);

  const start = useCallback(() => {
    controllerRef.current?.start();
  }, []);

  const append = useCallback((delta: string) => {
    controllerRef.current?.append(delta);
  }, []);

  const finish = useCallback(() => {
    controllerRef.current?.finish();
  }, []);

  const clear = useCallback(() => {
    controllerRef.current?.clear();
  }, []);

  useEffect(() => {
    const controller = createStreamingBufferController(setStreamingText);
    controllerRef.current = controller;

    return () => controller.dispose();
  }, [setStreamingText]);

  return useMemo(() => ({ start, append, finish, clear }), [append, clear, finish, start]);
}
