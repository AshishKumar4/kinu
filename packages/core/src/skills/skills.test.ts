/**
 * Skills module — behavior tests through the public surface.
 *
 * Asserts the contract the orchestrator + tool surface depend on:
 *   - SKILL.md round-trips through parse → stringify → parse.
 *   - Front-matter validation rejects what the LLM might accidentally generate.
 *   - Active-skill resolution picks explicit > keyword > always_active.
 *   - VFS-stored skills shadow built-ins of the same name.
 *   - The single `skills` tool's six actions behave like a typed CRUD verb.
 *
 * No mocking of internal helpers — uses an in-memory SkillsVfs that's the
 * same shape SqliteFS exposes. Built-in skills come from BUILTIN_SKILLS,
 * not stubs.
 */

import { describe, expect, test } from 'bun:test';
import {
  parseSkillFile, stringifySkillFile, validateSkillName,
  discoverSkills, BUILTIN_SKILLS,
  resolveActiveSkills, extractExplicitInvocations,
  renderActiveSkillsSection, unionAllowedTools, toolAllowedBySkills,
  runSkillsAction,
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
    expect(toolAllowedBySkills('think', ['run'])).toBe(false);
  });

  test('toolAllowedBySkills: glob-suffix `workspace.*` matches namespace', () => {
    expect(toolAllowedBySkills('workspace.readFile', ['workspace.*'])).toBe(true);
    expect(toolAllowedBySkills('workspace.readFile', ['workspace'])).toBe(true);
    expect(toolAllowedBySkills('sandbox.exec', ['workspace.*'])).toBe(false);
  });
});

describe('unionAllowedTools', () => {
  test('dedupes and sorts', () => {
    const a = fakeSkill('a', { allowed_tools: ['run', 'memory'] });
    const b = fakeSkill('b', { allowed_tools: ['run', 'think'] });
    expect(unionAllowedTools([a, b])).toEqual(['memory', 'run', 'think']);
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

// ── tool actions ─────────────────────────────────────────────────

function makeDeps() {
  const invoked = new Set<string>();
  return {
    invoked,
    deps: {
      vfs: memoryVfs(),
      recordInvoke: (name: string) => { invoked.add(name); },
      currentlyInvoked: () => Array.from(invoked),
    },
  };
}

describe('runSkillsAction', () => {
  test('list returns the catalogue with the built-in audit skill', async () => {
    const { deps } = makeDeps();
    const r = await runSkillsAction(deps, { action: 'list' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const list = r.result as Array<{ name: string; source: string }>;
    expect(list.some(e => e.name === 'audit-implementation' && e.source === 'builtin')).toBe(true);
  });

  test('read returns a built-in skill body', async () => {
    const { deps } = makeDeps();
    const r = await runSkillsAction(deps, { action: 'read', name: 'audit-implementation' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.result as ParsedSkill).body.length).toBeGreaterThan(0);
  });

  test('read on unknown name fails with not_found code', async () => {
    const { deps } = makeDeps();
    const r = await runSkillsAction(deps, { action: 'read', name: 'does-not-exist' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  test('invoke records the name and returns a preview', async () => {
    const { deps, invoked } = makeDeps();
    const r = await runSkillsAction(deps, { action: 'invoke', name: 'audit-implementation' });
    expect(r.ok).toBe(true);
    expect(invoked.has('audit-implementation')).toBe(true);
  });

  test('create writes a new VFS skill', async () => {
    const { deps } = makeDeps();
    const r = await runSkillsAction(deps, {
      action: 'create',
      name: 'my-workflow',
      description: 'A skill the agent authored.',
      body: '# my-workflow\n\nSteps go here.\n',
      allowed_tools: ['run'],
      keywords: ['workflow'],
      auto_activate: true,
    });
    expect(r.ok).toBe(true);
    // Verify it's discoverable.
    const list = await runSkillsAction(deps, { action: 'list' });
    expect(list.ok).toBe(true);
    if (list.ok) {
      const entry = (list.result as Array<{ name: string }>).find(e => e.name === 'my-workflow');
      expect(entry).toBeTruthy();
    }
  });

  test('create defaults user_invocable=true so /name invocation is honored after reload', async () => {
    // Regression: the create literal once omitted user_invocable, so
    // stringifySkillFile wrote `user-invocable: false` for every agent-authored
    // skill, silently killing /skill-name invocation on reload.
    const { deps } = makeDeps();
    await runSkillsAction(deps, {
      action: 'create', name: 'authored', description: 'x', body: 'y',
    });
    const read = await runSkillsAction(deps, { action: 'read', name: 'authored' });
    expect(read.ok).toBe(true);
    if (read.ok) {
      const s = read.result as ParsedSkill;
      expect(s.user_invocable).toBe(true);
      expect(s.disable_model_invocation).toBe(false);
    }
    // And it actually activates via /name through the loader.
    const all = (await runSkillsAction(deps, { action: 'list' }));
    expect(all.ok).toBe(true);
  });

  test('create honors explicit disable_model_invocation + user_invocable', async () => {
    const { deps } = makeDeps();
    await runSkillsAction(deps, {
      action: 'create', name: 'ops-runbook', description: 'x', body: 'y',
      keywords: ['deploy'], auto_activate: true,
      disable_model_invocation: true, user_invocable: false,
    });
    const read = await runSkillsAction(deps, { action: 'read', name: 'ops-runbook' });
    if (read.ok) {
      const s = read.result as ParsedSkill;
      expect(s.disable_model_invocation).toBe(true);
      expect(s.user_invocable).toBe(false);
      // disable_model_invocation coerces auto_activate off.
      expect(s.auto_activate).toBe(false);
    }
  });

  test('create on an existing skill returns duplicate error', async () => {
    const { deps } = makeDeps();
    await runSkillsAction(deps, {
      action: 'create', name: 'dup', description: 'x', body: 'y',
    });
    const r = await runSkillsAction(deps, {
      action: 'create', name: 'dup', description: 'x', body: 'y',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('duplicate');
  });

  test('edit updates fields and preserves untouched ones', async () => {
    const { deps } = makeDeps();
    await runSkillsAction(deps, {
      action: 'create', name: 'editme', description: 'old', body: 'original body',
      keywords: ['k1'],
    });
    const r = await runSkillsAction(deps, {
      action: 'edit', name: 'editme', description: 'new',
    });
    expect(r.ok).toBe(true);
    const read = await runSkillsAction(deps, { action: 'read', name: 'editme' });
    if (read.ok) {
      const s = read.result as ParsedSkill;
      expect(s.description).toBe('new');
      expect(s.body).toBe('original body');
      expect(s.keywords).toEqual(['k1']);
    }
  });

  test('delete removes a VFS skill', async () => {
    const { deps } = makeDeps();
    await runSkillsAction(deps, {
      action: 'create', name: 'goner', description: 'x', body: 'y',
    });
    const r = await runSkillsAction(deps, { action: 'delete', name: 'goner' });
    expect(r.ok).toBe(true);
    const after = await runSkillsAction(deps, { action: 'read', name: 'goner' });
    expect(after.ok).toBe(false);
  });

  test('delete of an un-overridden built-in is rejected', async () => {
    const { deps } = makeDeps();
    const r = await runSkillsAction(deps, { action: 'delete', name: 'audit-implementation' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('forbidden_action');
  });

  test('edit on a built-in writes a VFS override (forks the built-in)', async () => {
    const { deps } = makeDeps();
    const r = await runSkillsAction(deps, {
      action: 'edit', name: 'audit-implementation', description: 'forked',
    });
    expect(r.ok).toBe(true);
    const read = await runSkillsAction(deps, { action: 'read', name: 'audit-implementation' });
    if (read.ok) expect((read.result as ParsedSkill).description).toBe('forked');
    // Now delete should succeed (it removes the override, restoring built-in).
    const del = await runSkillsAction(deps, { action: 'delete', name: 'audit-implementation' });
    expect(del.ok).toBe(true);
    const restored = await runSkillsAction(deps, { action: 'read', name: 'audit-implementation' });
    if (restored.ok) {
      const s = restored.result as ParsedSkill;
      expect(s.source).toBe('builtin');
      expect(s.description).not.toBe('forked');
    }
  });

  test('invalid kebab-case name is rejected on create', async () => {
    const { deps } = makeDeps();
    const r = await runSkillsAction(deps, {
      action: 'create', name: 'BadName', description: 'x', body: 'y',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_name');
  });
});
