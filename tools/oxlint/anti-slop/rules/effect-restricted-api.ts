import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * Effect is this repository's failure channel, not its schema, service, logging, tracing or timer
 * system. Owner decision, 2026-09-23: each of those already has one system here, and a second
 * beside it is the defect the migration exists to remove.
 *
 *   Schema            valibot parses every trust boundary.
 *   Layer, Context    `AgentRuntime` and explicit dependencies carry services.
 *   Logger, log*      the obs `Logger`, whose `ReservedLogField` keeps secrets out at compile time.
 *   Tracer, spans     the obs `Tracer`, scoped to one invocation; `Effect.fn` opens a span per call,
 *                     so `Effect.fnUntraced` is the spelling here.
 *   Schedule, sleep,  AGENTS.md: no elapsed deadlines on work, which ends on completion, failure or
 *   delay, timeout    cancellation. A pending timer also keeps a Durable Object from hibernating.
 *   effect/unstable/  modules outside Effect's stability promise.
 */

const RESTRICTED_EXPORTS: Readonly<Record<string, string>> = {
  Schema: "valibot",
  Layer: "`AgentRuntime` and explicit dependencies",
  Context: "`AgentRuntime` and explicit dependencies",
  Logger: "the obs `Logger`",
  Tracer: "the obs `Tracer`",
  Schedule: "no timer: work ends on completion, failure or cancellation",
};

const RESTRICTED_MEMBERS: Readonly<Record<string, string>> = {
  sleep: "no timer: work ends on completion, failure or cancellation",
  delay: "no timer: work ends on completion, failure or cancellation",
  timeout: "no elapsed deadline: work ends on completion, failure or cancellation",
  timeoutOption: "no elapsed deadline: work ends on completion, failure or cancellation",
  timeoutOrElse: "no elapsed deadline: work ends on completion, failure or cancellation",
  schedule: "no timer: work ends on completion, failure or cancellation",
  scheduleFrom: "no timer: work ends on completion, failure or cancellation",
  fn: "`Effect.fnUntraced`: `Effect.fn` opens a span per call",
  withSpan: "the obs `Tracer`",
  annotateSpans: "the obs `Tracer`",
  annotateCurrentSpan: "the obs `Tracer`",
  withParentSpan: "the obs `Tracer`",
  useSpan: "the obs `Tracer`",
  makeSpan: "the obs `Tracer`",
  annotateLogs: "the obs `Logger`",
  withLogSpan: "the obs `Logger`",
};

/** `Effect.log`, `logInfo`, `logWarning`, … are the obs `Logger`'s job. */
const isLogMember = (name: string): boolean => /^log[A-Z]?/u.test(name) && name !== "logger";

function restrictedModule(source: string): string | undefined {
  if (source.startsWith("effect/unstable/")) return "a module outside Effect's stability promise";
  const name = source.startsWith("effect/") ? source.slice("effect/".length) : undefined;

  return name !== undefined && Object.hasOwn(RESTRICTED_EXPORTS, name) ? RESTRICTED_EXPORTS[name] : undefined;
}

function importedName(specifier: ESTree.ImportDeclarationSpecifier): string | undefined {
  if (specifier.type !== "ImportSpecifier") return undefined;

  return specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
}

export const effectRestrictedApiRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow the Effect schema, service, logging, tracing, timer and unstable APIs: Effect here is the failure channel only.",
    },
    messages: {
      restrictedImport: "`{{name}}` from Effect is a second system beside one this repository has; use {{instead}}.",
      restrictedMember: "`Effect.{{name}}` is a second system beside one this repository has; use {{instead}}.",
    },
  },
  createOnce(context) {
    const effectBindings = new Set<string>();

    return {
      Program() {
        effectBindings.clear();
      },
      ImportDeclaration(node) {
        const source = node.source.value;
        const instead = restrictedModule(source);

        if (instead !== undefined) {
          context.report({ node, messageId: "restrictedImport", data: { name: source, instead } });

          return;
        }

        for (const specifier of node.specifiers) {
          const imported = importedName(specifier);
          const reason = source === "effect" && imported !== undefined && Object.hasOwn(RESTRICTED_EXPORTS, imported) ? RESTRICTED_EXPORTS[imported] : undefined;

          if (reason !== undefined) {
            context.report({ node: specifier, messageId: "restrictedImport", data: { name: imported, instead: reason } });
          } else if ((source === "effect" && imported === "Effect") || (source === "effect/Effect" && specifier.type !== "ImportSpecifier")) {
            effectBindings.add(specifier.local.name);
          }
        }
      },
      MemberExpression(node) {
        if (node.computed || node.object.type !== "Identifier" || node.property.type !== "Identifier") return;

        if (!effectBindings.has(node.object.name)) return;
        const { name } = node.property;
        const instead = (Object.hasOwn(RESTRICTED_MEMBERS, name) ? RESTRICTED_MEMBERS[name] : undefined) ?? (isLogMember(name) ? "the obs `Logger`" : undefined);

        if (instead !== undefined) context.report({ node, messageId: "restrictedMember", data: { name, instead } });
      },
    };
  },
});
