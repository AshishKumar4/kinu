// AGENTS.md discovery: containment keeps a symlink from piping outside bytes into a prompt;
// trust classification decides whether surviving bytes may be system instructions.
import { scratchDir } from '../../test-utils/src/scratch';
import { describe, test, expect } from 'bun:test';
import { chmodSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CHARS_PER_TOKEN, renderAgentsMdSection, stepContextLimit,
  type InstructionTrustResolver, type ModelWindow,
} from '@kinu.run/core';
import { discoverAgentsMd } from '../src/agents-md';

const WIDE: ModelWindow = { contextWindow: 400_000, modelOutputLimit: 32_000 };

/** Answer reservation equals the declared maximum, so the instruction budget is the other half. */
const NARROW: ModelWindow = { contextWindow: 800, modelOutputLimit: 400 };

const budgetOf = (limits: ModelWindow): number => stepContextLimit(limits) * CHARS_PER_TOKEN;

const APPROVED: InstructionTrustResolver = () => 'approved';

const UNVERIFIED: InstructionTrustResolver = () => 'unverified';

function makeTree(): string {
  const root = scratchDir('agentsmd');

  return root;
}

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
    // lstat still sizes an unreadable file, but readFileSync throws EACCES: a read-before-admit discoverer fails here.
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
    // Legal: packages share one rule file this way.
    symlinkSync(join(root, 'rules', 'shared.md'), join(root, 'AGENTS.md'));

    const sources = discoverAgentsMd(root, WIDE, APPROVED);
    const inTree = sources.admitted.filter((f) => f.path.startsWith(root));
    expect(inTree.map((f) => f.content)).toEqual(['shared monorepo rules']);
    expect(inTree[0]?.path).toBe(join(root, 'AGENTS.md'));
  });

  test('a symlink up to an ancestor escapes its own directory and is refused', () => {
    const root = makeTree();
    const nested = join(root, 'pkg');
    mkdirSync(nested);
    writeFileSync(join(root, 'AGENTS.md'), 'root rules');
    // `pkg/AGENTS.md -> ../AGENTS.md` leaves `pkg`; the walk reaches the root file on its own.
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
    expect(asked).not.toContain(join(root, 'AGENTS.md'));
  });
});

describe('discoverAgentsMd — a bad symlink can never fail the turn', () => {
  test('a self-referential AGENTS.md is reported unavailable, not thrown', () => {
    // A self-link makes statSync and realpathSync throw ELOOP; escaping discovery would be a one-command DoS.
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
    const root = makeTree();
    const path = join(root, 'AGENTS.md');
    symlinkSync(path, path);
    const asked: string[] = [];

    discoverAgentsMd(root, WIDE, (p) => {
      asked.push(p);

      return 'approved';
    });
    expect(asked).not.toContain(path);
  });

  test('an escaping symlink is reported with a reason that names no target', () => {
    const root = makeTree();
    const outside = join(scratchDir('outside'), 'secret.md');
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
    const outside = join(scratchDir('agentsmd-outside'), 'poison.md');
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
