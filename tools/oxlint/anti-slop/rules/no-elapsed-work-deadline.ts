import { defineRule } from "@oxlint/plugins";

import { TEST_DIRECTORY, TEST_SUFFIX } from "./no-ambient-git-in-tests.ts";
import type { ESTree } from "@oxlint/plugins";

/**
 * Reject elapsed timers that end LLM, turn, delegation, swarm, head, job, or compaction work.
 *
 * AGENTS.md requires work to end on provider completion, a definitive failure, or explicit
 * cancellation. The deleted `BRANCH_RPC_TIMEOUT_MS` family made a branch failure silent: a timer
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
 * same-value no-timer branch is also outside the rule because the caller selected that bound.
 * `branch-process.ts` stays governed for its historical RPC regression; only its complete child
 * readiness handshake is exempt, after the `ready` message or child error/exit settles the promise.
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
    "packages/cli-backend/src/craft-executor.ts",
    "packages/cli-backend/src/execute-tools-factory.ts",
    "packages/cli-backend/src/opencode-provider.ts",
    "packages/cli-backend/src/claude-cli-provider.ts",
    "packages/cf-backend/src/actor-agent.ts",
    "packages/cf-backend/src/orchestrator.ts",
    "packages/cf-backend/src/fiber-recovery.ts",
  ],
  delegation: [
    "packages/core/src/subordinates/",
    "packages/core/src/events/ingress/peer.ts",
    "packages/core/src/evolution/delegation-features.ts",
    "packages/core/src/tools/agents-",
    "packages/cli-backend/src/agent-host/",
    "packages/cf-backend/src/subordinate-agent.ts",
    "packages/cf-backend/src/facet-spawn.ts",
    "packages/cf-backend/src/exploration.ts",
  ],
  swarm: [
    "packages/core/src/strategy/",
    "packages/core/src/mcts/",
    "packages/cli-backend/src/branch-worker.ts",
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

/** The historical RPC source remains in scope even though its filename names no policy domain. */
export const BRANCH_PROCESS_SOURCE = "packages/cli-backend/src/branch-process.ts";


/** The rule and its gate share this path predicate so they cannot govern different file sets. */
export function isElapsedWorkDeadlineSource(filename: string): boolean {
  const normalized = filename.replaceAll("\\", "/");
  if (ELAPSED_TEST_FILE.test(normalized)) return false;
  return normalized.includes(BRANCH_PROCESS_SOURCE)
    || Object.values(ELAPSED_WORK_SOURCE_ROOTS)
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

type FunctionLike = ESTree.ArrowFunctionExpression | ESTree.Function;

function isFunctionLike(node: ESTree.Node | null | undefined): node is FunctionLike {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
}

function identifierName(node: ESTree.Node | null | undefined): string | null {
  return node?.type === "Identifier" ? node.name : null;
}

function isStringLiteral(node: ESTree.Node | null | undefined, value: string): boolean {
  if (node?.type !== "Literal") return false;
  return node.value === value;
}

function callsIdentifier(node: ESTree.Node, name: string, firstArgument?: string): boolean {
  if (node.type === "ExpressionStatement") return callsIdentifier(node.expression, name, firstArgument);
  if (node.type === "BlockStatement") {
    return node.body.some((statement) => callsIdentifier(statement, name, firstArgument));
  }
  if (node.type === "IfStatement") {
    return callsIdentifier(node.consequent, name, firstArgument)
      || (node.alternate !== null && callsIdentifier(node.alternate, name, firstArgument));
  }
  if (node.type === "ReturnStatement") {
    return node.argument !== null && callsIdentifier(node.argument, name, firstArgument);
  }
  if (node.type === "AwaitExpression") return callsIdentifier(node.argument, name, firstArgument);
  if (node.type === "TSNonNullExpression"
    || node.type === "TSAsExpression"
    || node.type === "TSSatisfiesExpression") {
    return callsIdentifier(node.expression, name, firstArgument);
  }
  if (node.type === "UnaryExpression" && node.operator === "void") {
    return callsIdentifier(node.argument, name, firstArgument);
  }
  if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || node.callee.name !== name) {
    return false;
  }
  return firstArgument === undefined || identifierName(node.arguments[0]) === firstArgument;
}

function declaredFunction(body: ESTree.BlockStatement, name: string): FunctionLike | null {
  for (const statement of body.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      if (identifierName(declaration.id) === name && isFunctionLike(declaration.init)) {
        return declaration.init;
      }
    }
  }
  return null;
}

type ChildListener = {
  readonly childName: string;
  readonly listener: FunctionLike;
};

function childListener(
  body: ESTree.BlockStatement,
  childName: string | null,
  event: string,
): ChildListener | null {
  for (const statement of body.body) {
    if (statement.type !== "ExpressionStatement" || statement.expression.type !== "CallExpression") continue;
    const call = statement.expression;
    const callee = call.callee;
    if (callee.type !== "MemberExpression"
      || callee.computed
      || callee.object.type !== "Identifier"
      || callee.property.type !== "Identifier"
      || callee.property.name !== "on"
      || (childName !== null && callee.object.name !== childName)
      || !isStringLiteral(call.arguments[0], event)) {
      continue;
    }
    const listener = call.arguments[1];
    if (isFunctionLike(listener)) return { childName: callee.object.name, listener };
    if (listener?.type === "Identifier") {
      const declared = declaredFunction(body, listener.name);
      if (declared !== null) return { childName: callee.object.name, listener: declared };
    }
  }
  return null;
}

function isReadyMessageTest(node: ESTree.Expression, messageName: string): boolean {
  if (node.type !== "BinaryExpression" || node.operator !== "===") return false;
  const leftIsMessageMethod = node.left.type === "MemberExpression"
    && !node.left.computed
    && node.left.object.type === "Identifier"
    && node.left.object.name === messageName
    && node.left.property.type === "Identifier"
    && node.left.property.name === "method";
  const rightIsMessageMethod = node.right.type === "MemberExpression"
    && !node.right.computed
    && node.right.object.type === "Identifier"
    && node.right.object.name === messageName
    && node.right.property.type === "Identifier"
    && node.right.property.name === "method";
  return (leftIsMessageMethod && isStringLiteral(node.right, "ready"))
    || (isStringLiteral(node.left, "ready") && rightIsMessageMethod);
}

function resolvesOnReady(listener: FunctionLike, resolveName: string, timerName: string): boolean {
  const messageName = identifierName(listener.params[0]);
  const body = listener.body;
  if (messageName === null || body?.type !== "BlockStatement") return false;
  return body.body.some((statement) =>
    statement.type === "IfStatement"
      && isReadyMessageTest(statement.test, messageName)
      && callsIdentifier(statement.consequent, "clearTimeout", timerName)
      && callsIdentifier(statement.consequent, resolveName));
}

function settlesOnChildEvent(listener: FunctionLike, rejectName: string, timerName: string): boolean {
  const body = listener.body;
  if (body === null) return false;
  const clearsTimer = callsIdentifier(body, "clearTimeout", timerName);
  return clearsTimer && callsIdentifier(body, rejectName);
}

function promiseExecutor(node: ESTree.Node): FunctionLike | null {
  let parent = node.parent;
  while (parent !== null && parent.type !== "Program") {
    if (parent.type === "NewExpression"
      && parent.callee.type === "Identifier"
      && parent.callee.name === "Promise") {
      const executor = parent.arguments[0];
      return isFunctionLike(executor) ? executor : null;
    }
    parent = parent.parent;
  }
  return null;
}

/**
 * The branch worker's fork-ready wait is process startup, not an elapsed work deadline. Every
 * condition below is required: the timer rejects this promise; `ready` resolves it; and the same
 * child has error and exit listeners that clear the timer and reject. A timer that merely resembles
 * one piece of this sequence stays governed.
 */
function isBranchReadyStartupHandshake(node: ESTree.CallExpression): boolean {
  const callback = node.arguments[0];
  const executor = promiseExecutor(node);
  const executorBody = executor?.body;
  const timerName = node.parent?.type === "VariableDeclarator" && node.parent.init === node
    ? identifierName(node.parent.id)
    : null;
  if (!isFunctionLike(callback)
    || callback.body === null
    || executor === null
    || executorBody?.type !== "BlockStatement"
    || timerName === null) {
    return false;
  }
  const resolveName = identifierName(executor.params[0]);
  const rejectName = identifierName(executor.params[1]);
  if (resolveName === null
    || rejectName === null
    || !callsIdentifier(callback.body, rejectName)) {
    return false;
  }
  const message = childListener(executorBody, null, "message");
  if (message === null || !resolvesOnReady(message.listener, resolveName, timerName)) return false;
  const error = childListener(executorBody, message.childName, "error");
  const exit = childListener(executorBody, message.childName, "exit");
  return error !== null
    && exit !== null
    && settlesOnChildEvent(error.listener, rejectName, timerName)
    && settlesOnChildEvent(exit.listener, rejectName, timerName);
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
        if (!endsWork(callback.body)
          || hasNoTimerAlternative(node)
          || (context.filename.replaceAll("\\", "/").includes(BRANCH_PROCESS_SOURCE)
            && isBranchReadyStartupHandshake(node))) {
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
