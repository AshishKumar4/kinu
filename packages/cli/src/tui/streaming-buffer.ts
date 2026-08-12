import { useCallback, useEffect, useMemo, useRef } from 'react';

type TimeoutHandle = ReturnType<typeof setTimeout>;

export interface StreamingBufferController {
  start(): void;
  append(delta: string): void;
  finish(finalText?: string): void;
  clear(): void;
  dispose(): void;
}

/** Structural rather than `typeof setTimeout`: this module schedules a
 *  callback and cancels it, and the platform globals it runs against differ in
 *  the extras they hang off those names. */
export interface StreamingBufferTimers {
  setTimeout(callback: () => void, ms: number): TimeoutHandle;
  clearTimeout(handle: TimeoutHandle): void;
}

export function createStreamingBufferController(
  setStreamingText: (value: string | null) => void,
  intervalMs = 50,
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
    timer = timers.setTimeout(flush, intervalMs);
  };

  return {
    start() {
      cancelTimer();
      buffer = '';
      setStreamingText(null);
    },
    append(delta: string) {
      buffer += delta;
      schedule();
    },
    finish(finalText?: string) {
      if (finalText !== undefined) buffer = finalText;
      flush();
    },
    clear() {
      cancelTimer();
      buffer = '';
      setStreamingText(null);
    },
    dispose() {
      cancelTimer();
    },
  };
}

export function useStreamingBuffer(
  setStreamingText: (value: string | null) => void,
  intervalMs = 50,
) {
  const controllerRef = useRef<StreamingBufferController | null>(null);
  if (!controllerRef.current) controllerRef.current = createStreamingBufferController(setStreamingText, intervalMs);

  const start = useCallback(() => {
    controllerRef.current?.start();
  }, []);

  const append = useCallback((delta: string) => {
    controllerRef.current?.append(delta);
  }, []);

  const finish = useCallback((finalText?: string) => {
    controllerRef.current?.finish(finalText);
  }, []);

  const clear = useCallback(() => {
    controllerRef.current?.clear();
  }, []);

  useEffect(() => {
    const controller = createStreamingBufferController(setStreamingText, intervalMs);
    controllerRef.current = controller;
    return () => controller.dispose();
  }, [intervalMs, setStreamingText]);

  return useMemo(() => ({ start, append, finish, clear }), [append, clear, finish, start]);
}
