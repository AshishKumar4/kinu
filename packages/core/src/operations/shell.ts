/** A shell command in one runtime: the workspace's by default, or the sandbox's, or a user's machine. */
import * as v from 'valibot';
import { defineOperation } from './operation';

const described = <S extends v.GenericSchema>(schema: S, text: string) => v.pipe(schema, v.description(text));

const RUNTIME = "Default workspace; or sandbox, or a user's machine by its nickname from the execution status, which is required when several are connected.";

/** `shell.run` over the runtimes a router registered: its schema names them, and any other string is a device nickname. */
export function shellRun(runtimes: readonly string[]) {
  return defineOperation({
    ns: 'shell', name: 'run', impact: 'execute', slate: true,
    help: 'Run a shell command and get its output: the directory it started in, both streams (labelled when both wrote), and the exit code when not zero.',
    input: v.strictObject({
      command: v.pipe(v.string(), v.nonEmpty()),
      runtime: v.optional(v.pipe(v.string(), v.description(RUNTIME), v.metadata({ enum: [...runtimes] }))),
      why: v.optional(described(v.string(), 'For a runtime other than workspace: what it gives that the workspace shell lacks. Recorded with the outcome.')),
      cwd: v.optional(described(v.string(), "Where the command starts; relative paths are from your home, or from the named shell's directory.")),
      name: v.optional(described(v.pipe(v.string(), v.nonEmpty()), 'A shell that keeps its directory and exported variables between the calls naming it.')),
    }),
    output: v.string(),
  });
}

export const SHELL = { run: shellRun(['workspace']) } as const;
