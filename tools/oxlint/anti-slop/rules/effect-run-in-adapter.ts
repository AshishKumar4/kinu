import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { TEST_DIRECTORY, TEST_SUFFIX } from "./no-ambient-git-in-tests.ts";

/**
 * Only a surface's adapter runs an effect.
 *
 * An effect run anywhere else escapes the boundary that makes it safe: `settle` in obs/effect.ts
 * runs on a microtask scheduler, because Effect's default scheduler yields to a macrotask every
 * 2,048 steps and a Durable Object then admits other events mid-effect (measured 2026-09-23: 20 of
 * 20, see packages/cf-backend/tests/workerd/effect-atomicity.test.ts). A second `runPromise`, a
 * `ManagedRuntime`, a hand-built `Scheduler` or a detached fork each reopen that hazard or outlive
 * the invocation, the way a floating promise does.
 *
 * Scope is every file but tests: a suite and a probe may run the effects they assert on. A script
 * or a CLI entry point runs its effect through `settle` like everything else.
 */

/** Each surface's one adapter, with what it runs. */
export const EFFECT_ADAPTERS: Readonly<Record<string, string>> = {
  "packages/core/src/obs/effect.ts": "the server runner: `settle`, on a microtask scheduler",
};

export function isEffectRunScope(filename: string): boolean {
  const normalized = filename.replaceAll("\\", "/");

  if (TEST_DIRECTORY.test(normalized) || TEST_SUFFIX.test(normalized)) return false;

  return !Object.keys(EFFECT_ADAPTERS).some((adapter) => normalized === adapter || normalized.endsWith(`/${adapter}`));
}

/** Modules whose import alone is the runtime this rule keeps in the adapter. */
const RUNTIME_MODULES: Readonly<Record<string, true>> = {
  "effect/ManagedRuntime": true,
  "effect/Scheduler": true,
};

const RUNTIME_EXPORTS: Readonly<Record<string, true>> = { ManagedRuntime: true, Scheduler: true };

/** `Effect.run*` and a detached fork: each starts a fiber outside the adapter. */
const isRunMember = (name: string): boolean => name.startsWith("run") || name === "forkDetach";

function importedName(specifier: ESTree.ImportDeclarationSpecifier): string | undefined {
  if (specifier.type !== "ImportSpecifier") return undefined;

  return specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
}

export const effectRunInAdapterRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow running an effect, or building a runtime or scheduler, outside a declared Effect adapter.",
    },
    messages: {
      runOutsideAdapter:
        "`{{name}}` runs an effect outside the adapter. Compose the effect and let the boundary run it: `settle` (packages/core/src/obs/effect.ts) runs on a microtask scheduler so a Durable Object admits no other event mid-effect. A new surface declares its own adapter in EFFECT_ADAPTERS.",
      runtimeOutsideAdapter:
        "`{{name}}` builds a runtime or scheduler outside the adapter. The scheduler is the adapter's decision (packages/core/src/obs/effect.ts), because the default one yields to a macrotask mid-effect.",
    },
  },
  createOnce(context) {
    let inScope = false;
    const effectBindings = new Set<string>();

    return {
      Program() {
        inScope = isEffectRunScope(context.filename);
        effectBindings.clear();
      },
      ImportDeclaration(node) {
        if (!inScope) return;
        const source = node.source.value;

        if (Object.hasOwn(RUNTIME_MODULES, source)) {
          context.report({ node, messageId: "runtimeOutsideAdapter", data: { name: source } });

          return;
        }

        for (const specifier of node.specifiers) {
          const imported = importedName(specifier);

          if (source === "effect" && imported !== undefined && Object.hasOwn(RUNTIME_EXPORTS, imported)) {
            context.report({ node: specifier, messageId: "runtimeOutsideAdapter", data: { name: imported } });
          } else if (source === "effect" && imported === "Effect") {
            effectBindings.add(specifier.local.name);
          } else if (source === "effect/Effect" && specifier.type !== "ImportSpecifier") {
            effectBindings.add(specifier.local.name);
          } else if (source === "effect/Effect" && imported !== undefined && isRunMember(imported)) {
            context.report({ node: specifier, messageId: "runOutsideAdapter", data: { name: imported } });
          }
        }
      },
      MemberExpression(node) {
        if (!inScope || node.computed || node.object.type !== "Identifier" || node.property.type !== "Identifier") return;

        if (effectBindings.has(node.object.name) && isRunMember(node.property.name)) {
          context.report({ node, messageId: "runOutsideAdapter", data: { name: `${node.object.name}.${node.property.name}` } });
        }
      },
    };
  },
});
