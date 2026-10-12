/** What an agent's isolate is told of the tools its workspace runs for it, and their digest: it is told them again only
 *  when the digest moves. */
import { asSchema, type ToolSet } from 'ai';
import { hasPlanPermission } from '../execution/work-mode';
import { argumentDigest } from '../safety/argument-digest';
import { projectJsonValue } from '../utils/json';
import { toolDescription } from '../utils/tool-description';
import type { AgentToolDescriptor } from './agent-isolate';

export async function describeAgentTools(tools: ToolSet): Promise<{ readonly descriptors: AgentToolDescriptor[]; readonly digest: string }> {
  const descriptors = await Promise.all(Object.entries(tools).map(async ([name, tool]) => ({
    name,
    description: toolDescription(tool) ?? '',
    inputSchema: await asSchema(tool.inputSchema).jsonSchema,
    planAllowed: hasPlanPermission(tool),
  })));

  return { descriptors, digest: argumentDigest(projectJsonValue({ value: descriptors })) };
}
