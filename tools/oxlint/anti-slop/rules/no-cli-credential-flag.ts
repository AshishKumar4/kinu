import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/** Command-line flags whose value is a credential. */
const CREDENTIAL_FLAGS = ["--access-key-id", "--secret-access-key", "--session-token"];

/**
 * Keep credentials off command lines: argv is readable from the process list and lands in every
 * captured command log. Pass the value through stdin (`wrangler secret put`) or the child's
 * environment instead.
 */
export const noCliCredentialFlagRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow credential-bearing command-line flags.",
    },
    messages: {
      credentialFlag:
        "`{{flag}}` puts a credential on a command line, where the process list and captured logs keep it; pass it through stdin or the environment.",
    },
  },
  createOnce(context) {
    const check = (node: ESTree.Node, text: string): void => {
      const flag = CREDENTIAL_FLAGS.find((candidate) => text.includes(candidate));

      if (flag !== undefined) context.report({ node, messageId: "credentialFlag", data: { flag } });
    };

    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
});
