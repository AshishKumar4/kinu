/**
 * The console and `createTool` conventions run in two places: in-process (the CLI) as functions, and in the sandbox (the
 * Worker) as prelude source. These hold the source to the functions, value for value.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { programNamespace, SANDBOX_CONSOLE_PRELUDE, SANDBOX_CREATE_TOOL_PRELUDE, shownConsoleValue } from '../src/tools/sandbox-contract';

/** A value JSON cannot hold: it contains itself. */
interface Circular { self?: Circular }

const circular: Circular = {};

circular.self = circular;

const VALUES: readonly unknown[] = ['as written', { a: 1 }, [], [1, 'two'], 3, null, undefined, true, 10n, circular];

test('the sandbox console shows every value as the in-process console does', () => {
  const shown: string[] = [];
  const console = { log: (...args: string[]) => { shown.push(args.join(' ')); }, warn: () => {}, error: () => {} };

  new Function('console', `${SANDBOX_CONSOLE_PRELUDE}\nfor (const value of arguments[1]) console.log(value);`)(console, VALUES);

  expect(shown).toEqual(VALUES.map((value) => shownConsoleValue({ value })));
  expect(shownConsoleValue({ value: 10n })).toStartWith('[unserializable: ');
});

test('the sandbox createTool sends every function argument as its source, as the in-process one does', async () => {
  const received: unknown[][] = [];
  const workspace = { createTool: (...args: unknown[]) => { received.push(args); } };
  const body = function body(input: string) { return input; };

  const args = ['name', 'description', body, { schema: true }, () => 2];

  new Function('workspace', `${SANDBOX_CREATE_TOOL_PRELUDE}\nworkspace.createTool(...arguments[1]);`)(workspace, args);

  // The in-process shape (`programNamespace`) sends the same, so a program saves the same tool in either sandbox.
  const inProcess = programNamespace('workspace', {
    createTool: async (...sent) => {
      received.push(sent);

      return null;
    },
  });

  await v.parse(v.function(), inProcess['createTool'])(...args);

  expect(received).toEqual([['name', 'description', String(body), { schema: true }, '() => 2'], ['name', 'description', String(body), { schema: true }, '() => 2']]);
});
