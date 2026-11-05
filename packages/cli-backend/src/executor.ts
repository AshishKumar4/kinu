/**
 * Local code executor via Bun subprocess. Not a security sandbox: code runs with
 * the user's OS permissions.
 */

import { normalizeCode } from '@cloudflare/codemode/normalize';
import { decodeJsonValue, JsonValueSchema, programNamespace } from '@kinu.run/core';
import type { Executor, ExecuteResult, JsonValue, ResolvedProvider } from '@kinu.run/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as v from 'valibot';
import { chainOf, classify, settle } from '@kinu.run/core/obs';
import { Effect, Result } from 'effect';
import { requireBuild, stoppedProgram } from '@kinu.run/core';
import { ISOLATED_BUN_FLAGS } from '@kinu.run/core';

const subprocessResultSchema = v.variant('ok', [
  v.object({ ok: v.literal(true), result: v.optional(JsonValueSchema) }),
  v.object({ ok: v.literal(false), error: v.optional(v.string()) }),
]);

type ProviderFunction = (...args: JsonValue[]) => Promise<JsonValue | undefined>;

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
        return stoppedProgram(() => settle(executeInProcess(code, providerList)), opts);
      }

      // Apart on purpose: a verifier check cannot read its receipt, nor a probe the owner's project.
      return settle(executeInSubprocess(code));
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
  // A directory of its own, made only for its owner: no other local user can guess its path or plant a file there first.
  const dir = mkdtempSync(join(tmpdir(), 'kinu-exec-'));
  const stem = join(dir, 'program');
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
      env: { PATH: process.env.PATH, HOME: tmpdir() },
    });

    const exitCode = await proc.exited;

    return {
      exitCode,
      stdout: await Bun.file(outFile).text(),
      stderr: await Bun.file(errFile).text(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function executeInSubprocess(code: string): Effect.Effect<ExecuteResult> {
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

  // The Bun running the CLI, which need not be on PATH; beside its temp script, reading no bunfig or .env.
  return Effect.flatMap(Effect.promise(() => runToCompletion([process.execPath, ...ISOLATED_BUN_FLAGS, 'run'], wrapper, '.mjs', tmpdir())), (run) => {
    if (run.exitCode !== 0) {
      return Effect.succeed({ result: undefined, error: run.stderr.trim() || `Process exited with code ${run.exitCode}` });
    }

    const lastLine = run.stdout.trim().split('\n').pop() ?? '';
    const parsed = Result.try(() => v.parse(subprocessResultSchema, JSON.parse(lastLine)));

    if (Result.isSuccess(parsed)) {
      return Effect.succeed(parsed.success.ok ? { result: parsed.success.result } : { result: undefined, error: parsed.success.error ?? 'Unknown error' });
    }

    // A last line that is no answer is a program that ended first; anything else is a fault.
    return classify({ cause: parsed.failure }) === 'malformed-input'
      ? Effect.succeed({ result: undefined, error: 'The program exited before it returned a value' })
      : Effect.die(parsed.failure);
  });
}

function normalizeProviders(
  providers?: ResolvedProvider[] | Record<string, ProviderFunction>,
): ResolvedProvider[] {
  if (!providers) return [];

  if (Array.isArray(providers)) return providers;

  return [{ name: 'codemode', fns: providers }];
}

/**
 * The one in-process run of every CLI program, `eval`'s and the executor's: `names` its function's parameters, bound to
 * `values` in order, `prelude` before the code, and its value decoded as the sandbox's answer is.
 */
export async function runProgramInProcess(
  code: string, parameters: { readonly names: readonly string[]; readonly values: readonly unknown[] }, prelude = '',
): Promise<JsonValue | undefined> {
  const value: unknown = await new Function(...parameters.names, `${prelude}\nreturn (\n${normalizeCode(code)}\n)()`)(...parameters.values);

  return value === undefined ? undefined : decodeJsonValue({ value });
}

/** In-process execution: tool-backed code, whose functions cannot cross a process boundary. */
function executeInProcess(
  code: string, providers: ResolvedProvider[],
): Effect.Effect<ExecuteResult> {
  const ran = Effect.promise(async (): Promise<ExecuteResult> => {
    // As the cloud's sandbox holds a namespace, and eval here too (`programNamespace`).
    const bindings = Object.fromEntries(providers.map((p) => [p.name, programNamespace(p.name, p.fns)]));

    return { result: await runProgramInProcess(code, { names: Object.keys(bindings), values: Object.values(bindings) }) };
  });

  return Effect.catchCause(ran, (failed) => Effect.succeed({ result: undefined, error: chainOf(failed) }));
}
