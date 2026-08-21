/**
 * The search the landing page draws.
 *
 * The hero's proof is that a hard task gets a tree of agents, so the picture
 * on the front page is that tree. It is a real UCT
 * search: select by the same upper-confidence rule the evolution engine uses,
 * expand one child, score it, carry the score back to the root. Nothing is
 * hand-placed, and the tree is not a drawing of a tree.
 *
 * What it is NOT: a model runs no rollout here. A candidate's score comes from
 * a seeded latent quality plus noise, which is the one honest way to draw a
 * search on a page that must render in a worker with no agents and no
 * inference. The SHAPE is what the picture claims — a search spends its
 * rollouts on the branch that measures well and abandons the rest — and that
 * shape is produced by the search, not asserted by a designer.
 *
 * Seeded, so the page is a pure function of this file: a screenshot diff of
 * the landing shows a code change and never a new random tree.
 */

/** Where a node sits once the tree is laid out, in viewBox units. */
export interface HeroNode {
  readonly id: number;
  readonly parent: number | null;
  readonly depth: number;
  /** Rollouts this node received. Drives radius and edge weight. */
  readonly visits: number;
  /** Mean measured score, 0..1. Drives fill on the danger→success ramp. */
  readonly value: number;
  /** `kept` is on the principal variation, `pruned` was abandoned after one
   *  rollout, `open` is everything the search is still spending on. */
  readonly status: 'kept' | 'open' | 'pruned';
  /** The iteration that created this node, so the page can reveal the tree in
   *  the order the search built it. */
  readonly beat: number;
  readonly x: number;
  readonly y: number;
}

export interface HeroSearch {
  readonly nodes: readonly HeroNode[];
  /** Parent→child pairs, in the order the search created them. */
  readonly edges: readonly { readonly from: HeroNode; readonly to: HeroNode }[];
  readonly width: number;
  readonly height: number;
  /** Highest beat in the tree, which is how many reveals a full growth takes. */
  readonly beats: number;
  readonly depth: number;
}

export interface HeroSearchOptions {
  /** Rollouts to spend. 34 reaches depth 6 and leaves 16 branches, which fills
   *  a hero column at 1280px and still reads at 390px. */
  readonly iterations?: number;
  readonly maxDepth?: number;
  /** Candidates a node may fork into. Two, because the picture has to show a
   *  choice being made and abandoned rather than a fan of siblings. */
  readonly branching?: number;
  readonly seed?: number;
  /** Column pitch and row pitch, in viewBox units. */
  readonly col?: number;
  readonly row?: number;
  /** Room kept around the tree so a radius-11 node never clips. */
  readonly pad?: number;
}

interface Building {
  id: number;
  parent: Building | null;
  depth: number;
  visits: number;
  total: number;
  /** The quality this branch would reach if the search kept spending on it.
   *  Inherited with noise, which is what gives the tree a good side. */
  latent: number;
  beat: number;
  children: Building[];
  row: number;
  y: number;
}

/** mulberry32. Small, seedable, and good enough that the tree has no visible
 *  period — the same generator the gallery fixtures use. Exported for the
 *  hero's other seeded picture, the silk field in `hero-weave.ts`. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Low enough that the search visibly concentrates. At 1.4 the rollouts spread
 *  evenly and the tree comes out a bush four levels deep, which draws the
 *  opposite of what a measured search does. */
const EXPLORATION = 0.7;

/** UCT. A node with no rollouts is taken first, which is what makes a fresh
 *  branch worth drawing at all. */
function best(node: Building): Building {
  let pick = node.children[0]!;
  let score = -Infinity;
  for (const child of node.children) {
    const value = child.visits === 0
      ? Infinity
      : child.total / child.visits + EXPLORATION * Math.sqrt(Math.log(node.visits + 1) / child.visits);
    if (value > score) { score = value; pick = child; }
  }
  return pick;
}

export function heroSearch(options: HeroSearchOptions = {}): HeroSearch {
  const iterations = options.iterations ?? 34;
  const maxDepth = options.maxDepth ?? 8;
  const branching = options.branching ?? 2;
  const col = options.col ?? 68;
  const row = options.row ?? 21;
  const pad = options.pad ?? 16;
  const random = rng(options.seed ?? 0x5EA4C4);

  let next = 1;
  const root: Building = {
    id: 0, parent: null, depth: 0, visits: 0, total: 0,
    latent: 0.52, beat: 0, children: [], row: 0, y: 0,
  };
  const all: Building[] = [root];

  for (let beat = 1; beat <= iterations; beat++) {
    // Select: descend the tree until a node can still take a child.
    let target = root;
    while (target.children.length >= branching && target.depth < maxDepth) target = best(target);
    // Expand, unless the branch reached the depth bound — that one takes
    // another rollout where it is, which is how a search concentrates instead
    // of only ever growing.
    if (target.depth < maxDepth) {
      const child: Building = {
        id: next++, parent: target, depth: target.depth + 1, visits: 0, total: 0,
        latent: clamp(target.latent + (random() - 0.42) * 0.34),
        beat, children: [], row: 0, y: 0,
      };
      target.children.push(child);
      all.push(child);
      target = child;
    }
    // Score, then carry it to the root.
    const measured = clamp(target.latent + (random() - 0.5) * 0.16);
    for (let up: Building | null = target; up; up = up.parent) {
      up.visits += 1;
      up.total += measured;
    }
  }

  layout(root, row);
  const kept = principal(root);
  const depth = all.reduce((max, node) => Math.max(max, node.depth), 0);
  const height = Math.max(...all.map((node) => node.y)) + pad * 2;
  const nodes: HeroNode[] = all.map((node) => ({
    id: node.id,
    parent: node.parent?.id ?? null,
    depth: node.depth,
    visits: node.visits,
    value: node.visits === 0 ? 0 : node.total / node.visits,
    status: kept.has(node.id) ? 'kept' : node.visits <= 1 ? 'pruned' : 'open',
    beat: node.beat,
    x: pad + node.depth * col,
    y: pad + node.y,
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = nodes
    .filter((node) => node.parent !== null)
    .map((node) => ({ from: byId.get(node.parent!)!, to: node }));

  return {
    nodes,
    edges,
    width: pad * 2 + depth * col,
    height,
    beats: iterations,
    depth,
  };
}

function clamp(value: number): number {
  return value < 0.04 ? 0.04 : value > 0.98 ? 0.98 : value;
}

/**
 * Rows for leaves in order, parents centred on their children — the first-order
 * behaviour of the tidy layout `swarm-tree.tsx` gets from `d3.tree().nodeSize`,
 * which is unavailable here because a worker has no d3 and the app's layout is
 * bound to a React render. Depth is the x axis, as it is in the app: depth is
 * small and bounded while breadth is not.
 */
function layout(root: Building, row: number): void {
  let taken = 0;
  const place = (node: Building): number => {
    if (node.children.length === 0) {
      node.row = taken++;
      node.y = node.row * row;
      return node.y;
    }
    const ys = node.children.map(place);
    node.y = (ys[0]! + ys[ys.length - 1]!) / 2;
    return node.y;
  };
  place(root);
}

/** The line the search paid for: from the root, always the most-visited child.
 *  Same rule as `principalVariation` in `swarm-tree-model.ts`. */
function principal(root: Building): Set<number> {
  const ids = new Set<number>([root.id]);
  let node = root;
  while (node.children.length > 0) {
    let pick = node.children[0]!;
    for (const child of node.children) if (child.visits > pick.visits) pick = child;
    ids.add(pick.id);
    node = pick;
  }
  return ids;
}
