/**
 * SKILL.md format — Hermes-style markdown representation of crafted tools.
 *
 * Lets the user export the agent's learned tools as human-readable
 * markdown files with YAML frontmatter, edit them by hand, commit them
 * to a repo, share them, and import them back.
 *
 * Format (lifted in spirit from external/hermes-agent/CONTRIBUTING.md:342-389):
 *
 *   ---
 *   name: kebab-case-name
 *   description: One-sentence summary (≤80 chars)
 *   version: 1
 *   scope: local | shared
 *   created_at: <unix-ms>
 *   updated_at: <unix-ms>
 *   tags: [optional, list]
 *   params:                                  # optional, codemode shape
 *     argName: argDescription
 *   ---
 *
 *   # <name>
 *
 *   ## When to use
 *   <prose>
 *
 *   ## Code
 *   ```typescript
 *   async (args) => { ... }
 *   ```
 *
 *   ## Notes
 *   <optional prose: pitfalls, related skills, etc>
 *
 * Round-tripping is lossy for fields not modeled here — we preserve only
 * what CraftedTool carries. Extra frontmatter keys are dropped on import
 * (logged); unknown body sections are concatenated into 'extraBody'.
 */

import type { CraftedTool } from '../types/craft.js';
import { ensureDir } from '../utils/vfs-helpers.js';

export interface SkillMdParseResult {
  /** The crafted-tool fields we recognized. */
  readonly tool: Omit<CraftedTool, 'createdAt' | 'updatedAt'> & {
    createdAt?: number;
    updatedAt?: number;
  };
  /** Verbatim "When to use" section. */
  readonly whenToUse?: string;
  /** Verbatim "Notes" section. */
  readonly notes?: string;
  /** Any other unrecognized body sections, concatenated. */
  readonly extraBody?: string;
  /** Frontmatter keys we didn't recognize (informational). */
  readonly droppedFrontmatter: ReadonlyArray<string>;
}

/**
 * Render a CraftedTool as a SKILL.md file. The output is a complete
 * markdown document; pass to vfs.writeFile().
 */
export function craftedToolToSkillMd(
  tool: CraftedTool,
  bodySections?: { whenToUse?: string; notes?: string },
): string {
  const fm: string[] = ['---'];
  fm.push(`name: ${tool.name}`);
  fm.push(`description: ${escapeYamlString(tool.description)}`);
  fm.push(`scope: ${tool.scope}`);
  fm.push(`created_at: ${tool.createdAt}`);
  fm.push(`updated_at: ${tool.updatedAt}`);
  if (tool.params) {
    fm.push('params:');
    for (const [k, v] of Object.entries(tool.params)) {
      fm.push(`  ${k}: ${escapeYamlString(v)}`);
    }
  }
  fm.push('---');
  fm.push('');
  fm.push(`# ${tool.name}`);
  fm.push('');

  const whenToUse = bodySections?.whenToUse ?? autoWhenToUse(tool);
  fm.push('## When to use');
  fm.push(whenToUse);
  fm.push('');

  fm.push('## Code');
  fm.push('```typescript');
  fm.push(tool.code);
  fm.push('```');

  if (bodySections?.notes && bodySections.notes.trim().length > 0) {
    fm.push('');
    fm.push('## Notes');
    fm.push(bodySections.notes);
  }
  fm.push('');
  return fm.join('\n');
}

/**
 * Parse a SKILL.md string into a CraftedTool + body sections. Returns
 * { tool, whenToUse?, notes?, extraBody?, droppedFrontmatter }.
 *
 * Throws if frontmatter is missing or doesn't contain a `name` field.
 * Throws if no ```typescript fence in body — the code block is required.
 */
export function parseSkillMd(source: string): SkillMdParseResult {
  const fmMatch = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fmMatch) {
    throw new Error('SKILL.md missing YAML frontmatter (must start with ---)');
  }
  const fmBlock = fmMatch[1];
  const body = source.slice(fmMatch[0].length);

  const parsedFm = parseSimpleYaml(fmBlock);

  const known = new Set([
    'name', 'description', 'scope', 'created_at', 'updated_at', 'version', 'params', 'tags',
  ]);
  const droppedFrontmatter = Object.keys(parsedFm).filter((k) => !known.has(k));

  const name = parsedFm.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('SKILL.md frontmatter missing required `name` field');
  }
  const description = typeof parsedFm.description === 'string' ? parsedFm.description : `Crafted tool: ${name}`;
  const scope: 'local' | 'shared' =
    parsedFm.scope === 'shared' ? 'shared' : 'local';
  const createdAt = typeof parsedFm.created_at === 'number'
    ? parsedFm.created_at
    : (typeof parsedFm.created_at === 'string' ? Number(parsedFm.created_at) : undefined);
  const updatedAt = typeof parsedFm.updated_at === 'number'
    ? parsedFm.updated_at
    : (typeof parsedFm.updated_at === 'string' ? Number(parsedFm.updated_at) : undefined);

  let params: Record<string, string> | null = null;
  if (parsedFm.params && typeof parsedFm.params === 'object') {
    params = {};
    for (const [k, v] of Object.entries(parsedFm.params as Record<string, unknown>)) {
      params[k] = String(v);
    }
  }

  // Pull the ```typescript code block — required.
  const codeMatch = body.match(/```(?:typescript|ts|javascript|js)\n([\s\S]*?)\n```/);
  if (!codeMatch) {
    throw new Error('SKILL.md missing required ```typescript code block in body');
  }
  const code = codeMatch[1];

  // Split body into sections (## headings).
  const sections = splitBodyByH2(body);
  const whenToUse = sections.get('when to use')?.trim();
  const notes = sections.get('notes')?.trim();
  const extraNames = [...sections.keys()].filter(
    (k) => k !== 'when to use' && k !== 'notes' && k !== 'code',
  );
  const extraBody = extraNames.length > 0
    ? extraNames.map((n) => `## ${n}\n${sections.get(n)?.trim() ?? ''}`).join('\n\n')
    : undefined;

  return {
    tool: {
      name, description, scope, code, params,
      createdAt, updatedAt,
    },
    whenToUse, notes, extraBody, droppedFrontmatter,
  };
}

// ── helpers ─────────────────────────────────────────────────────────

function escapeYamlString(s: string): string {
  // Use double-quotes if string contains : # newlines or starts with - { [
  if (/[\n":#\[\]{}!*&|>'%@`]/.test(s) || /^[-?]/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return s;
}

function autoWhenToUse(tool: CraftedTool): string {
  return tool.description || `Use ${tool.name} when you need its specific behavior.`;
}

/**
 * Tiny YAML subset parser: supports flat scalar fields + one level of
 * nested object (for `params:`). Doesn't try to be general — we
 * round-trip the exact shape `craftedToolToSkillMd` writes.
 */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    let val = m[2].trim();
    if (val === '' && lines[i + 1] && lines[i + 1].startsWith('  ')) {
      // Nested object: collect indented children.
      const nested: Record<string, unknown> = {};
      i++;
      while (i < lines.length && lines[i].startsWith('  ')) {
        const childLine = lines[i].slice(2);
        const childMatch = childLine.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
        if (childMatch) nested[childMatch[1]] = unquoteScalar(childMatch[2]);
        i++;
      }
      out[key] = nested;
      continue;
    }
    out[key] = unquoteScalar(val);
    i++;
  }
  return out;
}

function unquoteScalar(s: string): string | number | boolean {
  const t = s.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }
  return t;
}

/** Split markdown body by `## ` headings; returns lowercase-keyed map. */
function splitBodyByH2(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const re = /^##\s+(.+)$/gm;
  const matches = [...body.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : body.length;
    sections.set(m[1].trim().toLowerCase(), body.slice(start, end));
  }
  return sections;
}

/**
 * Bulk export every crafted tool to SKILL.md files in a VFS directory.
 *
 *   skills/<name>.md
 *
 * Returns { written: number, skipped: number, errors: Array<{name,msg}> }.
 */
export interface ExportSkillsResult {
  written: number;
  skipped: number;
  errors: Array<{ name: string; msg: string }>;
}

export interface MinimalVFS {
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readFile(path: string, options?: { encoding?: string }): Promise<string | Uint8Array>;
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<string[]>;
}

export interface MinimalCraftStore {
  list(): CraftedTool[];
  get(name: string): CraftedTool | undefined;
  create(t: Omit<CraftedTool, 'createdAt' | 'updatedAt'>): void;
  update(name: string, patch: Partial<CraftedTool>): void;
}

export async function exportAllSkillsToVfs(
  vfs: MinimalVFS,
  craftStore: MinimalCraftStore,
  opts: { dir?: string } = {},
): Promise<ExportSkillsResult> {
  const dir = opts.dir ?? 'skills';
  const result: ExportSkillsResult = { written: 0, skipped: 0, errors: [] };
  await ensureDir(vfs, dir);
  for (const tool of craftStore.list()) {
    if (!tool.code || tool.code.startsWith('//')) {
      result.skipped++;
      continue;
    }
    try {
      const md = craftedToolToSkillMd(tool);
      const safeName = tool.name.replace(/[^A-Za-z0-9_-]/g, '_');
      await vfs.writeFile(`${dir}/${safeName}.md`, md);
      result.written++;
    } catch (err) {
      result.errors.push({ name: tool.name, msg: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

export interface ImportSkillsResult {
  imported: number;
  updated: number;
  skipped: number;
  errors: Array<{ path: string; msg: string }>;
}

/**
 * Import all SKILL.md files from a VFS directory back into the CraftStore.
 *
 * For each .md file:
 *   - parse the frontmatter + body
 *   - if a tool with the same name exists → call update()
 *   - else → call create()
 *
 * Files that fail to parse are reported in `errors` but don't halt the import.
 */
export async function importSkillsFromVfs(
  vfs: MinimalVFS,
  craftStore: MinimalCraftStore,
  opts: { dir?: string } = {},
): Promise<ImportSkillsResult> {
  const dir = opts.dir ?? 'skills';
  const result: ImportSkillsResult = { imported: 0, updated: 0, skipped: 0, errors: [] };
  if (!(await vfs.exists(dir))) return result;

  const entries = await vfs.readdir(dir);
  for (const name of entries) {
    if (!name.endsWith('.md')) {
      result.skipped++;
      continue;
    }
    const path = `${dir}/${name}`;
    try {
      const content = await vfs.readFile(path, { encoding: 'utf8' });
      const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
      const parsed = parseSkillMd(text);
      const existing = craftStore.get(parsed.tool.name);
      if (existing) {
        craftStore.update(parsed.tool.name, {
          description: parsed.tool.description,
          code: parsed.tool.code,
          scope: parsed.tool.scope,
          params: parsed.tool.params,
        });
        result.updated++;
      } else {
        craftStore.create({
          name: parsed.tool.name,
          description: parsed.tool.description,
          code: parsed.tool.code,
          scope: parsed.tool.scope,
          params: parsed.tool.params,
        });
        result.imported++;
      }
    } catch (err) {
      result.errors.push({ path, msg: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
