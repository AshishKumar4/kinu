import { readText, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
/** InlineExecutor: the `workspace.*` codemode provider over its workspace's files, shell, memory and craft store. */

import * as v from 'valibot';
import type { ExecutorProvider, ExecutorCapability, PortAnsweringExecutor, ResourceLimits } from '../execution/types';
import { nimbusSession, type NimbusSessionOpts } from '../execution/nimbus';
import type { FilesOwner } from '../safety/command-review';
import type { ShellSession } from '../execution/shell-session';
import type { Memory, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { CraftStore } from '../types/agent-runtime';
import { vfsAddressingHint } from '@kinu.run/agent-utils/vfs';
import { withVfsErrorHint } from '../vfs/errno';
import { isVfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { WORKSPACE_ROOT } from '../vfs/workspace-path';
import { commandResult, existsTool } from '../execution/exec-result';
import { shellExecOptions } from '../execution/shell-session';
import { diagnostics, KinuError, refusalOf, toKinuError } from '../obs/index';
import { CRAFT_NEUTRAL_PRIOR, isReservedCraftToolName } from '../craft/in-episode';
import { admitCraftedSource } from '../craft/source';
import { CRAFTED_TOOL_BODY, WORKSPACE_FILE_BINDINGS } from '../types/codemode';
import { checkMisevolutionForSurface, recordMisevolutionVeto } from '../safety/misevolution';
import { SlateOperationSchema, requireSlateWorkMode, type SlateOperation, type SlateCallResult } from '../slates/rpc';
import { currentWorkMode } from '../execution/work-mode';
import { TOOL_REACH } from './registry';
import { serveFile } from './file-operations';
import { TurnFileLedger } from '../vfs/file-ledger';
import { branchableToolCall } from './outcome';
import { TurnContextBudget } from '../context-budget';
import type { JsonValue } from '../utils/json';
import { cloudPlanes, type PathPlanes } from '../vfs/resolve';
import { SlateBuildNoteSchema } from '../operations/file';

const StringSchema = v.string();

const OptionalPathSchema = v.optional(v.string());

const FileWriteSuccessSchema = v.object({
  path: v.string(),
  bytes: v.number(),
  action: v.picklist(['created', 'replaced']),
  undo: v.optional(v.string()),
  build: v.optional(SlateBuildNoteSchema),
});

/** A written slate file's build, as a line of the answer. */
function buildLine(build: v.InferOutput<typeof SlateBuildNoteSchema>): string {
  return build.builds ? `The slate ${build.slate} builds.` : `The slate ${build.slate} does not build; the user still sees its last working version:\n${build.error ?? ''}`;
}

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
  /** Absent: {@link WORKSPACE_ROOT}, the root's. */
  home?: string;
  /** Absent: the cloud's planes over `home`. */
  planes?: PathPlanes;
  /** The owner's files surface; absent: `vfs`, the plane the tools reach. */
  files?: VFS;
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
  /** The turn's read-before-write ledger, shared with the native `file` tool; a thunk, as it resets per turn.
   *  Undefined: a private one. */
  ledger?: () => TurnFileLedger | undefined;
  /** Shared like `ledger`; required by the shared dispatcher's deps shape. */
  budget?: () => TurnContextBudget | undefined;
  /** Toolchain capabilities the shell can reach beyond coreutils, declared by the host. */
  toolchain?: readonly ExecutorCapability[];
  /** Capabilities the host can neither claim nor rule out; declared, since an omission reads as a measured absence. */
  unmeasured?: readonly ExecutorCapability[];
  /** The owning workspace's slate operations; absent when this backend has no slate host. */
  slate?: (operation: SlateOperation) => Promise<SlateCallResult>;
  /** Whether a slate still builds, for the write a program makes into one; a check, never a preview. */
  slateBuild?: (slate: string) => Promise<SlateCallResult>;
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

/** The one statement of what `createTool` takes, rendered into the declaration the model reads. */
const CREATE_TOOL_CONTRACT = 'Save a crafted tool, callable as `tools.<name>(args)` from the next program. `code` is '
  + `${CRAFTED_TOOL_BODY}; helpers may precede it. In its body, ${WORKSPACE_FILE_BINDINGS}, and call `
  + '`tools.<name>(args)`; `require`, `import` and `eval` are refused.';

export function createInlineExecutor(deps: InlineExecutorDeps): ExecutorProvider {
  const { vfs, memory, craftStore, shell, sql, actor, resourceLimits } = deps;
  // Fallback for callers with no turn-scoped ledger; stable for this executor's lifetime.
  const fallbackLedger = new TurnFileLedger();
  const fallbackBudget = new TurnContextBudget();
  const currentLedger = (): TurnFileLedger => deps.ledger?.() ?? fallbackLedger;
  const currentBudget = (): TurnContextBudget => deps.budget?.() ?? fallbackBudget;

  // The native `file` tool's write, on the same ledger read live per call.
  const fileWrite = serveFile(() => ({
    vfs, home: deps.home ?? WORKSPACE_ROOT, planes: deps.planes ?? cloudPlanes(deps.home ?? WORKSPACE_ROOT), ledger: currentLedger(), budget: currentBudget(), memory,
    ...(deps.slateBuild !== undefined && { slateBuild: deps.slateBuild }),
  })).write;

  const tools: ExecutorProvider['tools'] = {
    readFile: {
      planAllowed: true,
      description: 'Read a file from the agent workspace. Returns content as string.',
      execute: async (...args: unknown[]) => {
        const p = parseInput(StringSchema, { value: args[0] });

        if (p === undefined) {
          return refusalOf(new KinuError('bad_input', 'workspace.readFile: path must be a string'));
        }

        const content = await readText(vfs, p);
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
        const result = await branchableToolCall(async () => (await fileWrite.run({ path: p, content: text }, { callId: 'workspace.writeFile' })).value);
        const success = v.safeParse(FileWriteSuccessSchema, result);

        if (!success.success) return result;
        const { bytes, path, undo, build } = success.output;

        return [`Written ${bytes} bytes to ${path}`, ...(undo === undefined ? [] : [undo]), ...(build === undefined ? [] : [buildLine(build)])].join('\n');
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
        return Promise.resolve(vfs.readdir(path === undefined || path === '' ? '/' : path)).then(entries => entries.map(({ name }) => name));
      },
    },

    exists: existsTool(vfs, { description: 'Check if a path exists.', operation: 'workspace.exists' }),


    exec: {
      description:
        'Run a command in the workspace shell, over the SAME files readFile/readdir address. '
        + 'A real POSIX shell with ~95 coreutils, pipes, redirects, loops and variables; each call starts fresh in `cwd` (default: your home) '
        + 'unless it names a shell, which keeps its directory and exported variables. '
        + 'Available binaries and process features are listed in this workspace provider\'s capabilities; use sandbox or device only when the task needs that separate machine.',
      execute: async (...args: unknown[]) => {
        const command = parseInput(StringSchema, { value: args[0] });

        if (command === undefined) {
          return refusalOf(new KinuError('bad_input', 'workspace.exec: command must be a string'));
        }

        return commandResult(await shell.exec(command, shellExecOptions({ value: args[1] })));
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
      description: CREATE_TOOL_CONTRACT,
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
            `Tool name "${toolName}" is reserved: it collides with a built-in tool or the mcp_ prefix owned by MCP tools. Pick a different name.`)) };
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
                `Misevolution veto (${misevolution.criterionId}): ${misevolution.reason}. Rewrite the tool body without it: `
                + `${WORKSPACE_FILE_BINDINGS}, and call other tools as \`tools.<name>(args)\`.`)),
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

  const provider: ExecutorProvider = {
    name: TOOL_REACH.slate.codemode,
    kind: 'workspace',
    files: deps.files ?? vfs,
    homeDir: async () => WORKSPACE_ROOT,
    capabilities: new Set<ExecutorCapability>([
      'javascript', 'typescript', 'shell', 'fs_shared', ...(deps.toolchain ?? []),
    ]),
    filesOwner: deps.filesOwner,
    isAvailable: () => true,
    connect: async () => {},
    disconnect: async () => {},
    tools: withVfsGuidance(vfs, tools),
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
    exposePort: session.exposePort,
    unexposePort: session.unexposePort,
    listExposedPorts: session.listExposedPorts,
  };

  return opts.shellSession === undefined ? provider : { ...provider, shellSession: opts.shellSession };
}
