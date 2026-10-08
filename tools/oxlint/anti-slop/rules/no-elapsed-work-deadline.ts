import { defineRule } from "@oxlint/plugins";

import { TEST_DIRECTORY, TEST_SUFFIX } from "./no-ambient-git-in-tests.ts";
import type { ESTree } from "@oxlint/plugins";

/**
 * Reject elapsed timers that end LLM, turn, delegation, swarm, head, job, or compaction work.
 *
 * AGENTS.md requires work to end on provider completion, a definitive failure, or explicit
 * cancellation; a silence is a definitive failure (owner, 2026-10-01). The deleted `BRANCH_RPC_TIMEOUT_MS` family made a branch failure silent: a timer
 * rejected the RPC, MCTS stored zero, and convergence selected from a false signal.
 *
 * The exported scope is the policy boundary. Transport, scripts, and process-liveness code have
 * different timeout contracts and are not governed here. The gate imports this exact predicate,
 * asserts a nonempty denominator for every policy domain, and checks the binary's measured set.
 *
 * The matcher is structural:
 *
 *   1. `setTimeout` / `setInterval` with an inline callback that calls `reject(...)`, calls
 *      `.abort(...)`, or throws; and
 *   2. `AbortSignal.timeout(ms)` placed directly in a `Promise.race` array.
 *
 * A callback that only resolves bounds a wait without ending live work. An opt-in timer with a
 * same-value no-timer branch is also outside the rule because the caller selected that bound. A
 * silence bound is not a deadline: its delay is `silenceBoundMs('<id>')`, typed to admit only a catalog
 * fact declared `bounds: 'silence'`, which ends only work that stopped sending. Any other number is one.
 *
 * Deliberate limits: this does not infer an ending through an identifier callback, does not catch a
 * `Date.now()` delta checked elsewhere, and does not follow an `AbortSignal.timeout` binding into a
 * later race. The gate prints all three on its green path.
 */

/** What counts as test code for this rule. The arms live in `no-ambient-git-in-tests.ts`, which
 *  names them so a narrower consumer imports them instead of copying them; a third spelling of
 *  "test file" beside `TEST_FILE` is how the two rules stop agreeing about what a test is. */
export const ELAPSED_TEST_FILE = new RegExp(`${TEST_DIRECTORY.source}|${TEST_SUFFIX.source}`);

/** Source roots that perform the policy's named kinds of work. */
export const ELAPSED_WORK_SOURCE_ROOTS = {
  llm: [
    "packages/core/src/llm.ts",
    "packages/core/src/chat.ts",
    "packages/core/src/providers/",
    "packages/core/src/prompts/",
  ],
  turn: [
    "packages/core/src/orchestrator/",
    "packages/core/src/prompting/",
    "packages/core/src/turn-failure.ts",
    "packages/core/src/steer-branch.ts",
    "packages/core/src/context-",
    "packages/cli/src/chat-loop.ts",
    "packages/cli/src/cloud-turn-stream.ts",
    "packages/cli/src/turn-log.ts",
    "packages/cli/src/commands/run.ts",
    "packages/cli-backend/src/runtime.ts",
    "packages/cli-backend/src/local-session.ts",
    "packages/cli-backend/src/fiber.ts",
    "packages/cli-backend/src/node-runtime.ts",
    "packages/cli-backend/src/model-resolver.ts",
    "packages/cli-backend/src/executor.ts",
    "packages/cli-backend/src/codemode-tool-factory.ts",
    "packages/cli-backend/src/opencode-provider.ts",
    "packages/cf-backend/src/actor-agent.ts",
    "packages/cf-backend/src/orchestrator.ts",
  ],
  delegation: [
    "packages/core/src/subordinates/",
    "packages/core/src/events/ingress/peer.ts",
    "packages/core/src/evolution/delegation-features.ts",
    "packages/core/src/tools/agents-",
    "packages/cli-backend/src/agent-host/",
    "packages/cf-backend/src/subordinate-agent.ts",
    "packages/cf-backend/src/facet-spawn.ts",
  ],
  swarm: [
    "packages/core/src/strategy/",
    "packages/core/src/mcts/",
  ],
  head: [
    "packages/core/src/heads/",
    "packages/cli-backend/src/head-runtime.ts",
    "packages/cf-backend/src/head-runtime.ts",
  ],
  job: [
    "packages/core/src/jobs/",
    "packages/core/src/read-models/background-jobs.ts",
  ],
  compaction: [
    "packages/core/src/compaction.ts",
    "packages/compaction/src/",
  ],
} as const;

/** The rule and its gate share this path predicate so they cannot govern different file sets. */
export function isElapsedWorkDeadlineSource(filename: string): boolean {
  const normalized = filename.replaceAll("\\", "/");
  if (ELAPSED_TEST_FILE.test(normalized)) return false;
  return Object.values(ELAPSED_WORK_SOURCE_ROOTS)
    .some((roots) => roots.some((root) => normalized.includes(root)));
}


const TIMER_NAMES: Readonly<Record<string, true>> = {
  setTimeout: true,
  setInterval: true,
};
const ENDING_METHOD_NAMES: Readonly<Record<string, true>> = {
  abort: true,
  reject: true,
};

/**
 * Does this statement or expression end work in a timer callback? The rule recognizes the ending
 * operations rather than a variable name: `reject(...)`, `.reject(...)`, `.abort(...)`, and
 * `throw`. It reads wrappers and branches that do not change the callback's ending effect.
 */
function endsWork(node: ESTree.Node): boolean {
  if (node.type === "ThrowStatement") return true;
  if (node.type === "ExpressionStatement") return endsWork(node.expression);
  if (node.type === "ReturnStatement") return node.argument !== null && endsWork(node.argument);
  if (node.type === "IfStatement") {
    return endsWork(node.consequent)
      || (node.alternate !== null && endsWork(node.alternate));
  }
  if (node.type === "BlockStatement") return node.body.some((statement) => endsWork(statement));
  if (node.type === "CallExpression") {
    const callee = node.callee;
    if (callee.type === "Identifier") return callee.name === "reject";
    return callee.type === "MemberExpression"
      && !callee.computed
      && callee.property.type === "Identifier"
      && Object.hasOwn(ENDING_METHOD_NAMES, callee.property.name);
  }
  if (node.type === "AwaitExpression") return endsWork(node.argument);
  if (node.type === "TSNonNullExpression"
    || node.type === "TSAsExpression"
    || node.type === "TSSatisfiesExpression") {
    return endsWork(node.expression);
  }
  return node.type === "UnaryExpression" && node.operator === "void" && endsWork(node.argument);
}

/** Is this condition structurally about the same delay value the timer receives? */
function mentionsDelay(test: ESTree.Expression, delayName: string): boolean {
  if (test.type === "Identifier") return test.name === delayName;
  if (test.type === "BinaryExpression") {
    return test.left.type !== "PrivateIdentifier"
      && (mentionsDelay(test.left, delayName) || mentionsDelay(test.right, delayName));
  }
  if (test.type === "LogicalExpression") {
    return mentionsDelay(test.left, delayName) || mentionsDelay(test.right, delayName);
  }
  return test.type === "UnaryExpression" && mentionsDelay(test.argument, delayName);
}

/** `silenceBoundMs('<id>')`, whose parameter type admits only a fact the catalog declares a silence bound. */
function isSilenceBound(delay: ESTree.Node | undefined): boolean {
  if (delay?.type !== "CallExpression" || delay.callee.type !== "Identifier"
    || delay.callee.name !== "silenceBoundMs" || delay.arguments.length !== 1) return false;
  const [id] = delay.arguments;
  return id?.type === "Literal" && typeof id.value === "string";
}

/** A return branch provides the no-timer alternative to an opt-in deadline. */
function returnsWithoutArmingTimer(node: ESTree.Statement | null): boolean {
  if (node?.type === "ReturnStatement") return true;
  return node?.type === "BlockStatement"
    && node.body.length === 1
    && node.body[0]?.type === "ReturnStatement";
}

/**
 * A timer can be caller-selected without smuggling a path exemption into the rule. The two forms
 * intentionally recognized here share the delay value with their no-timer alternative:
 *
 *   if (deadline > 0) setTimeout(..., deadline)
 *   if (timeoutMs === undefined) return work(); ... setTimeout(..., timeoutMs)
 *
 * A different variable, an unconditional timer, or a condition that does not return to an unbounded
 * path remains governed.
 */
function hasNoTimerAlternative(node: ESTree.CallExpression): boolean {
  const delay = node.arguments[1];
  if (delay?.type !== "Identifier") return false;

  const delayName = delay.name;
  let child: ESTree.Node = node;
  let parent: ESTree.Node | null = node.parent;

  while (parent !== null && parent.type !== "Program") {
    if (parent.type === "IfStatement" && mentionsDelay(parent.test, delayName)) {
      if (parent.consequent === child && parent.alternate === null) return true;
      if (parent.alternate === child && returnsWithoutArmingTimer(parent.consequent)) return true;
    }
    if (parent.type === "ConditionalExpression" && mentionsDelay(parent.test, delayName)) {
      if (parent.consequent === child
        && parent.alternate.type === "Identifier"
        && parent.alternate.name === "undefined") {
        return true;
      }
      if (parent.alternate === child
        && parent.consequent.type === "Identifier"
        && parent.consequent.name === "undefined") {
        return true;
      }
    }
    if (parent.type === "BlockStatement") {
      const statementIndex = parent.body.findIndex((statement) => statement === child);
      if (statementIndex > 0) {
        for (const preceding of parent.body.slice(0, statementIndex)) {
          if (preceding.type === "IfStatement"
            && mentionsDelay(preceding.test, delayName)
            && (returnsWithoutArmingTimer(preceding.consequent)
              || returnsWithoutArmingTimer(preceding.alternate))) {
            return true;
          }
        }
      }
    }
    child = parent;
    parent = parent.parent;
  }

  return false;
}

export const noElapsedWorkDeadlineRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow timers that end work because wall-clock time elapsed; work ends on completion, definitive failure, or explicit cancellation.",
    },
    messages: {
      elapsedDeadlineArm:
        "This timer's callback ends pending work: an elapsed deadline is the cause of the ending, not a reason recorded beside it. Per AGENTS.md: no elapsed LLM, turn, delegation, swarm or compaction deadline; work ends on provider completion, a definitive failure, or explicit cancellation. Bound at the cause instead: reject on child exit, abort on a definitive failure, or declare a bounded wait that resolves rather than terminates.",
      elapsedRaceSignal:
        "`AbortSignal.timeout` raced here is an elapsed deadline raced against live work. Per AGENTS.md: no elapsed LLM, turn, delegation, swarm or compaction deadline; work ends on provider completion, a definitive failure, or explicit cancellation. Race a cancellation signal the caller owns, or resolve the race arm rather than aborting the work.",
    },
  },
  createOnce(context) {
    let inScope = false;

    return {
      Program() {
        inScope = isElapsedWorkDeadlineSource(context.filename);
      },
      CallExpression(node) {
        if (!inScope) return;
        const callee = node.callee;
        if (callee.type !== "Identifier" || !Object.hasOwn(TIMER_NAMES, callee.name)) return;

        const callback = node.arguments[0];
        if (callback === undefined
          || (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression")
          || callback.body === null) {
          return;
        }
        if (!endsWork(callback.body) || hasNoTimerAlternative(node) || isSilenceBound(node.arguments[1])) {
          return;
        }

        context.report({
          node,
          messageId: "elapsedDeadlineArm",
        });
      },
      "CallExpression:exit"(node) {
        if (!inScope) return;
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed) return;
        if (callee.object.type !== "Identifier" || callee.object.name !== "Promise") return;
        if (callee.property.type !== "Identifier" || callee.property.name !== "race") return;

        const argument = node.arguments[0];
        if (argument?.type !== "ArrayExpression") return;
        for (const element of argument.elements) {
          if (element === null || element.type !== "CallExpression") continue;
          const elementCallee = element.callee;
          if (elementCallee.type !== "MemberExpression" || elementCallee.computed) continue;
          if (elementCallee.object.type !== "Identifier"
            || elementCallee.object.name !== "AbortSignal") continue;
          if (elementCallee.property.type !== "Identifier"
            || elementCallee.property.name !== "timeout") continue;
          context.report({ node: element, messageId: "elapsedRaceSignal" });
        }
      },
    };
  },
});
