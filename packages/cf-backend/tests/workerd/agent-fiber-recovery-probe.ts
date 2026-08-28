import { Agent, type FiberRecoveryContext, type FiberRecoveryResult } from 'agents';

/** Minimal real SDK subject for the patched `_checkRunFibers` scan. No ActorAgent
 * policy or Kinu lane is involved: the assertion is about the installed Agents
 * dependency reading cf_agents_runs one metadata row then one snapshot at a time. */
export class FiberRecoveryProbeAgent extends Agent<Cloudflare.Env> {
  readonly recovered: string[] = [];

  async seedRun(id: string, name: string, snapshot: string, createdAt: number): Promise<void> {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS cf_agents_runs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, snapshot TEXT, created_at INTEGER NOT NULL
    )`);
    this.ctx.storage.sql.exec(
      `INSERT INTO cf_agents_runs (id, name, snapshot, created_at) VALUES (?, ?, ?, ?)`,
      id, name, snapshot, createdAt,
    );
  }

  /** Public SDK lifecycle entry. `Agent.onStart()` is what calls the installed
   *  recovery scan on an activation; invoking it here tests that entry instead
   *  of reaching through the dependency's private `_checkRunFibers` member. */
  async scan(): Promise<void> {
    await this.onStart();
  }

  async recoveredIds(): Promise<string[]> {
    return [...this.recovered];
  }

  async rows(): Promise<Array<{ id: string; name: string }>> {
    return this.ctx.storage.sql.exec<{ id: string; name: string }>(
      `SELECT id, name FROM cf_agents_runs ORDER BY rowid`,
    ).toArray();
  }

  override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<FiberRecoveryResult> {
    this.recovered.push(ctx.id);
    return { status: 'completed', snapshot: ctx.snapshot };
  }
}
