import * as v from 'valibot';
import { commandTool, type CommandTool, type ExecutorToolResult } from '@kinu.run/core';

const FakeOptionsSchema = v.object({ cwd: v.optional(v.string()) });

/** What a fake member read of a call's options. */
export type FakeCallOptions = v.InferOutput<typeof FakeOptionsSchema>;

/**
 * A fake command member that reads a call as the real ones do: the command and its `cwd`. `run` gets exactly what was
 * read.
 */
export function fakeCommandMember(
  description: string,
  run: (command: string, options: FakeCallOptions) => Promise<ExecutorToolResult>,
): CommandTool {
  return commandTool(description, (args) => {
    const command = typeof args[0] === 'string' ? args[0] : '';
    const parsed = v.safeParse(FakeOptionsSchema, args[1]);
    const options = parsed.success ? parsed.output : {};

    return {
      call: { text: command, ...(options.cwd !== undefined && { cwd: options.cwd }), context: {} },
      run: () => run(command, options),
    };
  });
}
