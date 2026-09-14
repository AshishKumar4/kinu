/**
 * Information moving along a picture: a bright head with a soft tail,
 * travelling one edge at a time. The search tree sends attempts out along
 * its branches and scores back toward the seed; the connectome sends
 * signals along its fibres. Both ride this one type: the pulse's place on
 * its edge, how it moves, how far its tail reaches, and how it is written
 * into the frame. Which edge comes next at an edge's end is each
 * picture's own rule — a tree walks parent and child, a graph walks
 * neighbours — so that step stays with the simulation.
 */

import { clamp, grown, PULSE_STRIDE } from './art';

export interface Pulse {
  readonly id: number;
  /** The frame's layer slot: a depth for the tree, a lobe for the connectome. */
  layer: number;
  /** The edge whose curve the pulse is on. */
  edge: number;
  /** Where the head is along the edge, 0 at its start, 1 at its end. */
  head: number;
  /** +1 from the edge's start toward its end, -1 the other way. A tree's
   *  pulse keeps its direction for life; a graph's turns with every edge. */
  direction: 1 | -1;
  readonly strength: number;
}

/** Advance the head by `speed` view widths per second along an edge `length` view widths long. */
export function movePulse(pulse: Pulse, speed: number, dt: number, length: number): void {
  pulse.head += pulse.direction * speed * dt / Math.max(1e-6, length);
}

/** Where the tail sits on the edge: `reach` view widths behind the head, clamped to the edge. */
export function pulseTail(pulse: Pulse, reach: number, length: number): number {
  return clamp(pulse.head - pulse.direction * reach / Math.max(1e-6, length), 0, 1);
}

/** One pulse as the frame carries it: the edge's whole curve in view
 *  units, the span the pulse lights, its look, and its identity. */
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

/** Write `record` as the `count`-th pulse of `data`, growing the buffer when it is full; returns the buffer to keep. */
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
