/** InlineExecutor: the `workspace.*` codemode provider over its workspace's files, shell, memory and craft store. */

import * as v from 'valibot';
import type { ExecutorProvider, ExecutorCapability, PortAnsweringExecutor, ResourceLimits } from '../execution/types';
import { nimbusSession, type NimbusSessionOpts } from '../execution/nimbus';
import type { FilesOwner, ShellSession } from '../safety/approval-gate';
import type { VFS, Memory, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { CraftStore } from '../types/agent-runtime';
import { appendMemoryNote } from '../memory/note';
import { isVfsError, vfsAddressingHint, withVfsErrorHint } from '../vfs/errno';
import { WORKSPACE_ROOT } from '../vfs/workspace-path';
import { readExecSignal } from '../execution/signal';
import { commandResult, existsTool } from '../execution/exec-result';
import { diagnostics, KinuError, refusalOf, toKinuError } from '../obs/index';
import { CRAFT_NEUTRAL_PRIOR, isReservedCraftToolName } from '../craft/in-episode';
import { admitCraftedSource } from '../craft/source';
import { checkMisevolutionForSurface, recordMisevolutionVeto } from '../safety/misevolution';
import { SlateOperationSchema, requireSlateWorkMode, type SlateOperation, type SlateCallResult } from '../slates/rpc';
import { currentWorkMode } from '../execution/work-mode';
import { TOOL_REACH } from './registry';
import { createFileDispatcher } from './file-tool';
import { TurnFileLedger } from '../vfs/file-ledger';
import { branchableToolCall } from './outcome';
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
  /** The declaration the host gated `shell` under. */
  filesOwner: FilesOwner;
  /** Measured limits of where `shell` really runs; none unless the host measured one. */
  resourceLimits?: ResourceLimits;
  /** Used to look up crafted-tool quality columns for listTools(). */
  sql?: SqlExecutor;
  /** Present exactly when `sql` is: vetoes land in actor-scoped `evolution_events`. */
  actor?: ActorHandle;
  /**
   * The turn's read/edit ledger, shared with the native `file` tool so both enforce one read-before-write gate.
   * A thunk because the ledger resets per turn and this executor is built earlier; undefined → private ledger.
   */
  ledger?: () => TurnFileLedger | undefined;
  /** Shared like `ledger`; required by the shared dispatcher's deps shape. */
  budget?: () => TurnContextBudget | undefined;
  /** Toolchain capabilities the shell can reach beyond coreutils, declared by the host (see `workspaceToolchainCapabilities`). */
  toolchain?: readonly ExecutorCapability[];
  /** Capabilities the host can neither claim nor rule out; declared, since an omission reads as a measured absence. */
  unmeasured?: readonly ExecutorCapability[];
  /** The owning workspace's slate operations; absent when this backend has no slate host. */
  slate?: (operation: SlateOperation) => Promise<SlateCallResult>;
}

/** Every VFS error out of `workspace.*` gets vfsAddressingHint; code, errno and path are kept. */
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
  // Fallback for callers with no turn-scoped ledger; stable for this executor's lifetime.
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
          return refusalOf(new KinuError('bad_input', 'workspace.readFile: path must be a string'));
        }

        const content = await vfs.readFile(p, { encoding: 'utf8' });
        const text = v.parse(v.string(), content);
        // The caller now has the whole file, so a later `file` edit on this path is not blind.
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

        if (path === undefined) return refusalOf(new KinuError('bad_input', 'workspace.editFile: path must be a string'));
        const list = parseInput(FileEditsSchema, { value: args[1] }) ?? [];

        // Same dispatcher and ledger as the native `file` edit, read live per call.
        return branchableToolCall(() => currentFileDispatch()({ action: 'edit', path, edits: list }));
      },
    },

    readdir: {
      planAllowed: true,
      description: 'List entries in a directory.',
      execute: async (...args: unknown[]) => {
        const path = parseInput(OptionalPathSchema, { value: args[0] });

        // Nothing was read, so do not report empty (AGENTS.md: empty read ≠ failed read).
        if (args[0] !== undefined && path === undefined) {
          return refusalOf(new KinuError('bad_input', 'workspace.readdir: path must be a string'));
        }

        // A path that is absent or blank names the workspace root.
        return vfs.readdir(path === undefined || path === '' ? '/' : path);
      },
    },

    exists: existsTool(vfs, { description: 'Check if a path exists.', operation: 'workspace.exists' }),


    exec: {
      description:
        'Run a command in the workspace shell, over the SAME files readFile/readdir address. '
        + 'A real POSIX shell with ~95 coreutils, pipes, redirects, loops, variables and a working directory that persists across calls. '
        + 'Available binaries and process features are listed in this workspace provider’s capabilities; use sandbox or device only when the task needs that separate machine.',
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
          return refusalOf(new KinuError('bad_input', 'workspace.searchMemory: query must be a string'));
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
          ? refusalOf(new KinuError('bad_input', 'workspace.saveNote: content must be a string'))
          : appendMemoryNote(memory, content, { by: actor?.name });
      },
    },

    listTools: {
      planAllowed: true,
      description: 'List crafted tools as an array of { name, description, qualityScore }.',
      execute: async () => {
        // A real array, so model code can `.filter`/`.map` it.
        const crafted = craftStore.list();
        // The columns exist on the crafted_tools row, so a failed read is a broken database.
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
        'Callable as `tools.<name>(...)` from the NEXT eval call on. ' +
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

        // Admission precedes every write: normalize to one expression and prove it parses.
        const admitted = admitCraftedSource(code, toolName);

        if (!admitted.ok) {
          return { ok: false, ...refusalOf(new KinuError('bad_input',
            `createTool("${toolName}"): ${admitted.error}`)) };
        }

        try {
          // Exact-name update is an upsert; a case-insensitive match on another name is a collision.
          const existing = craftStore.get(toolName);
          const desc = description;
          const codeStr = admitted.code;
          // Misevolution gate on the `craft_tool` surface, without `network-egress` (see SURFACE_CRITERIA).
          const misevolution = checkMisevolutionForSurface({ code: codeStr }, 'craft_tool');

          if (!misevolution.ok) {
            if (sql && actor) {
              recordMisevolutionVeto(sql, actor, {
                surface: 'craft_tool', violation: misevolution,
                detail: `workspace.createTool("${toolName}") rejected`,
              });
            }
            else {
              // Reported, never dropped: recording a veto needs both the store and the actor.
              diagnostics.failure('misevolution.veto_unrecorded', new KinuError(
                'unavailable',
                'a misevolution veto fired with no actor-scoped store to record it against',
              ), { surface: 'craft_tool', criterion: misevolution.criterionId, tool: toolName });
            }

            // `denied`: a gate refused and the work correctly never ran.
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

          // Column defaults seed the neutral prior in the same INSERT, so decay and injection floor see the tool.
          return { ok: true, name: toolName, action: 'created' };
        } catch (err) {
          // The craft store is local SQLite, so an unrecognised failure is `io`.
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
    // Captured and shadowed by `bindSlates`.
    tools.slates = {
      planAllowed: true,
      description: 'The slate operations behind the workspace.slates members.',
      execute: async (...args: unknown[]): Promise<JsonValue> => {
        const parsed = v.safeParse(SlateOperationSchema, args[0]);

        if (!parsed.success) return { success: false, ...refusalOf(new KinuError('bad_input',
          'workspace.slates received an operation outside its members', { cause: new v.ValiError(parsed.issues) })) };
        requireSlateWorkMode(parsed.output, currentWorkMode());
        const result = await slate(parsed.output);

        return result.ok ? result.value : { success: false, reason: result.reason, error: result.error };
      },
    };
  }

  const types = `/** Your workspace: the files the \`file\` tool reads and the \`workspace\` shell. */
declare namespace workspace {
  function readFile(path: string): Promise<string | Refusal>;
  function writeFile(path: string, content: string): Promise<string | Refusal>;
  /** The \`file\` tool's edit, over the same read state: read the file first; each old_text is copied verbatim and occurs once. */
  function editFile(
    path: string, edits: Array<{ old_text: string; new_text: string }>
  ): Promise<{ ok: boolean; path?: string; applied?: Array<{ line: number; removed_lines: number; added_lines: number }> } | Refusal>;
  function readdir(path: string): Promise<string[] | Refusal>;
  function exists(path: string): Promise<boolean | Refusal>;
  /** The workspace shell; its working directory persists across calls. */
  function exec(command: string): Promise<string | Refusal>;
  function searchMemory(query: string): Promise<string | Refusal>;
  function saveNote(content: string): Promise<string | Refusal>;
  /** Your crafted tools. */
  function listTools(): Promise<Array<{ name: string; description: string; qualityScore: number }> | Refusal>;
  /** Save a crafted tool, callable as \`tools.<name>(args)\` from the next program. */
  function createTool(
    name: string, description: string, code: string
  ): Promise<{ ok: true; name: string; action: 'created' | 'updated' } | Refusal>;
  ${slate === undefined ? '' : `/**
   * Slates in this workspace; read /skills/slates/SKILL.md before authoring one. \`workspace.slates.<id>\`
   * is the slate's server class: \`await workspace.slates.board.addStroke(stroke)\` runs its \`addStroke\`.
   */
  type SlateValue = null | boolean | number | string | SlateValue[] | { [key: string]: SlateValue };
  interface Slate {
    [method: string]: (...args: SlateValue[]) => Promise<SlateValue | Refusal>;
    /** Compile and boot it; a compile error is \`bad_input\` naming file and line. */
    $preview(): Promise<{ url: string; port: number; inline: { height: number } } | Refusal>;
    $methods(): Promise<string[] | Refusal>;
    /** Freeze its source as a version. */
    $commit(): Promise<SlateValue | Refusal>;
    $history(): Promise<SlateValue | Refusal>;
    $restore(version: string): Promise<SlateValue | Refusal>;
    /** End its process, URL, storage and files; committed versions stay. */
    $remove(): Promise<SlateValue | Refusal>;
    /** Sharing, workspace root only. */
    $inspect(version: string, include?: string[]): Promise<SlateValue | Refusal>;
    $publish(version: string, include?: string[]): Promise<SlateValue | Refusal>;
    $share(options: { visibility: 'users' | 'public'; approved: Array<{ slate: string; binding: string; member: string }>; fork?: boolean }): Promise<SlateValue | Refusal>;
    $graph(): Promise<SlateValue | Refusal>;
  }
  const slates: { readonly [id: string]: Slate } & {
    /** Every slate, and why any failed to load. */
    $list(): Promise<{ slates: Array<{ id: string; title: string; bindings: string[] }>; problems: Array<{ id: string; reason: string; error: string }> } | Refusal>;
    /** A committed version copied into a new slate. */
    $fork(version: string): Promise<SlateValue | Refusal>;
    /** Sharing, workspace root only. */
    $shares(): Promise<SlateValue | Refusal>;
    $liveShares(): Promise<SlateValue | Refusal>;
    $unshare(share: string): Promise<SlateValue | Refusal>;
    $viewerRequests(share: string): Promise<SlateValue | Refusal>;
  };
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
    filesOwner: deps.filesOwner,
    isAvailable: () => true,
    connect: async () => {},
    disconnect: async () => {},
    tools: withVfsGuidance(vfs, tools),
    types,
    positionalArgs: true,
    // No inbound TCP surface here; Worker slates use their separate host.
    async exposePort(port) {
      return {
        supported: false,
        reason:
          `workspace executor runs in the Worker and cannot expose inbound ports. ` +
          `Use an available preview-capable executor for a Node/Vite server (port ${port}). ` +
          `For an authored Worker slate, call workspace.slates.<id>.$preview().`,
      };
    },
    async unexposePort() { /* nothing to do */ },
    async listExposedPorts() { return []; },
  };

  if (resourceLimits !== undefined) {
    Object.assign(provider, { resourceLimits });
  }

  if (deps.unmeasured !== undefined) {
    Object.assign(provider, { unmeasuredCapabilities: new Set(deps.unmeasured) });
  }

  return provider;
}

export interface NimbusWorkspaceExecutorOpts extends NimbusSessionOpts {
  inline: Omit<InlineExecutorDeps, 'filesOwner'>;
  shellSession?: ShellSession;
}

/** Kinu's durable workspace tools plus the same Nimbus session's process/runtime/port surface, registered once as `workspace`. */
export function createNimbusWorkspaceExecutor(opts: NimbusWorkspaceExecutorOpts): PortAnsweringExecutor {
  const inline = createInlineExecutor({ ...opts.inline, filesOwner: 'agent' });
  const session = nimbusSession(opts);

  const provider: PortAnsweringExecutor = {
    ...inline,
    capabilities: new Set<ExecutorCapability>([...inline.capabilities, ...session.capabilities]),
    getStatus: session.getStatus,
    connect: session.connect,
    disconnect: session.disconnect,
    tools: { ...inline.tools, ...session.tools },
    types: (inline.types ?? '').replace(/\n}\s*$/, `${session.types}\n}`),
    exposePort: session.exposePort,
    unexposePort: session.unexposePort,
    listExposedPorts: session.listExposedPorts,
  };

  return opts.shellSession === undefined ? provider : { ...provider, shellSession: opts.shellSession };
}
