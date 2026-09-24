import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/** The one module a terminal colour may be written in; every other TUI module names a theme role. */
const REGISTRY = "theme.ts";

/** Props and style keys the renderer paints with. */
const COLOUR_KEYS = new Set(["fg", "bg", "color", "backgroundColor", "borderColor"]);

/** Terminal colour names: each one paints the same on every theme, which is what a role replaces. */
const NAMED_COLOURS = new Set(["red", "green", "blue", "yellow", "cyan", "magenta", "white", "black", "gray", "grey"]);

const HEX = /#[0-9A-Fa-f]{6}\b/u;

/** A module under the TUI's source root other than the registry itself. */
export function inTuiScope(filename: string): boolean {
  const normalized = filename.replaceAll("\\", "/");
  const at = normalized.lastIndexOf("/packages/cli/src/tui/");

  return at !== -1 && normalized.slice(at + "/packages/cli/src/tui/".length) !== REGISTRY;
}

function keyName(key: ESTree.Node): string | null {
  if (key.type === "Identifier") return key.name;

  if (key.type === "Literal" && typeof key.value === "string") return key.value;

  return null;
}

function namedColour(value: ESTree.Node | null | undefined): boolean {
  if (value?.type === "JSXExpressionContainer") return namedColour(value.expression);

  return value?.type === "Literal" && typeof value.value === "string" && NAMED_COLOURS.has(value.value.trim().toLowerCase());
}

/**
 * Keep every TUI colour in the theme registry: a hex literal or a named terminal colour outside
 * `theme.ts` paints the same on the light and the dark theme, so the theme switch cannot reach it.
 * Write the role the registry defines instead.
 */
export const noTuiColourLiteralRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow colour literals in the TUI outside its theme registry.",
    },
    messages: {
      hexColour: "`{{literal}}` is a colour literal outside the theme registry; name the theme role it stands for.",
      namedColour: "`{{key}}` is set to the terminal colour `{{colour}}`, which ignores the theme; name the theme role instead.",
    },
  },
  createOnce(context) {
    let inScope = false;

    const reportHex = (node: ESTree.Node, text: string): void => {
      const literal = HEX.exec(text)?.[0];

      if (literal !== undefined) context.report({ node, messageId: "hexColour", data: { literal } });
    };

    const reportNamed = (node: ESTree.Node, key: string, value: ESTree.Node | null | undefined): void => {
      if (!COLOUR_KEYS.has(key) || !namedColour(value)) return;
      const colour = value?.type === "JSXExpressionContainer" ? value.expression : value;

      if (colour?.type === "Literal" && typeof colour.value === "string") {
        context.report({ node, messageId: "namedColour", data: { key, colour: colour.value } });
      }
    };

    return {
      Program() {
        inScope = inTuiScope(context.filename);
      },
      Literal(node) {
        if (inScope && typeof node.value === "string") reportHex(node, node.value);
      },
      TemplateElement(node) {
        if (inScope) reportHex(node, node.value.cooked ?? node.value.raw);
      },
      JSXAttribute(node) {
        if (inScope && node.name.type === "JSXIdentifier") reportNamed(node, node.name.name, node.value);
      },
      Property(node) {
        if (!inScope || node.computed) return;
        const key = keyName(node.key);

        if (key !== null) reportNamed(node, key, node.value);
      },
    };
  },
});
