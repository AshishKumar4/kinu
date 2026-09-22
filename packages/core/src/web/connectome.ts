/**
 * Connectome background: a fixed-budget mat of branching, fusing fibres grown from the view's rim,
 * with signal grains. Pure and deterministic for a given seed, budget and call sequence; emits `ArtFrame`
 * (`nodeCount` always 0). Coordinates are view-normalised; nothing is drawn under keep-out boxes.
 */

import { type ArtFrame, clamp, grown, viewDistance, type KeepOut, PULSE_STRIDE, seededRandom, STROKE_STRIDE, TONE_ACCENT, TONE_BRIGHT } from './art';
import { movePulse, type Pulse, pulseTail, writePulse } from './pulse';

export interface ConnectomeOptions {
  readonly seed: number;
  readonly aspect: number;
  /** Defaults to MESH_SEGMENTS. */
  readonly segments?: number;
  /** Decisions already waiting at birth earn no flash. */
  readonly activity?: ConnectomeActivity;
}

export interface ConnectomeActivity {
  readonly working: boolean;
  readonly decisions: number;
}

export type ConnectomeMode = 'idle' | 'working' | 'attention';

export const MESH_SEGMENTS = 16_000;

export const CANVAS_SEGMENTS = 2_400;

const SIGNALS_PER_SEGMENT = 1 / 24;

/** In view width units. */
const SIGNAL_TAIL = 0.012;

/** Rim reach in view width units; a corner reaches CORNER_REACH times further. */
const REACH = 0.17;

const CORNER_REACH = 1.7;

const ROOT_SPACING = 0.016;

const CORNER_ROOTS = 10;

const SEGMENT = 0.02;

const RATIO = 0.86;

const SEGMENT_FLOOR = 0.005;

const MAX_GENERATION = 13;

const SEGMENTS_PER_BRANCH = 5;

/** Radians. */
const CURL = 0.2;

const CURL_NOISE = 0.5;

const SPREAD = 0.6;

const FUSE_REACH = 0.009;

const FIBRE_ALPHA = 0.095;

const SIGNAL_ALPHA = 0.42;

/** In view width units; deliberately separate from the hero tree's reach. */
const TISSUE_REACH = 0.16;

/** In view widths. */
const TISSUE_BEND = 0.028;

/** Per second. */
const POINTER_RATE = 7;

/** View widths per second. */
const BURST_SPEED = 0.4;

/** Seconds. */
const BURST_WINDOW = 0.25;

const AMPLITUDE_LOW = 0.45;

const AMPLITUDE_HIGH = 1;

const ACTIVITY_FADE_RATE = 1.4;

const FLASH_ATTACK = 0.12;

const FLASH_DECAY = 1.3;

const FOCUS_SECONDS = 20;

/** Keep-out reach in view width units: whole cover within KEEP_OUT_HOLD (exceeds sway plus blur/bloom), then fades over KEEP_OUT_FADE. */
const KEEP_OUT_HOLD = 0.016;

const KEEP_OUT_FADE = 0.02;

const EDGE_SAMPLES = 4;

/** View width units; the whole mesh sways together. */
const SWAY = 0.0022;

interface Look {
  readonly period: number;
  readonly glowBase: number;
  readonly glowAmp: number;
  /** Multiple of SIGNAL_ALPHA. */
  readonly energy: number;
  /** View widths per second. */
  readonly speed: number;
  /** Seconds, before the seeded jitter. */
  readonly cadence: number;
  readonly focus: number;
}

const IDLE: Look = { period: 10, glowBase: 0.16, glowAmp: 0.22, energy: 1, speed: 0.11, cadence: 0.02, focus: 0 };

const WORKING: Look = { period: 5, glowBase: 0.24, glowAmp: 0.28, energy: 1.35, speed: 0.17, cadence: 0.008, focus: 1 };

interface Node {
  readonly tree: number;
  readonly generation: number;
  readonly root: boolean;
  /** View units. */
  readonly hx: number;
  readonly hy: number;
  readonly rim: number;
  readonly corner: number;
  readonly cornerness: number;
  readonly edges: number[];
  x: number;
  y: number;
  /** 0 clear, 1 hidden. */
  cover: number;
  hold: number;
}

interface Edge {
  readonly a: number;
  readonly b: number;
  readonly generation: number;
  /** Share of its length; signed. */
  readonly bow: number;
  readonly width: number;
  readonly phase: number;
  readonly rim: number;
  tip: boolean;
  readonly tipRate: number;
  readonly tipPhase: number;
  drawn: number;
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
  /** 0 clear, 1 hidden. */
  cover: number;
}

interface Shoot {
  readonly from: number;
  readonly heading: number;
  readonly length: number;
  readonly generation: number;
  readonly curl: number;
}

interface Signal extends Pulse {
  /** -1 when it wanders. */
  readonly toward: number;
  hops: number;
}

interface Flash {
  readonly corner: number;
  age: number;
}

/** Table sine: tens of thousands of evaluations per frame, low precision is fine. */
const SINE_STEPS = 4_096;

const SINE = new Float32Array(new ArrayBuffer(4 * SINE_STEPS));

for (let index = 0; index < SINE_STEPS; index += 1) SINE[index] = Math.sin((2 * Math.PI * index) / SINE_STEPS);

const SINE_SCALE = SINE_STEPS / (2 * Math.PI);

function sine(angle: number): number {
  return SINE[(Math.floor(angle * SINE_SCALE) % SINE_STEPS + SINE_STEPS) % SINE_STEPS] ?? 0;
}

function branchChildren(roll: number, rim: number): number {
  if (roll < 0.35 + 0.45 * rim) return 2;

  if (roll < 0.95) return 1;

  return 0;
}

function envelope(age: number): number {
  if (age < FLASH_ATTACK) return age / FLASH_ATTACK;

  return clamp(1 - (age - FLASH_ATTACK) / FLASH_DECAY, 0, 1);
}

interface SignalLaunch {
  from: number;
  edgeId: number;
  toward: number;
  hops: number;
  strength: number;
}

interface StrokeLook {
  edge: Edge;
  glow: number;
  tone: number;
  alpha: number;
}

export class Connectome {
  private readonly random: () => number;

  private readonly budget: number;

  private readonly nodes: Node[] = [];

  private readonly edges: Edge[] = [];

  private readonly roots: number[] = [];

  private readonly signals: Signal[] = [];

  private readonly signalCap: number;

  private tipList: number[] = [];

  private aspect: number;

  private elapsed = 0;

  private nextSignalId = 1;

  private activity: ConnectomeActivity = { working: false, decisions: 0 };

  private look: Look = IDLE;

  private focusCorner = -1;

  private focusUntil = 0;

  private flash: Flash | null = null;

  /** View units; null when absent, hoverless or reduced-motion. */
  private pointerX: number | null = null;

  private pointerY: number | null = null;

  private burstX = 0;

  private burstY = 0;

  private burstAt = 0;

  private readonly burstFired: number[] = [];

  private nextFire: number[] = [];

  private keepOut: readonly KeepOut[] = [];

  private strokes: Float32Array<ArrayBuffer>;

  private readonly points = new Float32Array(new ArrayBuffer(0));

  private pulseData: Float32Array<ArrayBuffer>;

  constructor(options: ConnectomeOptions) {
    this.aspect = options.aspect;
    this.random = seededRandom(options.seed);
    this.budget = options.segments ?? MESH_SEGMENTS;
    this.signalCap = Math.max(8, Math.round(this.budget * SIGNALS_PER_SEGMENT));
    this.strokes = new Float32Array(new ArrayBuffer(4 * STROKE_STRIDE * (this.budget + 64)));
    this.pulseData = new Float32Array(new ArrayBuffer(4 * PULSE_STRIDE * this.signalCap));
    this.grow();
    this.fuse();

    for (const id of this.roots) {
      this.nextFire[id] = this.waitFor(IDLE.cadence * this.roots.length);
    }

    if (options.activity !== undefined) {
      this.activity = options.activity;
      this.look = options.activity.working ? WORKING : IDLE;

      if (options.activity.working) this.refocus();
    }

    this.place();
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

  /** A rise in the decision count flashes at once; everything else eases in. */
  setActivity(activity: ConnectomeActivity): void {
    const previous = this.activity;
    this.activity = activity;

    if (activity.decisions > previous.decisions) this.startFlash();

    if (activity.working && !previous.working) this.refocus();
  }

  mode(): ConnectomeMode {
    if (this.flash !== null && envelope(this.flash.age) > 0.02) return 'attention';

    return this.activity.working ? 'working' : 'idle';
  }

  /** Strongest pointer hold, 0 with no pointer. */
  pointerHold(): number {
    let hold = 0;

    for (const node of this.nodes) hold = Math.max(hold, node.hold);

    return hold;
  }

  step(dt: number): void {
    this.elapsed += dt;
    this.settleLook(dt);
    this.settlePointer(dt);
    this.place();
    this.stepFlash(dt);
    this.emit();
    this.stepSignals(dt);
  }

  /** View units. Never feeds the random stream, so scripted paths replay identically. */
  setPointer(x: number, y: number): void {
    if (this.pointerX === null) {
      this.burstX = x;
      this.burstY = y;
      this.burstAt = this.elapsed;
    }

    this.pointerX = x;
    this.pointerY = y;
  }

  clearPointer(): void {
    this.pointerX = null;
    this.pointerY = null;
  }

  frame(): ArtFrame {
    const flashCorner = this.flash?.corner ?? -1;
    const lift = this.flash === null ? 0 : envelope(this.flash.age);
    const wave = (2 * Math.PI * this.elapsed) / this.look.period;
    const focus = this.look.focus;
    const focusCorner = this.focusCorner;
    let count = 0;

    for (let index = 0; index < this.edges.length; index += 1) {
      const edge = this.edges[index];

      if (edge === undefined || edge.cover >= 0.996) continue;
      const a = this.nodes[edge.a];
      const b = this.nodes[edge.b];

      if (a === undefined || b === undefined) continue;
      const flashedEnd = a.corner === flashCorner ? a : b;
      const cornerness = flashedEnd.corner === flashCorner ? flashedEnd.cornerness : 0;
      const flashed = lift * cornerness;
      const focused = a.corner === focusCorner ? focus * a.cornerness * 0.3 : 0;
      const held = Math.max(a.hold, b.hold);
      const breath = 0.5 + 0.5 * sine(wave - edge.phase);
      const glow = clamp(this.look.glowBase + this.look.glowAmp * breath + focused + 0.5 * flashed + 0.35 * held, 0, 0.5 + 0.5 * flashed + 0.35 * held);
      const alpha = FIBRE_ALPHA * (0.35 + 0.65 * edge.rim) * (0.8 + 0.2 * breath) * (1 + 0.25 * focused / 0.3) * (1 + 1.2 * flashed) * (1 - edge.cover);

      if (alpha <= 0.003) continue;
      count = this.pushStroke(count, { edge, glow, tone: held > 0.02 ? TONE_BRIGHT : TONE_ACCENT, alpha });
    }

    return {
      strokes: this.strokes,
      count,
      nodes: this.points,
      nodeCount: 0,
      pulses: this.pulseData,
      pulseCount: this.framePulses(),
      time: this.elapsed,
    };
  }

  private distance(x0: number, y0: number, x1: number, y1: number): number {
    return viewDistance({ aspect: this.aspect, x0, y0, x1, y1 });
  }

  private edgeGap(x: number, y: number): number {
    return Math.max(0, Math.min(x, 1 - x, y * this.aspect, (1 - y) * this.aspect));
  }

  private nearestCorner(x: number, y: number): readonly [corner: number, gap: number] {
    const right = x > 0.5;
    const bottom = y > 0.5;
    const gap = this.distance(x, y, right ? 1 : 0, bottom ? 1 : 0);

    return [(right ? 1 : 0) + (bottom ? 2 : 0), gap];
  }

  private rimOf(x: number, y: number): number {
    const [, cornerGap] = this.nearestCorner(x, y);

    return clamp(Math.max(1 - this.edgeGap(x, y) / REACH, 1 - cornerGap / (REACH * CORNER_REACH)), 0, 1);
  }

  /** Grown breadth-first so the budget is spent evenly. */
  private grow(): void {
    const shoots: Shoot[] = [];
    const inward = (x: number, y: number): number => Math.atan2((0.5 - y) * this.aspect, 0.5 - x);

    const root = (x: number, y: number, wobble: number): void => {
      const heading = inward(x, y) + (this.random() - 0.5) * wobble;
      const id = this.plant(-1, 0, x, y);
      this.roots.push(id);
      shoots.push({ from: id, heading, length: SEGMENT * (0.8 + 0.4 * this.random()), generation: 0, curl: (this.random() < 0.5 ? -1 : 1) * CURL });
    };

    for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      for (let index = 0; index < CORNER_ROOTS; index += 1) {
        const along = 0.01 + this.random() * 0.08;
        const onTop = this.random() < 0.5;
        root(onTop ? Math.abs(cx - along) : cx, onTop ? cy : Math.abs(cy - along / this.aspect), 1.4);
      }
    }

    for (let along = ROOT_SPACING * 2; along < 1 - ROOT_SPACING * 1.8; along += ROOT_SPACING * (0.7 + 0.6 * this.random())) {
      root(along, 0, 1);
      root(along, 1, 1);
    }

    for (let along = ROOT_SPACING * 2 / this.aspect; along < 1 - ROOT_SPACING * 1.8 / this.aspect; along += (ROOT_SPACING * (0.7 + 0.6 * this.random())) / this.aspect) {
      root(0, along, 1);
      root(1, along, 1);
    }

    // Early die-out on some seeds is re-sprouted from rim fibres so every seed grows the same amount.
    let index = 0;
    let sprouts = 0;

    while (this.edges.length < this.budget && sprouts < this.budget) {
      const shoot = shoots[index];

      if (shoot !== undefined) {
        this.branch(shoot, shoots);
        index += 1;
        continue;
      }

      const from = Math.floor(this.random() * this.nodes.length);
      const node = this.nodes[from];
      sprouts += 1;

      if (node === undefined || node.rim < 0.4 || node.edges.length > 2) continue;
      const generation = Math.min(node.generation + 1, MAX_GENERATION - 2);
      shoots.push({ from, heading: inward(node.hx, node.hy) + (this.random() - 0.5) * 2.6, length: Math.max(SEGMENT_FLOOR, SEGMENT * RATIO ** generation), generation, curl: (this.random() < 0.5 ? -1 : 1) * CURL });
    }
  }

  private branch(shoot: Shoot, shoots: Shoot[]): void {
    let from = shoot.from;
    let heading = shoot.heading;
    let x = this.nodes[from]?.hx ?? 0;
    let y = this.nodes[from]?.hy ?? 0;
    const segments = 2 + Math.floor(this.random() * (SEGMENTS_PER_BRANCH - 1));

    for (let segment = 0; segment < segments; segment += 1) {
      heading += shoot.curl + (this.random() - 0.5) * CURL_NOISE;
      const length = shoot.length * (0.75 + 0.5 * this.random());
      const nx = x + Math.cos(heading) * length;
      const ny = y + Math.sin(heading) * length / this.aspect;

      if (nx < -0.015 || nx > 1.015 || ny < -0.015 || ny > 1.015 || this.edges.length >= this.budget) return;
      const rimHere = this.rimOf(nx, ny);

      if (rimHere < 0.03 || this.random() > 0.08 + 0.92 * rimHere * rimHere) return;
      const id = this.plant(from, shoot.generation, nx, ny);
      this.link(from, id, shoot.generation);

      if (this.random() < 0.3 && shoot.generation + 2 <= MAX_GENERATION) {
        shoots.push({ from: id, heading: heading + (this.random() < 0.5 ? -1 : 1) * (0.7 + this.random() * 0.6), length: Math.max(SEGMENT_FLOOR, shoot.length * 0.55), generation: shoot.generation + 2, curl: -shoot.curl });
      }

      from = id;
      x = nx;
      y = ny;
    }

    if (shoot.generation >= MAX_GENERATION) return;
    const rim = this.rimOf(x, y);
    const roll = this.random();
    const children = branchChildren(roll, rim);

    for (let child = 0; child < children; child += 1) {
      // Draw order is what makes one seed one figure.
      let side = child === 0 ? -1 : 1;

      if (children !== 2) side = this.random() < 0.5 ? -1 : 1;
      const turn = children === 2 ? SPREAD * (0.6 + 0.8 * this.random()) : SPREAD * 0.5 * this.random();
      shoots.push({ from, heading: heading + side * turn, length: Math.max(SEGMENT_FLOOR, shoot.length * RATIO), generation: shoot.generation + 1, curl: -shoot.curl * (0.5 + this.random()) });
    }
  }

  private plant(parent: number, generation: number, x: number, y: number): number {
    const hx = clamp(x, -0.015, 1.015);
    const hy = clamp(y, -0.015, 1.015);
    const [corner, cornerGap] = this.nearestCorner(hx, hy);
    const id = this.nodes.length;
    const tree = parent < 0 ? id : this.nodes[parent]?.tree ?? id;

    this.nodes.push({
      tree,
      generation,
      root: parent < 0,
      hx,
      hy,
      rim: this.rimOf(hx, hy),
      corner,
      cornerness: clamp(1 - cornerGap / (REACH * CORNER_REACH), 0, 1),
      edges: [],
      x: hx,
      y: hy,
      cover: 0,
      hold: 0,
    });

    return id;
  }

  private adjacent(a: number, b: number): boolean {
    return this.nodes[a]?.edges.some((id) => {
      const edge = this.edges[id];

      return edge !== undefined && (edge.a === b || edge.b === b);
    }) === true;
  }

  private link(a: number, b: number, generation: number): void {
    const first = this.nodes[a];
    const second = this.nodes[b];

    if (first === undefined || second === undefined || a === b || this.adjacent(a, b)) return;
    const id = this.edges.length;
    const mx = (first.hx + second.hx) / 2;
    const my = (first.hy + second.hy) / 2;

    this.edges.push({
      a,
      b,
      generation,
      bow: (this.random() - 0.5) * 0.24,
      width: Math.max(0.42, 0.95 - 0.04 * generation),
      phase: this.edgeGap(mx, my) * 2 * Math.PI * 2.2 + (mx + my) * 1.4,
      rim: this.rimOf(mx, my),
      tip: false,
      tipRate: (2 * Math.PI) / (12 + this.random() * 22),
      tipPhase: this.random() * 2 * Math.PI,
      drawn: 1,
      x0: 0,
      y0: 0,
      cx: 0,
      cy: 0,
      x1: 0,
      y1: 0,
      cover: 0,
    });
    first.edges.push(id);
    second.edges.push(id);
  }

  /** Nearest node of another tree within FUSE_REACH, or -1; only the 3×3 cell neighbourhood is read. */
  private nearestOfAnotherTree(origin: Node, grid: Map<number, number[]>, cell: number): number {
    const column = Math.floor((origin.hx + 0.02) / cell);
    const row = Math.floor((origin.hy * this.aspect + 0.02) / cell);
    let nearest = -1;
    let nearestGap = FUSE_REACH;

    for (let dc = -1; dc <= 1; dc += 1) {
      for (let dr = -1; dr <= 1; dr += 1) {
        for (const b of grid.get((column + dc) * 4_096 + row + dr) ?? []) {
          const other = this.nodes[b];

          if (other === undefined || other.tree === origin.tree) continue;
          const gap = this.distance(origin.hx, origin.hy, other.hx, other.hy);

          if (gap < nearestGap) {
            nearestGap = gap;
            nearest = b;
          }
        }
      }
    }

    return nearest;
  }

  private fuse(): void {
    const cell = FUSE_REACH;
    const grid = new Map<number, number[]>();
    const key = (x: number, y: number): number => Math.floor((x + 0.02) / cell) * 4_096 + Math.floor((y * this.aspect + 0.02) / cell);

    for (let id = 0; id < this.nodes.length; id += 1) {
      const node = this.nodes[id];

      if (node === undefined) continue;
      const at = key(node.hx, node.hy);
      const bucket = grid.get(at);

      if (bucket === undefined) grid.set(at, [id]);
      else bucket.push(id);
    }

    const tips = this.nodes.map((_node, id) => id).filter((id) => this.nodes[id]?.edges.length === 1 && this.nodes[id]?.root === false);

    for (const a of tips) {
      const origin = this.nodes[a];

      if (origin === undefined) continue;
      const nearest = this.nearestOfAnotherTree(origin, grid, cell);

      if (nearest >= 0) this.link(a, nearest, MAX_GENERATION);
    }

    for (const edge of this.edges) {
      const a = this.nodes[edge.a];
      const b = this.nodes[edge.b];
      edge.tip = (a?.edges.length === 1 && a.root === false) || (b?.edges.length === 1 && b.root === false);
    }

    this.tipList = this.nodes.map((_node, id) => id).filter((id) => this.nodes[id]?.edges.length === 1 && this.nodes[id]?.root === false);
  }

  private coverAt(x: number, y: number): number {
    let cover = 0;

    for (const box of this.keepOut) {
      const dx = Math.max(box.left - x, 0, x - box.right);
      const dy = Math.max(box.top - y, 0, y - box.bottom) * this.aspect;
      const spread = 1 - clamp((Math.sqrt(dx * dx + dy * dy) - KEEP_OUT_HOLD) / KEEP_OUT_FADE, 0, 1);

      if (spread > cover) cover = spread;

      if (cover >= 1) return 1;
    }

    return cover;
  }

  /** Covers are computed from homes: sway is smaller than the hold, so they stand until the boxes change. */
  private shade(): void {
    const reach = KEEP_OUT_HOLD + KEEP_OUT_FADE;
    const boxes = this.keepOut;

    for (const node of this.nodes) node.cover = boxes.length === 0 ? 0 : this.coverAt(node.hx, node.hy);

    for (const edge of this.edges) {
      const a = this.nodes[edge.a];
      const b = this.nodes[edge.b];

      if (a === undefined || b === undefined) continue;
      let cover = Math.max(a.cover, b.cover);

      if (boxes.length > 0 && cover < 1 && this.nearAnyBox(a, b, reach)) {
        const dx = b.hx - a.hx;
        const dy = (b.hy - a.hy) * this.aspect;
        const cx = (a.hx + b.hx) / 2 - dy * edge.bow;
        const cy = (a.hy + b.hy) / 2 + dx * edge.bow / this.aspect;

        for (let sample = 1; sample < EDGE_SAMPLES; sample += 1) {
          const t = sample / EDGE_SAMPLES;
          const u = 1 - t;
          cover = Math.max(cover, this.coverAt(u * u * a.hx + 2 * u * t * cx + t * t * b.hx, u * u * a.hy + 2 * u * t * cy + t * t * b.hy));
        }
      }

      edge.cover = cover;
    }
  }

  private nearAnyBox(a: Node, b: Node, reach: number): boolean {
    const left = Math.min(a.hx, b.hx) - reach;
    const right = Math.max(a.hx, b.hx) + reach;
    const top = Math.min(a.hy, b.hy) - reach / this.aspect;
    const bottom = Math.max(a.hy, b.hy) + reach / this.aspect;

    for (const box of this.keepOut) {
      if (box.left <= right && box.right >= left && box.top <= bottom && box.bottom >= top) return true;
    }

    return false;
  }

  private place(): void {
    const t = this.elapsed;
    const slow = t * 0.31;
    const slower = t * 0.23;

    const swayY = SWAY / this.aspect;
    const pointerX = this.pointerX;
    const pointerY = this.pointerY;

    for (const node of this.nodes) {
      node.x = node.hx + SWAY * sine(slow + node.hx * 9 + node.hy * 5);
      node.y = node.hy + swayY * sine(slower + node.hx * 4 + node.hy * 11 + 1.5708);

      if (pointerX !== null && pointerY !== null && node.hold > 0.001) {
        const gap = this.distance(node.x, node.y, pointerX, pointerY);

        if (gap > 1e-6) {
          const pull = Math.min(TISSUE_BEND, gap) * node.hold;
          node.x += (pointerX - node.x) / gap * pull;
          node.y += (pointerY - node.y) / gap * pull / this.aspect;
        }
      }
    }

    for (const edge of this.edges) {
      const a = this.nodes[edge.a];
      const b = this.nodes[edge.b];

      if (a === undefined || b === undefined) continue;
      const dx = b.x - a.x;
      const dy = (b.y - a.y) * this.aspect;
      edge.x0 = a.x;
      edge.y0 = a.y;
      edge.x1 = b.x;
      edge.y1 = b.y;
      edge.cx = (a.x + b.x) / 2 - dy * edge.bow;
      edge.cy = (a.y + b.y) / 2 + dx * edge.bow / this.aspect;

      if (edge.tip) edge.drawn = 0.55 + 0.45 * (0.5 + 0.5 * sine(edge.tipRate * t + edge.tipPhase));
    }
  }

  private settlePointer(dt: number): void {
    const ease = 1 - Math.exp(-dt * POINTER_RATE);
    const pointerX = this.pointerX;
    const pointerY = this.pointerY;

    if (pointerX === null || pointerY === null) {
      for (const node of this.nodes) node.hold *= 1 - ease;

      return;
    }

    for (const node of this.nodes) {
      const gap = this.distance(node.hx, node.hy, pointerX, pointerY);
      const target = gap >= TISSUE_REACH ? 0 : 1 - gap / TISSUE_REACH;
      node.hold += (target - node.hold) * ease;
    }

    const moved = this.distance(this.burstX, this.burstY, pointerX, pointerY);
    const window = this.elapsed - this.burstAt;

    if (window >= 0.1) {
      if (window > 0 && moved / window > BURST_SPEED) this.fireBurst(pointerX, pointerY);
      this.burstX = pointerX;
      this.burstY = pointerY;
      this.burstAt = this.elapsed;
    }
  }

  private fireBurst(x: number, y: number): void {
    let nearest = -1;
    let nearestGap = TISSUE_REACH;

    for (const id of this.roots) {
      const node = this.nodes[id];

      if (node === undefined) continue;
      const gap = this.distance(node.hx, node.hy, x, y);

      if (gap < nearestGap) {
        nearestGap = gap;
        nearest = id;
      }
    }

    if (nearest < 0) return;

    while (this.burstFired.length <= nearest) this.burstFired.push(-BURST_WINDOW * 2);

    if (this.elapsed - (this.burstFired[nearest] ?? -BURST_WINDOW * 2) < BURST_WINDOW) return;
    this.burstFired[nearest] = this.elapsed;
    const node = this.nodes[nearest];
    const edge = node?.edges[0];

    if (node !== undefined && edge !== undefined) {
      this.launch({ from: nearest, edgeId: edge, toward: -1, hops: 10, strength: AMPLITUDE_LOW + this.random() * (AMPLITUDE_HIGH - AMPLITUDE_LOW) });
    }
  }

  click(x: number, y: number): void {
    const near: Array<{ id: number; gap: number }> = [];

    for (let id = 0; id < this.nodes.length; id += 1) {
      const node = this.nodes[id];

      if (node === undefined) continue;
      const gap = this.distance(node.hx, node.hy, x, y);

      if (gap < TISSUE_REACH * 1.4) near.push({ id, gap });
    }

    near.sort((a, b) => a.gap - b.gap);

    for (const { id } of near.slice(0, 14)) {
      const node = this.nodes[id];

      if (node === undefined) continue;

      let best: number | null = null;
      let farthest = 0;

      for (const edgeId of node.edges) {
        const edge = this.edges[edgeId];

        if (edge === undefined) continue;
        const far = this.nodes[edge.a === id ? edge.b : edge.a];

        if (far === undefined) continue;
        const gap = this.distance(far.hx, far.hy, x, y);

        if (gap > farthest) {
          farthest = gap;
          best = edgeId;
        }
      }

      if (best !== null) this.launch({ from: id, edgeId: best, toward: -1, hops: 14, strength: 1.5 });
    }
  }

  private settleLook(dt: number): void {
    const wanted = this.activity.working ? WORKING : IDLE;
    const ease = 1 - Math.exp(-dt * ACTIVITY_FADE_RATE);
    const current = this.look;

    this.look = {
      period: current.period + (wanted.period - current.period) * ease,
      glowBase: current.glowBase + (wanted.glowBase - current.glowBase) * ease,
      glowAmp: current.glowAmp + (wanted.glowAmp - current.glowAmp) * ease,
      energy: current.energy + (wanted.energy - current.energy) * ease,
      speed: current.speed + (wanted.speed - current.speed) * ease,
      cadence: wanted.cadence,
      focus: current.focus + (wanted.focus - current.focus) * ease,
    };

    if (this.activity.working && this.elapsed >= this.focusUntil) this.refocus();
  }

  private visibleCorner(except: number): number {
    const corners = [0, 1, 2, 3].filter((corner) => corner !== except);

    const clear = corners.filter((corner) => {
      const own = this.roots.filter((id) => this.nodes[id]?.corner === corner);
      const hidden = own.filter((id) => (this.nodes[id]?.cover ?? 1) >= 0.5).length;

      return own.length > 0 && hidden * 2 < own.length;
    });

    const pool = clear.length > 0 ? clear : corners;

    return pool[Math.floor(this.random() * pool.length)] ?? 0;
  }

  private refocus(): void {
    this.focusCorner = this.visibleCorner(this.focusCorner);
    this.focusUntil = this.elapsed + FOCUS_SECONDS * (0.8 + 0.4 * this.random());
  }

  private startFlash(): void {
    const corner = this.activity.working && this.focusCorner >= 0 ? this.focusCorner : this.visibleCorner(-1);
    this.flash = { corner, age: 0 };

    for (const id of this.roots) {
      const node = this.nodes[id];
      const edge = node?.edges[0];

      if (node !== undefined && node.corner === corner && node.cornerness > 0.2 && edge !== undefined) this.launch({ from: id, edgeId: edge, toward: -1, hops: 10, strength: 1.6 });
    }
  }

  private stepFlash(dt: number): void {
    if (this.flash === null) return;
    this.flash.age += dt;

    if (this.flash.age > FLASH_ATTACK + FLASH_DECAY) this.flash = null;
  }

  /** Capped at eight means. */
  private waitFor(mean: number): number {
    return Math.min(8 * mean, -Math.log(1 - this.random()) * mean);
  }

  private emit(): void {
    const working = this.activity.working && this.focusCorner >= 0;
    const mean = this.look.cadence * this.roots.length;

    for (const id of this.roots) {
      if (this.elapsed < (this.nextFire[id] ?? Number.POSITIVE_INFINITY)) continue;
      this.nextFire[id] = this.elapsed + this.waitFor(mean);

      let from: number;

      if (working) {
        from = Math.floor(this.random() * this.nodes.length);
      } else if (this.random() < 0.6) {
        from = id;
      } else {
        from = this.tipList[Math.floor(this.random() * this.tipList.length)] ?? 0;
      }

      const origin = this.nodes[from];

      if (origin === undefined || (working && origin.corner === this.focusCorner && origin.cornerness > 0.5)) continue;
      const edge = this.chooseEdge(from, -1, working ? this.focusCorner : -1);
      const amplitude = AMPLITUDE_LOW + this.random() * (AMPLITUDE_HIGH - AMPLITUDE_LOW);

      if (edge !== null) {
        this.launch({ from, edgeId: edge, toward: working ? this.focusCorner : -1, hops: working ? 24 : 8 + Math.floor(this.random() * 8), strength: amplitude });
      }
    }
  }

  private chooseEdge(from: number, came: number, toward: number): number | null {
    const node = this.nodes[from];

    if (node === undefined) return null;
    const ways = node.edges.filter((id) => id !== came);
    const options = ways.length > 0 ? ways : node.edges;

    if (options.length === 0) return null;

    if (toward < 0 || this.random() < 0.2) return options[Math.floor(this.random() * options.length)] ?? null;
    const targetX = toward % 2 === 1 ? 1 : 0;
    const targetY = toward >= 2 ? 1 : 0;
    let best: number | null = null;
    let bestGap = Number.POSITIVE_INFINITY;

    for (const id of options) {
      const edge = this.edges[id];

      if (edge === undefined) continue;
      const far = this.nodes[edge.a === from ? edge.b : edge.a];

      if (far === undefined) continue;
      const gap = this.distance(far.hx, far.hy, targetX, targetY);

      if (gap < bestGap) {
        bestGap = gap;
        best = id;
      }
    }

    return best;
  }

  private launch(signal: SignalLaunch): void {
    const { from, edgeId, toward, hops, strength } = signal;
    const edge = this.edges[edgeId];

    if (edge === undefined || this.signals.length >= this.signalCap) return;
    const forward = edge.a === from;
    this.signals.push({ id: this.nextSignalId++, layer: edge.generation, edge: edgeId, head: forward ? 0 : 1, direction: forward ? 1 : -1, strength, toward, hops });
  }

  private stepSignals(dt: number): void {
    for (let index = this.signals.length - 1; index >= 0; index -= 1) {
      const signal = this.signals[index];
      const edge = this.edges[signal?.edge ?? -1];

      if (signal === undefined || edge === undefined) continue;
      const length = this.distance(edge.x0, edge.y0, edge.x1, edge.y1);
      movePulse(signal, this.look.speed, dt, length);

      if (edge.tip && signal.direction > 0 && signal.head >= edge.drawn) {
        signal.head = Math.max(0, 2 * edge.drawn - signal.head);
        signal.direction = -1;
        signal.hops -= 1;

        if (signal.hops <= 0) this.signals.splice(index, 1);
        continue;
      }

      const past = signal.direction > 0 ? signal.head - 1 : -signal.head;

      if (past < 0) continue;

      if (!this.arrive(signal, edge, past * Math.max(1e-6, length))) this.signals.splice(index, 1);
    }
  }

  private arrive(signal: Signal, edge: Edge, overshoot: number): boolean {
    const at = signal.direction > 0 ? edge.b : edge.a;
    const node = this.nodes[at];

    if (node === undefined) return false;
    const home = signal.toward >= 0 && node.corner === signal.toward && node.cornerness > 0.55;
    signal.hops -= 1;

    if (home || signal.hops <= 0) return false;
    const next = this.chooseEdge(at, signal.edge, signal.toward);
    const nextEdge = this.edges[next ?? -1];

    if (next === null || nextEdge === undefined) return false;
    const forward = nextEdge.a === at;
    const length = Math.max(1e-6, this.distance(nextEdge.x0, nextEdge.y0, nextEdge.x1, nextEdge.y1));
    signal.edge = next;
    signal.layer = nextEdge.generation;
    signal.direction = forward ? 1 : -1;
    signal.head = forward ? overshoot / length : 1 - overshoot / length;

    return true;
  }

  private pushStroke(count: number, look: StrokeLook): number {
    const { edge, glow, tone, alpha } = look;
    this.strokes = grown(this.strokes, (count + 1) * STROKE_STRIDE);
    const at = count * STROKE_STRIDE;
    const strokes = this.strokes;
    strokes[at] = edge.x0;
    strokes[at + 1] = edge.y0;
    strokes[at + 2] = edge.cx;
    strokes[at + 3] = edge.cy;
    strokes[at + 4] = edge.x1;
    strokes[at + 5] = edge.y1;
    strokes[at + 6] = edge.drawn;
    strokes[at + 7] = edge.width;
    strokes[at + 8] = glow;
    strokes[at + 9] = tone;
    strokes[at + 10] = alpha;
    strokes[at + 11] = edge.generation;

    return count + 1;
  }

  private framePulses(): number {
    let count = 0;

    for (const signal of this.signals) {
      const edge = this.edges[signal.edge];

      if (edge === undefined) continue;
      const tail = Math.min(pulseTail(signal, SIGNAL_TAIL, this.distance(edge.x0, edge.y0, edge.x1, edge.y1)), edge.drawn);
      const head = clamp(signal.head, 0, edge.drawn);
      const alpha = clamp(SIGNAL_ALPHA * this.look.energy * signal.strength, 0, 0.85) * (0.4 + 0.6 * edge.rim) * (1 - edge.cover);

      if (tail === head || alpha <= 0.003) continue;

      this.pulseData = writePulse(this.pulseData, count, {
        x0: edge.x0,
        y0: edge.y0,
        cx: edge.cx,
        cy: edge.cy,
        x1: edge.x1,
        y1: edge.y1,
        tail,
        head,
        width: (edge.width * 0.8 + 0.5) * (0.6 + 0.4 * Math.min(1, signal.strength)),
        glow: 0.9,
        tone: TONE_BRIGHT,
        alpha,
        id: signal.id,
        layer: signal.layer,
        direction: signal.direction,
      });
      count += 1;
    }

    return count;
  }
}
