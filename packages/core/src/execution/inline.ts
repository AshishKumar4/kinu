/**
 * InlineExecutor — the "workspace" provider inside the codemode sandbox.
 *
 * Wraps the agent's DO-local resources (SqliteFS, MemoryStore, shell emulator)
 * as workspace.* APIs callable from LLM-generated JS:
 *
 *   workspace.readFile("/src/main.ts")
 *   workspace.writeFile("/src/util.ts", code)
 *   workspace.exec("grep -rn TODO /src")
 *   workspace.searchMemory("how to handle errors")
 *   workspace.saveNote("User prefers TypeScript strict mode")
 *   workspace.listTools()
 */

import type { ExecutorProvider, ExecutorCapability, ResourceLimits } from './types.js';
import type { VFS, Memory, SqlExecutor } from '../types/primitives.js';
import type { CraftStore } from '../types/agent-runtime.js';
import { appendMemoryNote, memoryIndexPath } from '../memory/note.js';
import { ensureDir } from '../utils/vfs-helpers.js';
import { isVfsError, vfsAddressingHint, withVfsErrorHint } from '../vfs/errno.js';
import { readExecSignal } from './signal.js';
import { formatExecResult } from './exec-result.js';
import { checkMisevolutionForSurface, recordMisevolutionVeto } from '../scaffold/misevolution.js';
import { seedCraftScore } from '../craft/in-episode.js';

interface ShellExec {
  exec(command: string, opts?: { signal?: AbortSignal }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface InlineExecutorDeps {
  vfs: VFS;
  memory: Memory;
  craftStore: CraftStore;
  shell: ShellExec;
  /** The measured limits of wherever `shell` really runs. The cf backend's
   *  workspace shell is emulated in the Worker and declares none; the CLI's is
   *  the host process, so it passes its own cgroup's. */
  resourceLimits?: ResourceLimits;
  /** Optional — used to look up craft_scores for listTools(). Falls back to 0.7 if missing. */
  sql?: SqlExecutor;
  /**
   * Optional mid-turn notification — fires synchronously from workspace.createTool
   * after a successful create/update. The PreambleCraftedExecutor does not need
   * it because it reads craftStore.list() fresh on every execute; other adapters
   * can use it for eager notification.
   */
  onToolRegistered?: (tool: { name: string; description: string; code: string }) => void;
}

/**
 * Every VFS error out of `workspace.*` carries the correction the model needs
 * (vfsAddressingHint — shared with the `file` tool, which addresses the same
 * plane). The error keeps its code, errno and path; only what a reader sees
 * changes.
 */
function withVfsGuidance(vfs: VFS, tools: ExecutorProvider['tools']): ExecutorProvider['tools'] {
  const guided: ExecutorProvider['tools'] = {};
  for (const [name, entry] of Object.entries(tools)) {
    guided[name] = {
      ...entry,
      execute: async (...args: unknown[]) => {
        try {
          return await entry.execute(...args);
        } catch (err) {
          if (!isVfsError(err)) throw err;
          throw withVfsErrorHint(err, await vfsAddressingHint(vfs, 'workspace.*'));
        }
      },
    };
  }
  return guided;
}

export function createInlineExecutor(deps: InlineExecutorDeps): ExecutorProvider {
  const { vfs, memory, craftStore, shell, sql, resourceLimits, onToolRegistered } = deps;

  const tools: ExecutorProvider['tools'] = {
    readFile: {
      description: 'Read a file from the agent workspace. Returns content as string.',
      execute: async (path: unknown) => {
        const content = await vfs.readFile(String(path), { encoding: 'utf8' });
        return content ?? `File not found: ${path}`;
      },
    },

    writeFile: {
      description: 'Write content to a file. Creates parent directories automatically.',
      execute: async (path: unknown, content: unknown) => {
        const p = String(path);
        const dir = p.split('/').slice(0, -1).join('/');
        if (dir) await ensureDir(vfs, dir);
        await vfs.writeFile(p, String(content));
        const indexed = memoryIndexPath(p);
        if (indexed) await memory.index(indexed);
        return `Written ${String(content).length} bytes to ${p}`;
      },
    },

    readdir: {
      description: 'List entries in a directory.',
      execute: async (path: unknown) => {
        return vfs.readdir(String(path || '/'));
      },
    },

    exists: {
      description: 'Check if a path exists.',
      execute: async (path: unknown) => {
        return vfs.exists(String(path));
      },
    },

    exec: {
      description: 'Execute a POSIX shell command. Supports cat, grep, find, sed, ls, tree, head, tail, wc, mkdir, rm, cp, mv, echo, sort, uniq, xargs. Pipes (|) and redirects (>, >>) work.',
      execute: async (command: unknown, context?: unknown) => {
        const signal = readExecSignal(context);
        return formatExecResult(await shell.exec(String(command), signal ? { signal } : undefined));
      },
    },

    searchMemory: {
      description: 'Search long-term memory using FTS5 full-text search. Returns matching chunks.',
      execute: async (query: unknown) => {
        const results = await memory.search(String(query), 10);
        if (results.length === 0) return 'No results found.';
        return results.map(r => `[${r.path}:${r.startLine}-${r.endLine}] (score ${r.score.toFixed(2)})\n${r.snippet}`).join('\n\n');
      },
    },

    saveNote: {
      description: 'Save a note to long-term memory (MEMORY.md). The note is FTS5-indexed for search.',
      execute: async (content: unknown) => appendMemoryNote(memory, String(content)),
    },

    listTools: {
      description: 'List crafted tools as an array of { name, description, qualityScore }.',
      execute: async () => {
        // Return a real array so LLM code like `const tools = await workspace.listTools(); tools.filter(...)` works.
        // Previous implementation returned a joined markdown string and broke .filter/.map.
        const crafted = craftStore.list();
        // Pull EMA scores if available; default to 0.7 when unscored.
        const scoreByName = new Map<string, number>();
        if (sql) {
          try {
            const rows = sql<{ tool_name: string; score: number }>`
              SELECT tool_name, score FROM craft_scores
            `;
            for (const r of rows) scoreByName.set(r.tool_name, r.score);
          } catch { /* craft_scores may not exist yet */ }
        }
        return crafted.map(t => ({
          name: t.name,
          description: t.description,
          qualityScore: scoreByName.get(t.name) ?? 0.7,
        }));
      },
    },

    createTool: {
      description:
        'Create or update a reusable tool in CraftStore. ' +
        'Code must be an async arrow: `async (args) => { ... }`. ' +
        'Inside the body you may call `workspace.*`, `codemode.*`, and other crafted tools as `tools.<name>(args)`. ' +
        'Callable as `codemode.<name>(args)` or `tools.<name>(args)` on the NEXT execute_tools call in the same turn. ' +
        'Returns { ok, name, action: "created"|"updated" }.',
      execute: async (name: unknown, description: unknown, code: unknown) => {
        if (!name || !description || !code) {
          return { ok: false, error: 'createTool requires name, description, and code arguments.' };
        }
        const raw = String(name);
        let toolName = raw.replace(/[^A-Za-z0-9_]/g, '_');
        if (!toolName) return { ok: false, error: 'Tool name must contain at least one identifier character.' };
        if (/^[0-9]/.test(toolName)) toolName = '_' + toolName;
        try {
          // Exact-name update is an upsert. A different name that matches
          // case-insensitively is a collision — reject with an actionable
          // error so the LLM picks a distinct identity.
          const existing = craftStore.get(toolName);
          const desc = String(description);
          const codeStr = String(code);
          // The misevolution gate, before any write, on the `craft_tool`
          // surface — the safety-machinery criteria in full, deliberately
          // without `network-egress` (the same fetch runs unrestricted in an
          // ephemeral execute_tools call, so vetoing only its persisted form
          // buys nothing; see SURFACE_CRITERIA). What IS refused is a stored,
          // reusable, publishable tool that names the promotion tables, the
          // rollout knobs, the gate entry points, or the consent settings.
          const misevolution = checkMisevolutionForSurface(codeStr, 'craft_tool');
          if (!misevolution.ok) {
            if (sql) {
              recordMisevolutionVeto(sql, {
                surface: 'craft_tool', violation: misevolution,
                detail: `workspace.createTool("${toolName}") rejected`,
              });
            }
            return {
              ok: false,
              error:
                `Misevolution veto (${misevolution.criterionId}): ${misevolution.reason} ` +
                `Rewrite the tool body without it and call createTool again.`,
            };
          }
          if (existing) {
            craftStore.update(toolName, { description: desc, code: codeStr });
            onToolRegistered?.({ name: toolName, description: desc, code: codeStr });
            return { ok: true, name: toolName, action: 'updated' };
          }
          const caseHit = craftStore.list().find(t =>
            t.name !== toolName && t.name.toLowerCase() === toolName.toLowerCase(),
          );
          if (caseHit) {
            return {
              ok: false,
              error:
                `A tool named "${caseHit.name}" already exists ` +
                `(case-insensitive match with "${toolName}"). ` +
                `Either call that tool as codemode.${caseHit.name}(...) or ` +
                `pick a genuinely different name.`,
            };
          }
          craftStore.create({
            name: toolName,
            description: desc,
            code: codeStr,
            scope: 'local',
            params: null,
          });
          // The tool is born with a neutral prior, so the decay + injection
          // floor can see it at all: an unscored tool is exempt from the
          // filter forever, which is what kept a tool crafted here from ever
          // being retired no matter how it behaved.
          if (sql) seedCraftScore(sql, toolName);
          // Optional eager notification; PreambleCraftedExecutor reads
          // craftStore.list() live, so CF leaves this as a no-op.
          onToolRegistered?.({ name: toolName, description: desc, code: codeStr });
          return { ok: true, name: toolName, action: 'created' };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  };

  const types = `declare namespace workspace {
  function readFile(path: string): Promise<string>;
  function writeFile(path: string, content: string): Promise<string>;
  function readdir(path: string): Promise<string[]>;
  function exists(path: string): Promise<boolean>;
  function exec(command: string): Promise<string>;
  function searchMemory(query: string): Promise<string>;
  function saveNote(content: string): Promise<string>;
  /** Returns Array<{name, description, qualityScore}> of crafted tools. */
  function listTools(): Promise<Array<{ name: string; description: string; qualityScore: number }>>;
  /**
   * Create or update a crafted tool. Immediately callable as
   * \`codemode.<name>(args)\` in the SAME turn — no turn boundary needed.
   * Name is sanitized to a valid JS identifier; original case preserved.
   */
  function createTool(
    name: string, description: string, code: string
  ): Promise<{ ok: boolean; name?: string; action?: 'created' | 'updated'; error?: string }>;
}`;

  return {
    name: 'workspace',
    kind: 'workspace',
    capabilities: new Set<ExecutorCapability>(['javascript', 'typescript', 'shell', 'fs_shared']),
    ...(resourceLimits ? { resourceLimits } : {}),
    isAvailable: () => true,
    connect: async () => {},
    disconnect: async () => {},
    tools: withVfsGuidance(vfs, tools),
    types,
    positionalArgs: true,
    // workspace executor runs INSIDE the Worker — no inbound TCP port
    // surface available. The agent should use `sandbox` for anything
    // that needs to expose an HTTP server.
    async exposePort(port) {
      return {
        supported: false,
        reason:
          `workspace executor runs in the Worker and cannot expose inbound ports. ` +
          `Use the 'sandbox' executor for any server you want to preview (port ${port}).`,
      };
    },
    async unexposePort() { /* nothing to do */ },
    async listExposedPorts() { return []; },
  };
}
