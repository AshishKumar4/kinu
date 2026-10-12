import * as v from 'valibot';
import { commandTool, type CommandTool, type ExecutorToolResult } from '@kinu.run/core';

const FakeOptionsSchema = v.object({ cwd: v.optional(v.string()), language: v.optional(v.string()) });

/** What a fake member read of a call's options. */
export type FakeCallOptions = v.InferOutput<typeof FakeOptionsSchema>;

/**
 * A fake command member that reads a call as the real ones do: the command and its `cwd`; a `program` member runs its
 * text as a program unless its language is the shell. `run` gets exactly what was read.
 */
export function fakeCommandMember(
  description: string,
  run: (command: string, options: FakeCallOptions) => Promise<ExecutorToolResult>,
  kind: 'shell' | 'program' = 'shell',
): CommandTool {
  return commandTool(description, (args) => {
    const command = typeof args[0] === 'string' ? args[0] : '';
    const parsed = v.safeParse(FakeOptionsSchema, args[1]);
    const options = parsed.success ? parsed.output : {};
    const program = kind === 'program' && options.language !== 'shell' ? options.language ?? 'default' : undefined;

    return {
      call: { text: command, ...(program !== undefined && { program }), ...(options.cwd !== undefined && { cwd: options.cwd }), context: {} },
      run: () => run(command, options),
    };
  });
}
