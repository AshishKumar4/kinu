// Behavior tests for AGENTS.md discovery — the nearest-file-wins walk-up
// chain (agents.md standard) feeding core's admission and renderer. Discovery
// stats every candidate and reads only the ones that fit the model's window,
// so these tests assert what was READ as much as what was rendered.
//
// Two gates sit in front of the read. Containment: a file found at
// `<dir>/AGENTS.md` may only contribute bytes that live under `<dir>`, so a
// symlink out of the tree cannot pipe `/etc/passwd` into a prompt. Trust: the
// bytes that survive are classified by the owner's approval resolver, which is
// what decides whether they can be placed as system instructions at all.
import { describe, test, expect, afterEach } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CHARS_PER_TOKEN, renderAgentsMdSection, stepContextLimit,
  type InstructionTrustResolver, type ModelWindow,
} from '@kinu.run/core';
import { discoverAgentsMd } from '../src/agents-md';

/** Wide enough that admission is never what a chain-order test measures. */
const WIDE: ModelWindow = { contextWindow: 400_000, modelOutputLimit: 32_000 };
/** A window whose answer reservation is its own declared maximum, so the
 *  instruction budget is the other half of it. */
const NARROW: ModelWindow = { contextWindow: 800, modelOutputLimit: 400 };
/** Derived, never a literal: the same two facts the allocator is built from. */
const budgetOf = (limits: ModelWindow): number => stepContextLimit(limits) * CHARS_PER_TOKEN;

/** The owner has approved everything — the resolver a test uses when trust is
 *  not the thing it measures, so admission and rendering keep their meaning. */
const APPROVED: InstructionTrustResolver = () => 'approved';
/** Nobody approved anything: the standing answer for a file with no decision. */
const UNVERIFIED: InstructionTrustResolver = () => 'unverified';

const roots: string[] = [];
function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'kinu-agentsmd-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('discoverAgentsMd', () => {
  test('collects the walk-up chain ordered root-most first, nearest last', () => {
    const root = makeTree();
    const nested = join(root, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), 'root rules');
    writeFileSync(join(root, 'packages', 'AGENTS.md'), 'packages rules');
    writeFileSync(join(nested, 'AGENTS.md'), 'app rules');

    const sources = discoverAgentsMd(nested, WIDE, APPROVED);
    const inTree = sources.admitted.filter((f) => f.path.startsWith(root));
    expect(inTree.map((f) => f.content)).toEqual(['root rules', 'packages rules', 'app rules']);
    expect(inTree.at(-1)?.path).toBe(join(nested, 'AGENTS.md'));
    expect(sources.referenced.filter((ref) => ref.path.startsWith(root))).toEqual([]);
  });

  test('skips levels without a file, and an empty file is neither admitted nor referenced', () => {
    const root = makeTree();
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), 'only root');
    writeFileSync(join(root, 'a', 'AGENTS.md'), '   \n');

    const sources = discoverAgentsMd(nested, WIDE, APPROVED);
    expect(sources.admitted.filter((f) => f.path.startsWith(root)).map((f) => f.content))
      .toEqual(['only root']);
    // A file with no instructions is not worth pointing the model at either.
    expect(sources.referenced.filter((ref) => ref.path.startsWith(root))).toEqual([]);
  });

  test('returns an empty chain when no AGENTS.md exists anywhere up the tree', () => {
    const root = makeTree();
    const sources = discoverAgentsMd(root, WIDE, APPROVED);
    expect(sources.admitted.filter((f) => f.path.startsWith(root))).toEqual([]);
    expect(sources.referenced.filter((ref) => ref.path.startsWith(root))).toEqual([]);
  });

  test('an oversized AGENTS.md is sized, never read, and rendered as a sized reference', () => {
    const root = makeTree();
    const path = join(root, 'AGENTS.md');
    const oversized = 'B'.repeat(budgetOf(NARROW) + 1);
    writeFileSync(path, oversized);
    // A trap, not a fixture detail: an lstat still answers the size of a file
    // with no permission bits, but readFileSync cannot open it and `tolerate`
    // only swallows ENOENT. A discoverer that reads before it admits therefore
    // throws EACCES here instead of quietly materializing the whole file.
    chmodSync(path, 0o000);

    const sources = discoverAgentsMd(root, NARROW, APPROVED);
    expect(sources.admitted.filter((f) => f.path.startsWith(root))).toEqual([]);
    expect(sources.referenced.filter((ref) => ref.path.startsWith(root)))
      .toEqual([{ path, bytes: oversized.length }]);

    const section = renderAgentsMdSection(sources, 'system');
    expect(section).toContain(`${path} (${String(oversized.length)} bytes)`);
    expect(section).not.toContain('BBBB');
  });

  test('the budget is spent nearest-first: a giant root file is referenced, the nearest is read whole', () => {
    const root = makeTree();
    const nested = join(root, 'pkg');
    mkdirSync(nested, { recursive: true });
    const giant = join(root, 'AGENTS.md');
    writeFileSync(giant, 'R'.repeat(budgetOf(NARROW)));
    writeFileSync(join(nested, 'AGENTS.md'), 'nearest instructions win');

    const sources = discoverAgentsMd(nested, NARROW, APPROVED);
    expect(sources.admitted.filter((f) => f.path.startsWith(root)).map((f) => f.content))
      .toEqual(['nearest instructions win']);
    expect(sources.referenced.filter((ref) => ref.path.startsWith(root)).map((ref) => ref.path))
      .toEqual([giant]);

    const section = renderAgentsMdSection(sources, 'system');
    expect(section).toContain('nearest instructions win');
    expect(section).not.toContain('RRRR');
  });

  test('a wider window admits the file a narrow one only references', () => {
    const root = makeTree();
    const path = join(root, 'AGENTS.md');
    const content = 'A'.repeat(budgetOf(NARROW) + 1);
    writeFileSync(path, content);
    expect(content.length).toBeLessThan(budgetOf(WIDE));

    expect(discoverAgentsMd(root, NARROW, APPROVED).referenced.map((ref) => ref.path))
      .toContain(path);
    expect(discoverAgentsMd(root, WIDE, APPROVED).admitted.map((f) => f.content))
      .toContain(content);
  });
});

describe('discoverAgentsMd — containment', () => {
  /** The bytes an escaping link would exfiltrate. Distinctive so a leak can be
   *  searched for across the whole result rather than one field of it. */
  const SECRET = 'ssh-rsa AAAA-exfiltrated-private-key';

  test('an AGENTS.md symlinked to a file outside its directory is not admitted', () => {
    const root = makeTree();
    const outside = makeTree();
    const evil = join(outside, 'evil.md');
    writeFileSync(evil, SECRET);
    symlinkSync(evil, join(root, 'AGENTS.md'));

    const sources = discoverAgentsMd(root, WIDE, APPROVED);
    expect(sources.admitted.filter((f) => f.path.startsWith(root))).toEqual([]);
    expect(sources.referenced.filter((ref) => ref.path.startsWith(root))).toEqual([]);
    // Not one field: nowhere in the result, and nowhere in either rendering.
    expect(JSON.stringify(sources)).not.toContain('exfiltrated');
    expect(renderAgentsMdSection(sources, 'system')).not.toContain('exfiltrated');
    expect(renderAgentsMdSection(sources, 'unverified')).not.toContain('exfiltrated');
  });

  test('an escaping symlink does not disturb the plain files above and below it', () => {
    const root = makeTree();
    const outside = makeTree();
    const nested = join(root, 'pkg', 'app');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(outside, 'evil.md'), SECRET);
    writeFileSync(join(root, 'AGENTS.md'), 'root rules');
    symlinkSync(join(outside, 'evil.md'), join(root, 'pkg', 'AGENTS.md'));
    writeFileSync(join(nested, 'AGENTS.md'), 'app rules');

    const sources = discoverAgentsMd(nested, WIDE, APPROVED);
    expect(sources.admitted.filter((f) => f.path.startsWith(root)).map((f) => f.content))
      .toEqual(['root rules', 'app rules']);
    expect(JSON.stringify(sources)).not.toContain('exfiltrated');
  });

  test('an AGENTS.md symlinked to a file inside its own directory is admitted', () => {
    const root = makeTree();
    mkdirSync(join(root, 'rules'));
    writeFileSync(join(root, 'rules', 'shared.md'), 'shared monorepo rules');
    // Legal on purpose: packages share one rule file this way, and the bytes
    // still belong to the directory that offers them.
    symlinkSync(join(root, 'rules', 'shared.md'), join(root, 'AGENTS.md'));

    const sources = discoverAgentsMd(root, WIDE, APPROVED);
    const inTree = sources.admitted.filter((f) => f.path.startsWith(root));
    expect(inTree.map((f) => f.content)).toEqual(['shared monorepo rules']);
    // Provenance stays the discovered path, not the link target.
    expect(inTree[0]?.path).toBe(join(root, 'AGENTS.md'));
  });

  test('a symlink up to an ancestor escapes its own directory and is refused', () => {
    const root = makeTree();
    const nested = join(root, 'pkg');
    mkdirSync(nested);
    writeFileSync(join(root, 'AGENTS.md'), 'root rules');
    // `pkg/AGENTS.md -> ../AGENTS.md` leaves `pkg`, so `pkg` cannot vouch for
    // it. Nothing is lost: the walk already reaches the root file on its own,
    // which is why the chain shows it exactly once.
    symlinkSync(join(root, 'AGENTS.md'), join(nested, 'AGENTS.md'));

    const sources = discoverAgentsMd(nested, WIDE, APPROVED);
    expect(sources.admitted.filter((f) => f.path.startsWith(root)).map((f) => f.path))
      .toEqual([join(root, 'AGENTS.md')]);
  });

  test('a directory named AGENTS.md contributes nothing', () => {
    const root = makeTree();
    mkdirSync(join(root, 'AGENTS.md'));
    const sources = discoverAgentsMd(root, WIDE, APPROVED);
    expect(sources.admitted.filter((f) => f.path.startsWith(root))).toEqual([]);
    expect(sources.referenced.filter((ref) => ref.path.startsWith(root))).toEqual([]);
  });
});

describe('discoverAgentsMd — trust classification', () => {
  test('an admitted file with no approval is unverified', () => {
    const root = makeTree();
    writeFileSync(join(root, 'AGENTS.md'), 'root rules');
    const sources = discoverAgentsMd(root, WIDE, UNVERIFIED);
    expect(sources.admitted.filter((f) => f.path.startsWith(root)).map((f) => f.trust))
      .toEqual(['unverified']);
  });

  test('an admitted file the resolver approves is approved', () => {
    const root = makeTree();
    writeFileSync(join(root, 'AGENTS.md'), 'root rules');
    const sources = discoverAgentsMd(root, WIDE, APPROVED);
    expect(sources.admitted.filter((f) => f.path.startsWith(root)).map((f) => f.trust))
      .toEqual(['approved']);
  });

  test('the resolver is asked about the exact bytes that were read, at that path', () => {
    const root = makeTree();
    const path = join(root, 'AGENTS.md');
    const content = 'root rules';
    writeFileSync(path, content);

    const asked: Array<{ path: string; content: string }> = [];
    const sources = discoverAgentsMd(root, WIDE, (p, c) => {
      asked.push({ path: p, content: c });
      return 'approved';
    });

    expect(sources.admitted.map((f) => f.path)).toContain(path);
    // Content, not a digest: hashing is the authority's business, so discovery
    // hands over what it read and one module decides how bytes become a digest.
    expect(asked).toContainEqual({ path, content });
  });

  test('editing an approved file changes what the resolver is asked about', () => {
    const root = makeTree();
    const path = join(root, 'AGENTS.md');
    writeFileSync(path, 'first rules');
    const seen: string[] = [];
    const capture: InstructionTrustResolver = (_p, content) => {
      seen.push(content);
      return 'approved';
    };

    discoverAgentsMd(root, WIDE, capture);
    writeFileSync(path, 'second rules');
    discoverAgentsMd(root, WIDE, capture);

    // Content-addressed approval: the rewrite asks a different question, which
    // is the whole invalidation story — no cache to clear, no revoke to call.
    expect(seen).toEqual(['first rules', 'second rules']);
  });

  test('a referenced-but-unread file is never handed to the resolver', () => {
    const root = makeTree();
    writeFileSync(join(root, 'AGENTS.md'), 'C'.repeat(budgetOf(NARROW) + 1));
    const asked: string[] = [];
    const sources = discoverAgentsMd(root, NARROW, (p) => {
      asked.push(p);
      return 'approved';
    });

    expect(sources.referenced.map((ref) => ref.path)).toContain(join(root, 'AGENTS.md'));
    // Trust is about bytes. Nothing was read, so there are no bytes to judge.
    expect(asked).not.toContain(join(root, 'AGENTS.md'));
  });
});

describe('discoverAgentsMd — a bad symlink can never fail the turn', () => {
  test('a self-referential AGENTS.md is reported unavailable, not thrown', () => {
    // One `ln -s AGENTS.md AGENTS.md` used to take the whole turn down: both
    // statSync and realpathSync throw ELOOP and the throw escaped discovery.
    // The agent writes this plane, so that was a one-command denial of service.
    const root = makeTree();
    const path = join(root, 'AGENTS.md');
    symlinkSync(path, path);

    const sources = discoverAgentsMd(root, WIDE, APPROVED);
    expect(sources.admitted.filter((f) => f.path === path)).toEqual([]);
    expect(sources.unavailable).toContainEqual({ path, reason: 'symlink cycle' });
  });

  test('a two-link cycle between two AGENTS.md files is reported, not thrown', () => {
    const root = makeTree();
    const nested = join(root, 'pkg');
    mkdirSync(nested, { recursive: true });
    const a = join(root, 'AGENTS.md');
    const b = join(nested, 'AGENTS.md');
    symlinkSync(b, a);
    symlinkSync(a, b);

    const sources = discoverAgentsMd(nested, WIDE, APPROVED);
    expect(sources.admitted.filter((f) => f.path === a || f.path === b)).toEqual([]);
    expect(sources.unavailable?.map((u) => u.reason)).toContain('symlink cycle');
  });

  test('a cycle does not stop the real files in the chain from being carried', () => {
    // The property that matters: assembly continues. A broken link costs its own
    // file and nothing else.
    const root = makeTree();
    const nested = join(root, 'app');
    mkdirSync(nested, { recursive: true });
    const broken = join(nested, 'AGENTS.md');
    symlinkSync(broken, broken);
    writeFileSync(join(root, 'AGENTS.md'), 'root rules');

    const sources = discoverAgentsMd(nested, WIDE, APPROVED);
    expect(sources.admitted.map((f) => f.content)).toContain('root rules');
    expect(sources.unavailable?.map((u) => u.path)).toContain(broken);
  });

  test('an unavailable path is never handed to the resolver', () => {
    // Nothing was read, so there are no bytes to classify or to approve.
    const root = makeTree();
    const path = join(root, 'AGENTS.md');
    symlinkSync(path, path);
    const asked: string[] = [];

    discoverAgentsMd(root, WIDE, (p) => { asked.push(p); return 'approved'; });
    expect(asked).not.toContain(path);
  });

  test('an escaping symlink is reported with a reason that names no target', () => {
    // The reason must not leak the path outside the tree — that content is
    // exactly what this directory may not speak for.
    const root = makeTree();
    const outside = join(mkdtempSync(join(tmpdir(), 'kinu-outside-')), 'secret.md');
    writeFileSync(outside, 'SECRET-BYTES');
    const path = join(root, 'AGENTS.md');
    symlinkSync(outside, path);

    const sources = discoverAgentsMd(root, WIDE, APPROVED);
    const entry = sources.unavailable?.find((u) => u.path === path);
    expect(entry?.reason).toBe('symlink points outside its own directory');
    expect(JSON.stringify(sources)).not.toContain('SECRET-BYTES');
    expect(JSON.stringify(sources)).not.toContain(outside);
  });
});

describe('discoverAgentsMd — containment survives a post-admission swap', () => {
  test('reads no out-of-tree bytes when the validated target becomes a symlink', () => {
    const root = makeTree();
    const path = join(root, 'AGENTS.md');
    const target = join(root, 'shared.md');
    const outside = join(mkdtempSync(join(tmpdir(), 'kinu-agentsmd-outside-')), 'poison.md');
    writeFileSync(target, 'reviewed in-tree instructions');
    writeFileSync(outside, 'OUTSIDE-POISON-MUST-NEVER-REACH-THE-PROMPT');
    symlinkSync(target, path);

    const sources = discoverAgentsMd(root, WIDE, APPROVED, () => {
      renameSync(target, `${target}.old`);
      symlinkSync(outside, target);
    });

    expect(sources.admitted.map((file) => file.content))
      .not.toContain('OUTSIDE-POISON-MUST-NEVER-REACH-THE-PROMPT');
    expect(sources.unavailable).toContainEqual({
      path,
      reason: 'file changed after containment check',
    });
  });
});
