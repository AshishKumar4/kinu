/**
 * Local code executor for CLI backend using Bun subprocess.
 *
 * Runs user code in a separate Bun process with a 30-second timeout.
 * This is a local convenience boundary, not a security sandbox: code executes
 * with the user's OS permissions. Tool-backed execution runs in-process because
 * provider functions cannot be passed across process boundaries.
 */

import type { Executor, ExecuteResult, ResolvedProvider } from '@proteus/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';

const TIMEOUT_MS = 30_000;

/**
 * If the last non-empty line of code doesn't start with a keyword that
 * indicates a statement (const, let, var, if, for, while, etc.) and
 * doesn't already start with 'return', prepend 'return ' to it.
 * This makes multi-line LLM code like "const x=7;\nx*2" return a value.
 */
function addImplicitReturn(code: string): string {
  const lines = code.split('\n');
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && !lines[lastIdx]!.trim()) lastIdx--;
  if (lastIdx < 0) return code;

  const lastLine = lines[lastIdx]!.trim();
  if (/^(return|const |let |var |if |for |while |do |switch |throw |try |class |function |import |export )/.test(lastLine)) {
    return code;
  }
  if (/^[a-zA-Z_$]\w*\s*=[^=]/.test(lastLine)) {
    return code;
  }
  lines[lastIdx] = `return ${lastLine}`;
  return lines.join('\n');
}

export function createSandboxedExecutor(): Executor {
  return {
    async execute(code, providers): Promise<ExecuteResult> {
      const providerList: ResolvedProvider[] = normalizeProviders(providers);

      // If providers are needed, we can't pass functions across process
      // boundaries. Fall back to in-process vm for tool-backed execution.
      if (providerList.some(p => Object.keys(p.fns).length > 0)) {
        return executeInProcess(code, providerList);
      }

      return executeInSubprocess(code);
    },
  };
}

/** Execute in a Bun subprocess with timeout. */
async function executeInSubprocess(code: string): Promise<ExecuteResult> {
  const tmpFile = join(tmpdir(), `proteus-exec-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  // LLMs often send bare expressions (e.g., "7 * 13") without return.
  // Strategy: try as expression first, fall back to statements with
  // auto-return on the last line if it looks like an expression.
  const autoReturned = addImplicitReturn(code);
  const wrapper = `
    const __code = ${JSON.stringify(code)};
    async function __run() {
      try { return await (0, eval)("(async () => (" + __code + "))()"); }
      catch { return await (async () => { ${autoReturned} })(); }
    }
    try {
      const result = await __run();
      console.log(JSON.stringify({ ok: true, result: result ?? null }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: e.message ?? String(e) }));
    }
  `;

  writeFileSync(tmpFile, wrapper);

  try {
    const proc = Bun.spawn(['bun', 'run', tmpFile], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' },
    });

    const timeout = setTimeout(() => proc.kill(), TIMEOUT_MS);
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      return { result: undefined, error: stderr.trim() || `Process exited with code ${exitCode}` };
    }

    const lastLine = stdout.trim().split('\n').pop() ?? '';
    try {
      const parsed = JSON.parse(lastLine) as { ok: boolean; result?: unknown; error?: string };
      if (parsed.ok) return { result: parsed.result };
      return { result: undefined, error: parsed.error ?? 'Unknown error' };
    } catch {
      return { result: stdout.trim() || undefined };
    }
  } finally {
    try { unlinkSync(tmpFile); } catch { /* cleanup best-effort */ }
  }
}

function normalizeProviders(
  providers?: ResolvedProvider[] | Record<string, (...args: unknown[]) => Promise<unknown>>,
): ResolvedProvider[] {
  if (!providers) return [];
  if (Array.isArray(providers)) return providers;
  return [{ name: 'codemode', fns: providers }];
}

/** In-process execution for when tool providers are needed */
async function executeInProcess(code: string, providers: ResolvedProvider[]): Promise<ExecuteResult> {
  const context: Record<string, unknown> = {};

  for (const p of providers) {
    context[p.name] = new Proxy({}, {
      get: (_target, toolName: string) => {
        return async (args: unknown) => {
          const fn = p.fns[toolName];
          if (!fn) throw new Error(`Tool "${toolName}" not found in "${p.name}"`);
          return fn(args);
        };
      },
    });
  }

  // Use Function constructor with explicitly passed context vars
  const argNames = Object.keys(context);
  const argValues = argNames.map(k => context[k]);
  const wrapped = `return (async (${argNames.join(', ')}) => { ${code} })(${argNames.map((_, i) => `arguments[${i}]`).join(', ')})`;

  try {
    const fn = new Function(wrapped);
    const result = await Promise.race([
      fn(...argValues),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Execution timeout (30s)')), TIMEOUT_MS)),
    ]);
    return { result };
  } catch (error) {
    return {
      result: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Re-export for backward compatibility
export { createSandboxedExecutor as createNodeExecutor };
