/**
 * The connectome behind the signed-in shell: a mat of thin fibres that grow
 * in from the edges and corners of the view by one recursive rule — a
 * branch runs a few short curving segments, forks into shorter branches,
 * which fork again, a dozen generations deep — and fuse wherever a tip
 * meets another fibre, the way mycelium does. Thousands of strands overlap
 * into a texture that is dense at the rim, thins
 * toward the middle and is absent across it, where the page's content
 * sits. No single strand is meant to be read; the impression is the mat.
 * Signals travel the fibres as tiny bright grains, many at once, so the
 * tissue shimmers; tips extend and retract on a slow breath, and a wave of
 * light runs in from the rim.
 *
 * Three states, driven by what the shell knows: idle breathes and carries
 * a quiet traffic; working brightens and streams grains toward one corner;
 * a decision arriving flashes one corner's mat in unison, then settles.
 *
 * Pure and deterministic: the same seed, budget and sequence of
 * `setActivity` and `step(dt)` calls produce the same frames on any
 * runtime. There is no DOM here and no drawing; a renderer reads `frame()`
 * and draws what it says, through the same `ArtFrame` the landing hero
 * emits, so the hero's two renderers draw this picture unchanged. The
 * frame carries strokes and pulses only: endpoints are nothing, so
 * `nodeCount` is always 0.
 *
 * The population is fixed at construction — growth stops at the segment
 * budget and never resumes — so a frame costs the same at hour one as at
 * second one. The budget is the caller's: the WebGPU path draws a full mat
 * (`MESH_SEGMENTS`), the Canvas2D fallback a sparser one from the same
 * seed (`CANVAS_SEGMENTS`), since it strokes every segment one by one.
 * Coordinates are view-normalised: x and y run 0..1 across the drawn box;
 * `aspect` (height / width) keeps distances isotropic.
 *
 * Text never sits over tissue: the mount hands over the boxes of every run
 * of copy on the page's ground (`setKeepOut`), and a fibre or a grain
 * under one — or within its reach — is drawn at nothing. Measured
 * 2026-09-14: any art at all under a text box moves its 1% tail contrast,
 * so the rule is absence, not dimming.
 */

import { type ArtFrame, clamp, grown, viewDistance, type KeepOut, PULSE_STRIDE, seededRandom, STROKE_STRIDE, TONE_ACCENT, TONE_BRIGHT } from './art';
import { movePulse, type Pulse, pulseTail, writePulse } from './pulse';

export interface ConnectomeOptions {
  readonly seed: number;
  /** Height over width of the drawn box. */
  readonly aspect: number;
  /** Segments in the mat; growth stops here. Defaults to MESH_SEGMENTS. */
  readonly segments?: number;
  /** What the shell already knew when the picture began: decisions waiting
   *  at birth are old news and earn no flash; only a rise after this does. */
  readonly activity?: ConnectomeActivity;
}

/** What the shell knows: a live turn somewhere, and how many decisions wait on the owner. */
export interface ConnectomeActivity {
  readonly working: boolean;
  readonly decisions: number;
}

/** What the tissue is doing this instant. `attention` is the flash a new
 *  decision earns, over in about a second and a half; then the mode is
 *  whatever the activity says. */
export type ConnectomeMode = 'idle' | 'working' | 'attention';

/** The full mat, for the instanced WebGPU path; measured 2026-09-14 on
 *  the RTX 4080 at 1440×900: see the app background's record. */
export const MESH_SEGMENTS = 16_000;

/** The sparser mat Canvas2D strokes one segment at a time. */
export const CANVAS_SEGMENTS = 2_400;

/** Grains alive at once, per segment of budget: a shimmer, never a swarm. */
const SIGNALS_PER_SEGMENT = 1 / 24;

/** A grain's tail reaches this far behind its head, in view width units. */
const SIGNAL_TAIL = 0.012;

/** How far in from the nearest edge the mat reaches, in view width units;
 *  the rim's density falls to nothing here. A corner reaches CORNER_REACH
 *  times further. The mat reads
 *  as a frame around the content: most of its mass lives in the outer
 *  band, so the reach is shallow and the falloff steep — the centre
 *  column stays sparse. */
const REACH = 0.17;

const CORNER_REACH = 1.7;

/** Roots along an edge sit this far apart, before the seeded jitter; a corner holds CORNER_ROOTS of its own. */
const ROOT_SPACING = 0.016;

const CORNER_ROOTS = 10;

/** The rule: a root's segment is this long; a child's is RATIO of its
 *  parent's, never under SEGMENT_FLOOR; MAX_GENERATION generations deep. */
const SEGMENT = 0.02;

const RATIO = 0.86;

const SEGMENT_FLOOR = 0.005;

const MAX_GENERATION = 13;

/** A branch runs this many segments before it forks, at most. */
const SEGMENTS_PER_BRANCH = 5;

/** How far a branch turns per segment (its curl), the noise on that, and how far a fork's children spread, in radians. */
const CURL = 0.2;

const CURL_NOISE = 0.5;

const SPREAD = 0.6;

/** A tip this close to any fibre of another tree fuses with it. */
const FUSE_REACH = 0.009;

/** Per-fibre alpha on the rim; the mat's impression is their overlap. Falls
 *  with the rim toward the middle, on top of the density's own falloff. */
const FIBRE_ALPHA = 0.095;

const SIGNAL_ALPHA = 0.42;

/** The pointer's reach over the tissue, in view width units: inside it the
 *  mat answers. Apart from the hero tree's own reach on purpose: the tree
 *  bends tips under a cursor, the tissue holds whole strokes. The disc is
 *  wide enough that a cursor anywhere off-centre is felt, not just near
 *  the rim. */
const TISSUE_REACH = 0.16;

/** How far a tissue stroke bends toward the pointer at most, in view widths. */
const TISSUE_BEND = 0.028;

/** How fast the pointer's hold eases in and out, per second. */
const POINTER_RATE = 7;

/** A pointer burst faster than this (view widths per second) fires a signal. */
const BURST_SPEED = 0.4;

/** At most one pointer-fired signal per root in this window, in seconds. */
const BURST_WINDOW = 0.25;

/** A fired signal's brightness and width scale within this seeded range. */
const AMPLITUDE_LOW = 0.45;

/** The top of the seeded amplitude range. */
const AMPLITUDE_HIGH = 1;

/** How fast the look follows the activity: a change reads as a fade of
 *  about a second, never a cut. Slower than the hero's branch fade —
 *  activity is a mood, not an event. */
const ACTIVITY_FADE_RATE = 1.4;

/** The flash: a fast attack, then a decay of just over a second. */
const FLASH_ATTACK = 0.12;

const FLASH_DECAY = 1.3;

/** While working, the corner the grains converge on changes this often. */
const FOCUS_SECONDS = 20;

/** A keep-out box's reach, in view width units. Inside KEEP_OUT_HOLD of a
 *  box the cover is whole: a fibre's sway is under 0.004 and the blur and
 *  the bloom reach about 14 CSS px at 1440, so nothing drawn from a home
 *  this close ever lands under the copy. Past that the cover fades over
 *  KEEP_OUT_FADE, so the mat thins toward the copy instead of ending at a
 *  line. */
const KEEP_OUT_HOLD = 0.016;

const KEEP_OUT_FADE = 0.02;

/** Points along a segment's curve tested against the keep-out, ends included. */
const EDGE_SAMPLES = 4;

/** How far the mat sways, in view width units: the whole mesh moves as a
 *  cloth would, neighbours together, never a strand on its own. */
const SWAY = 0.0022;

/** The look a mode asks for; the drawn look eases between them. */
interface Look {
  /** Seconds per breath. */
  readonly period: number;
  readonly glowBase: number;
  readonly glowAmp: number;
  /** How bright a grain burns, as a multiple of SIGNAL_ALPHA. */
  readonly energy: number;
  /** View widths per second a grain travels. */
  readonly speed: number;
  /** Seconds between grains leaving, before the seeded jitter. */
  readonly cadence: number;
  /** How much the focus corner is lifted above the rest. */
  readonly focus: number;
}

const IDLE: Look = { period: 10, glowBase: 0.16, glowAmp: 0.22, energy: 1, speed: 0.11, cadence: 0.02, focus: 0 };

const WORKING: Look = { period: 5, glowBase: 0.24, glowAmp: 0.28, energy: 1.35, speed: 0.17, cadence: 0.008, focus: 1 };

interface Node {
  /** The root's tree this node grew in. */
  readonly tree: number;
  readonly generation: number;
  readonly root: boolean;
  /** Home, in view units; the drawn point sways around it. */
  readonly hx: number;
  readonly hy: number;
  /** 0 at REACH from the rim, 1 on it; the corner term lifts it near a corner. */
  readonly rim: number;
  /** The corner this node is nearest, 0..3, and how much it belongs to it. */
  readonly corner: number;
  readonly cornerness: number;
  /** Ids of the edges that touch this node. */
  readonly edges: number[];
  x: number;
  y: number;
  /** How far under the copy this node sits: 0 clear, 1 hidden. */
  cover: number;
  /** The pointer's hold on this node: 0 away, 1 under it. Eases both ways. */
  hold: number;
}

interface Edge {
  readonly a: number;
  readonly b: number;
  readonly generation: number;
  /** How far the curve bows from its chord, as a share of its length; signed. */
  readonly bow: number;
  readonly width: number;
  /** Where the breath wave reaches this segment. */
  readonly phase: number;
  /** The rim under the segment's middle. */
  readonly rim: number;
  /** A tip extends and retracts on its own slow breath; a grown edge is whole. */
  tip: boolean;
  readonly tipRate: number;
  readonly tipPhase: number;
  /** How much of the curve is drawn this frame, from a toward b. */
  drawn: number;
  /** View coordinates this frame. */
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
  /** How far under the copy any part of this edge lies: 0 clear, 1 hidden. */
  cover: number;
}

/** A branch waiting to grow: from a node, in a heading, at a length. */
interface Shoot {
  readonly from: number;
  readonly heading: number;
  readonly length: number;
  readonly generation: number;
  readonly curl: number;
}

/** A grain is a pulse that also knows where it is going and how far it may still travel. */
interface Signal extends Pulse {
  /** The corner it is converging on, or -1 when it wanders. */
  readonly toward: number;
  hops: number;
}

interface Flash {
  readonly corner: number;
  age: number;
}

/** A sine by table: the mat evaluates tens of thousands a frame, for a
 *  sway and a breath nobody reads to the fourth decimal. */
const SINE_STEPS = 4_096;

const SINE = new Float32Array(new ArrayBuffer(4 * SINE_STEPS));

for (let index = 0; index < SINE_STEPS; index += 1) SINE[index] = Math.sin((2 * Math.PI * index) / SINE_STEPS);

const SINE_SCALE = SINE_STEPS / (2 * Math.PI);

function sine(angle: number): number {
  return SINE[(Math.floor(angle * SINE_SCALE) % SINE_STEPS + SINE_STEPS) % SINE_STEPS] ?? 0;
}

/** How many children a shoot spawns for one roll: two where the rim opens the
 *  canopy, usually one, and rarely none so a branch can simply end. */
function branchChildren(roll: number, rim: number): number {
  if (roll < 0.35 + 0.45 * rim) return 2;

  if (roll < 0.95) return 1;

  return 0;
}

/** The flash envelope: full within FLASH_ATTACK, gone FLASH_DECAY later. */
function envelope(age: number): number {
  if (age < FLASH_ATTACK) return age / FLASH_ATTACK;

  return clamp(1 - (age - FLASH_ATTACK) / FLASH_DECAY, 0, 1);
}

/** One signal released onto an edge: where it starts, the edge it takes, the
 *  corner it is aimed at (-1 for none), how many hops it may travel and how
 *  bright it rides. */
interface SignalLaunch {
  from: number;
  edgeId: number;
  toward: number;
  hops: number;
  strength: number;
}

/** One stroke's look for this frame: the edge it draws and the light on it. */
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

  /** The pointer in view units, or null when absent, hoverless or reduced-motion. */
  private pointerX: number | null = null;

  private pointerY: number | null = null;

  /** Where the pointer was on the last burst check, and when, in tissue time. */
  private burstX = 0;

  private burstY = 0;

  private burstAt = 0;

  /** The last tissue time a pointer burst fired from each root. */
  private readonly burstFired: number[] = [];

  /** The tissue time each root may next send a grain, seeded exponentially. */
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

  /** The boxes of the copy on the ground, in view units: nothing is drawn under them. */
  setKeepOut(boxes: readonly KeepOut[]): void {
    this.keepOut = boxes;
    this.shade();
  }

  /** What the shell knows now. A decision count that rose since the last
   *  call is the one event the tissue answers at once: a flash, one corner,
   *  in unison. Everything else the look eases toward over the next second. */
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

  /** The strongest pointer hold across the mat, 0 with no pointer: what a
   *  gate waits on to know the cursor reached the simulation. */
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

  /** The pointer in view units: an input to the simulation, never to the
   *  random stream, so a scripted path replays the same frames. The mount
   *  calls this only where hover exists and motion is wanted. */
  setPointer(x: number, y: number): void {
    if (this.pointerX === null) {
      this.burstX = x;
      this.burstY = y;
      this.burstAt = this.elapsed;
    }

    this.pointerX = x;
    this.pointerY = y;
  }

  /** The pointer left: the hold eases back over about half a second. */
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
      const flashedEnd = [a, b].find((end) => end.corner === flashCorner);
      const cornerness = flashedEnd?.cornerness ?? 0;
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

  /** How far a point is from the nearest edge of the view, in view widths. */
  private edgeGap(x: number, y: number): number {
    return Math.max(0, Math.min(x, 1 - x, y * this.aspect, (1 - y) * this.aspect));
  }

  /** The corner a point is nearest and how far it is from it, in view widths. */
  private nearestCorner(x: number, y: number): readonly [corner: number, gap: number] {
    const right = x > 0.5;
    const bottom = y > 0.5;
    const gap = this.distance(x, y, right ? 1 : 0, bottom ? 1 : 0);

    return [(right ? 1 : 0) + (bottom ? 2 : 0), gap];
  }

  /** 0 at REACH from the rim and beyond, 1 on the rim; a corner's own reach lifts it. */
  private rimOf(x: number, y: number): number {
    const [, cornerGap] = this.nearestCorner(x, y);

    return clamp(Math.max(1 - this.edgeGap(x, y) / REACH, 1 - cornerGap / (REACH * CORNER_REACH)), 0, 1);
  }

  /** The roots: CORNER_ROOTS in each corner, then one every ROOT_SPACING
   *  along each edge, each heading inward with a turn of its own, and every
   *  shoot they send, grown breadth-first so the budget is spent evenly. */
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

    // Breadth-first until the budget is spent. A branching process near
    // criticality can die out early on some seeds; when the queue drains
    // with budget left, new shoots sprout from the rim's own fibres, so
    // every seed grows the same amount of tissue with the same falloff.
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

  /** One branch of the rule: up to SEGMENTS_PER_BRANCH curving segments,
   *  dying where the rim gives out, then a fork into shorter children — two
   *  more often near the rim, sometimes none — and now and then a twig. */
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

      // The rim gives out: a segment survives in proportion to how much rim is left under it.
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
      // A pair splits left and right; a lone child picks its side, and only it
      // draws — the draw order is what makes one seed one figure.
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

  /** The nearest node of ANOTHER tree within FUSE_REACH of this one, or -1 when
   *  no tree reaches it. Only the origin's own cell and its eight neighbours are
   *  read: a node further than one cell away is further than the reach. */
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

  /** Every tip within FUSE_REACH of a fibre of another tree fuses with the
   *  nearest such node, through a grid so the mat's size does not square
   *  the cost; then every edge that still ends at a tip becomes a tip edge. */
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

  /** How far under the copy a point at rest lies: 1 inside a box and for
   *  KEEP_OUT_HOLD around it, falling to 0 across KEEP_OUT_FADE beyond, the
   *  most of any box. */
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

  /** Every node's and every edge's cover, from their homes: the sway is
   *  smaller than the hold, so a cover holds for the picture's life until
   *  the boxes change. An edge is as covered as the most covered point on
   *  it; an edge whose whole box lies beyond every keep-out's reach is
   *  clear without a sample. */
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

  /** Whether the segment's box, grown by `reach`, meets any keep-out box. */
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

  /** The mat sways as one cloth: every node moves with a smooth field of
   *  its home, so neighbours move together; every edge follows its ends;
   *  every tip breathes out and back. The pointer's hold bends strokes
   *  toward it, at most TISSUE_BEND where the hold is whole. */
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

  /** The pointer's hold eases toward its target every step: whole under the
   *  pointer, nothing past TISSUE_REACH, in and out at POINTER_RATE, so a
   *  leave decays back over about half a second. A burst — fast motion —
   *  fires one signal from the nearest root in reach, rate-limited. */
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

  /** One signal from the nearest root in the pointer's reach, unless that
   *  root fired within BURST_WINDOW. The amplitude is seeded. */
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

  /** A click — a pointer press, not a move — sends a front out from the
   *  point: the nearest nodes each send a grain down the edge that leads
   *  AWAY from the click, so the wave travels outward through the mat. */
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

      // The outward way: the edge whose far end lies farther from the click.
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

  /** A corner whose mat is on view — most of its roots clear of the copy — at random; any corner when none is. */
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

  /** A decision arrived: one corner — the focus while working, else any —
   *  flashes, and every root of it sends a grain inward at once. */
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

  /** A seeded exponential wait of the given mean, capped at eight means so
   *  one draw never idles the tissue past its mood. */
  private waitFor(mean: number): number {
    return Math.min(8 * mean, -Math.log(1 - this.random()) * mean);
  }

  /** Grains leave per root on a seeded exponential wait whose mean is the
   *  mode's cadence times the root count, so the whole tissue still fires
   *  at today's rate while each root clusters and rests. Each grain's
   *  amplitude is seeded in [AMPLITUDE_LOW, AMPLITUDE_HIGH] and scales its
   *  brightness and width. */
  private emit(): void {
    const working = this.activity.working && this.focusCorner >= 0;
    const mean = this.look.cadence * this.roots.length;

    for (const id of this.roots) {
      if (this.elapsed < (this.nextFire[id] ?? Number.POSITIVE_INFINITY)) continue;
      this.nextFire[id] = this.elapsed + this.waitFor(mean);

      // From the root itself most of the time; sometimes the grain leaves a
      // tip and walks back toward it, or — while working — starts anywhere
      // and converges on the corner that wants the answer.
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

  /** The edge a grain at `from` takes next: never the one it came by
   *  unless nothing else touches the node; toward a corner, the one whose
   *  far end lies nearest that corner, most of the time. */
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

      // A tip edge ends where its breath has drawn it to: a grain there turns back.
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

  /** A grain at an edge's end: go on, or go out. */
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
