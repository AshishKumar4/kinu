/** A pulse moving along one edge of a picture (search tree or connectome); choosing the next edge stays with each simulation. */

import { clamp, grown, PULSE_STRIDE } from './art';

export interface Pulse {
  readonly id: number;
  /** A depth for the tree, a lobe for the connectome. */
  layer: number;
  edge: number;
  /** 0 at the edge's start, 1 at its end. */
  head: number;
  /** A tree's pulse keeps its direction for life; a graph's turns with every edge. */
  direction: 1 | -1;
  readonly strength: number;
}

/** `speed` and `length` are in view widths (per second). */
export function movePulse(pulse: Pulse, speed: number, dt: number, length: number): void {
  pulse.head += pulse.direction * speed * dt / Math.max(1e-6, length);
}

/** `reach` view widths behind the head, clamped to the edge. */
export function pulseTail(pulse: Pulse, reach: number, length: number): number {
  return clamp(pulse.head - pulse.direction * reach / Math.max(1e-6, length), 0, 1);
}

export interface PulseRecord {
  readonly x0: number;
  readonly y0: number;
  readonly cx: number;
  readonly cy: number;
  readonly x1: number;
  readonly y1: number;
  readonly tail: number;
  readonly head: number;
  readonly width: number;
  readonly glow: number;
  readonly tone: number;
  readonly alpha: number;
  readonly id: number;
  readonly layer: number;
  readonly direction: number;
}

/** Grows the buffer when full; returns the buffer to keep. */
export function writePulse(data: Float32Array<ArrayBuffer>, count: number, record: PulseRecord): Float32Array<ArrayBuffer> {
  const kept = grown(data, (count + 1) * PULSE_STRIDE);
  const at = count * PULSE_STRIDE;
  kept[at] = record.x0;
  kept[at + 1] = record.y0;
  kept[at + 2] = record.cx;
  kept[at + 3] = record.cy;
  kept[at + 4] = record.x1;
  kept[at + 5] = record.y1;
  kept[at + 6] = record.tail;
  kept[at + 7] = record.head;
  kept[at + 8] = record.width;
  kept[at + 9] = record.glow;
  kept[at + 10] = record.tone;
  kept[at + 11] = record.alpha;
  kept[at + 12] = record.id;
  kept[at + 13] = record.layer;
  kept[at + 14] = record.direction;
  kept[at + 15] = 0;

  return kept;
}
