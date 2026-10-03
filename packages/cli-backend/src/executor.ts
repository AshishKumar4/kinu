/**
 * Local code executor via Bun subprocess. Not a security sandbox: code runs with
 * the user's OS permissions.
 */

import { normalizeCode } from '@cloudflare/codemode/normalize';
import { decodeJsonValue, JsonValueSchema } from '@kinu.run/core';
import type { Executor, ExecuteResult, JsonValue, ResolvedProvider } from '@kinu.run/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, unlinkSync, rmSync } from 'node:fs';
import * as v from 'valibot';
import { classify, renderThrownChain } from '@kinu.run/core/obs';
import { requireBuild } from '@kinu.run/core';
import { ISOLATED_BUN_FLAGS } from '@kinu.run/core';

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

export function createSandboxedExecutor(): Executor {
  let detectedLanguages: readonly [string, ...string[]] | undefined;

  return {
    get languages() { return detectedLanguages ??= detectLanguages(); },
    async execute(code, providers, opts): Promise<ExecuteResult> {
      requireBuild('Native program execution without a constrained runtime');
      const language = opts?.language ?? 'javascript';

      if (language !== 'javascript') {
        // `languages` holds only interpreters resolved on PATH, so one refusal covers every case.
        const interpreter = this.languages.includes(language)
          ? INTERPRETERS.get(language)
          : undefined;

        if (!interpreter) {
          return { result: undefined, error: `Executor does not support language "${language}"` };
        }

        return executeWithInterpreter(code, interpreter);
      }

      // Provider functions cannot cross process boundaries; run in-process.
      const providerList: ResolvedProvider[] = normalizeProviders(providers);

      if (providerList.some(p => Object.keys(p.fns).length > 0)) {
        return executeInProcess(code, providerList);
      }

      return executeInSubprocess(code);
    },
  };
}

async function executeWithInterpreter(
  code: string,
  interpreter: { readonly command: string; readonly extension: string },
): Promise<ExecuteResult> {
  const run = await runToCompletion([interpreter.command], code, interpreter.extension);

  return run.exitCode === 0
    ? { result: run.stdout.trim() || null }
    : { result: undefined, error: run.stderr.trim() || `Process exited with code ${run.exitCode}` };
}

/**
 * stdio goes to temp files read after exit: a pipe resolves only at EOF, and a
 * daemonized grandchild inheriting the write end would hold `kinu exec` open.
 */
async function runToCompletion(
  argv: string[],
  code: string,
  extension: string,
  cwd?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stem = join(tmpdir(), `kinu-exec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const tmpFile = `${stem}${extension}`;
  const outFile = `${stem}.out`;
  const errFile = `${stem}.err`;
  writeFileSync(tmpFile, code);
  writeFileSync(outFile, '');
  writeFileSync(errFile, '');

  try {
    const proc = Bun.spawn([...argv, tmpFile], {
      ...(cwd !== undefined && { cwd }),
      stdout: Bun.file(outFile),
      stderr: Bun.file(errFile),
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' },
    });

    const exitCode = await proc.exited;

    return {
      exitCode,
      stdout: await Bun.file(outFile).text(),
      stderr: await Bun.file(errFile).text(),
    };
  } finally {
    rmSync(tmpFile, { force: true });
    unlinkSync(outFile);
    unlinkSync(errFile);
  }
}

async function executeInSubprocess(code: string): Promise<ExecuteResult> {
  // A compiled binary may have no bun CLI beside it.
  const bunBin = Bun.which('bun');

  if (!bunBin) return executeInProcess(code, []);

  const wrapper = `
    await Bun.file(import.meta.path).delete();
    try {
      const result = await (
        ${normalizeCode(code)}
      )();
      console.log(JSON.stringify({ ok: true, result: result ?? null }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: e.message ?? String(e) }));
    }
  `;

  // Beside its temp script, not in the project, and reading no bunfig or .env.
  const run = await runToCompletion([bunBin, ...ISOLATED_BUN_FLAGS, 'run'], wrapper, '.mjs', tmpdir());

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

/** In-process execution: tool-backed code, or JS when no subprocess runtime is on PATH. */
async function executeInProcess(
  code: string, providers: ResolvedProvider[],
): Promise<ExecuteResult> {
  const context: Record<string, ExecutorNamespace> = {};

  for (const p of providers) {
    context[p.name] = new Proxy<ExecutorNamespace>({}, {
      get: (_target, toolName: string) => {
        // Forward every argument: host bridge calls are multi-arg.
        return async (...args: JsonValue[]) => {
          const fn = p.fns[toolName];

          if (!fn) throw new Error(`Tool "${toolName}" not found in "${p.name}"`);

          return fn(...args);
        };
      },
    });
  }

  const argNames = Object.keys(context);
  const argValues = argNames.map(k => context[k]);

  try {
    const fn = new Function(...argNames, `return (\n${normalizeCode(code)}\n)()`);

    const value: unknown = await fn(...argValues);

    return { result: value === undefined ? undefined : decodeJsonValue({ value }) };
  } catch (error) {
    return {
      result: undefined,
      error: renderThrownChain({ cause: error }),
    };
  }
}
