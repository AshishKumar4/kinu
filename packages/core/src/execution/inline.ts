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
 *   workspace.slate({ op: 'list' })
 */

import * as v from 'valibot';
import type { ExecutorProvider, ExecutorCapability, ResourceLimits } from './types';
import type { VFS, Memory, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { CraftStore } from '../types/agent-runtime';
import { appendMemoryNote } from '../memory/note';
import { isVfsError, vfsAddressingHint, withVfsErrorHint } from '../vfs/errno';
import { WORKSPACE_ROOT } from '../vfs/workspace-path';
import { readExecSignal } from './signal';
import { commandResult, COMMAND_RESULT_TYPE, refusalText } from './exec-result';
import { diagnostics, ERROR_CODES, KinuError, refusalOf, toKinuError } from '../obs/index';
import { CRAFT_NEUTRAL_PRIOR, isReservedCraftToolName } from '../craft/in-episode';
import { admitCraftedSource } from '../craft/source';
import { checkMisevolutionForSurface, recordMisevolutionVeto } from '../scaffold/misevolution';
import { SlateOperationSchema, requireSlateWorkMode, type SlateOperation, type SlateCallResult } from '../slates/rpc';
import { SLATE_READ_MODELS } from '../slates/read-models';
import { currentWorkMode } from './work-mode';
import { TOOL_REACH } from '../tools/registry';
import { createFileDispatcher } from '../tools/file-tool';
import { TurnFileLedger } from '../tools/file-ledger';
import { branchableToolCall } from '../tools/outcome';
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
  /** Whose executor. Present exactly when `sql` is: the misevolution veto this
   *  writes lands in `evolution_events`, which is actor-scoped, so a veto with
   *  no owner would be filed against whoever read the stream next. */
  actor?: ActorHandle;
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
   * ledger at all (a hosted head or swarm node): the caller can supply
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
  /** The owning workspace's slate operations; absent when this backend has no slate host. */
  slate?: (operation: SlateOperation) => Promise<SlateCallResult>;
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
  const { vfs, memory, craftStore, shell, sql, actor, resourceLimits } = deps;
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
      planAllowed: true,
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
        const result = await branchableToolCall(() => currentFileDispatch()({ action: 'write', path: p, content: text }));
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
        // string. A bare `{ error }` would carry no reason at all.
        if (path === undefined) return refusalOf(new KinuError('bad_input', 'workspace.editFile: path must be a string'));
        const list = parseInput(FileEditsSchema, { value: args[1] }) ?? [];
        // Built per call: the SAME dispatcher and ledger the native `file`
        // tool's edit action uses (createFileDispatcher, tools/file-tool.ts),
        // read live so an edit gated here refuses identically to a
        // native-tool edit over the SAME turn's read state — cheap
        // (closures only, no I/O), the same cost ConversationSearchStore accepts.
        return branchableToolCall(() => currentFileDispatch()({ action: 'edit', path, edits: list }));
      },
    },

    readdir: {
      planAllowed: true,
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
      planAllowed: true,
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
          return refusalOf(new KinuError('bad_input', 'workspace.exec: command must be a string'));
        }
        const signal = readExecSignal({ context: args[1] });
        return commandResult(await shell.exec(command, signal ? { signal } : undefined));
      },
    },

    searchMemory: {
      planAllowed: true,
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
      planAllowed: true,
      description: 'List crafted tools as an array of { name, description, qualityScore }.',
      execute: async () => {
        // Return a real array so LLM code like `const tools = await workspace.listTools(); tools.filter(...)` works.
        // A joined markdown string has no .filter/.map and would break that call.
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
        // Admission precedes every write: normalize the source to one
        // expression and prove that it parses. The per-tool loader checks that
        // the expression evaluates to a function and attributes a load failure
        // to that tool.
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
            if (sql && actor) {
              recordMisevolutionVeto(sql, actor, {
                surface: 'craft_tool', violation: misevolution,
                detail: `workspace.createTool("${toolName}") rejected`,
              });
            }
            else {
              // REPORTED, never dropped. `evolution_events` is actor-scoped, so
              // recording a veto needs both the store and the actor whose row it
              // is; an executor built with one and not the other cannot write it.
              // Silence here would be the worst arm available: the gate fires,
              // the tool is refused, and the workspace's own audit of what its
              // gates refused has a hole in it that nothing reports. The refusal
              // below is unaffected — this says only that the RECORD is missing.
              diagnostics.failure('misevolution.veto_unrecorded', new KinuError(
                'unavailable',
                'a misevolution veto fired with no actor-scoped store to record it against',
              ), { surface: 'craft_tool', criterion: misevolution.criterionId, tool: toolName });
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
  };
  const slate = deps.slate;
  if (slate !== undefined) {
    tools.slate = {
      planAllowed: true,
      description: 'Manage an authored slate: list, preview, call a POST route, commit source, history, fork a version, or restore source.',
      execute: async <Input>(input: Input): Promise<JsonValue> => {
        const parsed = v.safeParse(SlateOperationSchema, input);
        if (!parsed.success) return { ok: false, ...refusalOf(new KinuError('bad_input',
          'workspace.slate expects a named op and its declared fields', { cause: new v.ValiError(parsed.issues) })) };
        requireSlateWorkMode(parsed.output, currentWorkMode());
        const result = await slate(parsed.output);
        return result.ok ? { ok: true, value: result.value } : { ok: false, reason: result.reason, error: result.error };
      },
    };
  }

  const types = `declare namespace workspace {
  /**
   * A refused call, CLASS first: branch on \`reason\`, never on the prose.
   * \`empty_anchor\`/\`not_found\`/\`ambiguous\`/\`overlap\`/\`no_change\`/\`unread\`/
   * \`stale\` are the file plane's verdicts about an anchor or a read;
   * the remaining reasons are the shared runtime failure codes.
   */
  type Refusal = {
    reason: 'empty_anchor' | 'not_found' | 'ambiguous' | 'overlap' | 'no_change'
      | 'unread' | 'stale' | ${ERROR_CODES.map((code) => JSON.stringify(code)).join(' | ')};
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
  function exec(command: string): Promise<${COMMAND_RESULT_TYPE}>;
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
  ${slate === undefined ? '' : `/**
   * Prefer a slate for dashboards, live-data views and workspace UI; use a full app
   * toolchain when the user asks for a standalone, ship-ready web application.
   * A slate is /home/user/slates/<id>/package.json and an authored JS/TS tree.
   * package.json main names a Worker module exporting default { fetch(request, env) }.
   * The strict slate field declares {title?,port?,runtime?:'worker',bindings?:Record<NAME,Binding>}.
   * Binding = {kind:'namespace',namespace:string,members?:string[]}
   *         | {kind:'rpc',methods:string[]} // read models: ${SLATE_READ_MODELS.join(', ')}
   *         | {kind:'mcp',server:string,tools?:string[]}
   *         | {kind:'app',id:string}.
   * A binding passes YOUR capability into env.NAME.member(...args), gated exactly as your own call.
   * Serve UI from fetch; app calls POST a JSON argument array to /<method> and receive JSON.
   * Call workspace.slate({op:"preview",id}) directly to compile and boot the Worker.
   * This does not use workspace node; no node import precheck or commit is needed.
   * On success read value.url. On refusal inspect reason/error and fix that cause.
   * Keep durable application data in admitted bindings, not process memory.
   * A preview boots on demand and its running process is never durable. Commit freezes source;
   * fork copies a committed version; restore changes source, not deployment history.
   */
  type SlateValue = null | boolean | number | string | SlateValue[] | { [key: string]: SlateValue };
  function slate(input: { op: 'preview'; id: string }): Promise<{ ok: true; value: { url: string; port: number } } | ({ ok: false } & Refusal)>;
  function slate(input:
    | { op: 'list' }
    | { op: 'commit' | 'history'; id: string }
    | { op: 'call'; id: string; method: string; args?: SlateValue[] }
    | { op: 'fork'; version: string }
    | { op: 'restore'; id: string; version: string }
  ): Promise<{ ok: true; value: SlateValue } | ({ ok: false } & Refusal)>;
`}
}`;

  const provider: ExecutorProvider = {
    name: TOOL_REACH.slate.codemode,
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
    // This fallback has no inbound TCP surface. Hosted composition supplies
    // its own process/port methods; Worker slates use their separate host.
    async exposePort(port) {
      return {
        supported: false,
        reason:
          `workspace executor runs in the Worker and cannot expose inbound ports. ` +
          `Use an available preview-capable executor for a Node/Vite server (port ${port}). ` +
          `For an authored Worker slate, use its declared slate preview operation when available.`,
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
