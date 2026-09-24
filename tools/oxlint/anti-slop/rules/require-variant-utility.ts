import { readFileSync, statSync } from "node:fs";

import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
import { parse } from "postcss";

import { inCapScope } from "./no-output-token-cap.ts";

/** Tailwind's own padding scale, which shares the `p-` prefix with the design system's classes. */
const TAILWIND_PADDING = /^p-(?:\d+(?:\.\d+)?|px|\[.+\])$/u;

const DESIGN_CLASS = /^p-[a-z0-9-]+$/u;

/** How one package stylesheet declares its `p-*` classes, as of one modification time. */
interface Declared {
  readonly path: string;
  readonly modified: number;
  readonly utilities: ReadonlySet<string>;
  readonly plain: ReadonlySet<string>;
}

/** Keyed by path and checked against the file's mtime, so an editor session sees a saved stylesheet. */
const declaredBy = new Map<string, Declared>();

/** The stylesheet of the package `filename` sits in: `packages/<name>/src/index.css`, or null. */
function stylesheetOf(filename: string): Declared | null {
  const normalized = filename.replaceAll("\\", "/");
  const at = /\/packages\/[^/]+\/src\//u.exec(normalized);

  if (at === null) return null;
  const path = `${normalized.slice(0, at.index + at[0].length)}index.css`;
  const modified = statSync(path, { throwIfNoEntry: false })?.mtimeMs;

  if (modified === undefined) return null;
  const known = declaredBy.get(path);

  if (known?.modified === modified) return known;

  const utilities = new Set<string>();
  const plain = new Set<string>();
  const root = parse(readFileSync(path, "utf8"), { from: path });
  root.walkAtRules("utility", (rule) => { utilities.add(rule.params.trim()); });
  root.walkRules((rule) => {
    for (const selector of rule.selectors) {
      const name = /^\.(p-[a-z0-9-]+)$/u.exec(selector.trim())?.[1];

      if (name !== undefined) plain.add(name);
    }
  });
  const declared = { path, modified, utilities, plain };
  declaredBy.set(path, declared);

  return declared;
}

/** `md:hover:p-x` -> `["md", "hover", "p-x"]`; a colon inside an arbitrary `[...]` variant does not split. */
function variantParts(token: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let at = 0; at < token.length; at += 1) {
    const char = token[at];

    if (char === "[") depth += 1;
    else if (char === "]") depth -= 1;
    else if (char === ":" && depth === 0) {
      parts.push(token.slice(start, at));
      start = at + 1;
    }
  }

  parts.push(token.slice(start));

  return parts;
}

/**
 * A design-system `p-*` class written behind a variant (`hover:p-text`) must be an `@utility` in its
 * package stylesheet: Tailwind emits nothing for a variant of a plain `@layer components` rule, so the
 * hover state silently never paints. A class declared both ways lands in two cascade layers, so each
 * use of it is reported too.
 */
export const requireVariantUtilityRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Require variant-prefixed design classes to be declared with @utility in the package stylesheet.",
    },
    messages: {
      variantOnPlainRule:
        "Tailwind emits nothing for `{{token}}`: `{{name}}` is not an `@utility` in {{stylesheet}}. Declare it with `@utility {{name}}`.",
      twoHomes:
        "`{{name}}` is declared both as `@utility` and as a plain rule in {{stylesheet}}, so its declarations land in two cascade layers. Keep one.",
    },
  },
  createOnce(context) {
    let declared: Declared | null = null;

    const check = (node: ESTree.Node, text: string): void => {
      if (declared === null) return;

      for (const token of text.split(/\s+/u)) {
        const parts = variantParts(token);
        const name = parts.at(-1)?.replace(/^!/u, "") ?? "";

        if (!DESIGN_CLASS.test(name) || TAILWIND_PADDING.test(name)) continue;

        if (declared.utilities.has(name) && declared.plain.has(name)) {
          context.report({ node, messageId: "twoHomes", data: { name, stylesheet: declared.path } });
        } else if (parts.length > 1 && !declared.utilities.has(name)) {
          context.report({ node, messageId: "variantOnPlainRule", data: { token, name, stylesheet: declared.path } });
        }
      }
    };

    return {
      Program() {
        declared = inCapScope(context.filename) ? stylesheetOf(context.filename) : null;
      },
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
});
