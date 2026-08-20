/**
 * Local code executor for CLI backend using Bun subprocess.
 *
 * Runs user code in a separate Bun process, under the caller's declared
 * wall-clock budget (30s by default — a scaffold turn declares minutes).
 * This is a local convenience boundary, not a security sandbox: code executes
 * with the user's OS permissions. Tool-backed execution runs in-process because
 * provider functions cannot be passed across process boundaries.
 */

import { decodeJsonValue, JsonValueSchema } from '@proteus/core';
import type { Executor, ExecuteResult, JsonValue, ResolvedProvider } from '@proteus/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import * as v from 'valibot';
import { renderThrownChain } from '@proteus/core/obs';

const TIMEOUT_MS = 30_000;
const subprocessResultSchema = v.variant('ok', [
  v.object({ ok: v.literal(true), result: v.optional(JsonValueSchema) }),
  v.object({ ok: v.literal(false), error: v.optional(v.string()) }),
]);

type ProviderFunction = (...args: JsonValue[]) => Promise<JsonValue | undefined>;
interface ExecutorNamespace {
  [toolName: string]: ProviderFunction;
}

const INTERPRETERS: ReadonlyMap<string, { readonly command: string; readonly extension: string }> = new Map([
  ['python', { command: 'python3', extension: '.py' }],
]);

function detectLanguages(): readonly [string, ...string[]] {
  const installed = [...INTERPRETERS]
    .filter(([, { command }]) => Bun.which(command) !== null)
    .map(([language]) => language);
  return ['javascript', ...installed];
}

/**
 * If the last non-empty line of code doesn't start with a keyword that
 * indicates a statement (const, let, var, if, for, while, etc.) and
 * doesn't already start with 'return', prepend 'return ' to it.
 * This makes multi-line LLM code like "const x=7;\nx*2" return a value.
 */
export function addImplicitReturn(code: string): string {
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
  let detectedLanguages: readonly [string, ...string[]] | undefined;
  return {
    get languages() { return detectedLanguages ??= detectLanguages(); },
    async execute(code, providers, opts): Promise<ExecuteResult> {
      const providerList: ResolvedProvider[] = normalizeProviders(providers);
      const timeoutMs = opts?.timeoutMs ?? TIMEOUT_MS;
      const language = opts?.language ?? 'javascript';

      if (!this.languages.includes(language)) {
        return { result: undefined, error: `Executor does not support language "${language}"` };
      }
      if (language !== 'javascript') {
        const interpreter = INTERPRETERS.get(language);
        if (!interpreter) {
          return { result: undefined, error: `Executor does not support language "${language}"` };
        }
        return executeWithInterpreter(code, interpreter, timeoutMs);
      }

      // If providers are needed, we can't pass functions across process
      // boundaries. Fall back to in-process vm for tool-backed execution.
      if (providerList.some(p => Object.keys(p.fns).length > 0)) {
        return executeInProcess(code, providerList, timeoutMs);
      }

      return executeInSubprocess(code, timeoutMs);
    },
  };
}

async function executeWithInterpreter(
  code: string,
  interpreter: { readonly command: string; readonly extension: string },
  timeoutMs: number,
): Promise<ExecuteResult> {
  const run = await runToCompletion([interpreter.command], code, interpreter.extension, timeoutMs);
  if (run.error) return { result: undefined, error: run.error };
  return run.exitCode === 0
    ? { result: run.stdout.trim() || null }
    : { result: undefined, error: run.stderr.trim() || `Process exited with code ${run.exitCode}` };
}

/**
 * Spawn, bound by wall clock, and read output WITHOUT depending on pipe EOF.
 *
 * stdio goes to temp files, read after exit. With pipes, `new Response(stdout)`
 * resolves only at EOF, and a grandchild the code left running (a daemonized
 * server) inherits the write end — so a finished probe held `proteus exec`
 * open until the harness cap killed it (TB2.1 nginx trial, 2026-08-20).
 */
async function runToCompletion(
  argv: string[],
  code: string,
  extension: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; error?: string }> {
  const stem = join(tmpdir(), `proteus-exec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const tmpFile = `${stem}${extension}`;
  const outFile = `${stem}.out`;
  const errFile = `${stem}.err`;
  writeFileSync(tmpFile, code);
  writeFileSync(outFile, '');
  writeFileSync(errFile, '');
  try {
    const proc = Bun.spawn([...argv, tmpFile], {
      stdout: Bun.file(outFile),
      stderr: Bun.file(errFile),
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' },
    });
    let killedByTimeout = false;
    const timeout = setTimeout(() => { killedByTimeout = true; proc.kill(); }, timeoutMs);
    const exitCode = await proc.exited;
    clearTimeout(timeout);
    if (killedByTimeout) {
      return { exitCode, stdout: '', stderr: '', error: `Execution timeout (${Math.round(timeoutMs / 1000)}s)` };
    }
    return {
      exitCode,
      stdout: await Bun.file(outFile).text(),
      stderr: await Bun.file(errFile).text(),
    };
  } finally {
    unlinkSync(tmpFile);
    unlinkSync(outFile);
    unlinkSync(errFile);
  }
}

/** Execute in a Bun subprocess with timeout. */
async function executeInSubprocess(code: string, timeoutMs: number): Promise<ExecuteResult> {
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

  // A compiled `proteus` binary is not the bun CLI and usually ships without
  // one beside it (TB2.1: turn review failed in every container-less deploy).
  // With no subprocess runtime, in-process execution is the real remaining
  // executor — same code, no isolation, stated here rather than guessed at.
  const bunBin = Bun.which('bun');
  if (!bunBin) return executeInProcess(code, [], timeoutMs);
  const run = await runToCompletion([bunBin, 'run'], wrapper, '.mjs', timeoutMs);
  if (run.error) return { result: undefined, error: run.error };
  if (run.exitCode !== 0) {
    return { result: undefined, error: run.stderr.trim() || `Process exited with code ${run.exitCode}` };
  }
  const lastLine = run.stdout.trim().split('\n').pop() ?? '';
  try {
    const parsed = v.parse(subprocessResultSchema, JSON.parse(lastLine));
    if (parsed.ok) return { result: parsed.result };
    return { result: undefined, error: parsed.error ?? 'Unknown error' };
  } catch {
    return { result: run.stdout.trim() || undefined };
  }
}

function normalizeProviders(
  providers?: ResolvedProvider[] | Record<string, ProviderFunction>,
): ResolvedProvider[] {
  if (!providers) return [];
  if (Array.isArray(providers)) return providers;
  return [{ name: 'codemode', fns: providers }];
}

/** In-process execution for when tool providers are needed */
async function executeInProcess(
  code: string, providers: ResolvedProvider[], timeoutMs: number,
): Promise<ExecuteResult> {
  const context: Record<string, ExecutorNamespace> = {};

  for (const p of providers) {
    context[p.name] = new Proxy<ExecutorNamespace>({}, {
      get: (_target, toolName: string) => {
        // Every argument is forwarded: the host bridge a scaffold runs against
        // is multi-arg (host.callTool(name, args), host.appendMemory(path,
        // content)), and dropping all but the first silently truncated them.
        return async (...args: JsonValue[]) => {
          const fn = p.fns[toolName];
          if (!fn) throw new Error(`Tool "${toolName}" not found in "${p.name}"`);
          return fn(...args);
        };
      },
    });
  }

  // Use Function constructor with explicitly passed context vars
  const argNames = Object.keys(context);
  const argValues = argNames.map(k => context[k]);
  const wrapped = `return (async (${argNames.join(', ')}) => { ${code} })(${argNames.map((_, i) => `arguments[${i}]`).join(', ')})`;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const fn = new Function(wrapped);
    const result = await Promise.race([
      Promise.resolve(fn(...argValues)).then((value) =>
        value === undefined ? undefined : decodeJsonValue({ value })),
      // Cleared in the finally — a scaffold turn's budget is minutes, and a
      // live timer would hold the process open long after the code settled.
      new Promise<JsonValue>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Execution timeout (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
      }),
    ]);
    return { result };
  } catch (error) {
    return {
      result: undefined,
      error: renderThrownChain({ cause: error }),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
