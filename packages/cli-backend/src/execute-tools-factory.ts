/**
 * Node-side createExecuteTool factory — the CLI's answer to the CF backend's
 * codemode-backed `execute_tools`. Passed as deps.createExecuteTool to
 * buildBuiltinTools, it gives the CLI a working `execute_tools` without a
 * workerd loader.
 *
 * The returned tool's execute compiles the LLM's code via `new Function()`
 * and runs it in-process with the execution router's provider namespaces
 * (`workspace.*` from the always-registered inline executor, plus any
 * extras) and a `codemode` object containing the pre-materialised
 * crafted-tool executes (already produced by deps.craftedToolExecute
 * upstream in buildBuiltinTools).
 *
 * Node/Bun only — V8 codegen is permitted there. This module is NEVER
 * imported by the CF backend, keeping `new Function` outside the
 * Durable Object isolate.
 */

import { tool, jsonSchema } from 'ai';

export interface NodeExecuteToolFactoryDeps {
  extraProviders?: NodeCodemodeProvider[];
}

export interface NodeCodemodeProvider {
  name: string;
  tools: Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>;
  types?: string;
  positionalArgs?: boolean;
}

/**
 * Build a createExecuteTool-compatible factory. Pass as deps.createExecuteTool
 * to buildBuiltinTools; pass a sentinel truthy value as deps.codemodeLoader
 * so the factory branch is entered (the loader itself is not used here).
 */
export function createNodeExecuteToolFactory(deps: NodeExecuteToolFactoryDeps = {}) {
  return (opts: {
    tools: Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>;
    providers: unknown[];
    loader: unknown;
  }) => {
    const craftedBindings: Record<string, (arg: unknown) => Promise<unknown>> = {};
    for (const [name, entry] of Object.entries(opts.tools)) {
      craftedBindings[name] = entry.execute as (arg: unknown) => Promise<unknown>;
    }

    const providers = [
      ...(opts.providers as NodeCodemodeProvider[]),
      ...(deps.extraProviders ?? []),
    ];

    return tool({
      description:
        'Execute JavaScript to accomplish tasks. workspace.* for files/shell, codemode.* for learned patterns. (Node fallback — same surface as the CF codemode sandbox.)',
      inputSchema: jsonSchema<{ code: string }>({
        type: 'object',
        properties: { code: { type: 'string', description: 'JavaScript code to execute' } },
        required: ['code'],
      }),
      execute: async (args: { code: string }, options?: unknown) => {
        try {
          const signal = readAbortSignal(options);
          const context = signal ? { signal } : undefined;
          const providerBindings: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> = {};
          for (const p of providers) {
            if (!p || typeof p !== 'object' || !('name' in p) || !('tools' in p)) continue;
            const nsp: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
            for (const [toolName, t] of Object.entries(p.tools)) {
              nsp[toolName] = (...a: unknown[]) => t.execute(...a, context);
            }
            providerBindings[p.name] = nsp;
          }
          // The `workspace` namespace comes from the execution router's inline
          // executor, always registered by createCLIRuntime.
          const workspace = providerBindings['workspace'] ?? {};

          // Build the arg names / values for the sandboxed function so every
          // registered provider namespace is accessible by name.
          const extraNamespaces = Object.keys(providerBindings).filter(n => n !== 'workspace');
          const argNames = ['workspace', 'codemode', ...extraNamespaces];
          const argValues: unknown[] = [workspace, craftedBindings, ...extraNamespaces.map(n => providerBindings[n])];

          const fn = new Function(
            ...argNames,
            `return (async () => {\n${args.code}\n})()`,
          );
          const result = await fn(...argValues);
          return { result: result === undefined ? '(no return value)' : result };
        } catch (e) {
          return { result: undefined, error: (e as Error).message };
        }
      },
    });
  };
}

function readAbortSignal(options: unknown): AbortSignal | undefined {
  if (!options || typeof options !== 'object' || !('abortSignal' in options)) return undefined;
  const signal = (options as { abortSignal?: unknown }).abortSignal;
  return typeof signal === 'object' && signal !== null && 'aborted' in signal && 'addEventListener' in signal
    ? signal as AbortSignal
    : undefined;
}
