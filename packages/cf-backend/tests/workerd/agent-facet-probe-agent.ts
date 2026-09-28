/**
 * The agent bundle the agent-facet probe loads: the shipped facet plus the calls the test drives. Exported under
 * the shipped class name, which the workspace object loads by name.
 */
import { AgentFacet as ShippedAgentFacet } from '../../src/agent-facet/agent-facet';
import type { AgentFacetAnswer } from './agent-facet-shapes';

let bootId: string | null = null;

export class AgentFacet extends ShippedAgentFacet {
  async boot(): Promise<string> {
    bootId ??= crypto.randomUUID();

    return bootId;
  }

  async write(path: string, text: string): Promise<void> {
    await this.workspace().files.write(path, text);
  }

  async exec(command: string): Promise<AgentFacetAnswer> {
    const { exitCode, stdout, stderr } = await this.workspace().exec(command);

    return { exitCode, stdout, stderr };
  }
}
