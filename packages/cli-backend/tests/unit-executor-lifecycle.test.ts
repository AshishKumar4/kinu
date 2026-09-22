/**
 * The local executor's process lifecycle: a run settles on the command's own exit, never on pipe EOF in either
 * direction; and the runtime is whatever the configured PATH resolves, falling back in-process when none is on it.
 * `Bun.which` reads the PATH the process started with, so the PATH cases run in a real child process.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as v from 'valibot';
import { scratchDir } from '@kinu.run/test-utils';
import { createSandboxedExecutor } from '../src/executor';

const EXECUTOR_MODULE = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../src/executor.ts')).href;

/** What the child probe prints: the ExecuteResult, as JSON. */
const ProbeAnswerSchema = v.object({
  result: v.optional(v.union([v.number(), v.string(), v.null()])),
  error: v.optional(v.string()),
});

/** Run the executor in a child bun started by absolute path (`process.execPath`), so a runtime-less PATH still starts. */
async function executeUnderPath(PATH: string, code: string): Promise<v.InferOutput<typeof ProbeAnswerSchema>> {
  const dir = scratchDir('executor-lifecycle-path');
  const probe = join(dir, 'probe.mjs');
  writeFileSync(probe, [
    `import { createSandboxedExecutor } from ${JSON.stringify(EXECUTOR_MODULE)};`,
    `const answer = await createSandboxedExecutor().execute(${JSON.stringify(code)}, []);`,
    `console.log(JSON.stringify(answer));`,
  ].join('\n'));

  const child = Bun.spawn([process.execPath, 'run', probe], {
    env: { PATH, HOME: process.env.HOME ?? '/tmp' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [out, err, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  const lastLine = out.trim().split('\n').pop() ?? '';

  if (exitCode !== 0 || lastLine === '') {
    throw new Error(`the executor probe failed under PATH=${PATH} (exit ${exitCode}): ${err.trim() || out.trim()}`);
  }

  return v.parse(ProbeAnswerSchema, JSON.parse(lastLine));
}

/** A `bun` shim on its own directory that records each invocation, then hands off to this process's runtime. */
function runtimeShim() {
  const dir = scratchDir('executor-lifecycle-shim');
  const record = join(dir, 'invocations');
  const shim = join(dir, 'bun');
  // Created empty, so a read is a count: zero invocations is an answer, not an absence.
  writeFileSync(record, '');
  writeFileSync(shim, [
    '#!/bin/sh',
    `printf '%s\\n' "$0" >> ${JSON.stringify(record)}`,
    `exec ${JSON.stringify(process.execPath)} "$@"`,
    '',
  ].join('\n'));
  chmodSync(shim, 0o755);

  return {
    dir,
    invocations: () => readFileSync(record, 'utf8').split('\n').filter(Boolean).length,
  };
}

describe('the local executor settles on the command, not on its pipes', () => {
  test('a lane whose stdout pipe closes early settles with the command\'s own exit, not an EOF crash', async () => {
    const executor = createSandboxedExecutor();

    // A grandchild keeps the inherited stdio after the command exits; a hang outlives bun's default test deadline and fails.
    expect(await executor.execute(
      'const child = Bun.spawn(["sleep", "30"], { stdout: "inherit", stderr: "inherit" });\n'
      + 'child.unref();\n'
      + '"answered"',
      [],
    )).toEqual({ result: 'answered' });

    if (!executor.languages.includes('python')) return;

    expect(await executor.execute(
      'import subprocess\n'
      + 'subprocess.Popen(["sleep", "30"])\n'
      + 'print("answered")\n',
      [],
      { language: 'python' },
    )).toEqual({ result: 'answered' });

    // Stdout ends while the command still runs, then it fails: its own exit code and stderr decide.
    expect(await executor.execute(
      'import os, sys\n'
      + 'sys.stdout.write("half an answer")\n'
      + 'sys.stdout.flush()\n'
      + 'os.close(1)\n'
      + 'sys.stderr.write("the command decided\\n")\n'
      + 'sys.exit(3)\n',
      [],
      { language: 'python' },
    )).toEqual({ result: undefined, error: 'the command decided' });

    expect(await executor.execute(
      'import os, sys\n'
      + 'sys.stdout.write("42\\n")\n'
      + 'sys.stdout.flush()\n'
      + 'os.close(1)\n'
      + 'sys.exit(0)\n',
      [],
      { language: 'python' },
    )).toEqual({ result: '42' });
  });

  test('spawn resolves its runtime by configured path, not the literal bun', async () => {
    const shim = runtimeShim();

    expect(await executeUnderPath(`${shim.dir}:${process.env.PATH ?? '/usr/bin:/bin'}`, '6 * 7'))
      .toEqual({ result: 42 });
    expect(shim.invocations()).toBe(1);

    // A path with no runtime (the compiled-binary deploy) resolves null, and the in-process executor does the work.
    expect(await executeUnderPath('/usr/bin:/bin', '6 * 7')).toEqual({ result: 42 });
    expect(shim.invocations()).toBe(1);
  });

  test('without bun, codemode callables run but module metadata is refused', async () => {
    expect(await executeUnderPath('/usr/bin:/bin', 'async () => (await Promise.resolve(42)) // result'))
      .toEqual({ result: 42 });
    const refused = await executeUnderPath('/usr/bin:/bin', 'return import.meta.main');
    expect(refused.result).toBeUndefined();
    expect(refused.error).toMatch(/import\.meta/);
  });
});
