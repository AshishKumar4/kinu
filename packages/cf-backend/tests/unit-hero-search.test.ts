/**
 * The front page's picture claims to be a search. This is what makes that true.
 *
 * A decorative tree would pass a screenshot review and lie in the only way that
 * matters: the page says "it runs the tree and keeps the branch that measured
 * best", and a reader is entitled to assume the drawing does that. So the
 * properties asserted here are the ones the copy promises — rollouts
 * concentrate on the branch that scores, abandoned branches really were
 * abandoned, and the bright line really is the most-visited path.
 *
 * Determinism is the second half. The tree is rendered into the page at request
 * time, so a search that varied would make every screenshot diff unreadable and
 * every caption number a lie.
 */

import { describe, expect, test } from 'bun:test';

import { heroSearch, type HeroNode } from '../src/lib/hero-search';

const search = heroSearch();
const byId = new Map(search.nodes.map((node) => [node.id, node]));
const children = (id: number): HeroNode[] => search.nodes.filter((node) => node.parent === id);

describe('the hero search is a tree', () => {
  test('exactly one root, and every other node hangs off a real parent', () => {
    const roots = search.nodes.filter((node) => node.parent === null);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.depth).toBe(0);
    for (const node of search.nodes) {
      if (node.parent === null) continue;
      const parent = byId.get(node.parent);
      expect(parent, `parent of ${node.id}`).toBeDefined();
      expect(node.depth).toBe(parent!.depth + 1);
      expect(node.beat).toBeGreaterThan(parent!.beat);
    }
  });

  test('one edge per non-root node, and every edge joins a parent to its child', () => {
    expect(search.edges).toHaveLength(search.nodes.length - 1);
    for (const { from, to } of search.edges) expect(to.parent).toBe(from.id);
  });

  test('no node forks wider than the search allows', () => {
    for (const node of search.nodes) expect(children(node.id).length).toBeLessThanOrEqual(2);
  });
});

describe('the search spends its rollouts', () => {
  test('the root carries every rollout', () => {
    expect(byId.get(0)!.visits).toBe(search.beats);
  });

  test('a parent carries at least what its children carry', () => {
    // Backpropagation adds one visit per ancestor per rollout, so a subtree can
    // never hold more than the node above it.
    for (const node of search.nodes) {
      const below = children(node.id).reduce((sum, child) => sum + child.visits, 0);
      expect(below, `node ${node.id}`).toBeLessThanOrEqual(node.visits);
    }
  });

  test('it concentrates rather than spreading evenly', () => {
    // The picture's whole argument. At the root, the kept child must be the
    // clear favourite; an even split is the bush that an over-exploring
    // constant produces, and it draws the opposite of a measured search.
    const top = children(0).sort((a, b) => b.visits - a.visits);
    expect(top.length).toBeGreaterThan(1);
    expect(top[0]!.visits).toBeGreaterThan(top[1]!.visits * 1.5);
  });

  test('every score is a fraction, and an unvisited node claims nothing', () => {
    for (const node of search.nodes) {
      expect(node.value).toBeGreaterThanOrEqual(0);
      expect(node.value).toBeLessThanOrEqual(1);
      if (node.visits === 0) expect(node.value).toBe(0);
    }
  });
});

describe('the statuses mean what the caption says', () => {
  test('the kept nodes are one path from the root, taking the most-visited child', () => {
    const kept = search.nodes.filter((node) => node.status === 'kept').sort((a, b) => a.depth - b.depth);
    expect(kept[0]!.id).toBe(0);
    for (let i = 0; i < kept.length; i++) {
      expect(kept[i]!.depth, 'the kept line has no gap').toBe(i);
      const next = children(kept[i]!.id).sort((a, b) => b.visits - a.visits)[0];
      if (next === undefined) expect(i).toBe(kept.length - 1);
      else expect(next.id, `child kept at depth ${i}`).toBe(kept[i + 1]!.id);
    }
  });

  test('an abandoned branch took one rollout and no more', () => {
    for (const node of search.nodes) {
      if (node.status === 'pruned') expect(node.visits).toBeLessThanOrEqual(1);
      if (node.visits > 1 && node.status !== 'kept') expect(node.status).toBe('open');
    }
    expect(search.nodes.some((node) => node.status === 'pruned')).toBeTrue();
    expect(search.nodes.some((node) => node.status === 'open')).toBeTrue();
  });
});

describe('the layout can be drawn', () => {
  test('depth is the x axis, at a constant pitch', () => {
    const columns = new Map<number, number>();
    for (const node of search.nodes) {
      const seen = columns.get(node.depth);
      if (seen === undefined) columns.set(node.depth, node.x);
      else expect(node.x, `depth ${node.depth}`).toBe(seen);
    }
    const xs = [...columns.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x);
    const pitches = xs.slice(1).map((x, i) => x - xs[i]!);
    expect(new Set(pitches).size).toBe(1);
  });

  test('no two nodes land on the same point', () => {
    const seen = new Set(search.nodes.map((node) => `${node.x},${node.y}`));
    expect(seen.size).toBe(search.nodes.length);
  });

  test('a parent sits between its children', () => {
    for (const node of search.nodes) {
      const kids = children(node.id);
      if (kids.length === 0) continue;
      const ys = kids.map((kid) => kid.y);
      expect(node.y).toBeGreaterThanOrEqual(Math.min(...ys));
      expect(node.y).toBeLessThanOrEqual(Math.max(...ys));
    }
  });

  test('every node fits inside the reported viewBox, radius included', () => {
    for (const node of search.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(11);
      expect(node.x).toBeLessThanOrEqual(search.width - 11);
      expect(node.y).toBeGreaterThanOrEqual(11);
      expect(node.y).toBeLessThanOrEqual(search.height - 11);
    }
  });
});

describe('the same code draws the same tree', () => {
  test('two runs are identical', () => {
    expect(heroSearch()).toEqual(heroSearch());
  });

  test('a different seed is a different search', () => {
    const other = heroSearch({ seed: 0x1234 });
    expect(other.nodes.map((node) => node.visits)).not.toEqual(search.nodes.map((node) => node.visits));
  });

  test('the defaults are the shape the page is designed around', () => {
    // Landscape, deep enough to show a line being followed, and small enough
    // to read at 390px. A change here is a change to the front page.
    expect(search.depth).toBeGreaterThanOrEqual(5);
    expect(search.width / search.height).toBeGreaterThan(1);
    expect(search.nodes.length).toBeGreaterThanOrEqual(24);
    expect(search.nodes.length).toBeLessThanOrEqual(48);
  });
});
