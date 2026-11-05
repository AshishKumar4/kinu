/** The live rows of a turn: its answer's segment and its thinking, each streamed into the transcript as it arrives and
 *  sealed when it ends. */
import { useCallback, useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { TurnMeter } from '@kinu.run/core/tui';
import type { DisplayMessage } from './messages';
import { writeLiveMessage } from './chat-scene-text';
import { useStreamingBuffer } from './streaming-buffer';

export function useTurnStream(setMessages: Dispatch<SetStateAction<DisplayMessage[]>>, msgIdRef: RefObject<number>) {
  const activeSegmentRef = useRef<string | null>(null);
  /** If false at turn-end, turn.text is appended once. */
  const turnStreamedTextRef = useRef(false);

  const writeActiveSegment = useMemo(() => writeLiveMessage(activeSegmentRef, setMessages), [setMessages]);
  const stream = useStreamingBuffer(writeActiveSegment);
  const activeThinkingRef = useRef<string | null>(null);
  const writeThinking = useMemo(() => writeLiveMessage(activeThinkingRef, setMessages), [setMessages]);
  const thinkingStream = useStreamingBuffer(writeThinking);
  const turnMeterRef = useRef<TurnMeter | null>(null);
  const stepOutputsRef = useRef(new Set<string>());

  const appendThinking = useCallback((delta: string) => {
    if (!activeThinkingRef.current) {
      const id = `msg-${++msgIdRef.current}`;
      activeThinkingRef.current = id;
      stepOutputsRef.current.add(id);
      setMessages((prev) => [...prev, { id, role: 'thinking', content: '', live: true }]);
      thinkingStream.start();
    }

    thinkingStream.append(delta);
  }, [thinkingStream]);

  const beginSegment = useCallback(() => {
    const id = `msg-${++msgIdRef.current}`;
    activeSegmentRef.current = id;
    stepOutputsRef.current.add(id);
    const segment: DisplayMessage = { id, role: 'assistant', content: '', live: true };
    setMessages((prev) => [...prev, segment]);
    stream.start();
  }, [stream]);

  const sealThinking = useCallback(() => {
    const id = activeThinkingRef.current;

    if (!id) return;
    thinkingStream.finish();
    activeThinkingRef.current = null;
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, live: false } : m)));
  }, [thinkingStream]);

  /** An empty segment (tool before any text) is removed. */
  const sealSegment = useCallback(() => {
    const id = activeSegmentRef.current;
    activeSegmentRef.current = null;
    stream.clear();

    if (!id) return;
    setMessages((prev) => prev.flatMap((m) => {
      if (m.id !== id) return [m];

      return m.content.trim() ? [{ ...m, live: false }] : [];
    }));
  }, [stream]);

  return {
    activeSegmentRef, turnStreamedTextRef, stream, activeThinkingRef, thinkingStream, turnMeterRef, stepOutputsRef,
    appendThinking, beginSegment, sealThinking, sealSegment,
  };
}
