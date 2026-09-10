import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import {
  functionParameterBindingName,
  functionParameterTypeAnnotation,
} from "../shared/function-parameters.ts";
import {
  createTypeAliasEnvironment,
  resolvedTypeMatches,
  type TypeAliasEnvironment,
} from "../shared/type-alias-resolution.ts";
type ParameterOwner =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

/**
 * KINU-LOCAL: upstream exempts a parameter named `cause` and the subject of a type predicate, and
 * matches only a literal `unknown` (or a union/parenthesised form of one). Every carve-out lets
 * unparsed input through, so this copy resolves aliases through the shared lexical environment
 * and exempts nothing. See tools/oxlint/anti-slop/upstream.json.
 */
/** Disallow unknown inputs; callers must pass a parsed or explicitly wrapped boundary value. */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow function parameters that resolve to unknown; decode or explicitly wrap boundary input before calling.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function.",
    },
  },
  createOnce(context) {
    let environment: TypeAliasEnvironment | null = null;

    const resolvesToUnknown = (type: ESTree.TSType): boolean =>
      environment !== null &&
      resolvedTypeMatches(type, environment, (resolved, matches) => {
        if (resolved.type === "TSUnknownKeyword") return true;
        if (resolved.type === "TSParenthesizedType") {
          return matches(resolved.typeAnnotation);
        }
        return resolved.type === "TSUnionType" && resolved.types.some(matches);
      });

    const checkParameters = (node: ParameterOwner) => {
      for (const parameter of node.params) {
        const annotation = functionParameterTypeAnnotation(parameter);
        if (annotation === null || annotation === undefined) continue;
        if (!resolvesToUnknown(annotation.typeAnnotation)) continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: "unknownParameter",
          data: { parameter: functionParameterBindingName(parameter, context.sourceCode) },
        });
      }
    };

    return {
      Program(node) {
        environment = createTypeAliasEnvironment(
          node,
          context.sourceCode.visitorKeys,
        );
      },
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
});
