/**
 * The `eval` codemode tool, shared by every CF actor with a runtime. Crafted tools are re-read
 * from the surface on every call, so a tool saved mid-turn is callable on the next program.
 */

import * as v from 'valibot';
import { createCodeTool } from "@cloudflare/codemode/ai";
import { type Tool } from 'ai';
import { DESKTOP_MEMBERS, execCallArgs, execContext, readDeviceRequestChannel, scopedTurnSurface, SlateProgramSchema, type CodemodeSurface, type DeviceRequestChannel, type ExecutorProviderSurface } from "@kinu.run/core";
import { renderCodemodeDescription, nativeToolFunctions, programSurface, servedImpacts, CRAFTED_TOOL_NAMESPACE, type CodemodeProvider, type WorkMode, currentWorkMode, permitInPlan, withCraftedToolDeclarations, codemodeInputSchema, withCodemodeProgram, codemodeFunction, JsonValueSchema, type JsonObject, type JsonValue, type ToolSurfaceNarrowing } from "@kinu.run/core";
import { KinuError } from '@kinu.run/core/obs';
import {
  KinuSandboxExecutor, renderToolsPrelude, type ProgramLaunch,
} from "./codemode-sandbox";

/** One actor's program launcher; what each program reaches is its call's `CodemodeScope`. */
export interface CodemodeFactoryOptions {
  launch: (online: boolean) => ProgramLaunch;
  workspace: string;
  onExecutorUsed?: (name: string) => void;
}

/** What one call's programs reach. */
export interface CodemodeScope {
  /** The actor's namespaces (`actorNamespaces`), built per program with each executor wrapped as given. */
  readonly namespaces: (executor: (provider: ExecutorProviderSurface) => ExecutorProviderSurface) => CodemodeProvider[];
  /** Which namespaces the turn's role or allowed tools reach: none is bound past it. */
  readonly reach: ToolSurfaceNarrowing;
  /** Asked before each member a program reaches runs, by namespace and member; it throws to refuse. */
  readonly nested?: (namespace: string, member: string) => void;
}

export interface CodemodeFactory {
  toolFor(surface: CodemodeSurface, scope: CodemodeScope): Tool;
  callTool(surface: CodemodeSurface, name: string, input: JsonObject, scope: CodemodeScope): Promise<JsonValue | undefined>;
}

/** `provider` with each member asking `nested` before it runs. */
function guarded(provider: CodemodeProvider, nested: (namespace: string, member: string) => void): CodemodeProvider {
  return {
    ...provider,
    tools: Object.fromEntries(Object.entries(provider.tools).map(([member, entry]) => [member, {
      ...entry,
      execute: async (...args: Parameters<typeof entry.execute>) => {
        nested(provider.name, member);

        return await entry.execute(...args);
      },
    }])),
  };
}

/** One program's own: what stops it, the device requests it owns, and the turn it runs in, each absent outside one. */
interface ProgramContext {
  readonly stop?: AbortSignal;
  readonly channel?: DeviceRequestChannel;
  readonly turn?: string;
}

export function createCodemodeToolFactory(options: CodemodeFactoryOptions): CodemodeFactory {
  // Each executor as one program calls it, built per program: its calls arrive over RPC, outside its async context, and
  // a program moved to the background keeps calling while the next one runs, so each call carries its own program's
  // stop and channel. The channel is read per call: a detach changes the owning job mid-program.
  const programExecutor = (program: ProgramContext) => (p: ExecutorProviderSurface): ExecutorProviderSurface => {
    const { stop: programStop, channel: deviceRequests, turn } = program;
    const wrapped: typeof p.tools = {};

    for (const [name, entry] of Object.entries(p.tools)) {
      // Only `exec` mints a durable device-request identity, and it reads context from the second positional arg.
      const carriesOwnership = name === 'exec' && p.positionalArgs === true;
      // A desktop call, named input then context, stops with its program and is refused once it was moved away.
      const drivesDesktop = p.name === 'computer' && DESKTOP_MEMBERS.some((member) => member === name);

      const called = (args: unknown[]): unknown[] => {
        // Stamped here, never by the program: the turn it runs in, which a chain it begins keeps (`SlateInvocation.turn`).
        if (name === 'slates') return turn === undefined ? [args[0]] : [args[0], { turn } satisfies v.InferOutput<typeof SlateProgramSchema>];

        if (drivesDesktop) return [args[0], { ...v.parse(v.optional(v.looseObject({}), {}), args[1]), ...execContext({ signal: programStop, channel: deviceRequests }) }];

        return carriesOwnership ? execCallArgs(args, { channel: deviceRequests }) : args;
      };

      wrapped[name] = {
        ...entry,
        execute: async (...args) => {
          const result = await entry.execute(...called(args));

          options.onExecutorUsed?.(p.name);

          return result;
        },
      };
    }

    return { ...p, tools: wrapped };
  };

  return {
    async callTool(surface, name, input, scope) {
      const call = codemodeFunction(CRAFTED_TOOL_NAMESPACE, name, async () => {
        // A slate's call runs no program, so there is no eval to stop it with; `native` carries its Plan check.
        const functions = nativeToolFunctions(surface.native, undefined);
        const entry = Object.hasOwn(functions, name) ? functions[name] : undefined;

        if (entry !== undefined) {
          if (!scope.reach.allowsTool(name)) throw new KinuError('denied', `${name} is not within this actor's reach right now`);

          return entry.execute(input);
        }

        if (name === 'eval' || (!scope.reach.allowsTool(name) && !scope.reach.allowsNamespace(CRAFTED_TOOL_NAMESPACE))) {
          throw new KinuError('denied', `${name} is not within this actor's reach right now`);
        }

        if (!surface.craftedTools().some((tool) => tool.name === name)) {
          throw new KinuError('missing', `tools has no member ${name}`);
        }

        const execute = this.toolFor(surface, scope).execute;

        if (execute === undefined) throw new KinuError('unavailable', 'The codemode executor is not callable');

        const result = v.parse(v.object({ result: v.optional(JsonValueSchema) }), await execute({
          code: `return await tools[${JSON.stringify(name)}](${JSON.stringify(input)});`,
        }, { toolCallId: `slate-${crypto.randomUUID()}`, messages: [], context: undefined }));

        return result.result;
      });

      return call(input);
    },
    toolFor(surface, scope) {
      // Built per call with the call's signal and channel: createCodeTool runs its executor without the tool call's
      // options, so a program's tool calls are stopped with its eval, and owned by it, only through what this binds.
      // `written`: the program as the agent wrote it, which the executor places (`programPlace`) before the vendor's
      // normalizer has wrapped it in a function, where an `import` no longer parses.
      const build = (mode: WorkMode, program: ProgramContext, written?: string): Tool => {
        const signal = program.stop;
        // Read as the program starts, so a tool crafted a step ago is callable now; its body is defined in the prelude.
        const crafted = surface.craftedTools();
        // No prelude here: createCodeTool drops every one; the per-call executor below restores them.
        const { providers: reached, describe } = programSurface({ surface, namespaces: scope.namespaces(programExecutor(program)), reach: scope.reach, mode, signal, crafted });
        const { nested } = scope;
        const bound = nested === undefined ? reached : reached.map((provider) => guarded(provider, nested));
        const executor = new KinuSandboxExecutor(options.launch(mode !== 'plan'), describe, servedImpacts(bound), { cwd: surface.cwd, crafted });

        const built = createCodeTool({
          // Composed here: the vendor's `{{types}}` replace reads `$` as a pattern.
          description: renderCodemodeDescription(bound),
          tools: bound,
          executor: {
            execute: (code, resolved) => {
              const live = Array.isArray(resolved)
                ? resolved.map((provider) => {
                  if (provider.name === CRAFTED_TOOL_NAMESPACE) {
                    return { ...provider, prelude: renderToolsPrelude(crafted, { workspace: options.workspace, cwd: surface.cwd }) };
                  }

                  const prelude = bound.find((declared) => declared.name === provider.name)?.prelude;

                  return prelude === undefined ? provider : { ...provider, prelude };
                })
                : resolved;

              return executor.execute(written ?? code, live);
            },
          },
        });

        // Core's input schema: codemode's label says "async arrow function", but the normalizer takes a script body.
        return { ...built, inputSchema: codemodeInputSchema() };
      };

      return withCraftedToolDeclarations(permitInPlan({
        ...build('build', {}),
        execute: (input, context) => {
          const channel = readDeviceRequestChannel({ toolOptions: context });
          // Read as the program starts, inside its tool call's turn: its RPC callbacks run outside that scope.
          const turn = scopedTurnSurface()?.key.turnId;
          const program = { stop: context.abortSignal, ...channel !== undefined && { channel }, ...turn !== undefined && { turn } };
          const written = v.is(v.object({ code: v.string() }), input) ? input.code : undefined;
          const execute = build(currentWorkMode() === 'plan' ? 'plan' : 'build', program, written).execute;

          if (execute === undefined) throw new Error('Codemode executor is not callable');

          return withCodemodeProgram(async () => (
            v.parse(v.object({ result: v.optional(v.unknown()), logs: v.optional(v.array(v.string())) }), await execute(input, context))
          ), { call: context.toolCallId, signal: context.abortSignal });
        },
      }), surface.craftedTools);
    },
  };
}
