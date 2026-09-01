/**
 * The local executor's process lifecycle: what ends a run, and what runs it.
 *
 * Two contracts, both about the spawn seam and both measured through the public
 * `execute` surface against real child processes:
 *
 *   1. A run settles on the COMMAND'S OWN EXIT. Output used to be read with
 *      `new Response(proc.stdout).text()`, which resolves at pipe EOF rather
 *      than at exit — so any process the code left running kept the inherited
 *      write end open and held the executor past the answer until the harness
 *      cap killed it (TB2.1 nginx trial). Nothing about the pipe may arbitrate
 *      the settle any more, in EITHER direction: a lane whose stdout closes
 *      early must still report the command's own exit and its own streams.
 *
 *   2. The runtime is whatever the CONFIGURED PATH resolves. The JS lane used
 *      to spawn the literal `"bun"`, which does not exist beside a compiled
 *      binary — every container-less deploy died with `Executable not found`
 *      instead of running the work. Resolution now decides, and a path with no
 *      runtime on it runs the work in-process rather than spawning a name.
 *
 * `Bun.which` reads the PATH the PROCESS started with, so contract 2 cannot be
 * driven by mutating `process.env` inside this test — it drives the same public
 * surface inside a real child process started under the PATH being stated.
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

/**
 * Run the executor's public surface in a CHILD bun process whose PATH is the
 * one under test.
 *
 * The child is started by absolute path (`process.execPath`), so a PATH with no
 * runtime on it still starts — which is the whole point: what the executor then
 * resolves is a decision it makes, not a decision the harness made for it.
 */
async function executeUnderPath(PATH: string): Promise<v.InferOutput<typeof ProbeAnswerSchema>> {
  const dir = scratchDir('executor-lifecycle-path');
  const probe = join(dir, 'probe.mjs');
  writeFileSync(probe, [
    `import { createSandboxedExecutor } from ${JSON.stringify(EXECUTOR_MODULE)};`,
    `const answer = await createSandboxedExecutor().execute('6 * 7', []);`,
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

/** A `bun` on a directory of its own that records each invocation and then
 *  hands the work to this process's real runtime. Being ON the configured path
 *  is what makes it the runtime a resolving executor picks. */
function runtimeShim() {
  const dir = scratchDir('executor-lifecycle-shim');
  const record = join(dir, 'invocations');
  const shim = join(dir, 'bun');
  // Created empty here, so a read of it is a COUNT and never a question about
  // whether the file exists: zero invocations is an answer, not an absence.
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

    // A command that answers and exits while a process it started keeps the
    // stdio it inherited. Reading output at EOF made this the hang: the exit
    // had already happened (measured at 6ms) and the read waited for the
    // grandchild. A hang here outlives bun's default test deadline and fails.
    expect(await executor.execute(
      'const child = Bun.spawn(["sleep", "30"], { stdout: "inherit", stderr: "inherit" });\n'
      + 'child.unref();\n'
      + '"answered"',
      [],
    )).toEqual({ result: 'answered' });

    if (!executor.languages.includes('python')) return;

    // The interpreter lane is the same seam and had the same read. Its
    // grandchild is a real subprocess holding the inherited descriptors.
    expect(await executor.execute(
      'import subprocess\n'
      + 'subprocess.Popen(["sleep", "30"])\n'
      + 'print("answered")\n',
      [],
      { language: 'python' },
    )).toEqual({ result: 'answered' });

    // The other direction: stdout ENDS while the command is still running, and
    // the command then fails. The settle is still the command's own — its exit
    // code decides the branch and its own stderr is the reason — rather than
    // anything derived from when the stream stopped.
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

    // And a clean exit whose stdout closed early still answers with what the
    // command actually wrote, not with an empty read.
    expect(await executor.execute(
      'import os, sys\n'
      + 'sys.stdout.write("42\\n")\n'
      + 'sys.stdout.flush()\n'
      + 'os.close(1)\n'
      + 'sys.exit(0)\n',
      [],
      { language: 'python' },
    )).toEqual({ result: '42' });
  }, 20_000);

  test('spawn resolves its runtime by configured path, not the literal bun', async () => {
    const shim = runtimeShim();

    // A runtime ON the configured path is the runtime the work runs through:
    // the executor resolved it and spawned what it resolved.
    expect(await executeUnderPath(`${shim.dir}:${process.env.PATH ?? '/usr/bin:/bin'}`))
      .toEqual({ result: 42 });
    expect(shim.invocations()).toBe(1);

    // A path with NO runtime on it is the compiled-binary deploy. Spawning the
    // literal name here is what failed as `Executable not found`; resolving it
    // answers null, and the in-process executor — the same one provider-backed
    // execution uses — does the work instead.
    expect(await executeUnderPath('/usr/bin:/bin')).toEqual({ result: 42 });
    // Nothing reached the shim on a path that does not contain it.
    expect(shim.invocations()).toBe(1);
  }, 30_000);
});
