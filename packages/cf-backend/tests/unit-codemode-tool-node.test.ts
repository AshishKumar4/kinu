/**
 * The eval tool places a program by the code the agent wrote (`programPlace`), not by what the vendor's normalizer
 * hands its executor: that wraps the program in a function, where a static `import` no longer parses, so a program
 * importing from the workspace was read as one that imports nothing and ran in the isolate, which failed it with
 * "Unexpected token '{'" (staging d56a6f234, 2026-10-23).
 */
import { freshServedStores } from '@kinu.run/test-utils';
import { expect, test } from 'bun:test';
import type { ToolExecutionOptions } from 'ai';
import { narrowToolSurface, type CodemodeSurface } from '@kinu.run/core';
import { createCodemodeToolFactory, type CodemodeScope } from '../src/codemode-tool';
import type { ProgramLaunch } from '../src/codemode-sandbox';

test('a program that imports from the workspace is placed as written: never launched in the isolate', async () => {
  const launched: string[] = [];

  // Offline, as in plan mode: no principal, so a program placed on the workspace's node is refused before it runs.
  const launch: ProgramLaunch = {
    run: async (source) => {
      launched.push(source);

      return { result: null };
    },
  };

  const factory = createCodemodeToolFactory({ launch: () => launch, workspace: 'main' });
  const surface: CodemodeSurface = { native: {}, craftedTools: () => [], external: () => ({}), cwd: '/home/main', stores: freshServedStores() };
  const scope: CodemodeScope = { namespaces: () => [], reach: narrowToolSurface(undefined) };
  const { execute } = factory.toolFor(surface, scope);

  if (execute === undefined) throw new Error('eval is not callable');
  const options: ToolExecutionOptions<unknown> = { toolCallId: 'call-import', messages: [], context: undefined, abortSignal: new AbortController().signal };
  const [importing] = await Promise.allSettled([execute({ code: "// Sum\nimport { x } from './lib.mjs';\nreturn x + 1;" }, options)]);
  const plain = await execute({ code: 'return 1;' }, options);

  expect(importing.status === 'rejected' ? String(importing.reason) : 'answered').toContain('Imports from the workspace run the program in the workspace');
  expect(plain).toMatchObject({ result: null });
  expect(launched).toHaveLength(1);
});
