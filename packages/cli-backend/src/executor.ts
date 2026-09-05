/**
 * Local code executor for CLI backend using Bun subprocess.
 *
 * Runs user code in a separate Bun process, under the caller's declared
 * wall-clock budget — and under NO budget when the caller declared none. This
 * used to default to 30 seconds, which is the same number as the foreground
 * detach window: a program that outran the window was killed at the very moment
 * the window would have handed the model a handle, so the detach could never be
 * observed. A deadline here is a kill; the window is not.
 *
 * This is a local convenience boundary, not a security sandbox: code executes
 * with the user's OS permissions. Tool-backed execution runs in-process because
 * provider functions cannot be passed across process boundaries.
 */

import { decodeJsonValue, JsonValueSchema } from '@kinu.run/core';
import type { Executor, ExecuteResult, JsonValue, ResolvedProvider } from '@kinu.run/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import * as v from 'valibot';
import { classify, renderThrownChain } from '@kinu.run/core/obs';

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
      const timeoutMs = opts?.timeoutMs;
      const language = opts?.language ?? 'javascript';

      if (language !== 'javascript') {
        // ONE refusal, because there was only ever one state to refuse:
        // `languages` is 'javascript' plus exactly those INTERPRETERS whose
        // command resolved on PATH, so "declared but has no interpreter" cannot
        // happen — and the two identical refusals that stood here read as if it
        // could. The lookup stays because it is what hands the compiler a
        // defined interpreter.
        const interpreter = this.languages.includes(language)
          ? INTERPRETERS.get(language)
          : undefined;
        if (!interpreter) {
          return { result: undefined, error: `Executor does not support language "${language}"` };
        }
        return executeWithInterpreter(code, interpreter, timeoutMs);
      }

      // If providers are needed, we can't pass functions across process
      // boundaries. Fall back to in-process vm for tool-backed execution.
      const providerList: ResolvedProvider[] = normalizeProviders(providers);
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
  timeoutMs?: number,
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
 * server) inherits the write end — so a finished probe held `kinu exec`
 * open until the harness cap killed it (TB2.1 nginx trial, 2026-08-20).
 */
async function runToCompletion(
  argv: string[],
  code: string,
  extension: string,
  timeoutMs?: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; error?: string }> {
  const stem = join(tmpdir(), `kinu-exec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    // No deadline asked for, no kill armed. The process ends when it ends.
    const timeout = timeoutMs === undefined
      ? undefined
      : setTimeout(() => { killedByTimeout = true; proc.kill(); }, timeoutMs);
    const exitCode = await proc.exited;
    clearTimeout(timeout);
    if (killedByTimeout) {
      return {
        exitCode, stdout: '', stderr: '',
        error: `Execution timeout (${Math.round((timeoutMs ?? 0) / 1000)}s)`,
      };
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
async function executeInSubprocess(code: string, timeoutMs?: number): Promise<ExecuteResult> {
  // LLMs often send bare expressions (e.g., "7 * 13") without return. The
  // expression form is PARSED first and RUN only if it parsed: deciding by a
  // failed run re-executed a throwing expression as statements, so a side
  // effect before the throw landed twice (measured 2026-09-05: an appended
  // marker file held two lines for one call).
  const autoReturned = addImplicitReturn(code);
  const wrapper = `
    const __code = ${JSON.stringify(code)};
    let __expression;
    try { __expression = (0, eval)("(async () => (" + __code + "))"); }
    catch (e) { if (!(e instanceof SyntaxError)) throw e; }
    async function __run() {
      if (__expression) return await __expression();
      return await (async () => { ${autoReturned} })();
    }
    try {
      const result = await __run();
      console.log(JSON.stringify({ ok: true, result: result ?? null }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: e.message ?? String(e) }));
    }
  `;

  // A compiled `kinu` binary is not the bun CLI and usually ships without
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
  } catch (error) {
    if (classify({ cause: error }) !== 'malformed-input') throw error;
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

/**
 * In-process execution — for tool-backed code, and for the JS lane on a machine
 * with no subprocess runtime on its PATH.
 *
 * Which runtime resolved decides WHERE the work runs, never what it answers, so
 * a bare expression is given the same value here as the subprocess wrapper gives
 * it: `addImplicitReturn` is the one rule both lanes apply. Without it a model
 * that asked for `7 * 6` was answered `42` beside a `bun` and `undefined` inside
 * a compiled-binary deploy — the same code, silently emptied by a PATH.
 */
async function executeInProcess(
  code: string, providers: ResolvedProvider[], timeoutMs?: number,
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
  const wrapped = `return (async (${argNames.join(', ')}) => { ${addImplicitReturn(code)} })(${argNames.map((_, i) => `arguments[${i}]`).join(', ')})`;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const fn = new Function(wrapped);
    const settled = Promise.resolve(fn(...argValues)).then((value) =>
      value === undefined ? undefined : decodeJsonValue({ value }));
    if (timeoutMs === undefined) return { result: await settled };
    // A caller that ASKED for a deadline gets one. Cleared in the finally — a
    // scaffold turn's budget is minutes, and a live timer would hold the
    // process open long after the code settled.
    const deadline = Promise.withResolvers<JsonValue>();
    timer = setTimeout(
      () => deadline.reject(new Error(`Execution timeout (${Math.round(timeoutMs / 1000)}s)`)),
      timeoutMs,
    );
    const result = await Promise.race([settled, deadline.promise]);
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
