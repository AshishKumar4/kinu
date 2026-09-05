/**
 * Skills module — behavior tests through the public surface.
 *
 * Asserts the contract the orchestrator + prompt depend on:
 *   - SKILL.md round-trips through parse → stringify → parse.
 *   - Front-matter validation rejects what the LLM might accidentally generate.
 *   - Discovery has ONE total order, independent of readdir order, and holds no
 *     body: it yields headers plus where each body is and what it would cost.
 *   - Active-skill resolution orders explicit > keyword > always_active, with a
 *     name tiebreak inside each tier.
 *   - The admission spends the model-window allocation (stepContextLimit over
 *     the resolved window and its answer reserve), the index first and the
 *     bodies after, and whatever it cannot fit stays reachable.
 *   - The ambient index (renderSkillsIndexSection) and the active-set render
 *     (renderActiveSkillsSection) print what the admission decided; neither
 *     takes a budget of its own.
 *
 * No `skills` tool and no `skills.*` codemode namespace: read/create/edit/
 * delete are ordinary VFS operations, already reachable via
 * workspace.readFile/writeFile/readdir/exec inside execute_tools — a
 * dedicated CRUD dispatcher would have been a second path to the same bytes.
 *
 * No mocking of internal helpers — uses an in-memory SkillsVfs that is the same
 * shape the workspace filesystem exposes, and which records what it was asked
 * for, so "no body was read" is an observation rather than a claim. Built-in
 * skills come from BUILTIN_SKILLS, not stubs.
 */

import { describe, expect, test } from 'bun:test';
import { stepContextLimit } from '../prompting/step-prune';
import { estimateTokens } from '../llm';
import {
  parseSkillFile, stringifySkillFile, validateSkillName,
  discoverSkills, BUILTIN_SKILLS, BUILTIN_SKILL_HEADERS,
  resolveActiveSkills, extractExplicitInvocations,
  admitSkillsIndex, admitActiveSkills,
  renderActiveSkillsSection, renderSkillsIndexSection, unionAllowedTools, toolAllowedBySkills,
  SkillError, SKILLS_DIR,
  type SkillsVfs, type ActiveSkill, type DiscoveredSkill,
} from './index';
import type { InstructionTrustResolver } from '../safety/instruction-trust';

// ── In-memory SkillsVfs fixture ──────────────────────────────────

/** Every path the VFS was asked for, in order. The `readFile` list is what
 *  proves a body was — or was not — fetched. */
interface VfsCalls { readFile: string[]; stat: string[]; readdir: string[] }

interface MemoryVfs extends SkillsVfs { calls: VfsCalls }

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
        const rest = k.slice(prefix.length);
        if (rest.includes('/')) continue;
        out.push(rest);
      }
      return opts.entryOrder ? opts.entryOrder(out) : out;
    },
    async unlink(p) { files.delete(p); },
    async mkdir() { /* no-op for memory fs */ },
  };
}

/** A window with room to spare. "Generous" here is a window, never a char count
 *  — there is no cap left to turn up. */
const ROOMY_TOKENS = stepContextLimit({ contextWindow: 200_000, modelOutputLimit: 8_000 });

function skillFile(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: desc ${name}\n---\n${body}`;
}

/** A discovered skill: header plus where its body is. `chars` is what admitting
 *  that body would cost, which is all the admission needs to decide. */
function fakeSkill(name: string, opts: Partial<ActiveSkill> = {}): DiscoveredSkill {
  const body = opts.body ?? 'body';
  return {
    name,
    description: opts.description ?? `desc ${name}`,
    allowed_tools: opts.allowed_tools ?? [],
    keywords: opts.keywords ?? [],
    auto_activate: opts.auto_activate ?? false,
    disable_model_invocation: opts.disable_model_invocation ?? false,
    user_invocable: opts.user_invocable ?? true,
    bodyRef: opts.bodyRef ?? { kind: 'file', path: `${SKILLS_DIR}/${name}.md`, chars: body.length },
    ext: {},
    source: 'vfs',
  };
}

/** The owner's answer for every body admitted below. These tests are about
 *  what the allocation pays for and what the system tier renders, so they stand
 *  on an approval rather than re-deciding one per call. */
const APPROVED: InstructionTrustResolver = () => 'approved';

/** An active skill whose body the admission paid for. */
function activeSkill(name: string, opts: Partial<ActiveSkill> = {}): ActiveSkill {
  return { ...fakeSkill(name, opts), trust: 'approved', body: opts.body ?? 'body' };
}

// ── parser ───────────────────────────────────────────────────────

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
    expect(r.skill.keywords).toEqual([]);
    expect(r.skill.auto_activate).toBe(false);
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
    // agentskills.io/specification's own example value: ONE scalar string of
    // space-separated tools, not a YAML list. Treating the whole string as a
    // single pattern (the bug this guards) produces a pattern that matches no
    // real tool name, collapsing the restricted surface to nothing.
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

  test('parses disable-model-invocation and coerces auto_activate to false', () => {
    const r = parseSkillFile(`---
name: locked
description: x
keywords: [foo]
auto_activate: true
disable-model-invocation: true
---
body
`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.disable_model_invocation).toBe(true);
    // Coerced false because disable_model_invocation overrides.
    expect(r.skill.auto_activate).toBe(false);
  });

  test('parses user-invocable: false', () => {
    const r = parseSkillFile(`---
name: ops-only
description: x
user-invocable: false
---
body
`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.skill.user_invocable).toBe(false);
  });

  test('defaults user_invocable to true', () => {
    const r = parseSkillFile(`---
name: normal
description: x
---
body
`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.skill.user_invocable).toBe(true);
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

  test('lowercases keywords for case-insensitive matching', () => {
    const r = parseSkillFile(`---
name: x
description: x
keywords: [Audit, REVIEW, refactor]
---
body
`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.skill.keywords).toEqual(['audit', 'review', 'refactor']);
  });

  test('round-trips parse → stringify → parse', () => {
    const original = parseSkillFile(`---
name: round-trip
description: A skill that survives serialization.
allowed-tools: [run, memory]
keywords: [round, trip]
auto_activate: true
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
    expect(reparsed.skill.keywords).toEqual(original.skill.keywords);
    expect(reparsed.skill.auto_activate).toBe(original.skill.auto_activate);
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

describe('validateSkillName', () => {
  test('accepts kebab-case', () => {
    expect(() => validateSkillName('audit-implementation')).not.toThrow();
    expect(() => validateSkillName('a')).not.toThrow();
    expect(() => validateSkillName('foo-bar-baz123')).not.toThrow();
  });

  test('rejects everything else', () => {
    expect(() => validateSkillName('FooBar')).toThrow(SkillError);
    expect(() => validateSkillName('foo_bar')).toThrow(SkillError);
    expect(() => validateSkillName('-foo')).toThrow(SkillError);
    expect(() => validateSkillName('foo-')).toThrow(SkillError);
    expect(() => validateSkillName('foo bar')).toThrow(SkillError);
    expect(() => validateSkillName('')).toThrow(SkillError);
  });
});

// ── explicit invocations ─────────────────────────────────────────

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

// ── active resolution ────────────────────────────────────────────

describe('resolveActiveSkills', () => {
  test('explicit invocation activates', () => {
    const set = resolveActiveSkills({
      available: [fakeSkill('a')], explicit: ['a'], userMessage: '', alwaysActive: [],
    });
    expect(set.map(a => a.skill.name)).toEqual(['a']);
    expect(set[0]?.reason.kind).toBe('explicit');
  });

  test('explicit invocation that does not match any skill is silently dropped', () => {
    const set = resolveActiveSkills({
      available: [fakeSkill('a')], explicit: ['nonexistent'], userMessage: '', alwaysActive: [],
    });
    expect(set).toEqual([]);
  });

  test('keyword auto-activation requires auto_activate: true', () => {
    const a = fakeSkill('a', { keywords: ['audit'], auto_activate: true });
    const b = fakeSkill('b', { keywords: ['audit'], auto_activate: false });
    const set = resolveActiveSkills({
      available: [a, b], explicit: [], userMessage: 'please audit my code', alwaysActive: [],
    });
    const names = set.map(s => s.skill.name);
    expect(names).toContain('a');
    expect(names).not.toContain('b');
  });

  test('keyword match is whole-word (no substring traps)', () => {
    const a = fakeSkill('a', { keywords: ['audit'], auto_activate: true });
    const set = resolveActiveSkills({
      available: [a], explicit: [], userMessage: 'auditorium', alwaysActive: [],
    });
    expect(set).toEqual([]);
  });

  test('always_active activates when the skill exists', () => {
    const set = resolveActiveSkills({
      available: [fakeSkill('a')], explicit: [], userMessage: '', alwaysActive: ['a'],
    });
    expect(set.map(a => a.skill.name)).toEqual(['a']);
    expect(set[0]?.reason.kind).toBe('always_active');
  });

  test('explicit overrides keyword and always_active reasons', () => {
    const a = fakeSkill('a', { keywords: ['audit'], auto_activate: true });
    const set = resolveActiveSkills({
      available: [a], explicit: ['a'], userMessage: 'audit please', alwaysActive: ['a'],
    });
    expect(set[0]?.reason.kind).toBe('explicit');
  });

  test('the same skill cannot be activated twice', () => {
    const a = fakeSkill('a', { keywords: ['audit'], auto_activate: true });
    const set = resolveActiveSkills({
      available: [a], explicit: ['a'], userMessage: 'audit', alwaysActive: ['a'],
    });
    expect(set.length).toBe(1);
  });

  test('disable_model_invocation blocks keyword auto-fire even when keywords match', () => {
    const a = fakeSkill('a', {
      keywords: ['audit'], auto_activate: true, disable_model_invocation: true,
    });
    const set = resolveActiveSkills({
      available: [a], explicit: [], userMessage: 'please audit my code', alwaysActive: [],
    });
    expect(set).toEqual([]);
  });

  test('disable_model_invocation does NOT block explicit user invocation', () => {
    const a = fakeSkill('a', { disable_model_invocation: true });
    const set = resolveActiveSkills({
      available: [a], explicit: ['a'], userMessage: '/a', alwaysActive: [],
    });
    expect(set.map(s => s.skill.name)).toEqual(['a']);
    expect(set[0]?.reason.kind).toBe('explicit');
  });

  test('user_invocable: false blocks /skill-name explicit invocation', () => {
    const a = fakeSkill('a', { user_invocable: false });
    const set = resolveActiveSkills({
      available: [a], explicit: ['a'], userMessage: '/a', alwaysActive: [],
    });
    expect(set).toEqual([]);
  });

  test('user_invocable: false does NOT block always-active activation', () => {
    const a = fakeSkill('a', { user_invocable: false });
    const set = resolveActiveSkills({
      available: [a], explicit: [], userMessage: '', alwaysActive: ['a'],
    });
    expect(set.map(s => s.skill.name)).toEqual(['a']);
    expect(set[0]?.reason.kind).toBe('always_active');
  });

  test('activation ORDER is explicit, then keyword, then always-active — the order the admission spends in', () => {
    const pinned = fakeSkill('aaa-pinned');
    const keyword = fakeSkill('bbb-keyword', { keywords: ['ship'], auto_activate: true });
    const invoked = fakeSkill('zzz-invoked');
    const set = resolveActiveSkills({
      available: [pinned, keyword, invoked],
      explicit: ['zzz-invoked'],
      userMessage: '/zzz-invoked time to ship',
      alwaysActive: ['aaa-pinned'],
    });
    // Alphabetically the pinned skill leads; by priority it comes last.
    expect(set.map(s => s.skill.name)).toEqual(['zzz-invoked', 'bbb-keyword', 'aaa-pinned']);
  });

  test('inside one tier the order is by name, whatever order the tier arrived in', () => {
    const available = [fakeSkill('m'), fakeSkill('a'), fakeSkill('z')];
    const forward = resolveActiveSkills({
      available, explicit: [], userMessage: '', alwaysActive: ['z', 'a', 'm'],
    });
    const reversed = resolveActiveSkills({
      available: [...available].reverse(), explicit: [], userMessage: '', alwaysActive: ['m', 'a', 'z'],
    });
    expect(forward.map(s => s.skill.name)).toEqual(['a', 'm', 'z']);
    expect(reversed.map(s => s.skill.name)).toEqual(['a', 'm', 'z']);
  });
});

// ── render + tool gating ─────────────────────────────────────────

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

  test('a deferred body renders its header, its cost and a pointer — never half a workflow', () => {
    const deferred: ActiveSkill = {
      ...fakeSkill('giant', { bodyRef: { kind: 'file', path: `${SKILLS_DIR}/giant.md`, chars: 50_000 } }),
      // The only trust an unread file body can have: there are no bytes to
      // approve, so its pointer is reference material.
      trust: 'unverified',
      body: null,
    };
    const out = renderActiveSkillsSection({
      active: [deferred],
      reasons: [{ name: 'giant', reason: { kind: 'explicit', matched_token: 'giant' } }],
    }, 'unverified');
    expect(out).toContain('### giant (explicit /giant)');
    expect(out).toContain('(50000 chars)');
    expect(out).toContain(`read it with workspace.readFile("${SKILLS_DIR}/giant.md")`);
    expect(out).not.toContain('[truncated:');
  });

  test('a deferred BUILT-IN body says there is no path rather than naming a file that does not exist', () => {
    const builtin: ActiveSkill = {
      ...fakeSkill('shipped', { bodyRef: { kind: 'builtin', text: 'B'.repeat(400) } }),
      trust: 'builtin',
      body: null,
    };
    const out = renderActiveSkillsSection({ active: [builtin], reasons: [] }, 'system');
    expect(out).toContain('built in and has no VFS path');
    expect(out).not.toContain('workspace.readFile');
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
      unread: [],
    }, ROOMY_TOKENS));
    expect(out).toContain('## Skills');
    // File descriptions are agent-writable bytes. The system index names a
    // validated filename but never embeds that prose before owner approval.
    expect(out).toContain('**alpha** (workspace skill; contents are reference material until the owner approves them)');
    expect(out).toContain('**zeta** (workspace skill; contents are reference material until the owner approves them)');
    expect(out.indexOf('alpha')).toBeLessThan(out.indexOf('zeta'));
    expect(out).not.toContain('desc alpha');
    expect(out).not.toContain('desc zeta');
    expect(out).not.toContain('ZETA-BODY-SHOULD-NOT-APPEAR');
    expect(out).not.toContain('ALPHA-BODY-SHOULD-NOT-APPEAR');
  });

  test('a file too big to open is still named, with its size and its path', () => {
    const out = renderSkillsIndexSection(admitSkillsIndex({
      skills: [],
      unread: [{ name: 'huge', path: `${SKILLS_DIR}/huge.md`, bytes: 4_000_000 }],
    }, ROOMY_TOKENS));
    expect(out).toContain('**huge**');
    expect(out).toContain('4000000 bytes');
    expect(out).toContain(`workspace.readFile("${SKILLS_DIR}/huge.md")`);
  });

  test('elides under allocation pressure with an honest count and where to look, never a silent cut', () => {
    const skills = Array.from({ length: 50 }, (_, i) =>
      fakeSkill(`skill-${String(i).padStart(2, '0')}`, { description: 'd'.repeat(150) }));
    // A small window is the only way to squeeze the index now — there is no char
    // cap left to turn down.
    const index = admitSkillsIndex({ skills, unread: [] },
      stepContextLimit({ contextWindow: 2_000, modelOutputLimit: 1_000 }));
    const out = renderSkillsIndexSection(index);
    expect(out).toMatch(/… and \d+ more skills? this turn's skills allocation did not reach/);
    expect(out).toContain(`workspace.readdir("${SKILLS_DIR}")`);
    // At least one entry survives, and the omitted count is honest (not "0").
    const shown = (out.match(/^- \*\*/gm) ?? []).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(skills.length);
    expect(index.omitted).toBe(skills.length - shown);
  });

  test('a roomy window names every skill', () => {
    const skills = Array.from({ length: 5 }, (_, i) => fakeSkill(`skill-${i}`));
    const out = renderSkillsIndexSection(admitSkillsIndex({ skills, unread: [] }, ROOMY_TOKENS));
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

// ── discover ─────────────────────────────────────────────────────

describe('discoverSkills', () => {
  test('returns built-ins when VFS is empty', async () => {
    const v = memoryVfs();
    const found = await discoverSkills(v, { admissionTokens: ROOMY_TOKENS });
    const names = found.skills.map(s => s.name);
    expect(names).toContain('audit-implementation');
    for (const b of BUILTIN_SKILLS) expect(names).toContain(b.name);
    // A built-in body is already in memory, so nothing was read for it.
    expect(v.calls.readFile).toEqual([]);
  });

  test('skips malformed files via onParseError instead of throwing', async () => {
    const errors: Array<{ path: string; err: string }> = [];
    const v = memoryVfs({
      [`${SKILLS_DIR}/good.md`]: skillFile('good', 'body'),
      [`${SKILLS_DIR}/bad.md`]: `not a valid skill file at all`,
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
      [`${SKILLS_DIR}/wrong-filename.md`]: `---\nname: actual-name\ndescription: ok\n---\nbody`,
    });
    const errors: string[] = [];
    const found = await discoverSkills(v, {
      admissionTokens: ROOMY_TOKENS, onParseError: (_p, e) => errors.push(e),
    });
    expect(found.skills.find(s => s.name === 'actual-name')).toBeFalsy();
    expect(errors.some(e => e.includes('does not match'))).toBe(true);
  });

  test('an illegal filename stem is rejected without opening the file', async () => {
    const v = memoryVfs({ [`${SKILLS_DIR}/Not_A_Skill.md`]: skillFile('x', 'body') });
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
      [`${SKILLS_DIR}/mid.md`]: skillFile('mid', 'M'),
      [`${SKILLS_DIR}/apex.md`]: skillFile('apex', 'A'),
      [`${SKILLS_DIR}/zulu.md`]: skillFile('zulu', 'Z'),
    };
    const views = [
      memoryVfs(files, { entryOrder: (n) => [...n].sort() }),
      memoryVfs(files, { entryOrder: (n) => [...n].sort().reverse() }),
      memoryVfs(files, { entryOrder: (n) => [n[1]!, n[2]!, n[0]!] }),
    ];
    const orders = await Promise.all(views.map(async (v) => {
      const found = await discoverSkills(v, { admissionTokens: ROOMY_TOKENS });
      return {
        names: found.skills.map(s => s.name),
        rendered: renderSkillsIndexSection(admitSkillsIndex(found, ROOMY_TOKENS)),
      };
    }));
    expect(orders[0]!.names).toEqual(['apex', 'audit-implementation', 'mid', 'zulu']);
    for (const o of orders) {
      expect(o.names).toEqual(orders[0]!.names);
      expect(o.rendered).toBe(orders[0]!.rendered);
    }
  });

  test('holds front matter only: no discovered skill carries a body, and the catalogue costs one read per file', async () => {
    const v = memoryVfs({
      [`${SKILLS_DIR}/one.md`]: skillFile('one', 'BODY-ONE'),
      [`${SKILLS_DIR}/two.md`]: skillFile('two', 'BODY-TWO'),
    });
    const found = await discoverSkills(v, { admissionTokens: ROOMY_TOKENS });
    for (const skill of found.skills) expect('body' in skill).toBe(false);
    expect(v.calls.readFile.sort()).toEqual([`${SKILLS_DIR}/one.md`, `${SKILLS_DIR}/two.md`]);
    // Size is consulted before bytes, for every candidate.
    expect(v.calls.stat.sort()).toEqual([`${SKILLS_DIR}/one.md`, `${SKILLS_DIR}/two.md`]);
    const one = found.skills.find(s => s.name === 'one');
    expect(one?.bodyRef).toEqual({ kind: 'file', path: `${SKILLS_DIR}/one.md`, chars: 'BODY-ONE'.length });
  });

  test('a file whose reported size alone exceeds the allocation is named from its filename and never opened', async () => {
    const path = `${SKILLS_DIR}/whale.md`;
    const v = memoryVfs(
      { [path]: skillFile('whale', 'W'), [`${SKILLS_DIR}/minnow.md`]: skillFile('minnow', 'm') },
      { sizes: { [path]: 40_000_000 } },
    );
    const found = await discoverSkills(v, { admissionTokens: ROOMY_TOKENS });
    expect(found.unread).toEqual([{ name: 'whale', path, bytes: 40_000_000 }]);
    expect(found.skills.map(s => s.name)).not.toContain('whale');
    expect(v.calls.stat).toContain(path);
    expect(v.calls.readFile).not.toContain(path);
    // The small one beside it was read normally.
    expect(v.calls.readFile).toContain(`${SKILLS_DIR}/minnow.md`);
  });
});

// ── the model-window admission ───────────────────────────────────

describe('skills admission', () => {
  function corpus(count: number, bodyChars: number): DiscoveredSkill[] {
    return Array.from({ length: count }, (_, i) => {
      const name = `skill-${String(i).padStart(2, '0')}`;
      return fakeSkill(name, {
        bodyRef: { kind: 'file', path: `${SKILLS_DIR}/${name}.md`, chars: bodyChars },
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
    const index = admitSkillsIndex({ skills, unread: [] }, admissionTokens);
    const activated = resolveActiveSkills({
      available: skills, explicit: [], userMessage: '', alwaysActive: skills.map(s => s.name),
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
    // The derivation, not a percentage: what was admitted fits the allocation
    // the step pipeline hands every request-bound producer.
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
    // Nothing was dropped: every activated skill is still in the set, the
    // deferred ones with a null body and a pointer — in the reference tier,
    // because an unread body has no bytes for the owner to have approved.
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
      bodyRef: { kind: 'file', path: `${SKILLS_DIR}/aaa-pinned-giant.md`, chars: 30_000 },
    });
    const invoked = fakeSkill('zzz-invoked', {
      bodyRef: { kind: 'file', path: `${SKILLS_DIR}/zzz-invoked.md`, chars: 400 },
    });
    const vfs = memoryVfs({
      [`${SKILLS_DIR}/aaa-pinned-giant.md`]: skillFile('aaa-pinned-giant', 'G'.repeat(30_000)),
      [`${SKILLS_DIR}/zzz-invoked.md`]: skillFile('zzz-invoked', 'I'.repeat(400)),
    });
    const activated = resolveActiveSkills({
      available: [giant, invoked],
      explicit: ['zzz-invoked'],
      userMessage: '/zzz-invoked',
      alwaysActive: ['aaa-pinned-giant'],
    });
    const set = await admitActiveSkills({
      vfs, activated, trust: APPROVED,
      admissionTokens: stepContextLimit({ contextWindow: 4_000, modelOutputLimit: 500 }),
    });
    const byName = new Map(set.active.map(s => [s.name, s]));
    expect(byName.get('zzz-invoked')?.body).toContain('I');
    expect(byName.get('aaa-pinned-giant')?.body).toBeNull();
    expect(vfs.calls.readFile).toEqual([`${SKILLS_DIR}/zzz-invoked.md`]);
    // …and the giant is still visible, with a pointer to its bytes — as
    // reference material, since nothing was read for the owner to approve.
    expect(renderActiveSkillsSection(set, 'unverified'))
      .toContain(`read it with workspace.readFile("${SKILLS_DIR}/aaa-pinned-giant.md")`);
  });

  test('every discovered skill is rendered, named in the index, or reachable through a pointer — nothing is lost silently', async () => {
    const whale = `${SKILLS_DIR}/whale.md`;
    const files: Record<string, string> = {};
    files[whale] = skillFile('whale', 'W');
    for (let i = 0; i < 12; i++) {
      files[`${SKILLS_DIR}/skill-${i}.md`] = skillFile(`skill-${i}`, 'b'.repeat(2_000));
    }
    const vfs = memoryVfs(files, { sizes: { [whale]: 90_000_000 } });
    const admissionTokens = stepContextLimit({ contextWindow: 3_000, modelOutputLimit: 400 });
    const discovery = await discoverSkills(vfs, { admissionTokens });
    const index = admitSkillsIndex(discovery, admissionTokens);
    const activated = resolveActiveSkills({
      available: discovery.skills, explicit: [], userMessage: '',
      alwaysActive: discovery.skills.map(s => s.name),
    });
    const set = await admitActiveSkills({
      vfs, activated, admissionTokens: admissionTokens - index.tokens, trust: APPROVED,
    });

    const indexText = renderSkillsIndexSection(index);
    const activeText = renderActiveSkillsSection(set, 'system')
      + renderActiveSkillsSection(set, 'unverified');
    const discovered = [...discovery.skills.map(s => s.name), ...discovery.unread.map(u => u.name)];
    expect(discovered.length).toBe(14); // 12 authored + the built-in + the whale
    for (const name of discovered) {
      expect(indexText.includes(`**${name}**`) || activeText.includes(`### ${name}`)).toBe(true);
    }
    // The index accounts for every discovered skill: what it named plus what it
    // says it could not reach is the whole catalogue, never a shorter list.
    const named = (indexText.match(/^- \*\*/gm) ?? []).length;
    expect(named + index.omitted).toBe(discovered.length);
    // Every body that missed the cut still says where it is.
    for (const skill of set.active) {
      if (skill.body !== null) continue;
      expect(activeText).toContain(skill.bodyRef.kind === 'file'
        ? `workspace.readFile("${skill.bodyRef.path}")`
        : 'has no VFS path');
    }
  });

  test('a built-in body is admitted without any read at all', async () => {
    const vfs = memoryVfs();
    const activated = resolveActiveSkills({
      available: [...BUILTIN_SKILL_HEADERS],
      explicit: [],
      userMessage: '',
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
      userMessage: '',
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
});
