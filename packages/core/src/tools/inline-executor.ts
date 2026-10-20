import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/** InlineExecutor: the `workspace.*` codemode provider over its workspace's shell, craft store and slates. */

import * as v from 'valibot';
import { commandTool, type ExecutorProvider, type ExecutorCapability, type PortAnsweringExecutor, type ResourceLimits } from '../execution/types';
import { shellCall } from '../execution/command-call';
import { nimbusSession, type NimbusSessionOpts } from '../execution/nimbus';
import type { FilesOwner } from '../safety/command-review';
import type { ShellSession } from '../execution/shell-session';
import type { ShellExecResult, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { CraftStore } from '../types/agent-runtime';
import { withVfsErrorHint } from '../vfs/errno';
import { isVfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { WORKSPACE_ROOT } from '../vfs/workspace-path';
import { commandAnswer, ExecPartsSchema } from '../execution/exec-result';
import { shellExecOptions } from '../execution/shell-session';
import { diagnostics, KinuError, refusalOf, settle, toKinuError } from '../obs/index';
import { Effect } from 'effect';
import { isReservedCraftToolName } from '../craft/in-episode';
import { craftPreference, craftPreferences, type CraftPreferenceRow } from '../craft/preference';
import { admitCraftedSource } from '../craft/source';
import { CRAFTED_TOOL_BODY, WORKSPACE_FILE_BINDINGS } from '../types/codemode';
import { checkMisevolutionForSurface, recordMisevolutionVeto } from '../safety/misevolution';
import { SlateOperationSchema, requireSlateWorkMode, type SlateOperation, type SlateCallResult } from '../slates/rpc';
import { currentWorkMode } from '../execution/work-mode';
import { TOOL_REACH } from './registry';
import { parseInput, type JsonValue } from '../utils/json';
import { addressingHint, cloudPlanes, type PathPlanes } from '../vfs/resolve';
import type { VfsMountRouting } from '../vfs/mounts';

const StringSchema = v.string();

/** `exec`'s options asking for the command's own output, not the text built from it. */

interface ShellExec {
  exec(command: string, opts?: { signal?: AbortSignal }): Promise<ShellExecResult>;
}

export interface InlineExecutorDeps {
  /** The plane the tools reach; `resolve` says where a path landed. */
  vfs: VFS & Partial<Pick<VfsMountRouting, 'resolve'>>;
  /** Absent: {@link WORKSPACE_ROOT}, the root's. */
  home?: string;
  /** Absent: the cloud's planes over `home`. */
  planes?: PathPlanes;
  /** The owner's files surface; absent: `vfs`, the plane the tools reach. */
  files?: VFS;
  craftStore: CraftStore;
  /** The agent's crafting setting, read per call; absent: on. */
  crafting?: () => boolean;
  shell: ShellExec;
  /** The declaration the host gated `shell` under. */
  filesOwner: FilesOwner;
  /** Measured limits of where `shell` really runs; none unless the host measured one. */
  resourceLimits?: ResourceLimits;
  /** Used to look up crafted-tool quality columns for listTools(). */
  sql?: SqlExecutor;
  /** Present exactly when `sql` is: vetoes land in actor-scoped `evolution_events`. */
  actor?: ActorHandle;
  /** Toolchain capabilities the shell can reach beyond coreutils, declared by the host. */
  toolchain?: readonly ExecutorCapability[];
  /** Capabilities the host can neither claim nor rule out; declared, since an omission reads as a measured absence. */
  unmeasured?: readonly ExecutorCapability[];
  /** The owning workspace's slate operations; absent when this backend has no slate host. */
  slate?: (operation: SlateOperation) => Promise<SlateCallResult>;
}

/** A path `workspace.*` found nothing at, or a directory it read as a file, says how paths are read here
 *  (`addressingHint`); code, errno and path are kept. */
function withVfsGuidance(planes: PathPlanes, tools: ExecutorProvider['tools']): ExecutorProvider['tools'] {
  const guided: ExecutorProvider['tools'] = {};

  for (const [name, entry] of Object.entries(tools)) {
    guided[name] = {
      ...entry,
      execute: async (...args: unknown[]) => {
        try {
          return await entry.execute(...args);
        } catch (err) {
          if (!isVfsError(err) || (err.code !== 'ENOENT' && err.code !== 'EISDIR')) throw err;
          throw withVfsErrorHint(err, addressingHint(planes));
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

/** The workspace executor's capabilities over the toolchain its host declares: its row's, and an inspection's of it. */
export function workspaceCapabilities(toolchain: readonly ExecutorCapability[] = []): Set<ExecutorCapability> {
  return new Set<ExecutorCapability>(['javascript', 'typescript', 'shell', 'fs_shared', ...toolchain]);
}

export function createInlineExecutor(deps: InlineExecutorDeps): ExecutorProvider {
  const { vfs, craftStore, shell, sql, actor, resourceLimits } = deps;

  // One place for where paths land and where the shell starts: its home, as files list from it too.
  const home = deps.home ?? WORKSPACE_ROOT;
  const planes = deps.planes ?? cloudPlanes(home);

  const tools: ExecutorProvider['tools'] = {
    // The workspace shell is gated itself (`withApprovalGatedShell`), on this same reading of the options.
    exec: commandTool(
      'Run a command in the workspace shell, over the SAME files `workspace.fs` reads and writes. '
        + 'A real POSIX shell with ~95 coreutils, pipes, redirects, loops and variables; each call starts fresh in `cwd` (default: your home) '
        + 'unless it names a shell, which keeps its directory and exported variables. '
        + 'Pass `parts: true` among the options to get `{ stdout, stderr, exitCode }` as the command wrote them, instead of the text. '
        + 'Available binaries and process features are listed in this workspace provider\'s capabilities; use sandbox or device only when the task needs that separate machine.',
      (args) => {
        const command = parseInput(StringSchema, { value: args[0] });

        if (command === undefined) return { refused: refusalOf(new KinuError('bad_input', 'workspace.exec: command must be a string')) };
        const options = shellExecOptions({ value: args[1] });

        return {
          call: shellCall(command, options, { stdin: true }),
          run: async () => commandAnswer(await shell.exec(command, options), v.is(ExecPartsSchema, args[1]), false),
        };
      },
    ),

    listTools: {
      planAllowed: true,
      description: 'List crafted tools, best first, as an array of { name, description, preference, broken }.',
      execute: async () => {
        // The columns exist on the crafted_tools row, so a failed read is a broken database.
        const rows = sql === undefined ? new Map<string, CraftPreferenceRow>() : craftPreferences(sql);
        const unrated = craftPreference({ offered: 0, chosen: 0, rated: 0, rating_sum: 0 });

        // A real array, so model code can `.filter`/`.map` it.
        return craftStore.list()
          .map((t) => {
            const row = rows.get(t.name);

            return { name: t.name, description: t.description, preference: row === undefined ? unrated : craftPreference(row), broken: row?.broken ?? null };
          })
          .sort((a, b) => b.preference - a.preference);
      },
    },

    retireTool: {
      description: 'Delete a crafted tool by name.',
      execute: (...args: unknown[]): Promise<JsonValue> => settle(Effect.gen(function* () {
        const name = parseInput(StringSchema, { value: args[0] });

        if (!name || craftStore.get(name) === undefined) {
          return yield* new KinuError('missing', `No crafted tool is named ${JSON.stringify(name ?? '')}.`);
        }

        craftStore.delete(name);

        return { name, action: 'retired' };
      })),
    },

    createTool: {
      description: CREATE_TOOL_CONTRACT,
      execute: async (...args: unknown[]): Promise<JsonValue> => {
        const name = parseInput(StringSchema, { value: args[0] });
        const description = parseInput(StringSchema, { value: args[1] });
        const code = parseInput(StringSchema, { value: args[2] });

        if (deps.crafting?.() === false) {
          return { ok: false, ...refusalOf(new KinuError('unavailable', 'Crafting is off for this agent: createTool makes no tool.')) };
        }

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

        if (!parsed.success) return refusalOf(new KinuError('bad_input',
          'workspace.slates received an operation outside its members', { cause: new v.ValiError(parsed.issues) }));
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
    homeDir: async () => planes.cwd,
    // The plane's own root: a relative path starts where the file plane starts it.
    fileRoot: async () => ({ root: '' }),
    capabilities: workspaceCapabilities(deps.toolchain),
    filesOwner: deps.filesOwner,
    isAvailable: () => true,
    connect: async () => {},
    disconnect: async () => {},
    tools: withVfsGuidance(planes, tools),
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
