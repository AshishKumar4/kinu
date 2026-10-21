// rc29 production walkthrough (F8): a turn crafted `run_detached_command`, asked `describe` for it, was told nothing is
// named so, and left the job unstarted. `tools.*` had no declarations at all, so describe answered no tool, native or
// crafted. The program's own describe is built here as codemode-tool builds it.
import { describe, expect, test } from 'bun:test';
import { jsonSchema, tool, type ToolSet } from 'ai';
import * as v from 'valibot';
import { describeProgramSource, narrowToolSurface, programDeclarations, programProviders, renderCodemodeDescription, withCraftedToolDeclarations } from '../src/index';

const NATIVE: ToolSet = {
  read_file: tool({
    description: 'Read a file.',
    inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string', description: 'Where the file is.' } }, required: ['path'] }),
    execute: async () => 'text',
  }),
  eval: withCraftedToolDeclarations(tool({
    description: 'Run a program.',
    inputSchema: jsonSchema({ type: 'object', properties: { code: { type: 'string' } }, required: ['code'] }),
    execute: async () => ({}),
  }), () => [{ name: 'run_detached_command', description: 'Runs a shell command detached from the turn.' }]),
};

/** A role with no narrowing: every tool and namespace. */
const EVERYWHERE = narrowToolSurface(undefined);

function programsDescribe() {
  const providers = programProviders({ surface: { native: NATIVE, external: () => ({}) }, namespaces: [], reach: EVERYWHERE, mode: 'build', signal: undefined });
  const declared = v.parse(v.function(), new Function(`${describeProgramSource(programDeclarations(providers))}\nreturn describe;`)());

  return { providers, describe: (name: string) => v.parse(v.string(), declared(name)) };
}

describe('describe answers `tools.*`', () => {
  test('a native tool is declared by its own input schema, as one input object', () => {
    expect(programsDescribe().describe('tools.read_file')).toContain('read_file(input: {');
    expect(programsDescribe().describe('tools.read_file')).toContain('path: string');
  });

  test('a crafted tool is declared as the turn prompt declares it, with what it is for', () => {
    const declared = programsDescribe().describe('tools.run_detached_command');

    expect({ said: declared.includes('Runs a shell command detached from the turn'), called: declared.includes('run_detached_command(...args: unknown[])') })
      .toEqual({ said: true, called: true });
  });

  test('the namespace lists both, and the eval docstring still lists no `tools` member', () => {
    const { providers, describe: declared } = programsDescribe();

    expect({ namespace: ['read_file(', 'run_detached_command('].every((member) => declared('tools').includes(member)), docstring: renderCodemodeDescription(providers).includes('read_file') })
      .toEqual({ namespace: true, docstring: false });
  });
});
