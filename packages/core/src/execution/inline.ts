/**
 * InlineExecutor — the "workspace" provider inside the codemode sandbox.
 *
 * Wraps the agent's own resources — the Nimbus filesystem and shell, memory,
 * the craft store — as workspace.* APIs callable from LLM-generated JS:
 *
 *   workspace.readFile("/src/main.ts")
 *   workspace.writeFile("/src/util.ts", code)
 *   workspace.editFile("/src/util.ts", [{old_text, new_text}])
 *   workspace.exec("grep -rn TODO /src")
 *   workspace.searchMemory("how to handle errors")
 *   workspace.saveNote("User prefers TypeScript strict mode")
 *   workspace.listTools()
 *   workspace.createView("deploy-health", { v: 1, title: "Deploy health", blocks: [...] })
 */

import * as v from 'valibot';
import type { ExecutorProvider, ExecutorCapability, ResourceLimits } from './types';
import type { VFS, Memory, SqlExecutor } from '../types/primitives';
import type { CraftStore } from '../types/agent-runtime';
import { appendMemoryNote } from '../memory/note';
import { isVfsError, vfsAddressingHint, withVfsErrorHint } from '../vfs/errno';
import { WORKSPACE_ROOT } from '../vfs/workspace-path';
import { readExecSignal } from './signal';
import { formatExecResult, refusalText } from './exec-result';
import { KinuError, refusalOf, toKinuError } from '../obs/index';
import { CRAFT_NEUTRAL_PRIOR, isReservedCraftToolName } from '../craft/in-episode';
import { admitCraftedSource } from '../craft/source';
import { checkMisevolutionForSurface, recordMisevolutionVeto } from '../scaffold/misevolution';
import { createView, deleteView, viewSlug } from '../views/store';
import { VIEW_DATA_SOURCES } from '../views/sources';
import { createFileDispatcher } from '../tools/file-tool';
import { TurnFileLedger } from '../tools/file-ledger';
import { TurnContextBudget } from '../context-budget';
import type { JsonValue } from '../utils/json';

const StringSchema = v.string();
const OptionalPathSchema = v.optional(v.string());
const FileEditsSchema = v.array(v.object({
  old_text: v.optional(v.string()),
  new_text: v.optional(v.string()),
}));
const FileWriteSuccessSchema = v.object({
  ok: v.literal(true),
  path: v.string(),
  bytes: v.number(),
  action: v.picklist(['created', 'replaced']),
});

function parseInput<TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: { value: unknown },
): v.InferOutput<TSchema> | undefined {
  const result = v.safeParse(schema, input.value);
  return result.success ? result.output : undefined;
}

interface ShellExec {
  exec(command: string, opts?: { signal?: AbortSignal }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface InlineExecutorDeps {
  vfs: VFS;
  memory: Memory;
  craftStore: CraftStore;
  shell: ShellExec;
  /** The measured limits of wherever `shell` really runs. The workspace shell
   *  runs inside the Worker/process and declares none unless the host measured
   *  one (the CLI passes its own cgroup's). */
  resourceLimits?: ResourceLimits;
  /** Optional — used to look up crafted-tool quality columns for listTools(). */
  sql?: SqlExecutor;
  /**
   * Optional mid-turn notification — fires synchronously from workspace.createTool
   * after a successful create/update. The hosted sandbox does not need it
   * because it reads craftStore.list() fresh on every execute; other adapters
   * can use it for eager notification.
   */
  onToolRegistered?: (tool: { name: string; description: string; code: string }) => void;
  /**
   * The turn's read/edit ledger, read live — SHARED with the native `file`
   * tool, so workspace.writeFile/editFile's read-before-write enforcement
   * is the SAME gate the native tool enforces (createFileDispatcher, tools/
   * file-tool.ts) over the SAME state, not a second implementation: a native
   * `file` edit never refuses a path this turn already read or wrote through
   * workspace.*, and vice versa.
   *
   * A THUNK, not a value, because this executor is registered once per
   * runtime construction — often the first thing a DO/session builds, ahead
   * of the per-turn accumulator that owns the real ledger — while the ledger
   * itself is reset per turn. Reading it lazily, at call time rather than
   * construction time, means construction order never matters: by the time
   * any tool here actually runs, a turn has always already begun.
   *
   * Returns `undefined`, not omitted, for an actor that has no turn-scoped
   * ledger at all (ExplorationAgent — a head or a swarm node): the caller can supply
   * the thunk unconditionally without itself touching whatever lazily-built
   * state decides the answer, which is what keeps this safe to wire from
   * inside another lazy getter's own construction. Undefined (from the
   * thunk, or the whole field omitted) → a private fresh ledger (tests, the
   * identity bootstrap path, heads) — every caller still gets a working
   * ledger, just not a turn-shared one.
   */
  ledger?: () => TurnFileLedger | undefined;
  /** Same sharing rule and reason as ledger. editFile's small ack payload
   *  never spends it (only file-tool.ts's own `read` does); required because
   *  the shared dispatcher's deps shape asks for one. */
  budget?: () => TurnContextBudget | undefined;
  /**
   * Toolchain this workspace's shell can actually reach beyond the coreutils,
   * as the capability names for it.
   *
   * Declared by the host because the host is what supplies the bytes: the local
   * CLI ships runtime packages and gets `python`, a Worker does not and must not
   * claim one. Derived rather than written out — see
   * `workspaceToolchainCapabilities` in vfs/workspace-runtimes.ts, which reads
   * the same list that decides which commands get registered.
   */
  toolchain?: readonly ExecutorCapability[];
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
  // Private fallback for callers that share no turn-scoped ledger (tests, the
  // identity bootstrap path) — stable across calls, so it still behaves like
  // ONE ledger for THIS executor's lifetime even though it is not turn-shared.
  const fallbackLedger = new TurnFileLedger();
  const fallbackBudget = new TurnContextBudget();
  const currentLedger = (): TurnFileLedger => deps.ledger?.() ?? fallbackLedger;
  const currentBudget = (): TurnContextBudget => deps.budget?.() ?? fallbackBudget;
  const currentFileDispatch = () => createFileDispatcher({
    vfs,
    ledger: currentLedger(),
    budget: currentBudget(),
    memory,
  });

  const tools: ExecutorProvider['tools'] = {
    readFile: {
      description: 'Read a file from the agent workspace. Returns content as string.',
      execute: async (...args: unknown[]) => {
        const p = parseInput(StringSchema, { value: args[0] });
        if (p === undefined) {
          return refusalText(new KinuError('bad_input', 'workspace.readFile: path must be a string'));
        }
        const content = await vfs.readFile(p, { encoding: 'utf8' });
        const text = v.parse(v.string(), content);
        // The caller now has the WHOLE file, exactly like a native `file`
        // action=write's read-before-overwrite check would record — a
        // subsequent native `file` edit on this path is not refused as blind.
        currentLedger().observeWhole(p, text);
        return text;
      },
    },

    writeFile: {
      description: 'Write content to a file. Creates a new file immediately; replacing an existing file requires readFile first. Creates parent directories automatically.',
      execute: async (...args: unknown[]) => {
        const p = parseInput(StringSchema, { value: args[0] });
        const text = parseInput(StringSchema, { value: args[1] });
        if (p === undefined) return refusalOf(new KinuError('bad_input', 'workspace.writeFile: path must be a string'));
        if (text === undefined) return refusalOf(new KinuError('bad_input', 'workspace.writeFile: content must be a string'));
        const result = await currentFileDispatch()({ action: 'write', path: p, content: text });
        const success = v.safeParse(FileWriteSuccessSchema, result);
        return success.success
          ? `Written ${success.output.bytes} bytes to ${success.output.path}`
          : result;
      },
    },

    editFile: {
      description: 'Replace exact text inside a file — old_text must occur exactly once and match what a prior readFile/writeFile/editFile here showed; refused if the file was never read/written in this scope or has changed since.',
      execute: async (...args: unknown[]) => {
        const path = parseInput(StringSchema, { value: args[0] });
        // `refusalOf`, not `refusalText`: this tool's declared result is already an
        // OBJECT carrying `reason` then `error`, so the classification travels as
        // the field the dispatcher's own refusals use rather than as JSON in a
        // string. What it replaces was an `{ error }` with no reason at all.
        if (path === undefined) return refusalOf(new KinuError('bad_input', 'workspace.editFile: path must be a string'));
        const list = parseInput(FileEditsSchema, { value: args[1] }) ?? [];
        // Built per call: the SAME dispatcher and ledger the native `file`
        // tool's edit action uses (createFileDispatcher, tools/file-tool.ts),
        // read live so an edit gated here refuses identically to a
        // native-tool edit over the SAME turn's read state — cheap
        // (closures only, no I/O), the same cost ConversationSearchStore accepts.
        return currentFileDispatch()({ action: 'edit', path, edits: list });
      },
    },

    readdir: {
      description: 'List entries in a directory.',
      execute: async (...args: unknown[]) => {
        const path = parseInput(OptionalPathSchema, { value: args[0] });
        // `[]` claimed the directory was empty. Nothing was read, so nothing is
        // known about the directory (AGENTS.md: an empty read stays
        // distinguishable from a failed one).
        if (args[0] !== undefined && path === undefined) {
          return refusalOf(new KinuError('bad_input', 'workspace.readdir: path must be a string'));
        }
        return vfs.readdir(path || '/');
      },
    },

    exists: {
      description: 'Check if a path exists.',
      execute: async (...args: unknown[]) => {
        const path = parseInput(StringSchema, { value: args[0] });
        // `false` claimed the path was absent — the same lie one line up.
        if (path === undefined) {
          return refusalOf(new KinuError('bad_input', 'workspace.exists: path must be a string'));
        }
        return vfs.exists(path);
      },
    },

    exec: {
      description:
        'Run a command in the workspace shell, over the SAME files readFile/readdir address. '
        + 'A real POSIX shell with ~95 coreutils, pipes, redirects, loops, variables and a working directory that persists across calls. '
        + 'Available binaries and process features are listed in this workspace provider’s capabilities; use sandbox or laptop only when the task needs that separate machine.',
      execute: async (...args: unknown[]) => {
        const command = parseInput(StringSchema, { value: args[0] });
        if (command === undefined) {
          return refusalText(new KinuError('bad_input', 'workspace.exec: command must be a string'));
        }
        const signal = readExecSignal({ context: args[1] });
        return formatExecResult(await shell.exec(command, signal ? { signal } : undefined));
      },
    },

    searchMemory: {
      description: 'Search long-term memory using FTS5 full-text search. Returns matching chunks.',
      execute: async (...args: unknown[]) => {
        const query = parseInput(StringSchema, { value: args[0] });
        if (query === undefined) {
          return refusalText(new KinuError('bad_input', 'workspace.searchMemory: query must be a string'));
        }
        const results = await memory.search(query, 10);
        if (results.length === 0) return 'No results found.';
        return results.map(r => `[${r.path}:${r.startLine}-${r.endLine}] (score ${r.score.toFixed(2)})\n${r.snippet}`).join('\n\n');
      },
    },

    saveNote: {
      description: 'Save a note to long-term memory (MEMORY.md). The note is FTS5-indexed for search.',
      execute: async (...args: unknown[]) => {
        const content = parseInput(StringSchema, { value: args[0] });
        return content === undefined
          ? refusalText(new KinuError('bad_input', 'workspace.saveNote: content must be a string'))
          : appendMemoryNote(memory, content);
      },
    },

    listTools: {
      description: 'List crafted tools as an array of { name, description, qualityScore }.',
      execute: async () => {
        // Return a real array so LLM code like `const tools = await workspace.listTools(); tools.filter(...)` works.
        // Previous implementation returned a joined markdown string and broke .filter/.map.
        const crafted = craftStore.list();
        // Pull quality scores. The columns live on the crafted_tools row the
        // store just wrote (identity/workspace-schema.ts ensures the shape),
        // so a read that fails is a broken database, not an unscored tool.
        const scoreByName = new Map<string, number>();
        if (sql) {
          const rows = sql<{ name: string; score: number }>`
            SELECT name, score FROM crafted_tools
          `;
          for (const r of rows) scoreByName.set(r.name, r.score);
        }
        return crafted.map(t => ({
          name: t.name,
          description: t.description,
          qualityScore: scoreByName.get(t.name) ?? CRAFT_NEUTRAL_PRIOR,
        }));
      },
    },

    createTool: {
      description:
        'Create or update a reusable tool in CraftStore. ' +
        'Code is JavaScript that denotes an async function: `async (args) => { ... }`, `async function name(args) { ... }`, or `const name = async (args) => { ... }` (helpers may precede it). ' +
        'Inside the body you may call `workspace.*`, `state.*`, other tools as `tools.<name>(...)`, `require(...)` and `fetch`. ' +
        'Callable as `tools.<name>(...)` from the NEXT execute_tools call on. ' +
        'Returns { ok, name, action: "created"|"updated" }.',
      execute: async (...args: unknown[]): Promise<JsonValue> => {
        const name = parseInput(StringSchema, { value: args[0] });
        const description = parseInput(StringSchema, { value: args[1] });
        const code = parseInput(StringSchema, { value: args[2] });
        if (!name || !description || !code) {
          return { ok: false, ...refusalOf(new KinuError('bad_input',
            'createTool requires name, description, and code arguments.')) };
        }
        let toolName = name.replace(/[^A-Za-z0-9_]/g, '_');
        if (!toolName) {
          return { ok: false, ...refusalOf(new KinuError('bad_input',
            'Tool name must contain at least one identifier character.')) };
        }
        if (/^[0-9]/.test(toolName)) toolName = '_' + toolName;
        if (isReservedCraftToolName(toolName)) {
          return { ok: false, ...refusalOf(new KinuError('bad_input',
            `Tool name "${toolName}" is reserved — it collides with a built-in tool or the mcp_ prefix owned by MCP tools. Pick a different name.`)) };
        }
        // Admission BEFORE any write: the source is normalized to one expression
        // and proven to parse, so a `const name = …` body can no longer be stored
        // verbatim and turn every later program in the workspace into a
        // SyntaxError. What parses but does not evaluate to a function is caught
        // per tool at load, and blamed on that tool alone.
        const admitted = admitCraftedSource(code, toolName);
        if (!admitted.ok) {
          return { ok: false, ...refusalOf(new KinuError('bad_input',
            `createTool("${toolName}"): ${admitted.error}`)) };
        }
        try {
          // Exact-name update is an upsert. A different name that matches
          // case-insensitively is a collision — reject with an actionable
          // error so the LLM picks a distinct identity.
          const existing = craftStore.get(toolName);
          const desc = description;
          const codeStr = admitted.code;
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
            // `denied`, which is the one code that exists for this: a GATE
            // refused and the work correctly never ran. It reached the census as
            // an unreasoned `{ ok: false, error }` — `returned_error`, filed under
            // `broke` — so the misevolution gate working was counted as a defect
            // in the tool it protected.
            return {
              ok: false,
              ...refusalOf(new KinuError('denied',
                `Misevolution veto (${misevolution.criterionId}): ${misevolution.reason} `
                + `Rewrite the tool body without it and call createTool again.`)),
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
              ...refusalOf(new KinuError('bad_input',
                `A tool named "${caseHit.name}" already exists `
                + `(case-insensitive match with "${toolName}"). `
                + `Either call that tool as tools.${caseHit.name}(...) or `
                + `pick a genuinely different name.`)),
            };
          }
          craftStore.create({
            name: toolName,
            description: desc,
            code: codeStr,
            scope: 'local',
            params: null,
          });
          // The column defaults seed the neutral prior inside the same INSERT,
          // so the decay + injection floor can see the new tool at all — one
          // statement, no second write to race it.
          // Optional eager notification; the hosted sandbox reads
          // craftStore.list() live on every program, so CF leaves this a no-op.
          onToolRegistered?.({ name: toolName, description: desc, code: codeStr });
          return { ok: true, name: toolName, action: 'created' };
        } catch (err) {
          // The craft store is SQLite in this agent's own object, so `io` is what
          // an unrecognised failure means here; a classified cause keeps its code.
          const failure = toKinuError({
            doing: `workspace.createTool ${toolName}`, cause: err, otherwise: 'io',
          });
          return { ok: false, ...refusalOf(failure) };
        }
      },
    },

    // Views sit here rather than on a top-level tool for the same reason
    // crafted tools do: this is the lane for artifacts the agent authors for
    // itself, ungated because the containment is the vocabulary rather than an
    // approval. A tenth tool would cost the cacheable prefix a full schema to
    // say what two lines of the codemode surface already say.
    createView: {
      description:
        'Publish a dashboard as a tab in the workspace UI. `spec` is declarative JSON — ' +
        'blocks are stat | table | list | kv | markdown | section, and every block reads from ' +
        'one of the allowed workspace RPCs. Upserts by name. Returns { ok, slug, version, action }.',
      execute: async (...args: unknown[]) => {
        // `unsupported`: a workspace built without a SQL store will not grow one
        // on a retry, which is the line between this and `unavailable`.
        if (!sql) {
          return { ok: false, ...refusalOf(new KinuError('unsupported',
            'This workspace has no SQL store, so views cannot be published.')) };
        }
        return createView({ vfs, sql }, args[0], args[1]);
      },
    },

    deleteView: {
      description: 'Remove a published view. Its versions stay in the changelog and can be restored.',
      execute: async (...args: unknown[]) => {
        if (!sql) {
          return { ok: false, ...refusalOf(new KinuError('unsupported',
            'This workspace has no SQL store, so views cannot be removed.')) };
        }
        const name = parseInput(StringSchema, { value: args[0] });
        const slug = viewSlug(name ?? '');
        if (!slug) {
          return { ok: false, ...refusalOf(new KinuError('bad_input',
            'A view name must contain at least one letter or digit.')) };
        }
        return deleteView({ vfs, sql }, slug);
      },
    },
  };

  const types = `declare namespace workspace {
  /**
   * A refused call, CLASS first: branch on \`reason\`, never on the prose.
   * \`empty_anchor\`/\`not_found\`/\`ambiguous\`/\`overlap\`/\`no_change\`/\`unread\`/
   * \`stale\` are the file plane's verdicts about an anchor or a read;
   * \`bad_input\`/\`missing\`/\`io\`/\`denied\`/\`unsupported\` are the classes every
   * tool in this runtime shares. This is exactly the vocabulary the durable
   * failure ledger reads, so anything you branch on here is what gets counted.
   */
  type Refusal = {
    reason: 'empty_anchor' | 'not_found' | 'ambiguous' | 'overlap' | 'no_change'
      | 'unread' | 'stale' | 'missing' | 'io' | 'bad_input' | 'denied' | 'unsupported';
    error: string;
  };
  function readFile(path: string): Promise<string>;
  function writeFile(path: string, content: string): Promise<string | Refusal>;
  /**
   * Replace exact text inside a file — old_text must occur exactly once,
   * copied verbatim (indentation and all) from what readFile/writeFile/
   * editFile last showed you here. Refused, touching nothing, if the file
   * was never read/written in this scope, has changed since, or old_text is
   * missing or not unique — the SAME enforcement the native \`file\` tool's
   * edit action applies, over the same read state (a native \`file\` read or
   * write of this path counts here too, and vice versa).
   */
  function editFile(
    path: string, edits: Array<{ old_text: string; new_text: string }>
  ): Promise<{ ok: boolean; path?: string; applied?: Array<{ line: number; removed_lines: number; added_lines: number }> } | Refusal>;
  function readdir(path: string): Promise<string[] | Refusal>;
  function exists(path: string): Promise<boolean | Refusal>;
  /**
   * Run a command in the workspace shell, over the SAME files the calls above
   * address. A real POSIX shell: ~95 coreutils, pipes, redirects, loops,
   * variables, and a working directory that persists across calls. Runtime,
   * process, and port support is declared by this provider's capabilities.
   */
  function exec(command: string): Promise<string>;
  function searchMemory(query: string): Promise<string>;
  function saveNote(content: string): Promise<string>;
  /** Returns Array<{name, description, qualityScore}> of crafted tools. */
  function listTools(): Promise<Array<{ name: string; description: string; qualityScore: number }>>;
  /**
   * Create or update a crafted tool. Callable as \`tools.<name>(args)\` on the NEXT
   * execute_tools call in this turn: the sandbox that created it is already built,
   * so the new tool is not in it. \`tools\` is the only namespace it is callable
   * in — the same one the native tools are in.
   * Name is sanitized to a valid JS identifier; original case preserved.
   */
  function createTool(
    name: string, description: string, code: string
  ): Promise<{ ok: true; name: string; action: 'created' | 'updated' } | ({ ok: false } & Refusal)>;
  /** Publish a dashboard tab in the workspace UI, upserting by name. The host
   *  draws it: no code, no HTML, no links, no images, nothing clickable.
   *  Every refusal carries \`reason\`; a spec or name the store rejects is
   *  \`bad_input\`. */
  function createView(name: string, spec: ViewSpec): Promise<{ ok: boolean; slug?: string; version?: number; error?: string; reason?: Refusal['reason'] }>;
  function deleteView(name: string): Promise<{ ok: boolean; error?: string; reason?: Refusal['reason'] }>;
  type ViewSpec = { v: 1; title: string; subtitle?: string; refreshMs?: number; blocks: ViewBlock[] };
  /** \`path\`/\`field\` are dotted paths into the RPC's result; omit for the whole result. */
  type ViewSource = { rpc: ${VIEW_DATA_SOURCES.map(s => `'${s}'`).join(' | ')}; limit?: number; path?: string };
  type ViewCell = { field: string; label: string; as?: 'text' | 'number' | 'badge' | 'time' };
  type ViewBlock =
    | { type: 'stat'; label: string; source: ViewSource; agg?: 'count' | 'value'; suffix?: string }
    | { type: 'table'; title?: string; source: ViewSource; columns: ViewCell[] }
    | { type: 'list'; title?: string; source: ViewSource; field?: string }
    | { type: 'kv'; title?: string; source: ViewSource; rows: ViewCell[] }
    | { type: 'markdown'; text: string }
    | { type: 'section'; title: string; blocks: Exclude<ViewBlock, { type: 'section' }>[] };
}`;

  const provider: ExecutorProvider = {
    name: 'workspace',
    kind: 'workspace',
    files: vfs,
    homeDir: async () => WORKSPACE_ROOT,
    capabilities: new Set<ExecutorCapability>([
      'javascript', 'typescript', 'shell', 'fs_shared', ...(deps.toolchain ?? []),
    ]),
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
  if (resourceLimits !== undefined) {
    Object.assign(provider, { resourceLimits });
  }
  return provider;
}
