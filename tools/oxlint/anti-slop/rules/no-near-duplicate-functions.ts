import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

/**
 * The smallest body worth calling a copy, in tokens outside its literals.
 *
 * Measured 2026-09-21 over every tracked TypeScript file: at 24 the tree reports 31 groups and
 * every one, read individually, is two functions a reviewer would fold into one; at 16 the groups
 * below the floor are two-statement accessors and one-line RPC forwarders whose second copy costs
 * less than the parameter that would replace it. 24 is the largest floor at which nothing the
 * reader wanted reported is lost, which is how `scripts/ast-duplication.ts` set its own floor.
 */
const MIN_TOKENS = 24;

/**
 * Token types whose VALUE is a literal. Two bodies that agree on every other token and differ in
 * some of these are one function whose parameter was written out as a second copy.
 */
const LITERAL_TOKEN = {
  Boolean: true,
  Null: true,
  Numeric: true,
  RegularExpression: true,
  String: true,
  Template: true,
} satisfies Record<string, true>;

type FunctionNode = ESTree.ArrowFunctionExpression | ESTree.Function;

/** A template chunk can run to a whole statement; the message needs its ends, not its middle. */
function abbreviate(literal: string): string {
  return literal.length <= 48 ? literal : `${literal.slice(0, 22)}…${literal.slice(-22)}`;
}

interface Body {
  readonly node: FunctionNode;
  /** The token stream with every literal replaced by its type: the shape the copies share. */
  readonly shape: string;
  /** The literal values in order, so two matching shapes can say what they swapped. */
  readonly literals: readonly string[];
  /** Tokens outside literals, the size against `MIN_TOKENS`. */
  readonly size: number;
}

function readBody(sourceCode: SourceCode, node: FunctionNode): Body | null {
  if (node.body === null) return null;
  const tokens = sourceCode.getTokens(node.body);
  const shape: string[] = [];
  const literals: string[] = [];
  let size = 0;
  for (const token of tokens) {
    if (Object.hasOwn(LITERAL_TOKEN, token.type)) {
      shape.push(`<${token.type}>`);
      literals.push(token.value);
    } else {
      shape.push(token.value);
      size += 1;
    }
  }
  return { node, shape: shape.join("\u0000"), literals, size };
}

function nameOf(sourceCode: SourceCode, node: FunctionNode): string {
  if (node.type === "FunctionDeclaration" && node.id !== null) return node.id.name;
  const parent = node.parent;
  if (parent?.type === "MethodDefinition" || parent?.type === "Property") {
    return sourceCode.getText(parent.key);
  }
  if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") {
    return parent.id.name;
  }
  return "the function";
}

/**
 * Reject a function whose body is another function's body in the same file with the literals
 * changed — or with nothing changed at all.
 *
 * `partOpened` and `partEnded` were the same twelve lines around the same query, one with `'open'`
 * and one with `'content-end'`; the fix was one function with an `operation` parameter. The gate
 * that hunts copies across the tree (`scripts/ast-duplication.ts`) keeps literal text in its
 * fingerprint on purpose, because an `INSERT` and an `INSERT … ON CONFLICT` under one identifier
 * layout are different functions — so a copy that differs only in a literal is the copy that gate
 * declares it cannot see. This rule is that declared blind spot, closed where a copy is least
 * defensible: inside one file, where the author could see both.
 *
 * Identifiers are kept verbatim and literals are freed, the exact complement of the gate's
 * fingerprint. A body that differs in an identifier is not this rule's subject.
 */
export const noNearDuplicateFunctionsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a function whose body repeats another function's body in the same file with only literals changed.",
    },
    messages: {
      swappedLiterals:
        "`{{name}}` is `{{original}}` (line {{line}}) with {{count}} literal(s) swapped: {{swaps}}. Two copies of one body drift apart on the next fix. Take the literal as a parameter, or hold the values in one table and keep one function.",
      exactCopy:
        "`{{name}}` repeats `{{original}}` (line {{line}}) token for token. Keep one and call it.",
    },
  },
  createOnce(context) {
    let bodies: Body[] = [];

    const collect = (node: FunctionNode): void => {
      const body = readBody(context.sourceCode, node);
      if (body !== null && body.size >= MIN_TOKENS) bodies.push(body);
    };

    return {
      Program() {
        bodies = [];
      },
      ArrowFunctionExpression: collect,
      FunctionDeclaration: collect,
      FunctionExpression: collect,
      "Program:exit"() {
        const byShape = new Map<string, Body[]>();
        for (const body of bodies) {
          const group = byShape.get(body.shape);
          if (group === undefined) byShape.set(body.shape, [body]);
          else group.push(body);
        }
        for (const group of byShape.values()) {
          if (group.length < 2) continue;
          group.sort((a, b) => (a.node.range?.[0] ?? 0) - (b.node.range?.[0] ?? 0));
          const [original, ...copies] = group;
          if (original === undefined) continue;
          for (const copy of copies) {
            // A copy nested inside another member of the group is the same finding twice.
            const [copyStart, copyEnd] = copy.node.range ?? [0, 0];
            if (group.some((other) => {
              const [start, end] = other.node.range ?? [0, 0];
              return other !== copy && start <= copyStart && copyEnd <= end;
            })) continue;
            const swaps = original.literals.flatMap((value, index) => {
              const other = copy.literals[index];
              return other === undefined || other === value ? [] : [`${abbreviate(value)} → ${abbreviate(other)}`];
            });
            const data = {
              name: nameOf(context.sourceCode, copy.node),
              original: nameOf(context.sourceCode, original.node),
              line: String(original.node.loc?.start.line ?? 0),
            };
            if (swaps.length === 0) {
              context.report({ node: copy.node, messageId: "exactCopy", data });
              continue;
            }
            context.report({
              node: copy.node,
              messageId: "swappedLiterals",
              data: { ...data, count: String(swaps.length), swaps: swaps.join(", ") },
            });
          }
        }
      },
    };
  },
});
