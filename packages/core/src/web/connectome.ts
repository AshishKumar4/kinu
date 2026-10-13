/**
 * Connectome background: a sparse tissue of still pyramidal neurons in the view's margins. Each cell is a soma, a long
 * apical dendrite with its tuft, two or three short basal dendrites, and an axon to two or three neighbours. A cell
 * fires now and then: its soma and arbor brighten and a spike runs down each axon, and a spike that lands may tip the
 * next cell over. Nothing moves. The pointer is a stimulus, never a force: a cell under it charges and fires, and a
 * click fires the nearest one. Pure and deterministic for a given seed, width and call sequence; emits `ArtFrame`.
 *
 * A soma's place is view-normalised (0..1 both ways), so a resize keeps the tissue spread over the view; every length
 * is in view widths, so a cell keeps its shape. Lengths are set in CSS pixels and scaled by the width it was grown for.
 */

import { type ArtFrame, clamp, type KeepOut, NODE_STRIDE, PULSE_STRIDE, STROKE_STRIDE, TONE_ACCENT, TONE_BRIGHT } from './art';
import { seededRandom } from '../utils/stats';

export interface ConnectomeOptions {
  readonly seed: number;
  readonly aspect: number;
  /** CSS pixels across, so a cell is the same size on any window. */
  readonly width: number;
  /** Decisions already waiting at birth earn no flash. */
  readonly activity?: ConnectomeActivity;
}

export interface ConnectomeActivity {
  readonly working: boolean;
  readonly decisions: number;
}

export type ConnectomeMode = 'idle' | 'working' | 'attention';

/** One cell per this many square pixels, between the bounds. */
const AREA_PER_CELL = 62_000;

const MIN_CELLS = 5;

const MAX_CELLS = 26;

const SPACING_PX = 210;

/** Axons reach neighbours at most this far. */
const AXON_REACH_PX = 520;

const APICAL_PX = [150, 230] as const;

const BASAL_PX = [22, 36] as const;

const SOMA_PX = [2.8, 3.6] as const;

const SPIKE_SPEED_PX = 300;

const SPIKE_TAIL_PX = 26;

/** An axon stops this short of the soma it reaches. */
const SYNAPSE_GAP_PX = 9;

/** Seconds between a cell's own spikes, on average, idle and while an agent works. */
const IDLE_PERIOD = 22;

const WORKING_PERIOD = 7;

const REFRACTORY = 2.4;

/** Seconds for a cell's charge, and its glow, to fall to a third. */
const LEAK = 1.8;

const GLOW_DECAY = 0.55;

const POINTER_REACH_PX = 110;

/** Charge per second at the pointer's centre: a cell under a resting pointer fires in about a second. */
const POINTER_CHARGE = 1.3;

/** Per second: how fast the pointer's hold eases in when it arrives and out when it leaves. */
const POINTER_RATE = 4;

const CLICK_REACH_PX = 200;

const DENDRITE_ALPHA = 0.28;

const AXON_ALPHA = 0.09;

const SOMA_ALPHA = 0.48;

const FLASH_ATTACK = 0.12;

const FLASH_DECAY = 1.3;

/** Keep-out reach in view widths: whole cover within KEEP_OUT_HOLD, fading over KEEP_OUT_FADE. */
const KEEP_OUT_HOLD = 0.012;

const KEEP_OUT_FADE = 0.02;

const MAX_SPIKES = 64;

interface Cell {
  /** View units. */
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly axons: number[];
  potential: number;
  glow: number;
  sense: number;
  quietUntil: number;
  nextOwn: number;
  pendingAt: number;
  cover: number;
}

/** A dendrite piece: a quadratic from the soma's place, in view widths both ways. */
interface Dendrite {
  readonly cell: number;
  readonly x0: number;
  readonly y0: number;
  readonly cx: number;
  readonly cy: number;
  readonly x1: number;
  readonly y1: number;
  readonly width: number;
  /** 0 at the soma, 1 at a tip. */
  readonly depth: number;
  cover: number;
}

interface Axon {
  readonly from: number;
  readonly to: number;
  /** Share of its length; signed. */
  readonly bow: number;
  readonly weight: number;
  cover: number;
}

interface Spike {
  readonly axon: number;
  head: number;
}

/** A curving run of dendrite pieces: where it starts, which way, how long, and its width and depth from end to end. */
interface Run {
  readonly cell: number;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly length: number;
  readonly segments: number;
  readonly width: readonly [number, number];
  readonly depth: readonly [number, number];
}

function between(random: () => number, [low, high]: readonly [number, number]): number {
  return low + (high - low) * random();
}

function envelope(age: number): number {
  if (age < FLASH_ATTACK) return age / FLASH_ATTACK;

  return clamp(1 - (age - FLASH_ATTACK) / FLASH_DECAY, 0, 1);
}

export class Connectome {
  private readonly random: () => number;

  /** View widths per CSS pixel. */
  private readonly px: number;

  private readonly cells: Cell[] = [];

  private readonly dendrites: Dendrite[] = [];

  private readonly axons: Axon[] = [];

  private readonly spikes: Spike[] = [];

  private aspect: number;

  private elapsed = 0;

  private activity: ConnectomeActivity = { working: false, decisions: 0 };

  private flashAge: number | null = null;

  /** View units; null when absent, hoverless or reduced-motion. */
  private pointer: readonly [number, number] | null = null;

  private hold = 0;

  private keepOut: readonly KeepOut[] = [];

  private readonly strokes: Float32Array<ArrayBuffer>;

  private readonly points: Float32Array<ArrayBuffer>;

  private readonly pulses = new Float32Array(new ArrayBuffer(4 * PULSE_STRIDE * MAX_SPIKES));

  constructor(options: ConnectomeOptions) {
    this.random = seededRandom(options.seed);
    this.aspect = options.aspect;
    this.px = 1 / Math.max(1, options.width);
    this.grow(options.width);
    this.strokes = new Float32Array(new ArrayBuffer(4 * STROKE_STRIDE * (this.dendrites.length + this.axons.length)));
    this.points = new Float32Array(new ArrayBuffer(4 * NODE_STRIDE * this.cells.length));

    if (options.activity !== undefined) this.activity = options.activity;
  }

  get time(): number {
    return this.elapsed;
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
    this.shade();
  }

  /** View units; nothing is drawn under them. */
  setKeepOut(boxes: readonly KeepOut[]): void {
    this.keepOut = boxes;
    this.shade();
  }

  /** A rise in the decision count fires every cell at once; working only quickens the cells' own spikes. */
  setActivity(activity: ConnectomeActivity): void {
    const previous = this.activity;
    this.activity = activity;

    if (activity.decisions <= previous.decisions) return;
    this.flashAge = 0;

    for (let index = 0; index < this.cells.length; index += 1) this.fire(index, true);
  }

  mode(): ConnectomeMode {
    if (this.flashAge !== null && envelope(this.flashAge) > 0.02) return 'attention';

    return this.activity.working ? 'working' : 'idle';
  }

  /** How far the pointer's stimulus has eased in: 0 with no pointer. */
  pointerHold(): number {
    return this.hold;
  }

  /** View units. Never feeds the random stream, so scripted paths replay identically. */
  setPointer(x: number, y: number): void {
    this.pointer = [x, y];
  }

  clearPointer(): void {
    this.pointer = null;
  }

  /** View units: fires the nearest cell in reach. */
  click(x: number, y: number): void {
    let nearest = -1;
    let gap = CLICK_REACH_PX * this.px;

    for (const [index, cell] of this.cells.entries()) {
      const distance = this.distance(cell.x, cell.y, x, y);

      if (distance < gap) {
        nearest = index;
        gap = distance;
      }
    }

    if (nearest >= 0) this.fire(nearest, true);
  }

  step(dt: number): void {
    this.elapsed += dt;
    this.hold += ((this.pointer === null ? 0 : 1) - this.hold) * (1 - Math.exp(-dt * POINTER_RATE));

    if (this.flashAge !== null) this.flashAge += dt;
    const period = this.activity.working ? WORKING_PERIOD : IDLE_PERIOD;
    const reach = POINTER_REACH_PX * this.px;

    for (const [index, cell] of this.cells.entries()) {
      cell.glow *= Math.exp(-dt / GLOW_DECAY);
      cell.potential *= Math.exp(-dt / LEAK);
      cell.sense = this.pointer === null ? 0 : this.hold * clamp(1 - this.distance(cell.x, cell.y, this.pointer[0], this.pointer[1]) / reach, 0, 1);
      cell.potential += POINTER_CHARGE * cell.sense * cell.sense * dt;

      // A charged cell fires a beat later, so a volley spreads instead of landing at once.
      if (cell.potential >= 1 && cell.pendingAt === 0) cell.pendingAt = this.elapsed + 0.06 + 0.12 * this.random();

      if (cell.pendingAt !== 0 && this.elapsed >= cell.pendingAt) {
        cell.pendingAt = 0;
        this.fire(index, false);
      }

      if (this.elapsed >= cell.nextOwn) {
        cell.nextOwn = this.elapsed + period * (0.4 + 1.2 * this.random());
        this.fire(index, false);
      }
    }

    this.moveSpikes(dt);
  }

  frame(): ArtFrame {
    let count = 0;
    const data = this.strokes;

    for (const piece of this.dendrites) {
      const cell = this.cells[piece.cell];

      if (cell === undefined || piece.cover >= 0.995) continue;
      const lit = cell.glow * (1 - 0.55 * piece.depth);
      const at = count * STROKE_STRIDE;
      data[at] = cell.x + piece.x0;
      data[at + 1] = cell.y + piece.y0 / this.aspect;
      data[at + 2] = cell.x + piece.cx;
      data[at + 3] = cell.y + piece.cy / this.aspect;
      data[at + 4] = cell.x + piece.x1;
      data[at + 5] = cell.y + piece.y1 / this.aspect;
      data[at + 6] = 1;
      data[at + 7] = piece.width;
      data[at + 8] = clamp(0.25 + lit + 0.3 * cell.sense, 0, 1);
      data[at + 9] = lit > 0.3 ? TONE_BRIGHT : TONE_ACCENT;
      data[at + 10] = DENDRITE_ALPHA * (1 - 0.45 * piece.depth) * (1 + 1.6 * lit + 0.6 * cell.sense) * (1 - piece.cover);
      data[at + 11] = 0;
      count += 1;
    }

    for (const [index, axon] of this.axons.entries()) {
      if (axon.cover >= 0.995) continue;
      const [x0, y0, cx, cy, x1, y1] = this.axonCurve(index);
      const at = count * STROKE_STRIDE;
      data[at] = x0;
      data[at + 1] = y0;
      data[at + 2] = cx;
      data[at + 3] = cy;
      data[at + 4] = x1;
      data[at + 5] = y1;
      data[at + 6] = 1;
      data[at + 7] = 0.7;
      data[at + 8] = 0.25;
      data[at + 9] = TONE_ACCENT;
      data[at + 10] = AXON_ALPHA * (1 - axon.cover);
      data[at + 11] = 0;
      count += 1;
    }

    let nodeCount = 0;

    for (const cell of this.cells) {
      if (cell.cover >= 0.995) continue;
      const at = nodeCount * NODE_STRIDE;
      this.points[at] = cell.x;
      this.points[at + 1] = cell.y;
      this.points[at + 2] = cell.radius * (1 + 0.3 * cell.glow);
      this.points[at + 3] = clamp(0.2 + cell.glow + 0.4 * cell.sense, 0, 1);
      this.points[at + 4] = cell.glow > 0.3 ? TONE_BRIGHT : TONE_ACCENT;
      this.points[at + 5] = clamp(SOMA_ALPHA * (1 + 1.2 * cell.glow + 0.5 * cell.sense), 0, 1) * (1 - cell.cover);
      this.points[at + 6] = 0;
      this.points[at + 7] = 0;
      nodeCount += 1;
    }

    return { strokes: data, count, nodes: this.points, nodeCount, pulses: this.pulses, pulseCount: this.framePulses(), time: this.elapsed };
  }

  /** In view widths. */
  private distance(x0: number, y0: number, x1: number, y1: number): number {
    return Math.hypot(x1 - x0, (y1 - y0) * this.aspect);
  }

  /** The axon's quadratic in view units, ending short of the soma it reaches. */
  private axonCurve(index: number): readonly [number, number, number, number, number, number] {
    const axon = this.axons[index];
    const from = axon === undefined ? undefined : this.cells[axon.from];
    const to = axon === undefined ? undefined : this.cells[axon.to];

    if (axon === undefined || from === undefined || to === undefined) return [0, 0, 0, 0, 0, 0];
    const dx = to.x - from.x;
    const dy = (to.y - from.y) * this.aspect;
    const end = 1 - SYNAPSE_GAP_PX * this.px / Math.max(1e-6, Math.hypot(dx, dy));

    return [from.x, from.y, from.x + dx / 2 - dy * axon.bow, from.y + (dy / 2 + dx * axon.bow) / this.aspect, from.x + dx * end, from.y + dy * end / this.aspect];
  }

  private fire(index: number, forced: boolean): void {
    const cell = this.cells[index];

    if (cell === undefined || (!forced && this.elapsed < cell.quietUntil)) return;
    cell.glow = 1;
    cell.potential = 0;
    cell.quietUntil = this.elapsed + REFRACTORY;

    for (const axon of cell.axons) {
      if (this.spikes.length < MAX_SPIKES) this.spikes.push({ axon, head: 0 });
    }
  }

  private moveSpikes(dt: number): void {
    const speed = SPIKE_SPEED_PX * this.px;

    for (let index = this.spikes.length - 1; index >= 0; index -= 1) {
      const spike = this.spikes[index];
      const axon = spike === undefined ? undefined : this.axons[spike.axon];
      const from = axon === undefined ? undefined : this.cells[axon.from];
      const to = axon === undefined ? undefined : this.cells[axon.to];

      if (spike === undefined || axon === undefined || from === undefined || to === undefined) continue;
      spike.head += speed * dt / Math.max(1e-6, this.distance(from.x, from.y, to.x, to.y));

      if (spike.head < 1) continue;
      this.spikes.splice(index, 1);

      if (this.elapsed >= to.quietUntil) to.potential += axon.weight;
    }
  }

  private framePulses(): number {
    let count = 0;

    for (const spike of this.spikes) {
      const axon = this.axons[spike.axon];
      const from = axon === undefined ? undefined : this.cells[axon.from];
      const to = axon === undefined ? undefined : this.cells[axon.to];

      if (axon === undefined || from === undefined || to === undefined) continue;
      const [x0, y0, cx, cy, x1, y1] = this.axonCurve(spike.axon);
      const head = clamp(spike.head, 0, 1);
      const tail = clamp(spike.head - SPIKE_TAIL_PX * this.px / Math.max(1e-6, this.distance(from.x, from.y, to.x, to.y)), 0, 1);
      const fade = (1 - axon.cover) * clamp((1 - spike.head) * 8, 0, 1);
      this.pulses.set([x0, y0, cx, cy, x1, y1, tail, head, 1.5, 0.9, TONE_BRIGHT, 0.7 * fade, spike.axon, 0, 1, 0], count * PULSE_STRIDE);
      count += 1;
    }

    return count;
  }

  /** 0 clear, 1 hidden; view units. */
  private coverAt(x: number, y: number): number {
    let cover = 0;

    for (const box of this.keepOut) {
      const dx = Math.max(box.left - x, 0, x - box.right);
      const dy = Math.max(box.top - y, 0, y - box.bottom) * this.aspect;
      cover = Math.max(cover, 1 - clamp((Math.hypot(dx, dy) - KEEP_OUT_HOLD) / KEEP_OUT_FADE, 0, 1));
    }

    return cover;
  }

  /** A curve is hidden as far as the most covered of its ends and its control point. */
  private shade(): void {
    for (const cell of this.cells) cell.cover = this.coverAt(cell.x, cell.y);

    for (const piece of this.dendrites) {
      const cell = this.cells[piece.cell];

      if (cell === undefined) continue;
      const at = (x: number, y: number): number => this.coverAt(cell.x + x, cell.y + y / this.aspect);
      piece.cover = Math.max(at(piece.x0, piece.y0), at(piece.cx, piece.cy), at(piece.x1, piece.y1));
    }

    for (const [index, axon] of this.axons.entries()) {
      const [x0, y0, cx, cy, x1, y1] = this.axonCurve(index);
      axon.cover = Math.max(this.coverAt(x0, y0), this.coverAt(cx, cy), this.coverAt(x1, y1));
    }
  }

  /** Margins first: the middle of the view holds the copy, so a cell there is kept only rarely. */
  private place(width: number): void {
    const target = clamp(Math.round(width * width * this.aspect / AREA_PER_CELL), MIN_CELLS, MAX_CELLS);
    const spacing = SPACING_PX * this.px;

    for (let attempt = 0; attempt < target * 60 && this.cells.length < target; attempt += 1) {
      const x = 0.03 + 0.94 * this.random();
      const y = 0.04 + 0.92 * this.random();
      const rim = Math.hypot((x - 0.58) / 0.42, (y - 0.5) / 0.5);

      if (this.random() > 0.15 + 0.85 * clamp((rim - 0.35) / 0.45, 0, 1)) continue;

      if (this.cells.some((cell) => this.distance(cell.x, cell.y, x, y) < spacing)) continue;
      this.cells.push({
        x, y, radius: between(this.random, SOMA_PX), axons: [], potential: 0, glow: 0, sense: 0,
        quietUntil: 0, nextOwn: IDLE_PERIOD * this.random(), pendingAt: 0, cover: 0,
      });
    }
  }

  /** Returns where the run ends, relative to its soma, and its last heading. */
  private branch({ cell, x, y, heading, length, segments, width, depth }: Run): readonly [number, number, number] {
    let px = x;
    let py = y;
    let angle = heading;
    const step = length / segments;

    for (let index = 0; index < segments; index += 1) {
      const bend = (this.random() - 0.5) * 0.5;
      const nx = px + Math.cos(angle + bend) * step;
      const ny = py + Math.sin(angle + bend) * step;
      const normal = angle + bend / 2 + Math.PI / 2;
      const share = index / segments;
      this.dendrites.push({
        cell, x0: px, y0: py,
        cx: (px + nx) / 2 + Math.cos(normal) * step * 0.12 * (this.random() - 0.5),
        cy: (py + ny) / 2 + Math.sin(normal) * step * 0.12 * (this.random() - 0.5),
        x1: nx, y1: ny, width: width[0] + (width[1] - width[0]) * share, depth: depth[0] + (depth[1] - depth[0]) * share, cover: 0,
      });
      px = nx;
      py = ny;
      angle += bend;
    }

    return [px, py, angle];
  }

  private grow(width: number): void {
    this.place(width);
    const px = this.px;

    for (const index of this.cells.keys()) {
      const up = -Math.PI / 2 + (this.random() - 0.5) * 0.7;
      const apical = between(this.random, APICAL_PX) * px;
      const [tx, ty, tipHeading] = this.branch({ cell: index, x: 0, y: 0, heading: up, length: apical, segments: 4, width: [1.5, 0.9], depth: [0, 0.6] });
      const tuft = 2 + Math.floor(this.random() * 2);

      for (let fork = 0; fork < tuft; fork += 1) {
        const spread = (fork - (tuft - 1) / 2) * 0.75 + (this.random() - 0.5) * 0.3;
        this.branch({ cell: index, x: tx, y: ty, heading: tipHeading + spread, length: apical * (0.22 + 0.15 * this.random()), segments: 2, width: [0.8, 0.5], depth: [0.6, 1] });
      }

      // Short basal dendrites, so a cell reads as a tree and never as legs.
      const basal = 2 + Math.floor(this.random() * 2);

      for (let root = 0; root < basal; root += 1) {
        const angle = up + Math.PI + (root - (basal - 1) / 2) * 1.1 + (this.random() - 0.5) * 0.3;
        const length = between(this.random, BASAL_PX) * px;
        const [bx, by, heading] = this.branch({ cell: index, x: 0, y: 0, heading: angle, length, segments: 2, width: [1.2, 0.8], depth: [0, 0.6] });

        for (const side of [-1, 1]) {
          if (this.random() < 0.35) continue;
          this.branch({ cell: index, x: bx, y: by, heading: heading + side * (0.35 + 0.3 * this.random()), length: length * (0.4 + 0.25 * this.random()), segments: 1, width: [0.7, 0.5], depth: [0.6, 1] });
        }
      }
    }

    this.wire();
  }

  /** Each cell's axon reaches two or three of its nearer neighbours, one axon a pair, bowed so no two runs overlap. */
  private wire(): void {
    for (const [index, cell] of this.cells.entries()) {
      const near = this.cells
        .map((other, id) => ({ id, gap: this.distance(cell.x, cell.y, other.x, other.y) }))
        .filter(({ id, gap }) => id !== index && gap < AXON_REACH_PX * this.px)
        .sort((a, b) => a.gap - b.gap)
        .slice(0, 2 + Math.floor(this.random() * 2));

      for (const { id } of near) {
        const other = this.cells[id];

        if (other === undefined || other.axons.some((axon) => this.axons[axon]?.to === index)) continue;
        cell.axons.push(this.axons.length);
        this.axons.push({ from: index, to: id, bow: (this.random() < 0.5 ? -1 : 1) * (0.12 + 0.14 * this.random()), weight: 0.5 + 0.6 * this.random(), cover: 0 });
      }
    }
  }
}
