/**
 * A program's body run under the prelude the product renders for every eval program (`renderToolsPrelude`), over the
 * namespaces a test hands it: `require`, `process` and the rest are the shipped shim's, bound as the sandbox binds them.
 * A test that rebuilt the binding by hand passed what the product does not (staging rc29: a lookup the runtime's seam
 * dropped was present in the test's).
 */
import * as v from 'valibot';
import { KINU_NODE_MODULE_NAME, KINU_NODE_MODULE_SOURCE } from '@kinu.run/core';
import { renderToolsPrelude } from '../../src/codemode-sandbox';
import { NODE_COMPAT_MODULE, nodeCompatSource } from '../../src/node-compat-module';

/** The namespaces a program sees: absent ones are left unbound, as an actor that does not wire them leaves them. */
export interface ProgramNamespaces {
  readonly workspace?: unknown;
  readonly computer?: unknown;
  readonly device?: unknown;
}

/** What `body` returns, read by `schema`, run as the sandbox runs an eval program, with `cwd` as its `process.cwd()`. */
export async function runProgram<Answer>(body: string, namespaces: ProgramNamespaces, cwd: string, schema: v.GenericSchema<Answer>): Promise<Answer> {
  // The prelude imports the shim and Nimbus's node-compat by their module names, which only the sandbox's loader
  // resolves: here, data URLs of the same sources.
  const shim = `data:text/javascript;base64,${Buffer.from(KINU_NODE_MODULE_SOURCE).toString('base64')}`;
  const compat = `data:text/javascript;base64,${Buffer.from(await nodeCompatSource()).toString('base64')}`;

  const prelude = renderToolsPrelude([], { workspace: 'kinu-test', cwd })
    .replace(`"./${KINU_NODE_MODULE_NAME}"`, JSON.stringify(shim))
    .replace(`"./${NODE_COMPAT_MODULE}"`, JSON.stringify(compat));

  const names = (['workspace', 'computer', 'device'] as const).filter((name) => namespaces[name] !== undefined);

  // The program's text is a module's body, as the sandbox wraps it: an async function over the namespaces it binds.
  // `this.env` is the sandbox's bindings, and `tools` its crafted-tool table; a test grants neither anything.
  const program = await import(`data:text/javascript;base64,${Buffer.from(
    `export default async function (tools, ${names.join(', ')}) {\n${prelude}\n${body}\n}`,
  ).toString('base64')}`);

  return v.parse(schema, await v.parse(v.object({ default: v.function() }), program).default.call({ env: {} }, {}, ...names.map((name) => namespaces[name])));
}
