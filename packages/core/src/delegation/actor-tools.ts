/**
 * An actor's tool surface: `buildBuiltinTools` plus the `agents` delegation tool.
 * `agents` lives here, not in that factory, because registering it there closes a runtime import cycle.
 */

import type { ToolSet } from 'ai';
import * as v from 'valibot';
import { Cause, Effect, Exit } from 'effect';
import { buildToolSurface, surfaceStores, type BuiltinToolDeps, type CodemodeBuilder } from '../tools/builtins';
import type { ServedStores } from '../tools/actor-stores';
import type { AgentsToolDeps } from './agents-tool';
import { createAgentsTool } from './agents-operations';
import { agentsWired } from './agents-tool';
import type { EffectClaimDeps } from '../tools/effect-claim';
import { wrapToolsForBackground, type ActorJobs } from '../jobs/background-wrap';
import { isBackgroundOutcomeText } from '../jobs/threshold';
import { withClampedToolResult } from '../tools/clamp';
import { createCraftLedger, observeCraftCall, type CraftLedger } from '../craft/in-episode';
import type { TurnCraftLedger } from '../craft/turn-ledger';
import { currentWorkMode } from '../execution/work-mode';
import { renderThrownChain, settle } from '../obs/index';
import { renderToolResult } from '../utils/evidence-window';
import type { AgentRuntime } from '../types/agent-runtime';

// Not `ActorToolDeps`: cf-backend's actor-agent.ts already owns that name.
export interface ActorToolsetDeps extends BuiltinToolDeps {
  /** Deps for `agents`; registered when any group is wired, actions gate per group. */
  agents?: AgentsToolDeps;
  /** Durable once-only boundary for tools whose effects leave the process. */
  effectClaims: EffectClaimDeps;
  /** Builds `eval` over the finished surface (builtins plus `agents`); runs before the effect-claim wrap. */
  codemode?: CodemodeBuilder;
  jobs: ActorJobs;
  /** The turn's crafted-tool record: its `eval` calls are observed here, where they run. Absent, none is. */
  craft?: TurnCraftLedger;
  /** The store operations to project, when a caller already serves them (another mode's tools in the same call). */
  served?: ServedStores;
}

export interface ActorToolsets {
  readonly turn: ToolSet;
  readonly raw: ToolSet;
  /** The store operations both run, which the actor's other projections (its programs, a slate's call, its scaffold's
   *  machines) take rather than serving their own. */
  readonly stores: ServedStores;
}

/** Every builtin, plus `agents` when any delegation group is offered, each behind its replay policy (tools/effect-claim.ts). */
export function buildActorTools(deps: ActorToolsetDeps): ActorToolsets {
  let extra: ToolSet | undefined;

  if (deps.agents && agentsWired(deps.agents)) extra = { agents: createAgentsTool(deps.agents) };

  const { codemode } = deps;
  const clamp = { files: deps.rt.storage, producer: 'eval' as const, images: true as const };
  const stores = surfaceStores(deps);
  // The budget its stores account into, which its other tools share.
  const { budget } = stores.deps.files();

  // An actor's `eval` results are clamped to its context budget; a confined surface's are its run's to judge.
  const raw = buildToolSurface({
    ...deps, extra, served: stores,
    codemode: codemode && ((surface, reach) => withClampedToolResult(
      codemode(surface, reach), deps.contextBudget ? { ...clamp, budget } : clamp,
    )),
  });

  const turn = wrapToolsForBackground(raw, deps.jobs);

  if (deps.craft !== undefined && turn.eval !== undefined) {
    turn.eval = observingCrafts(turn.eval, craftLedgerOver(deps.rt), deps.craft);
  }

  return { raw, turn, stores };
}

/** The crafted-tool store `rt` holds, opened on first use: a turn that records nothing reads none, and an agent's own
 *  isolate has none (they are the workspace's). */
function craftLedgerOver(rt: Pick<AgentRuntime, 'craftStore' | 'storage'>): CraftLedger {
  let opened: CraftLedger | undefined;
  const ledger = (): CraftLedger => (opened ??= createCraftLedger({ craftStore: rt.craftStore, sql: rt.storage.sql }));

  return { names: () => ledger().names(), broke: (name, error) => { ledger().broke(name, error); }, repaired: (names) => { ledger().repaired(names); } };
}

/**
 * `eval`, scored where it runs, over the store its crafted tools live in: each call it closes while `turn` records is
 * observed against the callable set as it was dispatched (`observeCraftCall`), into `turn` under its call id. A
 * backgrounded call has not finished, so it is not observed; nor is a Plan invocation.
 */
export function observingCrafts(entry: ToolSet[string], ledger: CraftLedger, turn: TurnCraftLedger): ToolSet[string] {
  const { execute } = entry;

  if (execute === undefined) return entry;

  return {
    ...entry,
    execute: async (input, options) => {
      if (!turn.recording || currentWorkMode() === 'plan') return await execute(input, options);
      const before = new Set(ledger.names());
      const code = v.safeParse(v.object({ code: v.string() }), input);

      const observe = (result: string, failed: boolean): void => {
        if (!code.success || isBackgroundOutcomeText(result)) return;
        const call = observeCraftCall(ledger, { code: code.output.code, before, result, failed });

        if (call !== null) turn.note(options.toolCallId, call);
      };

      // The call closes as it would unobserved: its output, or its own error rethrown as it was thrown.
      return await settle(Effect.gen(function* () {
        const settled = yield* Effect.exit(Effect.promise(async () => await execute(input, options)));

        if (Exit.isSuccess(settled)) {
          observe(renderToolResult(settled.value), false);

          return settled.value;
        }

        observe(renderThrownChain({ cause: Cause.squash(settled.cause) }), true);

        return yield* Effect.failCause(settled.cause);
      }));
    },
  };
}

export {
  PEER_REPLY_TOPIC,
  type AgentsToolDeps, type AgentsSwarmDeps,
  type TeamToolDeps, type SubagentRosterEntry, type SubagentStatus,
  type SubagentDelivery, type SubagentPhase, type SubagentHandoff, type SubagentDismissal,
  type PeersToolDeps,
  type PeerAskOutcome, type PeerSendOutcome, type PeerReplyOutcome, type PeerSpawnOutcome,
} from './agents-tool';
