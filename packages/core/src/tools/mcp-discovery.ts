import { describeTarget, searchConnectors, type ConnectorDescription } from '@cloudflare/codemode/discovery';
import { asSchema, type ToolSet } from 'ai';
import type { CodemodeProvider } from '../types/codemode';
import type { SerializableToolDescriptor } from './mcp-surface';
import { projectJsonValue } from '../utils/json';

// Policy wrappers copy tool entries but retain their schema, which each MCP tool owns.
const descriptorsBySchema = new WeakMap<object, SerializableToolDescriptor>();

export function registerMcpDescriptors(tools: ToolSet, descriptors: readonly SerializableToolDescriptor[]): void {
  for (const descriptor of descriptors) descriptorsBySchema.set(asSchema(tools[descriptor.toolKey].inputSchema), descriptor);
}

/** Discovery describes only the callable, policy-narrowed surface. Calls still enter the original Kinu tools. */
export function mcpDiscoveryProvider(tools: ToolSet): CodemodeProvider {
  const entries = Object.entries(tools).flatMap(([name, entry]) => {
    const descriptor = descriptorsBySchema.get(asSchema(entry.inputSchema));

    return descriptor === undefined ? [] : [{ name, descriptor }];
  });

  const descriptions: ConnectorDescription[] = [{
    name: 'tools',
    descriptors: Object.fromEntries(entries.map(({ name, descriptor }) => [name, {
      description: descriptor.description,
      inputSchema: descriptor.inputSchema ?? { type: 'object' },
    }])),
  }];

  return {
    name: 'codemode', positionalArgs: true, declarations: {},
    tools: {
      list: {
        description: 'List connected MCP servers, or the tools of one server.', planAllowed: true,
        execute: async (...args) => {
          if (args[0] !== undefined) {
            return projectJsonValue({ value: entries.filter(({ descriptor }) => descriptor.serverName === String(args[0]))
              .map(({ name, descriptor }) => ({ path: `tools.${name}`, name: descriptor.name, description: descriptor.description })) });
          }

          const servers = new Map<string, number>();

          for (const { descriptor } of entries) servers.set(descriptor.serverName, (servers.get(descriptor.serverName) ?? 0) + 1);

          return [...servers].map(([server, count]) => ({ server, tools: count }));
        },
      },
      search: {
        description: 'Search MCP tools by a short intent phrase.', planAllowed: true,
        execute: async (...args) => projectJsonValue({ value: searchConnectors(String(args[0]), descriptions) }),
      },
      describe: {
        description: 'Read types and the complete JSON input schema for one MCP tool.', planAllowed: true,
        execute: async (...args) => {
          const described = describeTarget(String(args[0]), descriptions);
          const descriptor = descriptions[0].descriptors[described.path.slice('tools.'.length)];

          return projectJsonValue({ value: descriptor === undefined ? described : { ...described, inputSchema: descriptor.inputSchema } });
        },
      },
    },
  };
}
