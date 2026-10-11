/** A caller in a separate isolate, using the product's public setup and turn entrypoints. */
import { DurableObject } from 'cloudflare:workers';
import type { OrchestratorAgent } from './product';
import type { UserDO } from '../../packages/cf-backend/src/user/user-do';
import type { Slice } from './meter';
import { SCRIPTED_MODEL_SPEC } from '../../packages/test-utils/src/scripted-model-spec';
import { PERF_SECRET, PERF_SECRET_HOST } from './egress-secret';

interface DriverEnv {
  readonly OWNER_TOKEN: string;
  readonly OrchestratorAgent: DurableObjectNamespace<OrchestratorAgent>;
  readonly UserDO: DurableObjectNamespace<UserDO>;
}

const OWNER = 'fedcba9876543210fedcba9876543211';

export class PerfDriver extends DurableObject<DriverEnv> {
  private target(workspace: string) { return this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspace)); }

  async setup(workspace: string): Promise<void> {
    const users = this.env.UserDO.get(this.env.UserDO.idFromName(OWNER));
    const caller = { ownerToken: this.env.OWNER_TOKEN };
    const target = this.target(workspace);
    await users.ensureProfile(caller, 'owner@perfio.local', 'Owner');
    await users.registerWorkspace(caller, workspace, workspace);
    const claim = await target.claimOwner(OWNER);
    await users.ensureWorkspaceCapability(workspace, claim.capabilityHash);
    await users.setCredential(caller, 'openai-compat.default', { kind: 'openai-compat', baseURL: 'http://model.invalid', apiKey: 'perf' });

    await target.setSoul('# Probe\n\nAnswer.');
    await target.setModel(SCRIPTED_MODEL_SPEC);
    await target.getWorkspaceSnapshot();
    await target.perfQuiet();
  }

  async turn(workspace: string, text: string): Promise<void> {
    const target = this.target(workspace);
    const result = await target.runTaskFromMcp(text);

    if (result.status !== 'queued') throw new Error(`probe turn was ${result.status}`);
    await target.perfJoin();
  }

  async begin(workspace: string): Promise<void> {
    const target = this.target(workspace);
    await target.perfBegin();
  }

  async cut(workspace: string, label: string, resume: boolean): Promise<{ workspace: Slice; facet: Slice | null }> {
    return await this.target(workspace).perfCut(label, resume);
  }

  async seed(workspace: string): Promise<void> { await this.target(workspace).perfSeed(); }

  /** The egress subject's vault secret, put and granted while the workspace runs: its egress reads grants as they stand. */
  async grant(workspace: string): Promise<string> {
    const users = this.env.UserDO.get(this.env.UserDO.idFromName(OWNER));
    const binding = await users.putEgressSecret({ ownerToken: this.env.OWNER_TOKEN }, { id: 'perfio-git', label: 'perfio git', host: PERF_SECRET_HOST, secret: PERF_SECRET });

    await this.target(workspace).perfGrantEgress(binding.id);

    return binding.placeholder;
  }

  async tool(workspace: string, name: string, input: string): Promise<string> {
    return await this.target(workspace).perfTool(name, input);
  }
}

export default {
  async fetch(request: Request, env: DriverEnv & { readonly PERF_DRIVER: DurableObjectNamespace<PerfDriver> }): Promise<Response> {
    const url = new URL(request.url);
    const workspace = url.searchParams.get('workspace') ?? 'perf';
    const driver = env.PERF_DRIVER.get(env.PERF_DRIVER.idFromName(workspace));

    switch (url.pathname) {
      case '/setup': await driver.setup(workspace); break;
      case '/turn': await driver.turn(workspace, url.searchParams.get('text') ?? 'hello'); break;
      case '/begin': await driver.begin(workspace); break;
      case '/cut': return Response.json(await driver.cut(workspace, url.searchParams.get('label') ?? '', url.searchParams.get('resume') === '1'));
      case '/seed': await driver.seed(workspace); break;
      case '/grant': return new Response(await driver.grant(workspace));
      case '/tool': {
        const input = await request.text();

        return new Response(await driver.tool(workspace, url.searchParams.get('name') ?? 'file', input));
      }

      default: return new Response('not found', { status: 404 });
    }

    return new Response(null, { status: 204 });
  },
};
