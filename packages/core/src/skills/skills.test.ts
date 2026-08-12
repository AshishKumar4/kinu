/**
 * Skills module — behavior tests through the public surface.
 *
 * Asserts the contract the orchestrator + prompt depend on:
 *   - SKILL.md round-trips through parse → stringify → parse.
 *   - Front-matter validation rejects what the LLM might accidentally generate.
 *   - Active-skill resolution picks explicit > keyword > always_active.
 *   - VFS-stored skills shadow built-ins of the same name.
 *   - The ambient index (renderSkillsIndexSection) and the active-set render
 *     (renderActiveSkillsSection) cover discovery and activation respectively.
 *
 * No `skills` tool and no `skills.*` codemode namespace: read/create/edit/
 * delete are ordinary VFS operations, already reachable via
 * workspace.readFile/writeFile/readdir/exec inside execute_tools — a
 * dedicated CRUD dispatcher would have been a second path to the same bytes.
 *
 * No mocking of internal helpers — uses an in-memory SkillsVfs that's the
 * same shape the workspace filesystem exposes. Built-in skills come from BUILTIN_SKILLS,
 * not stubs.
 */

import { describe, expect, test } from 'bun:test';
import {
  parseSkillFile, stringifySkillFile, validateSkillName,
  discoverSkills, BUILTIN_SKILLS,
  resolveActiveSkills, extractExplicitInvocations,
  renderActiveSkillsSection, renderSkillsIndexSection, unionAllowedTools, toolAllowedBySkills,
  ACTIVE_SKILLS_MAX_CHARS,
  SkillError, SKILLS_DIR,
  type SkillsVfs, type ParsedSkill,
} from './index.js';

// ── In-memory SkillsVfs fixture ──────────────────────────────────

function memoryVfs(initial: Record<string, string> = {}): SkillsVfs {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    async exists(p) { return files.has(p); },
    async readFile(p) {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    async writeFile(p, data) {
      files.set(p, typeof data === 'string' ? data : new TextDecoder().decode(data));
    },
    async readdir(p) {
      const prefix = p.replace(/\/$/, '') + '/';
      const out: string[] = [];
      for (const k of files.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (rest.includes('/')) continue;
        out.push(rest);
      }
      return out;
    },
    async unlink(p) { files.delete(p); },
    async mkdir() { /* no-op for memory fs */ },
  };
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

function fakeSkill(name: string, opts: Partial<ParsedSkill> = {}): ParsedSkill {
  return {
    name, description: `desc ${name}`,
    allowed_tools: opts.allowed_tools ?? [],
    keywords: opts.keywords ?? [],
    auto_activate: opts.auto_activate ?? false,
    disable_model_invocation: opts.disable_model_invocation ?? false,
    user_invocable: opts.user_invocable ?? true,
    body: opts.body ?? 'body',
    ext: {},
    source: 'vfs',
  };
}

describe('resolveActiveSkills', () => {
  test('explicit invocation activates', () => {
    const a = fakeSkill('a');
    const set = resolveActiveSkills({
      available: [a], explicit: ['a'], userMessage: '', alwaysActive: [],
    });
    expect(set.active.map(s => s.name)).toEqual(['a']);
    expect(set.reasons[0]?.reason.kind).toBe('explicit');
  });

  test('explicit invocation that does not match any skill is silently dropped', () => {
    const a = fakeSkill('a');
    const set = resolveActiveSkills({
      available: [a], explicit: ['nonexistent'], userMessage: '', alwaysActive: [],
    });
    expect(set.active).toEqual([]);
  });

  test('keyword auto-activation requires auto_activate: true', () => {
    const a = fakeSkill('a', { keywords: ['audit'], auto_activate: true });
    const b = fakeSkill('b', { keywords: ['audit'], auto_activate: false });
    const set = resolveActiveSkills({
      available: [a, b], explicit: [], userMessage: 'please audit my code', alwaysActive: [],
    });
    const names = set.active.map(s => s.name);
    expect(names).toContain('a');
    expect(names).not.toContain('b');
  });

  test('keyword match is whole-word (no substring traps)', () => {
    const a = fakeSkill('a', { keywords: ['audit'], auto_activate: true });
    const set = resolveActiveSkills({
      available: [a], explicit: [], userMessage: 'auditorium', alwaysActive: [],
    });
    expect(set.active).toEqual([]);
  });

  test('always_active activates when the skill exists', () => {
    const a = fakeSkill('a');
    const set = resolveActiveSkills({
      available: [a], explicit: [], userMessage: '', alwaysActive: ['a'],
    });
    expect(set.active.map(s => s.name)).toEqual(['a']);
    expect(set.reasons[0]?.reason.kind).toBe('always_active');
  });

  test('explicit overrides keyword and always_active reasons', () => {
    const a = fakeSkill('a', { keywords: ['audit'], auto_activate: true });
    const set = resolveActiveSkills({
      available: [a], explicit: ['a'], userMessage: 'audit please', alwaysActive: ['a'],
    });
    expect(set.reasons[0]?.reason.kind).toBe('explicit');
  });

  test('the same skill cannot be activated twice', () => {
    const a = fakeSkill('a', { keywords: ['audit'], auto_activate: true });
    const set = resolveActiveSkills({
      available: [a], explicit: ['a'], userMessage: 'audit', alwaysActive: ['a'],
    });
    expect(set.active.length).toBe(1);
  });

  test('disable_model_invocation blocks keyword auto-fire even when keywords match', () => {
    const a = fakeSkill('a', {
      keywords: ['audit'], auto_activate: true, disable_model_invocation: true,
    });
    const set = resolveActiveSkills({
      available: [a], explicit: [], userMessage: 'please audit my code', alwaysActive: [],
    });
    expect(set.active).toEqual([]);
  });

  test('disable_model_invocation does NOT block explicit user invocation', () => {
    const a = fakeSkill('a', { disable_model_invocation: true });
    const set = resolveActiveSkills({
      available: [a], explicit: ['a'], userMessage: '/a', alwaysActive: [],
    });
    expect(set.active.map(s => s.name)).toEqual(['a']);
    expect(set.reasons[0]?.reason.kind).toBe('explicit');
  });

  test('user_invocable: false blocks /skill-name explicit invocation', () => {
    const a = fakeSkill('a', { user_invocable: false });
    const set = resolveActiveSkills({
      available: [a], explicit: ['a'], userMessage: '/a', alwaysActive: [],
    });
    expect(set.active).toEqual([]);
  });

  test('user_invocable: false does NOT block always-active activation', () => {
    const a = fakeSkill('a', { user_invocable: false });
    const set = resolveActiveSkills({
      available: [a], explicit: [], userMessage: '', alwaysActive: ['a'],
    });
    expect(set.active.map(s => s.name)).toEqual(['a']);
    expect(set.reasons[0]?.reason.kind).toBe('always_active');
  });
});

// ── render + tool gating ─────────────────────────────────────────

describe('renderActiveSkillsSection + tool gating', () => {
  test('returns empty string for empty active set', () => {
    expect(renderActiveSkillsSection({ active: [], reasons: [] })).toBe('');
  });

  test('renders the skill body and a "tool surface restricted" line when allow_tools is non-empty', () => {
    const a = fakeSkill('a', { allowed_tools: ['run', 'memory'] });
    const out = renderActiveSkillsSection({
      active: [a],
      reasons: [{ name: 'a', reason: { kind: 'explicit', matched_token: 'a' } }],
    });
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

  test('caps total skill-body chars: oversized body truncates with a read pointer', () => {
    const big = fakeSkill('giant', { body: 'x'.repeat(ACTIVE_SKILLS_MAX_CHARS + 5_000) });
    const out = renderActiveSkillsSection({
      active: [big],
      reasons: [{ name: 'giant', reason: { kind: 'explicit', matched_token: 'giant' } }],
    });
    expect(out.length).toBeLessThan(ACTIVE_SKILLS_MAX_CHARS + 1_000); // body capped + framing
    expect(out).toContain('### giant');
    expect(out).toMatch(/\[truncated: 5000 more chars — read the full body with workspace\.readFile\("\/workspace\/skills\/giant\.md"\)\]/);
  });

  test('budget spends in activation order: earlier skills keep their bodies', () => {
    const first = fakeSkill('first', { body: 'FIRST-BODY '.repeat(40) });
    const hog = fakeSkill('hog', { body: 'y'.repeat(50_000) });
    const last = fakeSkill('last', { body: 'LAST-BODY', allowed_tools: ['memory'] });
    const out = renderActiveSkillsSection({
      active: [first, hog, last],
      reasons: [
        { name: 'first', reason: { kind: 'always_active', via: 'config' } },
        { name: 'hog', reason: { kind: 'keyword', matched_keyword: 'hog' } },
        { name: 'last', reason: { kind: 'keyword', matched_keyword: 'last' } },
      ],
    });
    // First skill intact; the hog absorbs the truncation; the last skill keeps
    // its header + read pointer (and its tool restriction still announces).
    expect(out).toContain('FIRST-BODY');
    expect(out).toContain('[truncated:');
    expect(out).not.toContain('LAST-BODY');
    expect(out).toContain('### last (keyword "last")');
    expect(out).toContain('(body omitted by the size cap — read the full body with workspace.readFile("/workspace/skills/last.md"))');
    expect(out).toContain('restricted to: memory');
  });

  test('small bodies render unchanged under the cap', () => {
    const a = fakeSkill('a', { body: 'short body' });
    const out = renderActiveSkillsSection({
      active: [a],
      reasons: [{ name: 'a', reason: { kind: 'explicit', matched_token: 'a' } }],
    });
    expect(out).toContain('short body');
    expect(out).not.toContain('[truncated:');
    expect(out).not.toContain('omitted by the size cap');
  });
});

describe('renderSkillsIndexSection', () => {
  test('returns empty string when nothing is available', () => {
    expect(renderSkillsIndexSection([])).toBe('');
  });

  test('lists every skill by name + description, sorted, with no body', () => {
    const a = fakeSkill('zeta', { body: 'ZETA-BODY-SHOULD-NOT-APPEAR' });
    const b = fakeSkill('alpha', { body: 'ALPHA-BODY-SHOULD-NOT-APPEAR' });
    const out = renderSkillsIndexSection([a, b]);
    expect(out).toContain('## Skills');
    expect(out).toContain('**alpha** — desc alpha');
    expect(out).toContain('**zeta** — desc zeta');
    // Sorted alphabetically regardless of input order.
    expect(out.indexOf('alpha')).toBeLessThan(out.indexOf('zeta'));
    // Progressive disclosure: the index is name + description only.
    expect(out).not.toContain('ZETA-BODY-SHOULD-NOT-APPEAR');
    expect(out).not.toContain('ALPHA-BODY-SHOULD-NOT-APPEAR');
  });

  test('clips an oversized description per entry', () => {
    const withLongDesc: ParsedSkill = { ...fakeSkill('a'), description: 'x'.repeat(500) };
    const out = renderSkillsIndexSection([withLongDesc]);
    expect(out).toContain('…');
    expect(out.length).toBeLessThan(600);
  });

  test('elides under budget pressure with an honest count, never a silent cut', () => {
    const skills = Array.from({ length: 50 }, (_, i) =>
      fakeSkill(`skill-${String(i).padStart(2, '0')}`, { description: 'd'.repeat(150) }));
    const out = renderSkillsIndexSection(skills, 1_000);
    expect(out).toContain('more skill');
    expect(out).toMatch(/… and \d+ more skills? not shown/);
    // At least one entry survives, and the omitted count is honest (not "0").
    const shown = (out.match(/^- \*\*/gm) ?? []).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(skills.length);
  });

  test('fits comfortably under the default budget with a handful of skills', () => {
    const skills = Array.from({ length: 5 }, (_, i) => fakeSkill(`skill-${i}`));
    const out = renderSkillsIndexSection(skills);
    expect(out).not.toContain('more skill');
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

// ── discover + tool ──────────────────────────────────────────────

describe('discoverSkills', () => {
  test('returns built-ins when VFS is empty', async () => {
    const v = memoryVfs();
    const found = await discoverSkills(v);
    // Should include audit-implementation as a built-in.
    const names = found.map(s => s.name);
    expect(names).toContain('audit-implementation');
    for (const b of BUILTIN_SKILLS) expect(names).toContain(b.name);
  });

  test('VFS skill shadows a built-in of the same name', async () => {
    const overrideBody = '# Overridden\n\nNew body.\n';
    const overrideSrc = `---
name: audit-implementation
description: My override of the audit skill.
---

${overrideBody}`;
    const v = memoryVfs({
      [`${SKILLS_DIR}/audit-implementation.md`]: overrideSrc,
    });
    const found = await discoverSkills(v);
    const audit = found.find(s => s.name === 'audit-implementation');
    expect(audit?.description).toBe('My override of the audit skill.');
    expect(audit?.source).toBe('vfs');
  });

  test('skips malformed files via onParseError instead of throwing', async () => {
    const errors: Array<{ path: string; err: string }> = [];
    const v = memoryVfs({
      [`${SKILLS_DIR}/good.md`]: `---\nname: good\ndescription: ok\n---\nbody`,
      [`${SKILLS_DIR}/bad.md`]: `not a valid skill file at all`,
    });
    const found = await discoverSkills(v, {
      onParseError: (path, err) => errors.push({ path, err }),
    });
    expect(found.find(s => s.name === 'good')).toBeTruthy();
    expect(errors.length).toBeGreaterThan(0);
  });

  test('mismatched filename vs frontmatter name is rejected', async () => {
    const v = memoryVfs({
      [`${SKILLS_DIR}/wrong-filename.md`]: `---\nname: actual-name\ndescription: ok\n---\nbody`,
    });
    const errors: string[] = [];
    const found = await discoverSkills(v, { onParseError: (_p, e) => errors.push(e) });
    expect(found.find(s => s.name === 'actual-name')).toBeFalsy();
    expect(errors.some(e => e.includes('does not match'))).toBe(true);
  });
});

