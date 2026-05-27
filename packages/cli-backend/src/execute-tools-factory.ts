/**
 * Node-side createExecuteTool factory. Compatible shape with
 * @cloudflare/think/tools/execute's createExecuteTool, so the CLI can pass
 * this as deps.createExecuteTool to buildBuiltinTools and get a working
 * `execute_tools` without a workerd loader.
 *
 * The returned tool's execute compiles the LLM's code via `new Function()`
 * and runs it in-process with a `workspace` API binding and a `codemode`
 * object containing the pre-materialised crafted-tool executes (already
 * produced by deps.craftedToolExecute upstream in buildBuiltinTools).
 *
 * Node/Bun only — V8 codegen is permitted there. This module is NEVER
 * imported by the CF backend, keeping `new Function` outside the
 * Durable Object isolate.
 */

import { tool, jsonSchema } from 'ai';
import type { VFS, Memory } from '@proteus/core';
import type { ExecutorProvider } from '@proteus/core';
import { appendMemoryNote } from '@proteus/core';

interface ShellLike {
  exec(command: string, stdin?: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface NodeExecuteToolFactoryDeps {
  vfs: VFS;
  memory: Memory;
  shell?: ShellLike;
}

/**
 * Build a createExecuteTool-compatible factory. Pass as deps.createExecuteTool
 * to buildBuiltinTools; pass a sentinel truthy value as deps.codemodeLoader
 * so the factory branch is entered (the loader itself is not used here).
 */
export function createNodeExecuteToolFactory(deps: NodeExecuteToolFactoryDeps) {
  return (opts: {
    tools: Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>;
    providers: unknown[];
    loader: unknown;
  }) => {
    const { vfs, memory, shell } = deps;
    const craftedBindings: Record<string, (arg: unknown) => Promise<unknown>> = {};
    for (const [name, entry] of Object.entries(opts.tools)) {
      craftedBindings[name] = entry.execute as (arg: unknown) => Promise<unknown>;
    }

    // Merge registered provider tools under their namespaces too. The real
    // codemode sandbox exposes each provider as a Proxy global; we eagerly
    // bind because Node has no RPC layer between sandbox and host.
    const providerBindings: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> = {};
    for (const p of opts.providers as Array<ExecutorProvider>) {
      if (!p || typeof p !== 'object' || !('name' in p) || !('tools' in p)) continue;
      const nsp: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
      for (const [toolName, t] of Object.entries(p.tools)) {
        nsp[toolName] = t.execute as (...a: unknown[]) => Promise<unknown>;
      }
      providerBindings[p.name] = nsp;
    }

    return tool({
      description:
        'Execute JavaScript to accomplish tasks. workspace.* for files/shell, codemode.* for learned patterns. (Node fallback — same surface as the CF codemode sandbox.)',
      inputSchema: jsonSchema<{ code: string }>({
        type: 'object',
        properties: { code: { type: 'string', description: 'JavaScript code to execute' } },
        required: ['code'],
      }),
      execute: async (args: { code: string }) => {
        try {
          const workspaceApi = {
            readFile: async (path: string) => {
              const content = await vfs.readFile(path, { encoding: 'utf8' });
              return content ?? `File not found: ${path}`;
            },
            writeFile: async (path: string, content: string) => {
              await vfs.writeFile(path, content);
              return `Written ${content.length} bytes to ${path}`;
            },
            exec: async (command: string) => {
              if (!shell) return 'Error: no shell available in this runtime.';
              const result = await shell.exec(command);
              if (result.exitCode !== 0) return `Error (exit ${result.exitCode}): ${result.stderr}`;
              return result.stdout || '(no output)';
            },
            readdir: async (path: string) => vfs.readdir(path),
            exists: async (path: string) => vfs.exists(path),
            searchMemory: async (query: string) => {
              const results = await memory.search(query, 10);
              return results.map((r) => `[${r.path}] ${r.snippet}`).join('\n') || 'No results.';
            },
            saveNote: async (content: string) => appendMemoryNote(memory, content),
          };
          // Merge workspace provider bindings over the inline workspaceApi
          // so `workspace.createTool` etc from the execution router also work.
          const workspace = { ...workspaceApi, ...(providerBindings['workspace'] ?? {}) };

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
