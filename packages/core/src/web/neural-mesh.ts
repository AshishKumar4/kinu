/**
 * The living background behind the signed-in shell: a frame of neural tissue round the page, as a Golgi-stained section
 * of cortex reads. Over a thousand pyramidal neurons in three depth planes, their arbors overlapping into one mesh that
 * is solid along every edge, densest in the corners, and thins across the outer third of the page to bare behind the
 * copy. Each cell is a soma, branching dendrites and an axon whose branches end in boutons on other cells' dendrites;
 * every cell also throws unwired collaterals, the neuropil between them. A far cell is smaller, greyer and simpler, and
 * every apical dendrite reaches toward its nearest edge, as cortex's do toward its surface.
 *
 * A cell fires: a spike runs down its axon, the synapse glints, the signal creeps up the dendrite to the next soma, and
 * the next cell may fire in turn, so a thought travels through the mesh as a cascade that always dies out. Idle, cells
 * fire rarely; while agents work, often, and the cascades run on. A decision arriving starts a cascade from a corner.
 * The pointer charges the cells beneath it, and a click fires the nearest. The whole mesh carries MESH_OPACITY of its
 * ink: texture first, neurons when you look.
 *
 * Every resting stroke is written once into the frame's rest prefix, which a renderer keeps; only lit cells and
 * travelling signals are drawn each frame, and a tick touches only the cells doing anything. Lengths are CSS pixels; a
 * frame is written in view units. Pure and deterministic for a seed, size, field and call sequence.
 */
import { type ArtFrame, clamp, grown, type KeepOut, type Lift, NODE_STRIDE, PULSE_STRIDE, STROKE_STRIDE, TONE_ACCENT, TONE_ASH, TONE_BRIGHT } from './art';
import { seededRandom } from '../utils/stats';

export interface MeshActivity {
  readonly working: boolean;
  readonly decisions: number;
}

export type MeshMode = 'idle' | 'working' | 'attention';

/** The page beside the rail, in view units across: the rail is opaque, so the mesh frames only this. */
export interface Field {
  readonly left: number;
  readonly right: number;
}

export interface MeshOptions {
  readonly seed: number;
  readonly aspect: number;
  /** CSS pixels across, so a cell is the same size on any window. */
  readonly width: number;
  /** Decisions already waiting at birth earn no cascade and no attention. */
  readonly activity?: MeshActivity;
  /** The page beside the rail; the whole view by default. */
  readonly field?: Field;
  /** How much of its full ink the whole mesh carries, resting tissue and firing alike; MESH_OPACITY by default. */
  readonly opacity?: number;
}

/** The mesh's ink: texture first, neurons when you look. The owner's Fainter. */
const MESH_OPACITY = 0.2;

interface Layer {
  readonly scale: number;
  /** Least distance between two somas of the plane where the tissue is densest, in px. */
  readonly spacing: number;
  /** Most cells the plane holds, whatever the page's size. */
  readonly cap: number;
  readonly ink: number;
  readonly width: number;
  readonly tone: number;
  readonly glow: number;
  readonly basal: number;
  readonly tuft: number;
  readonly apicalSegments: number;
  readonly targets: number;
  /** How far its axon reaches for a target, in px. */
  readonly reach: number;
  /** Unwired axon collaterals: the fine fibres between cells that make the section a mesh. */
  readonly collaterals: number;
}

/** Far, middle and near. A far cell is drawn with a few strokes; a near one with all its branches. */
const LAYERS: readonly Layer[] = [
  { scale: 0.55, spacing: 18, cap: 1600, ink: 0.65, width: 0.6, tone: TONE_ASH, glow: 0.1, basal: 2, tuft: 2, apicalSegments: 1, targets: 2, reach: 80, collaterals: 1 },
  { scale: 0.78, spacing: 27, cap: 700, ink: 0.85, width: 0.8, tone: TONE_ASH, glow: 0.12, basal: 3, tuft: 2, apicalSegments: 2, targets: 2, reach: 120, collaterals: 2 },
  { scale: 1, spacing: 48, cap: 220, ink: 1, width: 1, tone: TONE_ACCENT, glow: 0.18, basal: 3, tuft: 3, apicalSegments: 3, targets: 3, reach: 170, collaterals: 2 },
];

/** How deep the tissue reaches in from an edge: about the outer third of the page's shorter side, between the bounds. */
const BAND_SHARE = 0.32;

const BAND_PX = [120, 340] as const;

/** How fast it thins across the band: past 1 it stays solid a while at the edge before falling away. */
const FALLOFF = 1.7;

/** Somas of different planes keep at least this far apart. */
const ANY_SPACING_PX = 6;

const APICAL_PX = [62, 104] as const;

const BASAL_PX = [18, 30] as const;

const SOMA_PX = [2.5, 3.4] as const;

const DENDRITE_ALPHA = 0.55;

const AXON_ALPHA = 0.26;

const COLLATERAL_ALPHA = 0.22;

const SOMA_ALPHA = 0.6;

const BOUTON_ALPHA = 0.45;

/** On paper the dense mesh needs far less lift than today's sparse tissue to read the same; the opacity scales both. */
const MESH_LIFT: Lift = { dark: 1, light: 1.15 };

const AXON_SPEED_PX = 120;

const DENDRITE_SPEED_PX = 55;

const AXON_TAIL_PX = 48;

const DENDRITE_TAIL_PX = 22;

/** A cell fires once its charge reaches 1; charge leaks away with this time constant, in seconds. */
const LEAK = 3;

const REFRACTORY = 4;

/**
 * The chance one arriving signal fires its cell, by the synapse's own strength, idle and while agents work. Each cell
 * reaches two or three others, so a cascade runs on to about 1 / (1 - kp) cells: a handful idle, a sweep of tens
 * while working. Kept below 1 / k, a cascade always dies out.
 */
const RELEASE = [0.26, 0.36] as const;

const WORKING_RELEASE = 1.35;

/** What an arrival that does not fire its cell adds to the cell's charge, so close arrivals still sum. */
const ARRIVAL_CHARGE = 0.3;

/** Cells firing on their own, per second across the whole mesh, idle and while agents work. */
const IDLE_RATE = 0.7;

const WORKING_RATE = 1.8;

const MAX_SPIKES = 220;

/** A decision's attention, in seconds: it rises over the attack and fades over the decay. */
const ATTENTION_ATTACK = 0.12;

const ATTENTION_DECAY = 1.3;

/** Glow a glint carries: below the renderers' halo threshold (0.55), so firing reads as light, never as a flare. */
const GLINT_GLOW = 0.5;

/** Below this opacity a glint keeps the square root of the drop: at 0.2 it carries 0.33 of its full ink, not 0.2. */
const GLINT_OPACITY = 0.55;

const GLOW_DECAY = 1.1;

const FLASH_DECAY = 0.55;

const POINTER_REACH_PX = 130;

/** The grid wiring looks up neighbours in, px. */
const WIRE_CELL = 64;

const POINTER_CHARGE = 0.55;

/** Keep-out reach in view widths: whole cover within HOLD, fading over FADE. */
const HOLD = 0.012;

const FADE = 0.06;

type Point = readonly [number, number];

interface Cell {
  readonly x: number;
  readonly y: number;
  readonly layer: number;
  readonly radius: number;
  /** The apical dendrite's direction, toward the nearest edge. */
  readonly heading: number;
  /** The strokes lit when the cell fires: its soma and dendrites. */
  readonly pieces: number[];
  charge: number;
  glow: number;
  sense: number;
  quietUntil: number;
}

type Kind = 'dendrite' | 'axon' | 'soma' | 'bouton';

/** One quadratic stroke, in px. */
interface Piece {
  readonly cell: number;
  readonly kind: Kind;
  readonly from: Point;
  readonly bend: Point;
  readonly to: Point;
  readonly width: number;
  readonly alpha: number;
  readonly tone: number;
  readonly glow: number;
  /** 0 at the soma, 1 at a tip: a tip lights less. */
  readonly depth: number;
  /** The dendrite piece this one grows from, or -1 from the soma. */
  readonly parent: number;
  readonly length: number;
  cover: number;
}

/** A run along pieces: each step spans its piece from `t0` to `t1`, `length` px. */
interface Step {
  readonly piece: number;
  readonly t0: number;
  readonly t1: number;
  readonly start: number;
  readonly length: number;
}

interface Path {
  readonly steps: readonly Step[];
  readonly length: number;
}

interface Branch {
  readonly to: number;
  readonly path: Path;
  /** Up the target's dendrite from the synapse to its soma. */
  readonly dendrite: Path;
  readonly synapse: Point;
  /** The chance an arriving signal fires the target, idle. */
  readonly release: number;
  flash: number;
  lit: boolean;
}

interface Axon {
  readonly trunk: Path;
  readonly branches: Branch[];
}

/** Where an axon branch lands: a dendrite piece of its target, and how far along it. */
interface Landing {
  readonly piece: number;
  readonly t: number;
}

/** One cell as a reader checking the tissue sees it: view place, plane, and the cells its axon reaches. */
export interface CellCensus {
  readonly x: number;
  readonly y: number;
  readonly layer: number;
  readonly targets: readonly number[];
}

interface Spike {
  readonly cell: number;
  /** -1 on the trunk, else the branch it runs down or, once `upDendrite`, up from. */
  readonly branch: number;
  readonly upDendrite: boolean;
  readonly bright: boolean;
  at: number;
}

function envelope(age: number): number {
  if (age < ATTENTION_ATTACK) return age / ATTENTION_ATTACK;

  return clamp(1 - (age - ATTENTION_ATTACK) / ATTENTION_DECAY, 0, 1);
}

function pointAt(piece: Pick<Piece, 'from' | 'bend' | 'to'>, t: number): Point {
  const u = 1 - t;

  return [
    u * u * piece.from[0] + 2 * u * t * piece.bend[0] + t * t * piece.to[0],
    u * u * piece.from[1] + 2 * u * t * piece.bend[1] + t * t * piece.to[1],
  ];
}

/** A quadratic's length, near enough: between its chord and its control polygon. */
function curveLength(from: Point, bend: Point, to: Point): number {
  const chord = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const polygon = Math.hypot(bend[0] - from[0], bend[1] - from[1]) + Math.hypot(to[0] - bend[0], to[1] - bend[1]);

  return (2 * chord + polygon) / 3;
}

function between(random: () => number, [low, high]: readonly [number, number]): number {
  return low + (high - low) * random();
}

export class NeuralMesh {
  private readonly seed: number;
  private readonly width: number;
  private field: Field;
  private aspect: number;
  /** Runtime chance: firings and weights' draws stay apart from the tissue's growth. */
  private readonly chance: () => number;
  private draws: () => number = () => 0;
  private cells: Cell[] = [];
  private pieces: Piece[] = [];
  private axons: Axon[] = [];
  private spikes: Spike[] = [];
  private keepOut: readonly KeepOut[] = [];
  private activity: MeshActivity = { working: false, decisions: 0 };
  private pointer: Point | null = null;
  private hold = 0;
  private elapsed = 0;
  private nextFiring = 1;
  /** Seconds since a decision arrived; null before the first. */
  private flashAge: number | null = null;
  /** A cascade a decision starts: cells to fire, and when. */
  private queued: { cell: number; at: number }[] = [];
  private strokes = new Float32Array(new ArrayBuffer(4 * STROKE_STRIDE * 16_384));
  private nodes = new Float32Array(new ArrayBuffer(4 * NODE_STRIDE * 256));
  private pulses = new Float32Array(new ArrayBuffer(4 * PULSE_STRIDE * 512));
  private restCount = 0;
  private restEpoch = 0;
  private restDirty = true;
  /** Cells charged, lit or under the pointer; every other cell is at rest and a tick leaves it alone. */
  private active: number[] = [];
  private isActive = new Uint8Array(0);
  /** Synapses still flashing. */
  private flashing: Branch[] = [];
  /** Cells by WIRE_CELL square, for the pointer and the wiring to find neighbours. */
  private grid = new Map<string, number[]>();
  /** One stroke's and one disc's ink, filled in before each write: a frame writes hundreds, and allocates none. */
  private readonly ink = { alpha: 0, glow: 0, tone: 0 };
  private readonly spot = { x: 0, y: 0, radius: 0, glow: 0, alpha: 0 };
  /** Every stroke's and pulse's alpha, by ground: the lift times the opacity, one object so a renderer can keep it. */
  private readonly lift: Lift;
  private readonly opacity: number;
  /** What a glint carries beyond the opacity: firing fades more slowly than the tissue, so it still reads as light. */
  private readonly glint: number;

  constructor(options: MeshOptions) {
    this.seed = options.seed;
    this.width = Math.max(1, options.width);
    this.field = options.field ?? { left: 0, right: 1 };
    this.aspect = options.aspect;
    this.chance = seededRandom(options.seed + 1);
    this.opacity = clamp(options.opacity ?? MESH_OPACITY, 0, 1);
    this.lift = { dark: MESH_LIFT.dark * this.opacity, light: MESH_LIFT.light * this.opacity };
    this.glint = this.opacity > 0 ? Math.sqrt(GLINT_OPACITY / Math.min(this.opacity, GLINT_OPACITY)) : 1;

    if (options.activity !== undefined) this.activity = options.activity;
    this.grow();
  }

  get time(): number {
    return this.elapsed;
  }

  /** The cells, for a reader that checks the tissue's shape: place, plane and whom each axon reaches. */
  census(): CellCensus[] {
    return this.cells.map((cell, index) => ({
      x: cell.x / this.width, y: cell.y / this.height(), layer: cell.layer,
      targets: (this.axons[index]?.branches ?? []).map((branch) => branch.to),
    }));
  }

  setAspect(aspect: number): void {
    if (Math.abs(aspect - this.aspect) < 1e-6) return;
    this.aspect = aspect;
    this.grow();
  }

  setKeepOut(boxes: readonly KeepOut[]): void {
    const same = boxes.length === this.keepOut.length && boxes.every((box, index) => {
      const was = this.keepOut[index];

      return was !== undefined && Math.abs(box.left - was.left) + Math.abs(box.top - was.top) + Math.abs(box.right - was.right) + Math.abs(box.bottom - was.bottom) < 1e-4;
    });

    if (same) return;
    this.keepOut = boxes;
    this.shade();
  }

  setActivity(activity: MeshActivity): void {
    const arrived = activity.decisions > this.activity.decisions;

    this.activity = activity;

    if (!arrived) return;
    this.flashAge = 0;
    this.decide();
  }

  /** Attention for the moment a decision arrives, then back under the activity's hum. */
  mode(): MeshMode {
    if (this.flashAge !== null && envelope(this.flashAge) > 0.02) return 'attention';

    return this.activity.working ? 'working' : 'idle';
  }

  /** View units. A field that moved by half a pixel or more (the rail folded) grows the tissue again, from the seed. */
  setField(field: Field): void {
    if (Math.abs(field.left - this.field.left) * this.width < 0.5 && Math.abs(field.right - this.field.right) * this.width < 0.5) return;
    this.field = field;
    this.grow();
  }

  pointerHold(): number {
    return this.hold;
  }

  setPointer(x: number, y: number): void {
    this.pointer = [x * this.width, y * this.height()];
  }

  clearPointer(): void {
    this.pointer = null;
  }

  click(x: number, y: number): void {
    const nearest = this.nearest(x * this.width, y * this.height());

    if (nearest >= 0) this.fire(nearest, false);
  }

  step(dt: number): void {
    const tick = clamp(dt, 0, 0.1);

    this.elapsed += tick;

    if (this.flashAge !== null) this.flashAge += tick;
    this.hold = this.pointer === null ? Math.max(0, this.hold - tick * 1.5) : Math.min(1, this.hold + tick * 2);
    this.charge(tick);
    this.travel(tick);
    this.nextFiring -= tick;

    if (this.nextFiring <= 0 && this.cells.length > 0) {
      this.fire(Math.floor(this.chance() * this.cells.length), false);
      this.nextFiring = -Math.log(1 - this.chance()) / (this.activity.working ? WORKING_RATE : IDLE_RATE);
    }

    if (this.queued.length > 0) {
      for (const entry of this.queued) {
        if (entry.at <= this.elapsed) this.fire(entry.cell, true);
      }

      this.queued = this.queued.filter((entry) => entry.at > this.elapsed);
    }
  }

  frame(): ArtFrame {
    if (this.restDirty) this.writeRest();
    let count = this.restCount;
    let nodeCount = 0;

    for (const index of this.active) {
      const cell = this.cells[index];

      if (cell === undefined) continue;
      const lit = cell.glow + 0.55 * cell.sense;

      if (lit < 0.06) continue;
      count = this.writeLit(cell, count);
      const spot = this.spot;

      spot.x = cell.x;
      spot.y = cell.y;
      spot.radius = cell.radius * (1 + 0.3 * cell.glow);
      spot.glow = GLINT_GLOW * clamp(cell.glow, 0, 1);
      spot.alpha = this.opacity * this.glint * 0.5 * lit * (1 - this.cover(cell.x, cell.y));
      nodeCount = this.writeNode(nodeCount);
    }

    for (const branch of this.flashing) {
      const spot = this.spot;

      [spot.x, spot.y] = branch.synapse;
      spot.radius = 1.7;
      spot.glow = GLINT_GLOW;
      spot.alpha = this.opacity * this.glint * 0.55 * branch.flash * (1 - this.cover(spot.x, spot.y));
      nodeCount = this.writeNode(nodeCount);
    }

    return {
      strokes: this.strokes, count, nodes: this.nodes, nodeCount, pulses: this.pulses, pulseCount: this.writePulses(), time: this.elapsed,
      rest: { count: this.restCount, epoch: this.restEpoch }, lift: this.lift,
    };
  }

  private height(): number {
    return this.width * this.aspect;
  }

  /** The whole tissue from the seed: the same seed, size and field always grow the same cells. */
  private grow(): void {
    this.draws = seededRandom(this.seed);
    this.cells = [];
    this.pieces = [];
    this.axons = [];
    this.spikes = [];
    this.queued = [];
    this.active = [];
    this.flashing = [];
    this.place();
    this.isActive = new Uint8Array(this.cells.length);
    this.grid = new Map();

    for (const [id, cell] of this.cells.entries()) {
      const key = this.squareKey(Math.floor(cell.x / WIRE_CELL), Math.floor(cell.y / WIRE_CELL));

      this.grid.set(key, [...(this.grid.get(key) ?? []), id]);
    }

    for (const [index, cell] of this.cells.entries()) this.sprout(index, cell);
    this.wire();
    this.shade();
    this.restDirty = true;
  }

  private band(): number {
    const fieldWidth = (this.field.right - this.field.left) * this.width;

    return clamp(BAND_SHARE * Math.min(fieldWidth, this.height()), BAND_PX[0], BAND_PX[1]);
  }

  /** 1 at an edge of the page beside the rail and into its corners, thinning across the band to 0 past it. */
  private density(x: number, y: number): number {
    const left = this.field.left * this.width;
    const right = this.field.right * this.width;
    const band = this.band();
    const across = (distance: number): number => (1 - clamp(distance / band, 0, 1)) ** FALLOFF;
    const fx = across(Math.max(0, Math.min(x - left, right - x)));
    const fy = across(Math.max(0, Math.min(y, this.height() - y)));

    return 1 - (1 - fx) * (1 - fy);
  }

  /** Near planes first, so the far plane fills the gaps between them. */
  private place(): void {
    const left = this.field.left * this.width - 10;
    const right = this.field.right * this.width + 10;
    const height = this.height();
    const grid = new Map<string, number[]>();
    const keyOf = (x: number, y: number): string => `${String(Math.floor(x / 40))},${String(Math.floor(y / 40))}`;
    let weighted = 0;

    for (let y = 0; y < height; y += 32) {
      for (let x = left; x < right; x += 32) weighted += this.density(x, y) * 32 * 32;
    }

    for (let layer = LAYERS.length - 1; layer >= 0; layer -= 1) {
      const plane = LAYERS[layer];

      if (plane === undefined) continue;
      const target = Math.min(plane.cap, Math.round(weighted / (1.7 * plane.spacing * plane.spacing)));
      let placed = 0;

      for (let attempt = 0; attempt < target * 30 && placed < target; attempt += 1) {
        const x = left + (right - left) * this.draws();
        const y = -10 + (height + 20) * this.draws();
        const density = this.density(x, y);

        if (this.draws() > density) continue;
        // The density lives in the spacing too: a quarter as dense, twice as far apart, so the band thins smoothly
        // and a page whose edges fill up never spills its cells inward.
        const spacing = plane.spacing / Math.sqrt(Math.max(density, 0.04));

        if (this.crowded(grid, { x, y, layer, spacing })) continue;
        const index = this.cells.length;
        const cellKey = keyOf(x, y);

        this.cells.push({ x, y, layer, radius: between(this.draws, SOMA_PX) * plane.scale, heading: this.headingAt(x, y), pieces: [], charge: 0, glow: 0, sense: 0, quietUntil: 0 });
        grid.set(cellKey, [...(grid.get(cellKey) ?? []), index]);
        placed += 1;
      }
    }
  }

  private crowded(grid: Map<string, number[]>, at: { x: number; y: number; layer: number; spacing: number }): boolean {
    const span = Math.ceil(at.spacing / 40);
    const cx = Math.floor(at.x / 40);
    const cy = Math.floor(at.y / 40);

    for (let gx = cx - span; gx <= cx + span; gx += 1) {
      for (let gy = cy - span; gy <= cy + span; gy += 1) {
        for (const index of grid.get(`${String(gx)},${String(gy)}`) ?? []) {
          const other = this.cells[index];

          if (other === undefined) continue;
          const apart = Math.hypot(other.x - at.x, other.y - at.y);

          if (apart < ANY_SPACING_PX || (other.layer === at.layer && apart < at.spacing)) return true;
        }
      }
    }

    return false;
  }

  /** Toward the nearest edge, the tissue's surface, with a cell's own lean. */
  private headingAt(x: number, y: number): number {
    const left = this.field.left * this.width;
    const right = this.field.right * this.width;
    const toEdge: readonly [number, number][] = [[x - left, Math.PI], [right - x, 0], [y, -Math.PI / 2], [this.height() - y, Math.PI / 2]];
    const nearest = toEdge.reduce((best, edge) => (edge[0] < best[0] ? edge : best));

    return nearest[1] + (this.draws() - 0.5) * 1.1;
  }

  private add(piece: Omit<Piece, 'length' | 'cover'>): number {
    this.pieces.push({ ...piece, length: curveLength(piece.from, piece.bend, piece.to), cover: 0 });

    return this.pieces.length - 1;
  }

  /** One dendrite segment of `length` px, bent a little; returns its index, end and heading. */
  private dendrite(cell: number, run: { from: Point; heading: number; length: number; width: number; depth: number; parent: number }) {
    const owner = this.cells[cell];
    const plane = LAYERS[owner?.layer ?? 0] ?? LAYERS[0];
    const turn = (this.draws() - 0.5) * 0.45;
    const heading = run.heading + turn;
    const to: Point = [run.from[0] + Math.cos(heading) * run.length, run.from[1] + Math.sin(heading) * run.length];
    const sway = (this.draws() - 0.5) * 0.35 * run.length;

    const bend: Point = [
      (run.from[0] + to[0]) / 2 + Math.cos(heading + Math.PI / 2) * sway,
      (run.from[1] + to[1]) / 2 + Math.sin(heading + Math.PI / 2) * sway,
    ];

    const index = this.add({
      cell, kind: 'dendrite', from: run.from, bend, to, width: run.width, depth: run.depth, parent: run.parent,
      alpha: DENDRITE_ALPHA * (plane?.ink ?? 1) * (1 - 0.4 * run.depth), tone: plane?.tone ?? TONE_ASH, glow: plane?.glow ?? 0.1,
    });

    owner?.pieces.push(index);

    return { index, to, heading };
  }

  private sprout(index: number, cell: Cell): void {
    const plane = LAYERS[cell.layer];

    if (plane === undefined) return;
    const soma: Point = [cell.x, cell.y];
    const along: Point = [Math.cos(cell.heading), Math.sin(cell.heading)];
    const apical = between(this.draws, APICAL_PX) * plane.scale;
    const thick = plane.width;

    // The soma, a pyramid along the apical axis: a broad base tapering into the apical dendrite, as a Golgi cell's is.
    const at = (share: number): Point => [cell.x + along[0] * cell.radius * share, cell.y + along[1] * cell.radius * share];

    for (const [from, to, width] of [[-0.55, 0.15, 1.7], [0, 1.4, 0.95]] as const) {
      cell.pieces.push(this.add({
        cell: index, kind: 'soma', from: at(from), bend: at((from + to) / 2), to: at(to), width: cell.radius * width, depth: 0, parent: -1,
        alpha: SOMA_ALPHA * plane.ink, tone: plane.tone, glow: plane.glow,
      }));
    }

    let tip = { index: -1, to: soma, heading: cell.heading };

    for (let segment = 0; segment < plane.apicalSegments; segment += 1) {
      tip = this.dendrite(index, { from: tip.to, heading: tip.heading, length: apical / plane.apicalSegments, width: 1.35 * thick, depth: (0.55 * segment) / plane.apicalSegments, parent: tip.index });

      // A near cell's apical dendrite throws an oblique branch off its middle.
      if (segment === 0 && cell.layer === 2) {
        const side = this.draws() < 0.5 ? -1 : 1;

        this.dendrite(index, { from: tip.to, heading: tip.heading + side * 1.1, length: apical * 0.3, width: 0.75 * thick, depth: 0.7, parent: tip.index });
      }
    }

    for (let fork = 0; fork < plane.tuft; fork += 1) {
      const spread = (fork - (plane.tuft - 1) / 2) * 0.7;
      const branch = this.dendrite(index, { from: tip.to, heading: tip.heading + spread, length: apical * 0.28, width: 0.8 * thick, depth: 0.75, parent: tip.index });

      if (cell.layer === 2) this.dendrite(index, { from: branch.to, heading: branch.heading + (this.draws() - 0.5) * 0.8, length: apical * 0.16, width: 0.55 * thick, depth: 1, parent: branch.index });
    }

    for (let root = 0; root < plane.basal; root += 1) {
      const angle = cell.heading + Math.PI + (root - (plane.basal - 1) / 2) * 1.05;
      const base = this.dendrite(index, { from: soma, heading: angle, length: between(this.draws, BASAL_PX) * plane.scale, width: 1.1 * thick, depth: 0.45, parent: -1 });

      if (cell.layer === 0 || this.draws() < 0.4) continue;

      for (const side of [-1, 1]) {
        this.dendrite(index, { from: base.to, heading: base.heading + side * 0.45, length: between(this.draws, BASAL_PX) * plane.scale * 0.55, width: 0.65 * thick, depth: 0.85, parent: base.index });
      }
    }

    for (let fibre = 0; fibre < plane.collaterals; fibre += 1) this.collateral(index, cell, plane);
  }

  /** A fine axon collateral meandering off the soma for three bends: wired to nothing, it is the mesh between cells. */
  private collateral(index: number, cell: Cell, plane: Layer): void {
    let from: Point = [cell.x, cell.y];
    let heading = this.draws() * Math.PI * 2;
    const step = between(this.draws, [16, 30]) * plane.scale;

    for (let bend = 0; bend < 3; bend += 1) {
      heading += (this.draws() - 0.5) * 1.1;
      const to: Point = [from[0] + Math.cos(heading) * step, from[1] + Math.sin(heading) * step];
      const sway = (this.draws() - 0.5) * 0.5 * step;
      const middle: Point = [(from[0] + to[0]) / 2 - Math.sin(heading) * sway, (from[1] + to[1]) / 2 + Math.cos(heading) * sway];

      this.add({ cell: index, kind: 'axon', from, bend: middle, to, width: 0.5 * plane.width, depth: 1, parent: -1, alpha: COLLATERAL_ALPHA * plane.ink, tone: plane.tone, glow: 0.08 });
      from = to;
    }
  }

  /** The dendrite piece of `target` whose middle lies nearest `from`, and the point on it a synapse lands. */
  private synapseOn(target: number, from: Point): Landing | null {
    const cell = this.cells[target];

    if (cell === undefined) return null;
    let best: { piece: number; t: number; d: number } | null = null;

    for (const index of cell.pieces) {
      const piece = this.pieces[index];

      if (piece === undefined || piece.kind !== 'dendrite') continue;
      const t = 0.5 + 0.4 * this.draws();
      const at = pointAt(piece, t);
      const d = Math.hypot(at[0] - from[0], at[1] - from[1]);

      if (best === null || d < best.d) best = { piece: index, t, d };
    }

    return best === null ? null : { piece: best.piece, t: best.t };
  }

  /** Up the dendrite from its synapse to the soma: the synapse's piece from `t` back to 0, then each parent whole. */
  private upTo(piece: number, t: number): Path {
    const steps: Step[] = [];
    let start = 0;
    let at = piece;
    let from = t;

    while (at >= 0) {
      const current = this.pieces[at];

      if (current === undefined) break;
      const length = current.length * from;

      steps.push({ piece: at, t0: from, t1: 0, start, length });
      start += length;
      at = current.parent;
      from = 1;
    }

    return { steps, length: start };
  }

  private single(piece: number): Path {
    const length = this.pieces[piece]?.length ?? 0;

    return { steps: [{ piece, t0: 0, t1: 1, start: 0, length }], length };
  }

  /**
   * Each cell's axon leaves its base and branches to the nearest cells of its own or a neighbouring plane, never back
   * to a cell that already reaches it: a signal sent straight back finds its sender resting, and the cascade stops.
   */
  private wire(): void {
    const reaches = new Set<string>();
    const around = (cell: Cell, reach: number): number[] => this.around(cell.x, cell.y, reach);

    for (const [index, cell] of this.cells.entries()) {
      const plane = LAYERS[cell.layer];

      if (plane === undefined) continue;
      const reach = plane.reach;

      const near = around(cell, reach)
        .map((id) => ({ id, d: Math.hypot((this.cells[id]?.x ?? 0) - cell.x, (this.cells[id]?.y ?? 0) - cell.y), layer: this.cells[id]?.layer ?? -9 }))
        .filter((other) => other.id !== index && !reaches.has(`${String(other.id)}>${String(index)}`))
        .filter((other) => Math.abs(other.layer - cell.layer) <= 1 && other.d > 12 && other.d < reach)
        .sort((a, b) => a.d - b.d)
        .slice(0, plane.targets);

      const landings = near
        .map((other) => ({ to: other.id, at: this.synapseOn(other.id, [cell.x, cell.y]) }))
        .filter((landing): landing is { to: number; at: Landing } => landing.at !== null);

      for (const landing of landings) reaches.add(`${String(index)}>${String(landing.to)}`);

      const aim = landings.length === 0
        ? [cell.x - Math.cos(cell.heading) * 20, cell.y - Math.sin(cell.heading) * 20]
        : landings.reduce<[number, number]>((sum, landing) => {
          const at = pointAt(this.pieces[landing.at.piece] ?? { from: [0, 0], bend: [0, 0], to: [0, 0] }, landing.at.t);

          return [sum[0] + at[0] / landings.length, sum[1] + at[1] / landings.length];
        }, [0, 0]);

      const toward = Math.atan2(aim[1] - cell.y, aim[0] - cell.x);
      const trunkLength = Math.min(26 * plane.scale, 0.35 * Math.hypot(aim[0] - cell.x, aim[1] - cell.y)) + 4;
      const hillock: Point = [cell.x + Math.cos(toward) * trunkLength, cell.y + Math.sin(toward) * trunkLength];

      const trunk = this.add({
        cell: index, kind: 'axon', from: [cell.x, cell.y], bend: [(cell.x + hillock[0]) / 2, (cell.y + hillock[1]) / 2], to: hillock,
        width: 0.7 * plane.width, depth: 0, parent: -1, alpha: AXON_ALPHA * plane.ink, tone: plane.tone, glow: 0.12,
      });

      const branches = landings.map((landing): Branch => {
        const synapse = pointAt(this.pieces[landing.at.piece] ?? { from: [0, 0], bend: [0, 0], to: [0, 0] }, landing.at.t);
        const dx = synapse[0] - hillock[0];
        const dy = synapse[1] - hillock[1];
        const bow = (this.draws() - 0.5) * 0.45;
        const bend: Point = [(hillock[0] + synapse[0]) / 2 - dy * bow, (hillock[1] + synapse[1]) / 2 + dx * bow];
        const piece = this.add({ cell: index, kind: 'axon', from: hillock, bend, to: synapse, width: 0.6 * plane.width, depth: 0, parent: -1, alpha: AXON_ALPHA * plane.ink, tone: plane.tone, glow: 0.12 });
        const norm = Math.hypot(synapse[0] - bend[0], synapse[1] - bend[1]) || 1;
        const back: Point = [synapse[0] - ((synapse[0] - bend[0]) / norm) * 2.4, synapse[1] - ((synapse[1] - bend[1]) / norm) * 2.4];

        // The bouton: the axon's swollen end, pressed against the dendrite.
        this.add({ cell: index, kind: 'bouton', from: back, bend: [(back[0] + synapse[0]) / 2, (back[1] + synapse[1]) / 2], to: synapse, width: 1.7 * plane.scale, depth: 0, parent: -1, alpha: BOUTON_ALPHA * plane.ink, tone: plane.tone, glow: 0.2 });

        return { to: landing.to, path: this.single(piece), dendrite: this.upTo(landing.at.piece, landing.at.t), synapse, release: between(this.chance, RELEASE), flash: 0, lit: false };
      });

      this.axons.push({ trunk: this.single(trunk), branches });
    }
  }

  private squareKey(gx: number, gy: number): string {
    return `${String(gx)},${String(gy)}`;
  }

  /** The cells in the grid squares within `reach` px of a point. */
  private around(x: number, y: number, reach: number): number[] {
    const span = Math.ceil(reach / WIRE_CELL);
    const cx = Math.floor(x / WIRE_CELL);
    const cy = Math.floor(y / WIRE_CELL);
    const found: number[] = [];

    for (let gx = cx - span; gx <= cx + span; gx += 1) {
      for (let gy = cy - span; gy <= cy + span; gy += 1) {
        for (const id of this.grid.get(this.squareKey(gx, gy)) ?? []) found.push(id);
      }
    }

    return found;
  }

  private wake(index: number): void {
    if (this.isActive[index] === 1) return;
    this.isActive[index] = 1;
    this.active.push(index);
  }

  /** 0 clear, 1 hidden behind copy, with a feathered edge; px in. */
  private cover(x: number, y: number): number {
    const vx = x / this.width;
    const vy = y / this.height();
    let cover = 0;

    for (const box of this.keepOut) {
      const dx = Math.max(box.left - vx, 0, vx - box.right);
      const dy = Math.max(box.top - vy, 0, vy - box.bottom) * this.aspect;

      cover = Math.max(cover, 1 - clamp((Math.hypot(dx, dy) - HOLD) / FADE, 0, 1));
    }

    return cover;
  }

  /** Every piece's cover; the rest is redrawn only if one moved. */
  private shade(): void {
    let moved = false;

    for (const piece of this.pieces) {
      const cover = Math.max(this.cover(piece.from[0], piece.from[1]), this.cover(piece.bend[0], piece.bend[1]), this.cover(piece.to[0], piece.to[1]));

      if (cover !== piece.cover) moved = true;
      piece.cover = cover;
    }

    if (moved) this.restDirty = true;
  }

  private nearest(x: number, y: number): number {
    let best = -1;
    let bestDistance = Infinity;

    for (const [index, cell] of this.cells.entries()) {
      const d = Math.hypot(cell.x - x, cell.y - y);

      if (d < bestDistance && this.cover(cell.x, cell.y) < 0.9) {
        best = index;
        bestDistance = d;
      }
    }

    return best;
  }

  private fire(index: number, bright: boolean): void {
    const cell = this.cells[index];

    if (cell === undefined || this.elapsed < cell.quietUntil) return;
    cell.glow = 1;
    cell.charge = 0;
    cell.quietUntil = this.elapsed + REFRACTORY;
    this.wake(index);

    this.launch({ cell: index, branch: -1, upDendrite: false, bright, at: 0 });
  }

  /** A decision arrives: a cascade starts in a corner, five cells in quick succession. */
  private decide(): void {
    const height = this.height();
    const corners: readonly Point[] = [[this.field.left * this.width, 0], [this.field.right * this.width, 0], [this.field.left * this.width, height], [this.field.right * this.width, height]];
    const corner = corners[Math.floor(this.chance() * corners.length)] ?? [0, 0];

    const near = this.cells
      .map((cell, id) => ({ id, d: Math.hypot(cell.x - corner[0], cell.y - corner[1]) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 5);

    for (const [order, cell] of near.entries()) this.queued.push({ cell: cell.id, at: this.elapsed + order * 0.18 });
  }

  private charge(dt: number): void {
    const leak = Math.exp(-dt / LEAK);
    const glow = Math.exp(-dt / GLOW_DECAY);
    const flash = Math.exp(-dt / FLASH_DECAY);

    const pointer = this.pointer;

    // The pointer wakes the cells beneath it; once awake, a cell's sense follows the pointer until it rests again.
    if (pointer !== null && this.hold > 0) {
      for (const id of this.around(pointer[0], pointer[1], POINTER_REACH_PX)) this.wake(id);
    }

    let kept = 0;

    for (let at = 0; at < this.active.length; at += 1) {
      const index = this.active[at] ?? 0;
      const cell = this.cells[index];

      if (cell === undefined) continue;
      cell.charge *= leak;
      cell.glow *= glow;
      cell.sense = pointer === null ? 0 : this.hold * clamp(1 - Math.hypot(cell.x - pointer[0], cell.y - pointer[1]) / POINTER_REACH_PX, 0, 1);
      cell.charge += POINTER_CHARGE * cell.sense * cell.sense * dt;

      if (cell.charge >= 1) this.fire(index, false);

      if (cell.glow < 0.004 && cell.charge < 0.004 && cell.sense === 0) {
        cell.glow = 0;
        cell.charge = 0;
        this.isActive[index] = 0;
        continue;
      }

      this.active[kept] = index;
      kept += 1;
    }

    this.active.length = kept;
    let lit = 0;

    for (const branch of this.flashing) {
      branch.flash *= flash;

      if (branch.flash < 0.03) {
        branch.flash = 0;
        branch.lit = false;
        continue;
      }

      this.flashing[lit] = branch;
      lit += 1;
    }

    this.flashing.length = lit;
  }

  /** Spikes run on; one at a trunk's end splits down each branch, one at a synapse climbs the dendrite. */
  private travel(dt: number): void {
    const gain = this.activity.working ? WORKING_RELEASE : 1;
    const current = this.spikes;

    // Survivors, the spikes they become, and those a firing starts all join one list, capped at MAX_SPIKES.
    this.spikes = [];

    for (const spike of current) {
      const axon = this.axons[spike.cell];
      const path = this.pathOf(spike);

      if (axon === undefined || path === null) continue;
      spike.at += (spike.upDendrite ? DENDRITE_SPEED_PX : AXON_SPEED_PX) * dt;

      if (spike.at < path.length) {
        this.launch(spike);
        continue;
      }

      if (spike.branch < 0) {
        for (const branch of axon.branches.keys()) this.launch({ cell: spike.cell, branch, upDendrite: false, bright: spike.bright, at: spike.at - path.length });
        continue;
      }

      const branch = axon.branches[spike.branch];

      if (branch === undefined) continue;

      if (!spike.upDendrite) {
        branch.flash = 1;

        if (!branch.lit) {
          branch.lit = true;
          this.flashing.push(branch);
        }

        this.launch({ ...spike, upDendrite: true, at: 0 });
        continue;
      }

      const target = this.cells[branch.to];

      if (target === undefined) continue;
      target.glow = Math.max(target.glow, 0.18);
      target.charge += ARRIVAL_CHARGE;
      this.wake(branch.to);

      if (this.chance() < branch.release * gain || target.charge >= 1) this.fire(branch.to, spike.bright);
    }
  }

  private launch(spike: Spike): void {
    if (this.spikes.length < MAX_SPIKES) this.spikes.push(spike);
  }

  private pathOf(spike: Spike): Path | null {
    const axon = this.axons[spike.cell];

    if (axon === undefined) return null;

    if (spike.branch < 0) return axon.trunk;
    const branch = axon.branches[spike.branch];

    if (branch === undefined) return null;

    return spike.upDendrite ? branch.dendrite : branch.path;
  }

  /** Writes `piece` in `this.ink`. */
  private writeStroke(count: number, piece: Piece): number {
    const { alpha, glow, tone } = this.ink;

    if (alpha <= 0.003) return count;
    this.strokes = grown(this.strokes, (count + 1) * STROKE_STRIDE);
    const at = count * STROKE_STRIDE;
    const data = this.strokes;
    const width = this.width;
    const height = this.height();

    data[at] = piece.from[0] / width;
    data[at + 1] = piece.from[1] / height;
    data[at + 2] = piece.bend[0] / width;
    data[at + 3] = piece.bend[1] / height;
    data[at + 4] = piece.to[0] / width;
    data[at + 5] = piece.to[1] / height;
    data[at + 6] = 1;
    data[at + 7] = piece.width;
    data[at + 8] = glow;
    data[at + 9] = tone;
    data[at + 10] = alpha;
    data[at + 11] = 0;

    return count + 1;
  }

  /** The tissue at rest, every piece unlit: written only when it changes, and kept by a renderer between changes. */
  private writeRest(): void {
    let count = 0;

    for (const piece of this.pieces) {
      if (piece.cover >= 0.995) continue;
      this.inked(piece.alpha * (1 - piece.cover), piece.glow, piece.tone);
      count = this.writeStroke(count, piece);
    }

    this.restCount = count;
    this.restEpoch += 1;
    this.restDirty = false;
  }

  /** A lit cell's soma and dendrites, again over the rest, brighter by its glow and the pointer's charge. */
  private writeLit(cell: Cell, from: number): number {
    let count = from;

    for (const index of cell.pieces) {
      const piece = this.pieces[index];

      if (piece === undefined || piece.cover >= 0.995) continue;
      const lit = cell.glow * (1 - 0.5 * piece.depth) + 0.5 * cell.sense;

      this.inked(piece.alpha * (1 - piece.cover) * 1.3 * this.glint * lit, GLINT_GLOW * clamp(0.3 + lit, 0, 1), TONE_ACCENT);
      count = this.writeStroke(count, piece);
    }

    return count;
  }

  private inked(alpha: number, glow: number, tone: number): void {
    this.ink.alpha = alpha;
    this.ink.glow = glow;
    this.ink.tone = tone;
  }

  /** Writes the disc in `this.spot`. */
  private writeNode(count: number): number {
    const { x, y, radius, glow, alpha } = this.spot;

    if (alpha <= 0.003) return count;
    this.nodes = grown(this.nodes, (count + 1) * NODE_STRIDE);
    const index = count * NODE_STRIDE;
    const data = this.nodes;

    data[index] = x / this.width;
    data[index + 1] = y / this.height();
    data[index + 2] = radius;
    data[index + 3] = glow;
    data[index + 4] = TONE_ACCENT;
    data[index + 5] = clamp(alpha, 0, 1);
    data[index + 6] = 0;
    data[index + 7] = 0;

    return count + 1;
  }

  /** Each spike as a glint over the pieces its head and tail span: brighter down an axon, softer up a dendrite. */
  private writePulses(): number {
    let count = 0;

    for (let id = 0; id < this.spikes.length; id += 1) {
      const spike = this.spikes[id];
      const path = spike === undefined ? null : this.pathOf(spike);

      if (spike === undefined) continue;

      if (path === null || path.length <= 0) continue;
      const tail = spike.at - (spike.upDendrite ? DENDRITE_TAIL_PX : AXON_TAIL_PX);
      const ends = clamp((path.length - spike.at) / 10, 0, 1) * clamp(spike.at / 6, 0, 1);

      for (const step of path.steps) {
        if (step.length <= 0 || step.start > spike.at || step.start + step.length < tail) continue;
        const piece = this.pieces[step.piece];

        if (piece === undefined || piece.cover >= 0.995) continue;
        const span = step.t1 - step.t0;

        this.pulses = grown(this.pulses, (count + 1) * PULSE_STRIDE);
        const at = count * PULSE_STRIDE;
        const data = this.pulses;
        const width = this.width;
        const height = this.height();

        data[at] = piece.from[0] / width;
        data[at + 1] = piece.from[1] / height;
        data[at + 2] = piece.bend[0] / width;
        data[at + 3] = piece.bend[1] / height;
        data[at + 4] = piece.to[0] / width;
        data[at + 5] = piece.to[1] / height;
        data[at + 6] = step.t0 + span * clamp((tail - step.start) / step.length, 0, 1);
        data[at + 7] = step.t0 + span * clamp((spike.at - step.start) / step.length, 0, 1);
        data[at + 8] = spike.upDendrite ? 1.2 : 1.5;
        data[at + 9] = GLINT_GLOW;
        data[at + 10] = TONE_BRIGHT;
        data[at + 11] = (spike.upDendrite ? 0.4 : 0.7) * this.glint * ends * (1 - piece.cover);
        data[at + 12] = id;
        data[at + 13] = 0;
        data[at + 14] = 1;
        data[at + 15] = 0;
        count += 1;
      }
    }

    return count;
  }
}
