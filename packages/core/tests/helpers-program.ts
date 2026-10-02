import { jsonSchema, tool } from 'ai';
import {
  CRAFTED_TOOL_NAMESPACE, KINU_NODE_MODULE_SOURCE, codemodeFunction, craftedFailureFunctions, renderCraftedDefinitions,
  type CodemodeBuilder,
} from '../src/index';
import { renderThrownChain } from '../src/obs';

/** The sandbox's own module, loaded as the CLI loads it. */
const kinuNode: Promise<unknown> = import(`data:text/javascript;base64,${Buffer.from(KINU_NODE_MODULE_SOURCE).toString('base64')}`);

/**
 * `eval` as both backends run a program, without their console, shell or namespaces beyond an empty `workspace`: the
 * surface's crafted tools are defined in the program's own scope.
 */
export function programCodemode(): CodemodeBuilder {
  return (surface) => tool({
    description: 'a program over the surface',
    inputSchema: jsonSchema<{ code: string }>({ type: 'object', properties: { code: { type: 'string' } }, required: ['code'] }),
    execute: async ({ code }) => {
      try {
        const crafted = surface.craftedTools();

        const tools = Object.fromEntries(Object.entries(craftedFailureFunctions(crafted))
          .map(([name, entry]) => [name, codemodeFunction(CRAFTED_TOOL_NAMESPACE, name, entry.execute)]));

        const run = new Function('__kinu', CRAFTED_TOOL_NAMESPACE, 'workspace', `${renderCraftedDefinitions(crafted)}\nreturn (async () => {\n${code}\n})();`);

        return { result: await run(await kinuNode, tools, {}) };
      } catch (error) {
        return { result: undefined, error: renderThrownChain({ cause: error }) };
      }
    },
  });
}
