/**
 * Skills behaviour through the public surface. There is no `skills` tool: CRUD is
 * ordinary VFS operations. The in-memory SkillsVfs records every call, so "no body
 * was read" is observed, not claimed.
 */

import { describe, expect, test } from 'bun:test';
import { createTestRuntime, present } from '@kinu.run/test-utils';
import { stepContextLimit } from '../prompting/step-prune';
import { estimateTokens } from '../llm';
import {
  parseSkillFile, stringifySkillFile,
  discoverSkills, BUILTIN_SKILLS, BUILTIN_SKILL_FILES, BUILTIN_SKILL_HEADERS,
  resolveActiveSkills, extractExplicitInvocations,
  admitSkillsIndex, admitActiveSkills,
  renderActiveSkillsSection, renderSkillsIndexSection, unionAllowedTools, toolAllowedBySkills,
  WORKSPACE_SKILLS_DIR, skillViewPath, skillsMount, workspaceSkillIndexLine,
  type SkillsVfs, type ActiveSkill, type DiscoveredSkill,
} from './index';
import { withMountTable } from '../vfs/mounts';
import type { VFS } from '../types/primitives';
import { resolveTurnSkills, type TurnSkillSurface } from '../orchestrator/turn-surface';
import { buildSystemPromptSync } from '../prompt';
import { SHARED_SKILLS_DIR } from '../vfs/shared-drive';
import { makeVfsError } from '../vfs/errno';
import type { InstructionTrustResolver } from '../safety/instruction-trust';
import { createRecordingLogger, setDiagnosticsSink } from '../obs/index';

/** The `readFile` list proves whether a body was fetched. */
interface VfsCalls { readFile: string[]; stat: string[]; readdir: string[] }

/** `readdir` is a required field so a test that swaps the lister holds the one it replaced. */
interface MemoryVfs extends SkillsVfs { calls: VfsCalls; readdir: (path: string) => Promise<string[]> }

function memoryVfs(
  initial: Record<string, string> = {},
  opts: { entryOrder?: (names: string[]) => string[]; sizes?: Record<string, number> } = {},
): MemoryVfs {
  const files = new Map<string, string>(Object.entries(initial));
  const calls: VfsCalls = { readFile: [], stat: [], readdir: [] };

  return {
    calls,
    async exists(p) { return files.has(p); },
    async readFile(p) {
      calls.readFile.push(p);
      const v = files.get(p);

      if (v === undefined) throw new Error(`ENOENT: ${p}`);

      return v;
    },
    async writeFile(p, data) {
      files.set(p, data instanceof Uint8Array ? new TextDecoder().decode(data) : data);
    },
    async stat(p) {
      calls.stat.push(p);
      const v = files.get(p);

      if (v === undefined) return null;

      return { size: opts.sizes?.[p] ?? v.length, mtimeMs: 0, isDir: false };
    },
    async readdir(p) {
      calls.readdir.push(p);
      const prefix = p.replace(/\/$/, '') + '/';
      const out: string[] = [];

      for (const k of files.keys()) {
        if (!k.startsWith(prefix)) continue;
        // A nested path lists as its first segment once.
        const head = k.slice(prefix.length).split('/')[0];

        if (!out.includes(head)) out.push(head);
      }

      return opts.entryOrder ? opts.entryOrder(out) : out;
    },
    async unlink(p) { files.delete(p); },
    async mkdir() { /* no-op for memory fs */ },
  };
}

/** A roomy window; there is no char cap to turn up. */
const ROOMY_TOKENS = stepContextLimit({ contextWindow: 200_000, modelOutputLimit: 8_000 });

function skillFile(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: desc ${name}\n---\n${body}`;
}

/** `chars` is what admitting the body would cost. */
function fakeSkill(name: string, opts: Partial<ActiveSkill> = {}): DiscoveredSkill {
  const body = opts.body ?? 'body';

  return {
    name,
    description: opts.description ?? `desc ${name}`,
    allowed_tools: opts.allowed_tools ?? [],
    user_invocable: opts.user_invocable ?? true,
    bodyRef: opts.bodyRef ?? { kind: 'file', path: `${WORKSPACE_SKILLS_DIR}/${name}.md`, chars: body.length },
    ext: {},
    source: 'vfs',
  };
}

/** These tests stand on an approval rather than re-deciding one per call. */
const APPROVED: InstructionTrustResolver = () => 'approved';

function activeSkill(name: string, opts: Partial<ActiveSkill> = {}): ActiveSkill {
  return { ...fakeSkill(name, opts), trust: 'approved', body: opts.body ?? 'body' };
}

describe('parseSkillFile', () => {
  test('parses a minimal valid SKILL.md', () => {
    const r = parseSkillFile(`---
name: hello-world
description: A trivial workflow.
---

# Hello

Do the thing.
`);

    expect(r.ok).toBe(true);

    if (!r.ok) return;
    expect(r.skill.name).toBe('hello-world');
    expect(r.skill.description).toBe('A trivial workflow.');
    expect(r.skill.allowed_tools).toEqual([]);
    expect(r.skill.body).toContain('# Hello');
    expect(r.skill.source).toBe('vfs');
  });

  test('accepts both `allowed-tools` and `allowed_tools`', () => {
    const hyphen = parseSkillFile(`---
name: a
description: x
allowed-tools: [run, memory]
---
body
`);

    const snake = parseSkillFile(`---
name: a
description: x
allowed_tools: [run, memory]
---
body
`);

    expect(hyphen.ok && snake.ok).toBe(true);

    if (hyphen.ok && snake.ok) {
      expect(hyphen.skill.allowed_tools).toEqual(snake.skill.allowed_tools);
      expect(hyphen.skill.allowed_tools).toEqual(['run', 'memory']);
    }
  });

  test('accepts the Agent Skills spec\'s space-separated `allowed-tools` string', () => {
    // agentskills.io example: one space-separated string, not a YAML list. Read as a
    // single pattern it matches no tool, collapsing the surface to nothing.
    const r = parseSkillFile(`---
name: a
description: x
allowed-tools: Bash(git:*) Read
---
body
`);

    expect(r.ok).toBe(true);

    if (r.ok) expect(r.skill.allowed_tools).toEqual(['Bash(git:*)', 'Read']);
  });

  test('rejects non-kebab-case name', () => {
    const r = parseSkillFile(`---
name: BadName
description: x
---
body
`);

    expect(r.ok).toBe(false);
  });

  test('rejects missing description', () => {
    const r = parseSkillFile(`---
name: x
---
body
`);

    expect(r.ok).toBe(false);
  });

  test('uses fallbackName when frontmatter omits name (Anthropic spec)', () => {
    const r = parseSkillFile(`---
description: A skill authored without an explicit name.
---
body
`, 'vfs', 'my-skill-from-dir');

    expect(r.ok).toBe(true);

    if (r.ok) expect(r.skill.name).toBe('my-skill-from-dir');
  });

  test('rejects names containing reserved words (anthropic/claude)', () => {
    const a = parseSkillFile(`---
name: anthropic-helper
description: x
---
body
`);

    const c = parseSkillFile(`---
name: claude-thing
description: x
---
body
`);

    expect(a.ok).toBe(false);
    expect(c.ok).toBe(false);
  });

  test('rejects names exceeding 64 characters', () => {
    const tooLong = 'a' + '-b'.repeat(40); // 81 chars

    const r = parseSkillFile(`---
name: ${tooLong}
description: x
---
body
`);

    expect(r.ok).toBe(false);
  });

  test('rejects descriptions exceeding 1024 characters', () => {
    const longDesc = 'x'.repeat(1025);

    const r = parseSkillFile(`---
name: a
description: ${longDesc}
---
body
`);

    expect(r.ok).toBe(false);
  });

  test('rejects descriptions containing XML tags', () => {
    const r = parseSkillFile(`---
name: a
description: "Has <tool>tags</tool> inside"
---
body
`);

    expect(r.ok).toBe(false);
  });

  // Only a real `false` closes the skill to `/skill-name`.
  for (const c of [
    { name: 'parses user-invocable: false', frontmatter: 'name: ops-only\ndescription: x\nuser-invocable: false', invocable: false },
    { name: 'defaults user_invocable to true', frontmatter: 'name: normal\ndescription: x', invocable: true },
  ]) {
    test(c.name, () => {
      const r = parseSkillFile(`---\n${c.frontmatter}\n---\nbody\n`);

      expect(r.ok).toBe(true);

      if (r.ok) expect(r.skill.user_invocable).toBe(c.invocable);
    });
  }

  test('only a real boolean closes a skill: a quoted "false" is a string, not a flag', () => {
    const quoted = parseSkillFile(`---
name: quoted
description: x
user-invocable: "false"
---
body
`);

    expect(quoted.ok).toBe(true);

    if (quoted.ok) expect(quoted.skill.user_invocable).toBe(true);
  });

  test('preserves unknown front-matter keys in ext (forward-compat)', () => {
    const r = parseSkillFile(`---
name: x-skill
description: forward-compat
custom_field: hello
also_custom: 42
---
body
`);

    expect(r.ok).toBe(true);

    if (!r.ok) return;
    expect(r.skill.ext.custom_field).toBe('hello');
    expect(r.skill.ext.also_custom).toBe(42);
  });

  test('round-trips parse → stringify → parse', () => {
    const original = parseSkillFile(`---
name: round-trip
description: A skill that survives serialization.
allowed-tools: [run, memory]
user-invocable: false
---

# Round trip

Body content with **markdown**.
`);

    expect(original.ok).toBe(true);

    if (!original.ok) return;
    const ser = stringifySkillFile(original.skill);
    const reparsed = parseSkillFile(ser);
    expect(reparsed.ok).toBe(true);

    if (!reparsed.ok) return;
    expect(reparsed.skill.name).toBe(original.skill.name);
    expect(reparsed.skill.description).toBe(original.skill.description);
    expect(reparsed.skill.allowed_tools).toEqual(original.skill.allowed_tools);
    expect(reparsed.skill.user_invocable).toBe(original.skill.user_invocable);
    expect(reparsed.skill.body.trim()).toBe(original.skill.body.trim());
  });

  test('keeps type-looking strings as strings through stringify → parse', () => {
    const base = parseSkillFile(`---
name: x
description: x
---
body
`);

    expect(base.ok).toBe(true);

    if (!base.ok) return;

    const skill = {
      ...base.skill,
      ext: {
        flag: 'true',
        count: '123',
        ratio: '1.5',
        missing: 'null',
        tilde: '~',
        nested: { inner: 'false' },
        tags: ['123', 'false', 'hello'],
      },
    };

    const reparsed = parseSkillFile(stringifySkillFile(skill));
    expect(reparsed.ok).toBe(true);

    if (!reparsed.ok) return;
    expect(reparsed.skill.ext.flag).toBe('true');
    expect(reparsed.skill.ext.count).toBe('123');
    expect(reparsed.skill.ext.ratio).toBe('1.5');
    expect(reparsed.skill.ext.missing).toBe('null');
    expect(reparsed.skill.ext.tilde).toBe('~');
    expect(reparsed.skill.ext.nested).toEqual({ inner: 'false' });
    expect(reparsed.skill.ext.tags).toEqual(['123', 'false', 'hello']);
  });
});

describe('extractExplicitInvocations', () => {
  test('finds /skill-name tokens at start of message', () => {
    expect(extractExplicitInvocations('/audit-implementation please')).toEqual(['audit-implementation']);
  });

  test('finds /skill-name tokens after whitespace', () => {
    expect(extractExplicitInvocations('please /audit-implementation now')).toEqual(['audit-implementation']);
  });

  test('finds multiple in order', () => {
    expect(extractExplicitInvocations('/a then /b-c then /d'))
      .toEqual(['a', 'b-c', 'd']);
  });

  test('ignores slashes in URLs and paths', () => {
    // No leading whitespace before the slash → not a token.
    expect(extractExplicitInvocations('see https://example.com/path')).toEqual([]);
  });

  test('returns empty when there are none', () => {
    expect(extractExplicitInvocations('no slashes here')).toEqual([]);
  });
});

describe('resolveActiveSkills', () => {
  test('explicit invocation activates', () => {
    const set = resolveActiveSkills({
      available: [fakeSkill('a')], explicit: ['a'], alwaysActive: [],
    });

    expect(set.map(a => a.skill.name)).toEqual(['a']);
    expect(set[0]?.reason.kind).toBe('explicit');
  });

  test('explicit invocation that does not match any skill is silently dropped', () => {
    const set = resolveActiveSkills({
      available: [fakeSkill('a')], explicit: ['nonexistent'], alwaysActive: [],
    });

    expect(set).toEqual([]);
  });

  test('always_active activates when the skill exists', () => {
    const set = resolveActiveSkills({
      available: [fakeSkill('a')], explicit: [], alwaysActive: ['a'],
    });

    expect(set.map(a => a.skill.name)).toEqual(['a']);
    expect(set[0]?.reason.kind).toBe('always_active');
  });

  test('explicit overrides always_active, and the same skill is activated once', () => {
    const set = resolveActiveSkills({
      available: [fakeSkill('a')], explicit: ['a'], alwaysActive: ['a'],
    });

    expect(set).toHaveLength(1);
    expect(set[0]?.reason.kind).toBe('explicit');
  });

  test('user_invocable: false blocks /skill-name explicit invocation', () => {
    const a = fakeSkill('a', { user_invocable: false });

    const set = resolveActiveSkills({
      available: [a], explicit: ['a'], alwaysActive: [],
    });

    expect(set).toEqual([]);
  });

  test('user_invocable: false does NOT block always-active activation', () => {
    const a = fakeSkill('a', { user_invocable: false });

    const set = resolveActiveSkills({
      available: [a], explicit: [], alwaysActive: ['a'],
    });

    expect(set.map(s => s.skill.name)).toEqual(['a']);
    expect(set[0]?.reason.kind).toBe('always_active');
  });

  test('activation ORDER is explicit, then always-active — the order the admission spends in', () => {
    const pinned = fakeSkill('aaa-pinned');
    const invoked = fakeSkill('zzz-invoked');

    const set = resolveActiveSkills({
      available: [pinned, invoked],
      explicit: ['zzz-invoked'],
      alwaysActive: ['aaa-pinned'],
    });

    // Alphabetically the pinned skill leads; by priority it comes last.
    expect(set.map(s => s.skill.name)).toEqual(['zzz-invoked', 'aaa-pinned']);
  });

  test('inside one tier the order is by name, whatever order the tier arrived in', () => {
    const available = [fakeSkill('m'), fakeSkill('a'), fakeSkill('z')];

    const forward = resolveActiveSkills({
      available, explicit: [], alwaysActive: ['z', 'a', 'm'],
    });

    const reversed = resolveActiveSkills({
      available: [...available].reverse(), explicit: [], alwaysActive: ['m', 'a', 'z'],
    });

    expect(forward.map(s => s.skill.name)).toEqual(['a', 'm', 'z']);
    expect(reversed.map(s => s.skill.name)).toEqual(['a', 'm', 'z']);
  });
});

describe('renderActiveSkillsSection + tool gating', () => {
  test('returns empty string for empty active set', () => {
    expect(renderActiveSkillsSection({ active: [], reasons: [] }, 'system')).toBe('');
  });

  test('renders the skill body and a "tool surface restricted" line when allow_tools is non-empty', () => {
    const a = activeSkill('a', { allowed_tools: ['run', 'memory'] });

    const out = renderActiveSkillsSection({
      active: [a],
      reasons: [{ name: 'a', reason: { kind: 'explicit', matched_token: 'a' } }],
    }, 'system');

    expect(out).toContain('## Active skills');
    expect(out).toContain('run');
    expect(out).toContain('### a (explicit /a)');
  });

  test('toolAllowedBySkills: empty union = no restriction', () => {
    expect(toolAllowedBySkills('anything', [])).toBe(true);
  });

  test('toolAllowedBySkills: exact match', () => {
    expect(toolAllowedBySkills('run', ['run', 'memory'])).toBe(true);
    expect(toolAllowedBySkills('agents', ['run'])).toBe(false);
  });

  test('toolAllowedBySkills: glob-suffix `workspace.*` matches namespace', () => {
    expect(toolAllowedBySkills('workspace.readFile', ['workspace.*'])).toBe(true);
    expect(toolAllowedBySkills('workspace.readFile', ['workspace'])).toBe(true);
    expect(toolAllowedBySkills('sandbox.exec', ['workspace.*'])).toBe(false);
  });

  test('toolAllowedBySkills: a spec-dialect `Bash(git:*)` pattern restricts its own family', () => {
    expect(toolAllowedBySkills('Bash', ['Bash(git:*)'])).toBe(true);
    expect(toolAllowedBySkills('Read', ['Bash(git:*)', 'Read'])).toBe(true);
    expect(toolAllowedBySkills('memory', ['Bash(git:*)', 'Read'])).toBe(false);
  });

  test('a deferred body renders its header, its cost and a pointer — never half a workflow', () => {
    const deferred: ActiveSkill = {
      ...fakeSkill('giant', { bodyRef: { kind: 'file', path: `${WORKSPACE_SKILLS_DIR}/giant.md`, chars: 50_000 } }),
      // An unread body has no bytes to approve, so its pointer is reference material.
      trust: 'unverified',
      body: null,
    };

    const out = renderActiveSkillsSection({
      active: [deferred],
      reasons: [{ name: 'giant', reason: { kind: 'explicit', matched_token: 'giant' } }],
    }, 'unverified');

    expect(out).toContain('### giant (explicit /giant)');
    expect(out).toContain('(50000 chars)');
    // The pointer is the one load path every skill has, whichever root holds it.
    expect(out).toContain(skillViewPath('giant'));
    expect(out).not.toContain('[truncated:');
  });

  test('render order is name order, so the same active set is byte-identical however it was activated', () => {
    const a = activeSkill('alpha');
    const b = activeSkill('beta');
    expect(renderActiveSkillsSection({ active: [a, b], reasons: [] }, 'system'))
      .toBe(renderActiveSkillsSection({ active: [b, a], reasons: [] }, 'system'));
  });

  test('admitted bodies render unchanged', () => {
    const a = activeSkill('a', { body: 'short body' });

    const out = renderActiveSkillsSection({
      active: [a],
      reasons: [{ name: 'a', reason: { kind: 'explicit', matched_token: 'a' } }],
    }, 'system');

    expect(out).toContain('short body');
    expect(out).not.toContain('not admitted');
  });
});

describe('renderSkillsIndexSection', () => {
  test('returns empty string when nothing was admitted', () => {
    expect(renderSkillsIndexSection({ lines: [], omitted: 0, tokens: 0 })).toBe('');
  });

  test('lists each admitted workspace skill by safe name only, in charged order, with no body or description', () => {
    const out = renderSkillsIndexSection(admitSkillsIndex({
      skills: [
        fakeSkill('alpha', { body: 'ALPHA-BODY-SHOULD-NOT-APPEAR' }),
        fakeSkill('zeta', { body: 'ZETA-BODY-SHOULD-NOT-APPEAR' }),
      ],
      unread: [], omitted: 0,
    }, ROOMY_TOKENS));

    expect(out).toContain('## Skills');
    // Descriptions are agent-writable; the system index never embeds them before approval.
    expect(out).toContain(`**alpha** \`${skillViewPath('alpha')}\``);
    expect(out).toContain(`**zeta** \`${skillViewPath('zeta')}\``);
    expect(out.indexOf('alpha')).toBeLessThan(out.indexOf('zeta'));
    expect(out).not.toContain('desc alpha');
    expect(out).not.toContain('desc zeta');
    expect(out).not.toContain('ZETA-BODY-SHOULD-NOT-APPEAR');
    expect(out).not.toContain('ALPHA-BODY-SHOULD-NOT-APPEAR');
  });

  test('a file too big to open is still named, with its size and its path', () => {
    const out = renderSkillsIndexSection(admitSkillsIndex({
      skills: [],
      unread: [{ name: 'huge', path: `${WORKSPACE_SKILLS_DIR}/huge.md`, bytes: 4_000_000 }], omitted: 0,
    }, ROOMY_TOKENS));

    expect(out).toContain('**huge**');
    expect(out).toContain('4000000 bytes');
    expect(out).toContain(skillViewPath('huge'));
  });

  test('elides under allocation pressure with an honest count and where to look, never a silent cut', () => {
    const skills = Array.from({ length: 50 }, (_, i) =>
      fakeSkill(`skill-${String(i).padStart(2, '0')}`, { description: 'd'.repeat(150) }));

    // A small window is the only way to squeeze the index.
    const index = admitSkillsIndex({ skills, unread: [], omitted: 0 },
      stepContextLimit({ contextWindow: 2_000, modelOutputLimit: 1_000 }));

    const out = renderSkillsIndexSection(index);
    expect(out).toMatch(/… and \d+ more skills? this turn's skills allocation did not reach/);
    expect(out).toContain('`/skills`');
    // At least one entry survives, and the omitted count is honest.
    const shown = (out.match(/^- \*\*/gm) ?? []).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(skills.length);
    expect(index.omitted).toBe(skills.length - shown);
  });

  test('a roomy window names every skill', () => {
    const skills = Array.from({ length: 5 }, (_, i) => fakeSkill(`skill-${i}`));
    const out = renderSkillsIndexSection(admitSkillsIndex({ skills, unread: [], omitted: 0 }, ROOMY_TOKENS));
    expect(out).not.toContain('did not reach');

    for (const s of skills) expect(out).toContain(`**${s.name}**`);
  });
});

describe('unionAllowedTools', () => {
  test('dedupes and sorts', () => {
    const a = fakeSkill('a', { allowed_tools: ['run', 'memory'] });
    const b = fakeSkill('b', { allowed_tools: ['run', 'agents'] });
    expect(unionAllowedTools([a, b])).toEqual(['agents', 'memory', 'run']);
  });
});

describe('discoverSkills', () => {
  test('one precedence decides a name: a built-in is reserved, the workspace beats the Drive, a folder beats a flat file', async () => {
    const errors: string[] = [];

    const v = memoryVfs({
      [`${WORKSPACE_SKILLS_DIR}/deploy.md`]: skillFile('deploy', 'workspace body'),
      [`${WORKSPACE_SKILLS_DIR}/lint.md`]: skillFile('lint', 'flat lint'),
      [`${WORKSPACE_SKILLS_DIR}/lint/SKILL.md`]: skillFile('lint', 'folder lint'),
      [`${WORKSPACE_SKILLS_DIR}/slates/SKILL.md`]: skillFile('slates', 'a shadow of the built-in'),
      [`${SHARED_SKILLS_DIR}/deploy/SKILL.md`]: skillFile('deploy', 'shared body'),
      [`${SHARED_SKILLS_DIR}/review/SKILL.md`]: skillFile('review', 'shared review'),
      [`${SHARED_SKILLS_DIR}/review/scripts/run.sh`]: 'echo hi',
      [`${SHARED_SKILLS_DIR}/notes.md`]: skillFile('notes', 'flat shared'),
    });

    const found = await discoverSkills(v, { admissionTokens: ROOMY_TOKENS, onParseError: (_f, e) => errors.push(e) });
    const byName = new Map(found.skills.map(s => [s.name, s]));

    expect(byName.get('deploy')?.bodyRef).toMatchObject({ kind: 'file', path: `${WORKSPACE_SKILLS_DIR}/deploy.md` });
    expect(byName.get('lint')?.bodyRef).toMatchObject({ kind: 'file', path: `${WORKSPACE_SKILLS_DIR}/lint/SKILL.md` });
    expect(byName.get('slates')?.bodyRef.kind).toBe('builtin');
    expect(byName.get('review')?.source).toBe('shared');
    expect(byName.get('review')?.bodyRef).toMatchObject({ kind: 'file', path: `${SHARED_SKILLS_DIR}/review/SKILL.md` });
    expect(byName.get('notes')?.source).toBe('shared');
    expect(errors.sort()).toEqual([
      `"deploy" is shadowed by ${WORKSPACE_SKILLS_DIR}/deploy.md`,
      `"lint" is shadowed by ${WORKSPACE_SKILLS_DIR}/lint/SKILL.md`,
      '"slates" is a built-in skill name and cannot be overridden by a file',
    ]);

    // No losing body was opened.
    expect(v.calls.readFile).not.toContain(`${SHARED_SKILLS_DIR}/deploy/SKILL.md`);
    expect(v.calls.readFile).not.toContain(`${WORKSPACE_SKILLS_DIR}/lint.md`);
    expect(renderSkillsIndexSection(admitSkillsIndex(found, ROOMY_TOKENS))).toContain(workspaceSkillIndexLine('review', 'shared'));
  });

  test('an absent /shared mount is no shared skills, not a failed discovery', async () => {
    const v = memoryVfs({ [`${WORKSPACE_SKILLS_DIR}/own.md`]: skillFile('own', 'O') });
    const listed = v.readdir;

    v.readdir = async (p) => {
      if (p.startsWith('/shared')) throw makeVfsError('ENXIO', '/shared — the shared Drive mounts once the workspace has an owner', p);

      return await listed(p);
    };

    const found = await discoverSkills(v, { admissionTokens: ROOMY_TOKENS });

    expect(found.skills.map(s => s.name)).toContain('own');
    expect(found.skills.filter(s => s.source === 'shared')).toEqual([]);
  });

  test('returns built-ins when VFS is empty', async () => {
    const v = memoryVfs();
    const found = await discoverSkills(v, { admissionTokens: ROOMY_TOKENS });
    const names = found.skills.map(s => s.name);
    expect(names).toContain('audit-implementation');

    for (const b of BUILTIN_SKILLS) expect(names).toContain(b.name);
    // A built-in body is already in memory.
    expect(v.calls.readFile).toEqual([]);
  });

  test('the slates built-in ships the authoring doctrine', () => {
    const skill = present(BUILTIN_SKILLS.find((s) => s.name === 'slates'), 'the slates built-in skill');

    for (const fragment of [
      'class Slate extends SlateObject', 'this.storage', 'this.sql',
      'kinu:slate', 'slate://', 'env.agent.send', 'env.ai.run',
      'persists across code edits, restarts and eviction',
    ]) {
      expect(skill.body).toContain(fragment);
    }
  });

  test('skips malformed files via onParseError instead of throwing', async () => {
    const errors: Array<{ path: string; err: string }> = [];

    const v = memoryVfs({
      [`${WORKSPACE_SKILLS_DIR}/good.md`]: skillFile('good', 'body'),
      [`${WORKSPACE_SKILLS_DIR}/bad.md`]: `not a valid skill file at all`,
    });

    const found = await discoverSkills(v, {
      admissionTokens: ROOMY_TOKENS,
      onParseError: (path, err) => errors.push({ path, err }),
    });

    expect(found.skills.find(s => s.name === 'good')).toBeTruthy();
    expect(errors.length).toBeGreaterThan(0);
  });

  test('mismatched filename vs frontmatter name is rejected', async () => {
    const v = memoryVfs({
      [`${WORKSPACE_SKILLS_DIR}/wrong-filename.md`]: `---\nname: actual-name\ndescription: ok\n---\nbody`,
    });

    const errors: string[] = [];

    const found = await discoverSkills(v, {
      admissionTokens: ROOMY_TOKENS, onParseError: (_p, e) => errors.push(e),
    });

    expect(found.skills.find(s => s.name === 'actual-name')).toBeFalsy();
    expect(errors.some(e => e.includes('does not match'))).toBe(true);
  });

  test('an illegal filename stem is rejected without opening the file', async () => {
    const v = memoryVfs({ [`${WORKSPACE_SKILLS_DIR}/Not_A_Skill.md`]: skillFile('x', 'body') });
    const errors: string[] = [];

    const found = await discoverSkills(v, {
      admissionTokens: ROOMY_TOKENS, onParseError: (_p, e) => errors.push(e),
    });

    expect(found.skills.every(s => s.source === 'builtin')).toBe(true);
    expect(errors.some(e => e.includes('filename stem'))).toBe(true);
    expect(v.calls.readFile).toEqual([]);
  });

  test('ORDER is the same whatever order readdir returns entries in — and so is the rendered index', async () => {
    const files = {
      [`${WORKSPACE_SKILLS_DIR}/mid.md`]: skillFile('mid', 'M'),
      [`${WORKSPACE_SKILLS_DIR}/apex.md`]: skillFile('apex', 'A'),
      [`${WORKSPACE_SKILLS_DIR}/zulu.md`]: skillFile('zulu', 'Z'),
    };

    const views = [
      memoryVfs(files, { entryOrder: (n) => [...n].sort() }),
      memoryVfs(files, { entryOrder: (n) => [...n].sort().reverse() }),
      // The shared directory lists empty; only the workspace's three rotate.
      memoryVfs(files, { entryOrder: (n) => (n.length === 3 ? [n[1], n[2], n[0]] : n) }),
    ];

    const orders = await Promise.all(views.map(async (v) => {
      const found = await discoverSkills(v, { admissionTokens: ROOMY_TOKENS });

      return {
        names: found.skills.map(s => s.name),
        rendered: renderSkillsIndexSection(admitSkillsIndex(found, ROOMY_TOKENS)),
      };
    }));

    expect(orders[0].names).toEqual(['apex', 'audit-implementation', 'mid', 'slates', 'zulu']);

    for (const o of orders) {
      expect(o.names).toEqual(orders[0].names);
      expect(o.rendered).toBe(orders[0].rendered);
    }
  });

  test('holds front matter only: no discovered skill carries a body, and the catalogue costs one read per file', async () => {
    const v = memoryVfs({
      [`${WORKSPACE_SKILLS_DIR}/one.md`]: skillFile('one', 'BODY-ONE'),
      [`${WORKSPACE_SKILLS_DIR}/two.md`]: skillFile('two', 'BODY-TWO'),
    });

    const found = await discoverSkills(v, { admissionTokens: ROOMY_TOKENS });

    for (const skill of found.skills) expect('body' in skill).toBe(false);
    expect(v.calls.readFile.sort()).toEqual([`${WORKSPACE_SKILLS_DIR}/one.md`, `${WORKSPACE_SKILLS_DIR}/two.md`]);
    // Size is consulted before bytes, for every candidate.
    expect(v.calls.stat.sort()).toEqual([`${WORKSPACE_SKILLS_DIR}/one.md`, `${WORKSPACE_SKILLS_DIR}/two.md`]);
    const one = found.skills.find(s => s.name === 'one');
    expect(one?.bodyRef).toEqual({ kind: 'file', path: `${WORKSPACE_SKILLS_DIR}/one.md`, chars: 'BODY-ONE'.length });
  });

  test('a file whose reported size alone exceeds the allocation is named from its filename and never opened', async () => {
    const path = `${WORKSPACE_SKILLS_DIR}/whale.md`;

    const v = memoryVfs(
      { [path]: skillFile('whale', 'W'), [`${WORKSPACE_SKILLS_DIR}/minnow.md`]: skillFile('minnow', 'm') },
      { sizes: { [path]: 40_000_000 } },
    );

    const found = await discoverSkills(v, { admissionTokens: ROOMY_TOKENS });
    expect(found.unread).toEqual([{ name: 'whale', path, bytes: 40_000_000 }]);
    expect(found.skills.map(s => s.name)).not.toContain('whale');
    expect(v.calls.stat).toContain(path);
    expect(v.calls.readFile).not.toContain(path);
    // The small one beside it was read normally.
    expect(v.calls.readFile).toContain(`${WORKSPACE_SKILLS_DIR}/minnow.md`);
  });

  // KINU-047: without stat, the read is bounded by the same byte ceiling and admitted truncated.
  test('a stat-less plane reads bounded: an oversized file is admitted truncated to the ceiling', async () => {
    const admissionTokens = 100; // ceiling: 400 chars
    const ceiling = admissionTokens * 4;
    const body = 'B'.repeat(ceiling * 4);
    const path = `${WORKSPACE_SKILLS_DIR}/whale.md`;

    const v = memoryVfs({ [path]: skillFile('whale', body) });
    delete v.stat; // a file view with no size answer

    const found = await discoverSkills(v, { admissionTokens });

    expect(v.calls.readFile).toContain(path);
    const whale = found.skills.find((s) => s.name === 'whale');
    expect(whale).toBeTruthy();
    expect(whale?.bodyRef).toMatchObject({ kind: 'file', path });
    expect(whale?.bodyRef.kind === 'file' && whale.bodyRef.chars).toBeLessThanOrEqual(ceiling);
  });

  // KINU-050: a huge directory admits only as many headers as the budget carries, in sorted order.
  test('discovery admits at most as many file skills as the prompt budget can carry, in sorted order', async () => {
    const admissionTokens = 500;
    // The bound derives from the cheapest workspace header line.
    const bound = Math.floor(admissionTokens / estimateTokens(workspaceSkillIndexLine('a').length + 1));
    const files: Record<string, string> = {};

    for (let i = bound + 5; i >= 1; i -= 1) {
      files[`${WORKSPACE_SKILLS_DIR}/skill-${String(i).padStart(3, '0')}.md`] = skillFile(`skill-${String(i).padStart(3, '0')}`, 'x');
    }

    const v = memoryVfs(files);
    const found = await discoverSkills(v, { admissionTokens });

    const workspace = found.skills.filter((s) => s.source !== 'builtin').map((s) => s.name);
    expect(workspace).toHaveLength(bound);
    expect(workspace).toEqual(
      Array.from({ length: bound }, (_, i) => `skill-${String(i + 1).padStart(3, '0')}`),
    );
    // No file beyond the bound was opened.
    expect(v.calls.readFile.length).toBeLessThanOrEqual(bound);
  });
});

describe('skills admission', () => {
  function corpus(count: number, bodyChars: number): DiscoveredSkill[] {
    return Array.from({ length: count }, (_, i) => {
      const name = `skill-${String(i).padStart(2, '0')}`;

      return fakeSkill(name, {
        bodyRef: { kind: 'file', path: `${WORKSPACE_SKILLS_DIR}/${name}.md`, chars: bodyChars },
      });
    });
  }

  async function admitAll(
    skills: DiscoveredSkill[],
    limits: { contextWindow: number; modelOutputLimit: number },
  ) {
    const files: Record<string, string> = {};

    for (const s of skills) {
      if (s.bodyRef.kind === 'file') files[s.bodyRef.path] = skillFile(s.name, 'b'.repeat(s.bodyRef.chars));
    }

    const vfs = memoryVfs(files);
    const admissionTokens = stepContextLimit(limits);
    const index = admitSkillsIndex({ skills, unread: [], omitted: 0 }, admissionTokens);

    const activated = resolveActiveSkills({
      available: skills, explicit: [], alwaysActive: skills.map(s => s.name),
    });

    const set = await admitActiveSkills({
      vfs, activated, admissionTokens: admissionTokens - index.tokens, trust: APPROVED,
    });

    return { index, set, vfs, admittedBodies: set.active.filter(s => s.body !== null) };
  }

  const bodyChars = (set: { active: ActiveSkill[] }) =>
    set.active.reduce((n, s) => n + (s.body?.length ?? 0), 0);

  test('a bigger context window admits more skill text; a bigger answer reserve admits less', async () => {
    const skills = corpus(40, 4_000);
    const small = await admitAll(skills, { contextWindow: 16_000, modelOutputLimit: 1_000 });
    const big = await admitAll(skills, { contextWindow: 200_000, modelOutputLimit: 1_000 });
    const reserved = await admitAll(skills, { contextWindow: 16_000, modelOutputLimit: 7_000 });

    expect(bodyChars(big.set)).toBeGreaterThan(bodyChars(small.set));
    expect(bodyChars(reserved.set)).toBeLessThan(bodyChars(small.set));
    // What was admitted fits the step pipeline's allocation.
    expect(estimateTokens(bodyChars(small.set)) + small.index.tokens)
      .toBeLessThanOrEqual(stepContextLimit({ contextWindow: 16_000, modelOutputLimit: 1_000 }));
  });

  test('only the bodies the allocation admitted are ever read', async () => {
    const skills = corpus(6, 20_000);

    const { vfs, admittedBodies, set } = await admitAll(skills,
      { contextWindow: 24_000, modelOutputLimit: 8_000 });

    expect(admittedBodies.length).toBeGreaterThan(0);
    expect(admittedBodies.length).toBeLessThan(skills.length);

    const readPaths = admittedBodies
      .map(s => s.bodyRef.kind === 'file' ? s.bodyRef.path : s.name).sort();

    expect(vfs.calls.readFile.sort()).toEqual(readPaths);
    // Nothing dropped: deferred skills keep a null body and a reference-tier pointer.
    expect(set.active.length).toBe(skills.length);

    const rendered = renderActiveSkillsSection(set, 'system')
      + renderActiveSkillsSection(set, 'unverified');

    for (const skill of skills) expect(rendered).toContain(`### ${skill.name}`);
  });

  test('the index is charged first and the bodies get what it left', async () => {
    const skills = corpus(3, 1_000);
    const limits = { contextWindow: 40_000, modelOutputLimit: 4_000 };
    const { index, set } = await admitAll(skills, limits);
    expect(index.tokens).toBeGreaterThan(0);
    expect(index.lines.length).toBe(skills.length);

    const bodyTokens = set.active
      .reduce((n, s) => n + (s.body === null ? 0 : estimateTokens(s.body.length)), 0);

    expect(index.tokens + bodyTokens).toBeLessThanOrEqual(stepContextLimit(limits));
  });

  test('the bodies are spent in activation priority order: an explicitly invoked skill keeps its body when a pinned giant cannot', async () => {
    const giant = fakeSkill('aaa-pinned-giant', {
      bodyRef: { kind: 'file', path: `${WORKSPACE_SKILLS_DIR}/aaa-pinned-giant.md`, chars: 30_000 },
    });

    const invoked = fakeSkill('zzz-invoked', {
      bodyRef: { kind: 'file', path: `${WORKSPACE_SKILLS_DIR}/zzz-invoked.md`, chars: 400 },
    });

    const vfs = memoryVfs({
      [`${WORKSPACE_SKILLS_DIR}/aaa-pinned-giant.md`]: skillFile('aaa-pinned-giant', 'G'.repeat(30_000)),
      [`${WORKSPACE_SKILLS_DIR}/zzz-invoked.md`]: skillFile('zzz-invoked', 'I'.repeat(400)),
    });

    const activated = resolveActiveSkills({
      available: [giant, invoked],
      explicit: ['zzz-invoked'],
      alwaysActive: ['aaa-pinned-giant'],
    });

    const set = await admitActiveSkills({
      vfs, activated, trust: APPROVED,
      admissionTokens: stepContextLimit({ contextWindow: 4_000, modelOutputLimit: 500 }),
    });

    const byName = new Map(set.active.map(s => [s.name, s]));
    expect(byName.get('zzz-invoked')?.body).toContain('I');
    expect(byName.get('aaa-pinned-giant')?.body).toBeNull();
    expect(vfs.calls.readFile).toEqual([`${WORKSPACE_SKILLS_DIR}/zzz-invoked.md`]);
    // The giant stays visible as a reference-tier pointer.
    expect(renderActiveSkillsSection(set, 'unverified')).toContain(skillViewPath('aaa-pinned-giant'));
  });

  test('every discovered skill is rendered, named in the index, or reachable through a pointer — nothing is lost silently', async () => {
    const whale = `${WORKSPACE_SKILLS_DIR}/whale.md`;
    const files: Record<string, string> = {};
    files[whale] = skillFile('whale', 'W');

    for (let i = 0; i < 12; i++) {
      files[`${WORKSPACE_SKILLS_DIR}/skill-${i}.md`] = skillFile(`skill-${i}`, 'b'.repeat(2_000));
    }

    const vfs = memoryVfs(files, { sizes: { [whale]: 90_000_000 } });
    const admissionTokens = stepContextLimit({ contextWindow: 3_000, modelOutputLimit: 400 });
    const discovery = await discoverSkills(vfs, { admissionTokens });
    const index = admitSkillsIndex(discovery, admissionTokens);

    const activated = resolveActiveSkills({
      available: discovery.skills, explicit: [],
      alwaysActive: discovery.skills.map(s => s.name),
    });

    const set = await admitActiveSkills({
      vfs, activated, admissionTokens: admissionTokens - index.tokens, trust: APPROVED,
    });

    const indexText = renderSkillsIndexSection(index);

    const activeText = renderActiveSkillsSection(set, 'system')
      + renderActiveSkillsSection(set, 'unverified');

    const discovered = [...discovery.skills.map(s => s.name), ...discovery.unread.map(u => u.name)];
    expect(discovered.length).toBe(12 + BUILTIN_SKILLS.length + 1); // 12 authored + the built-ins + the whale

    for (const name of discovered) {
      expect(indexText.includes(`**${name}**`) || activeText.includes(`### ${name}`)).toBe(true);
    }

    // Named plus unreachable is the whole catalogue.
    const named = (indexText.match(/^- \*\*/gm) ?? []).length;
    expect(named + index.omitted).toBe(discovered.length);

    // Every body that missed the cut still says where it is.
    for (const skill of set.active) {
      if (skill.body === null) expect(activeText).toContain(skillViewPath(skill.name));
    }
  });

  test('a built-in body is admitted without any read at all', async () => {
    const vfs = memoryVfs();

    const activated = resolveActiveSkills({
      available: [...BUILTIN_SKILL_HEADERS],
      explicit: [],
      alwaysActive: BUILTIN_SKILL_HEADERS.map(s => s.name),
    });

    const set = await admitActiveSkills({
      vfs, activated, admissionTokens: ROOMY_TOKENS, trust: APPROVED,
    });

    expect(set.active.length).toBe(BUILTIN_SKILL_HEADERS.length);

    for (const skill of set.active) expect(skill.body).toBeTruthy();
    expect(vfs.calls.readFile).toEqual([]);
  });

  test('an over-budget built-in body keeps trusted policy and its activation reason', async () => {
    const vfs = memoryVfs();
    const [builtin] = BUILTIN_SKILL_HEADERS;

    if (!builtin) throw new Error('expected a built-in skill');

    const activated = resolveActiveSkills({
      available: [builtin],
      explicit: [],
      alwaysActive: [builtin.name],
    });

    const set = await admitActiveSkills({
      vfs,
      activated,
      admissionTokens: 0,
      trust: APPROVED,
    });

    expect(set.active[0]?.body).toBeNull();
    expect(set.active[0]?.trust).toBe('builtin');
    expect(set.reasons).toEqual([{ name: builtin.name, reason: { kind: 'always_active', via: 'config' } }]);
    expect(unionAllowedTools(set.active)).toEqual(builtin.allowed_tools);
  });

  test('a window with no room admits nothing and reads nothing, and still counts what exists', async () => {
    const skills = corpus(3, 1_000);
    const { index, set, vfs } = await admitAll(skills, { contextWindow: 0, modelOutputLimit: 0 });
    expect(index.lines).toEqual([]);
    expect(index.omitted).toBe(3);
    expect(set.active.every(s => s.body === null)).toBe(true);
    expect(vfs.calls.readFile).toEqual([]);
  });

  test('a skill whose stat or read throws defers itself instead of failing the turn', async () => {
    const log = createRecordingLogger();
    const restore = setDiagnosticsSink(log);

    try {
      const vfs: SkillsVfs = {
        async exists() { return true; },
        async readFile(p) {
          if (p === `${WORKSPACE_SKILLS_DIR}/bad-read.md`) throw new Error('boom-read');

          return skillFile(p.includes('good') ? 'good' : 'bad-stat', 'hello body');
        },
        async writeFile() {},
        async stat(p) {
          if (p === `${WORKSPACE_SKILLS_DIR}/bad-stat.md`) throw new Error('boom-stat');

          return { size: 60, mtimeMs: 0, isDir: false };
        },
        async readdir() { return []; },
      };

      const activated = ['bad-stat', 'bad-read', 'good'].map((name) => ({
        skill: fakeSkill(name),
        reason: { kind: 'explicit', matched_token: name } as const,
      }));

      const set = await admitActiveSkills({ vfs, activated, admissionTokens: ROOMY_TOKENS, trust: APPROVED });
      const byName = new Map(set.active.map((s) => [s.name, s]));
      expect(set.active.length).toBe(3);
      expect(byName.get('bad-stat')?.body).toBeNull();
      expect(byName.get('bad-stat')?.trust).toBe('unverified');
      expect(byName.get('bad-read')?.body).toBeNull();
      expect(byName.get('bad-read')?.trust).toBe('unverified');
      expect(byName.get('good')?.body).toContain('hello body');
      expect(set.reasons.map((r) => r.name).sort()).toEqual(['bad-read', 'bad-stat', 'good']);
      expect(log.emitted.filter((l) => l.event === 'skills.admission_failed').length).toBe(2);
    } finally {
      restore();
    }
  });
});

/** The agent's file plane as a backend composes it: a memory tree extended by the `/skills` mount. */
function skillsPlane(files: Record<string, string>): VFS {
  const tree = memoryVfs(files);

  const base: VFS = {
    readFile: (path, opts) => tree.readFile(path, opts),
    writeFile: (path, data) => tree.writeFile(path, data),
    readdir: (path) => tree.readdir(path),
    stat: async (path) => (await tree.stat?.(path)) ?? null,
    exists: (path) => tree.exists(path),
    unlink: async (path) => { await tree.unlink?.(path); },
    mkdir: async () => {},
  };

  const plane: VFS = withMountTable(base, [skillsMount(() => plane)]);

  return plane;
}

describe('the /skills view', () => {
  const files = {
    [`${WORKSPACE_SKILLS_DIR}/deploy/SKILL.md`]: skillFile('deploy', 'workspace deploy'),
    [`${WORKSPACE_SKILLS_DIR}/deploy/scripts/run.sh`]: 'echo deploy',
    [`${WORKSPACE_SKILLS_DIR}/slates/SKILL.md`]: skillFile('slates', 'a shadow of the built-in'),
    [`${SHARED_SKILLS_DIR}/deploy/SKILL.md`]: skillFile('deploy', 'drive deploy'),
    [`${SHARED_SKILLS_DIR}/review.md`]: skillFile('review', 'drive review'),
  };

  test('lists one folder per loadable name and serves each from the root the precedence picks', async () => {
    const plane = skillsPlane(files);

    expect(await plane.readdir('/')).toContain('skills');
    expect(await plane.readdir('/skills')).toEqual(['audit-implementation', 'deploy', 'review', 'slates']);
    // A built-in outranks the workspace file that claims its name.
    expect(await plane.readFile(skillViewPath('slates'), { encoding: 'utf8' })).toBe(BUILTIN_SKILL_FILES.slates);
    expect(await plane.readFile(skillViewPath('deploy'), { encoding: 'utf8' })).toBe(files[`${WORKSPACE_SKILLS_DIR}/deploy/SKILL.md`]);
    expect(await plane.readFile('/skills/deploy/scripts/run.sh', { encoding: 'utf8' })).toBe('echo deploy');
    expect(await plane.readFile(skillViewPath('review'), { encoding: 'utf8' })).toBe(files[`${SHARED_SKILLS_DIR}/review.md`]);
    expect(await plane.readdir('/skills/review')).toEqual(['SKILL.md']);
  });

  test('a skill written a moment ago is already there, and a name no root holds is absent by its full path', async () => {
    const plane = skillsPlane(files);
    await plane.writeFile(`${WORKSPACE_SKILLS_DIR}/fresh/SKILL.md`, skillFile('fresh', 'new'));

    expect(await plane.readFile(skillViewPath('fresh'), { encoding: 'utf8' })).toBe(skillFile('fresh', 'new'));
    expect(await plane.exists(skillViewPath('nope'))).toBe(false);
    await expect(plane.readFile(skillViewPath('nope'))).rejects.toThrow("'/skills/nope/SKILL.md'");
  });

  test('every write is refused and names where a skill is written instead', async () => {
    const plane = skillsPlane(files);

    for (const write of [
      () => plane.writeFile(skillViewPath('deploy'), 'replaced'),
      () => plane.writeFile(skillViewPath('slates'), 'replaced'),
      () => plane.unlink(skillViewPath('review')),
    ]) {
      await expect(write()).rejects.toMatchObject({ code: 'EROFS' });
      await expect(write()).rejects.toThrow(`${WORKSPACE_SKILLS_DIR}/<name>/SKILL.md`);
    }

    expect(await plane.readFile(skillViewPath('deploy'), { encoding: 'utf8' })).toBe(files[`${WORKSPACE_SKILLS_DIR}/deploy/SKILL.md`]);
  });
});

describe('a turn\'s skills in its system prompt', () => {
  test('words in a user message load no body, so two turns with no skill change render one system prompt', async () => {
    const vfs = memoryVfs({ [`${WORKSPACE_SKILLS_DIR}/deploy/SKILL.md`]: skillFile('deploy', 'ship it') });

    const turn = (userText: string) => resolveTurnSkills({
      vfs, userText, trust: APPROVED,
      config: { getAlwaysActiveSkills: () => [] },
      limits: { contextWindow: 200_000, modelOutputLimit: 8_000 },
    });

    const { rt } = createTestRuntime();

    const prompt = (surface: TurnSkillSurface) => buildSystemPromptSync(rt, surface.activeSkills === undefined
      ? { availableSkills: surface.available }
      : { availableSkills: surface.available, activeSkills: surface.activeSkills });

    const quiet = await turn('hello');
    const loud = await turn('build me a dashboard, a form and a live view over the slate data');

    expect(loud.activeSkills).toBeUndefined();
    expect(prompt(loud)).toBe(prompt(quiet));
    expect(prompt(quiet)).toContain(skillViewPath('slates'));
  });
});
