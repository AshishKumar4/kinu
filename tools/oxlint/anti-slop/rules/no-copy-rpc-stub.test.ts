import { RuleTester } from "oxlint/plugins-dev";

import { noCopyRpcStubRule } from "./no-copy-rpc-stub.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "copiedRpcStub" };

tester.run("anti-slop/no-copy-rpc-stub", noCopyRpcStubRule, {
  valid: [
    // Holding the stub. This is the correction every invalid case below should become.
    "const vault = env.UserDO.get(env.UserDO.idFromName(userId)); await vault.listEgressSecrets();",
    // Holding it behind a narrower contract, declared rather than structurally copied.
    "const vault: EgressVaultClient = env.UserDO.get(env.UserDO.idFromName(userId));",
    // Awaited and held.
    "const agent = await getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, name); await agent.acceptContainerEvent(e);",
    // runtime.ts:163-167 as it really stands. Object.assign over an object LITERAL is correct: those
    // members are own enumerable properties, and flagging it would be a false positive on live code.
    "const namespaceView: Partial<RuntimeUserDONamespace> = {}; Object.assign(namespaceView, { idFromName: (name: string) => env.UserDO.idFromName(name), get: (id: DurableObjectId) => env.UserDO.get(id) });",
    // Spread of an object literal that merely mentions the namespace.
    "const view = { ...{ get: (id: DurableObjectId) => env.UserDO.get(id) } };",
    // `get` on things that are not Durable Object namespaces. Keying on any `.get(…)` would flag
    // these, which is why the rule requires the chain to be reached through `env`.
    "const merged = { ...headers.get('x-trace') };",
    "Object.assign(target, cache.get(key));",
    "Object.assign(target, this.registry.get(name));",
    // A plain value produced by a function that happens to be called on env.
    "Object.assign(target, env.CONFIG_JSON);",
    // Passing the stub as an argument is fine; only copying its members is not.
    "await handle(env.UserDO.get(id));",
    // Spreading a plain object that was built from stub RESULTS (data, not the stub).
    "const secrets = await vault.listEgressSecrets(); const out = { ...secrets };",
  ],
  invalid: [
    {
      name: "egress/outbound.ts:164 as it shipped — the vault view whose resolveEgressInjection production proved undefined",
      code: "const vaultView: Partial<EgressVaultClient> = {};\nObject.assign(vaultView, env.UserDO.get(env.UserDO.idFromName(params.ownerUserId)));",
      errors: [error],
    },
    {
      name: "egress/outbound.ts:258 as it shipped — the awaited getAgentByName form",
      code: "const agentView: Partial<ContainerEventClient> = {};\nObject.assign(agentView, await getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, params.workspaceName));",
      errors: [error],
    },
    {
      name: "runtime.ts:220 as it shipped — same pattern on the OrchestratorAgent namespace, never observed firing",
      code: "const rootView: Partial<RootApprovalClient> = {};\nObject.assign(rootView, env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(workspaceName)));",
      errors: [error],
    },
    {
      name: "object spread copies exactly as little as Object.assign",
      code: "const view = { ...env.UserDO.get(env.UserDO.idFromName(userId)) };",
      errors: [error],
    },
    {
      name: "spread of an awaited getAgentByName",
      code: "const view = { ...(await getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, name)) };",
      errors: [error],
    },
    {
      name: "splitting the expression across two statements is not an escape — the const alias resolves",
      code: "const stub = env.UserDO.get(env.UserDO.idFromName(userId));\nconst view = { ...stub };",
      errors: [error],
    },
    {
      name: "the alias reached through Object.assign",
      code: "const stub = await getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, name);\nconst view = {};\nObject.assign(view, stub);",
      errors: [error],
    },
    {
      name: "`as DurableObjectStub<UserDO>` does not launder it — the cast is stripped",
      code: "Object.assign(view, env.UserDO.get(env.UserDO.idFromName(userId)) as DurableObjectStub<UserDO>);",
      errors: [error],
    },
    {
      name: "a binding whose only stub evidence is its DurableObjectStub annotation",
      code: "const stub: DurableObjectStub<UserDO> = acquire();\nconst view = { ...stub };",
      errors: [error],
    },
    {
      name: "reached through this.env",
      code: "Object.assign(view, this.env.OrchestratorAgent.get(id));",
      errors: [error],
    },
    {
      name: "reached through a nested options bag, as owned-model-services.ts spells it",
      code: "Object.assign(view, this.options.env.UserDO.get(this.options.env.UserDO.idFromName(userId)));",
      errors: [error],
    },
    {
      name: "getByName, the newer namespace spelling",
      code: "const view = { ...env.UserDO.getByName(userId) };",
      errors: [error],
    },
    {
      name: "two stub sources in one Object.assign are two findings",
      code: "Object.assign(view, env.UserDO.get(a), env.OrchestratorAgent.get(b));",
      errors: [error, error],
    },
  ],
});
