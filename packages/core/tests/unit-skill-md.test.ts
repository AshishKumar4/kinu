/**
 * Unit tests for SKILL.md export/import.
 */

import { describe, test, expect } from 'bun:test';
import {
  craftedToolToSkillMd, parseSkillMd,
  exportAllSkillsToVfs, importSkillsFromVfs,
  type MinimalVFS, type MinimalCraftStore,
} from '../src/craft/skill-md.js';
import type { CraftedTool } from '../src/types/craft.js';

const sampleTool: CraftedTool = {
  name: 'multiply_numbers',
  description: 'Multiply two numbers and return the product.',
  scope: 'local',
  code: 'async (a, b) => Number(a) * Number(b)',
  params: { a: 'first number', b: 'second number' },
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
};

describe('craftedToolToSkillMd', () => {
  test('renders required frontmatter + name heading + code block', () => {
    const md = craftedToolToSkillMd(sampleTool);
    expect(md).toContain('---');
    expect(md).toContain('name: multiply_numbers');
    expect(md).toContain('description:');
    expect(md).toContain('scope: local');
    expect(md).toContain('# multiply_numbers');
    expect(md).toContain('## When to use');
    expect(md).toContain('## Code');
    expect(md).toContain('```typescript');
    expect(md).toContain('async (a, b) => Number(a) * Number(b)');
  });

  test('includes params subsection when present', () => {
    const md = craftedToolToSkillMd(sampleTool);
    expect(md).toContain('params:');
    expect(md).toContain('  a: first number');
    expect(md).toContain('  b: second number');
  });

  test('appends optional Notes section when supplied', () => {
    const md = craftedToolToSkillMd(sampleTool, { notes: 'Coerces strings to numbers.' });
    expect(md).toContain('## Notes');
    expect(md).toContain('Coerces strings to numbers.');
  });

  test('escapes YAML-unsafe strings in description', () => {
    const tool: CraftedTool = { ...sampleTool, description: 'Has: special # chars\n' };
    const md = craftedToolToSkillMd(tool);
    expect(md).toContain('description: "Has: special # chars\\n"');
  });
});

describe('parseSkillMd', () => {
  test('round-trips a tool produced by craftedToolToSkillMd', () => {
    const md = craftedToolToSkillMd(sampleTool);
    const parsed = parseSkillMd(md);
    expect(parsed.tool.name).toBe('multiply_numbers');
    expect(parsed.tool.description).toBe('Multiply two numbers and return the product.');
    expect(parsed.tool.scope).toBe('local');
    expect(parsed.tool.code.trim()).toBe('async (a, b) => Number(a) * Number(b)');
    expect(parsed.tool.params).toEqual({ a: 'first number', b: 'second number' });
    expect(parsed.tool.createdAt).toBe(1700000000000);
    expect(parsed.tool.updatedAt).toBe(1700000001000);
  });

  test('preserves When to use section when present', () => {
    const md = craftedToolToSkillMd(sampleTool, { whenToUse: 'Use when you need a product.' });
    const parsed = parseSkillMd(md);
    expect(parsed.whenToUse).toContain('Use when you need a product.');
  });

  test('throws on missing frontmatter', () => {
    expect(() => parseSkillMd('# no frontmatter\n```typescript\nx\n```')).toThrow(/frontmatter/i);
  });

  test('throws on missing code block', () => {
    expect(() => parseSkillMd('---\nname: x\n---\n# x\nno code')).toThrow(/code block/i);
  });

  test('throws on missing name', () => {
    expect(() => parseSkillMd('---\ndescription: x\n---\n# x\n```typescript\nasync()=>{}\n```')).toThrow(/name/i);
  });

  test('drops unknown frontmatter keys gracefully', () => {
    const md = `---
name: simple_tool
description: Just a test.
scope: local
created_at: 1700000000000
updated_at: 1700000001000
totally_unknown_key: ignored
another_unknown: also dropped
---

# simple_tool

## Code
\`\`\`typescript
async () => 'ok'
\`\`\`
`;
    const parsed = parseSkillMd(md);
    expect(parsed.droppedFrontmatter.sort()).toEqual(['another_unknown', 'totally_unknown_key']);
  });

  test('handles js/javascript fence variants', () => {
    const md = `---
name: x
description: y
scope: local
created_at: 1
updated_at: 1
---

# x

## Code
\`\`\`javascript
async () => 1
\`\`\`
`;
    const parsed = parseSkillMd(md);
    expect(parsed.tool.code.trim()).toBe('async () => 1');
  });
});

// ── Export/import VFS round-trip ─────────────────────────────────────

function makeMemoryVFS(): MinimalVFS {
  const files = new Map<string, string>();
  const dirs = new Set<string>(['/', 'skills']);
  return {
    async writeFile(path, content) { files.set(path, content); },
    async mkdir(path) { dirs.add(path); },
    async readFile(path) {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      return files.get(path)!;
    },
    async exists(path) { return files.has(path) || dirs.has(path); },
    async readdir(path) {
      const prefix = path === '/' ? '/' : path + '/';
      const names = new Set<string>();
      for (const f of files.keys()) {
        if (f.startsWith(prefix)) {
          const name = f.slice(prefix.length).split('/')[0];
          if (name) names.add(name);
        }
      }
      return Array.from(names);
    },
  };
}

function makeMemoryCraftStore(initial: CraftedTool[] = []): MinimalCraftStore & { _all: CraftedTool[] } {
  const all = [...initial];
  return {
    _all: all,
    list() { return [...all]; },
    get(name) { return all.find((t) => t.name === name); },
    create(t) {
      all.push({ ...t, createdAt: 1, updatedAt: 1 } as CraftedTool);
    },
    update(name, patch) {
      const i = all.findIndex((t) => t.name === name);
      if (i >= 0) all[i] = { ...all[i], ...patch, updatedAt: Date.now() } as CraftedTool;
    },
  };
}

describe('exportAllSkillsToVfs', () => {
  test('writes one .md file per tool, skips empty/comment-only code', async () => {
    const vfs = makeMemoryVFS();
    const cs = makeMemoryCraftStore([
      sampleTool,
      { ...sampleTool, name: 'tool_b', code: 'async () => "b"' },
      { ...sampleTool, name: 'commented_out', code: '// disabled' },
    ]);
    const result = await exportAllSkillsToVfs(vfs, cs);
    expect(result.written).toBe(2);
    expect(result.skipped).toBe(1);
    expect(await vfs.exists('skills/multiply_numbers.md')).toBe(true);
    expect(await vfs.exists('skills/tool_b.md')).toBe(true);
  });

  test('uses custom dir when provided', async () => {
    const vfs = makeMemoryVFS();
    const cs = makeMemoryCraftStore([sampleTool]);
    await exportAllSkillsToVfs(vfs, cs, { dir: 'custom/path' });
    expect(await vfs.exists('custom/path/multiply_numbers.md')).toBe(true);
  });
});

describe('importSkillsFromVfs', () => {
  test('imports new tools + updates existing ones', async () => {
    const vfs = makeMemoryVFS();
    const cs = makeMemoryCraftStore([
      { ...sampleTool, code: 'OLD CODE' },  // existing — will be updated
    ]);

    // Pre-populate the VFS with two SKILL.md files: the existing tool (new code) + a new tool.
    await vfs.writeFile('skills/multiply_numbers.md', craftedToolToSkillMd({
      ...sampleTool, code: 'NEW CODE',
    }));
    await vfs.writeFile('skills/added_tool.md', craftedToolToSkillMd({
      ...sampleTool, name: 'added_tool', code: 'async () => "new"',
    }));

    const result = await importSkillsFromVfs(vfs, cs);
    expect(result.imported).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.errors).toEqual([]);

    expect(cs.get('multiply_numbers')!.code).toBe('NEW CODE');
    expect(cs.get('added_tool')!.code.trim()).toBe('async () => "new"');
  });

  test('reports parse errors but doesn\'t halt the import', async () => {
    const vfs = makeMemoryVFS();
    const cs = makeMemoryCraftStore([]);
    await vfs.writeFile('skills/good.md', craftedToolToSkillMd(sampleTool));
    await vfs.writeFile('skills/broken.md', '# no frontmatter\ngarbage');

    const result = await importSkillsFromVfs(vfs, cs);
    expect(result.imported).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].path).toBe('skills/broken.md');
  });

  test('returns empty result if directory missing', async () => {
    const vfs = makeMemoryVFS();
    const cs = makeMemoryCraftStore([]);
    const result = await importSkillsFromVfs(vfs, cs, { dir: 'nonexistent' });
    expect(result.imported).toBe(0);
    expect(result.updated).toBe(0);
  });

  test('skips non-md files', async () => {
    const vfs = makeMemoryVFS();
    const cs = makeMemoryCraftStore([]);
    await vfs.writeFile('skills/README.txt', 'not a skill');
    await vfs.writeFile('skills/skill.md', craftedToolToSkillMd(sampleTool));
    const result = await importSkillsFromVfs(vfs, cs);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
  });
});
