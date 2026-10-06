/**
 * The agent bundle the agent-facet probe loads: the shipped facet plus the calls the test drives. Exported under
 * the shipped class name, which the workspace object loads by name.
 */
import { AgentFacet as ShippedAgentFacet } from '../../src/agent-facet/agent-facet';
import type { AgentFacetAnswer, AgentFacetClaim } from './agent-facet-shapes';

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

  /** A row in this agent's own SQLite, which only its facet storage holds. */
  async mark(value: string): Promise<void> {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS probe_marks (value TEXT)');
    this.ctx.storage.sql.exec('INSERT INTO probe_marks VALUES (?)', value);
  }

  async marks(): Promise<string[]> {
    const table = this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'probe_marks'").toArray();

    return table.length === 0 ? [] : this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM probe_marks').toArray().map((row) => row.value);
  }

  async turns(): Promise<AgentFacetClaim[]> {
    return this.ctx.storage.sql.exec<AgentFacetClaim & Record<string, SqlStorageValue>>('SELECT actor_id AS actorId, turn_id AS turnId, outcome, program_kind AS programKind FROM actor_turn_claims').toArray();
  }
}
