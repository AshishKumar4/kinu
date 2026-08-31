// Kinu-local coverage on top of the vendored upstream suite in
// ./require-safety-comment-for-type-assertion.test.ts. Upstream accepts the mere presence of a
// `SAFETY:` comment; these cases pin the two rejections upstream has never carried.
// See tools/oxlint/anti-slop/upstream.json.
import { RuleTester } from "oxlint/plugins-dev";

import { requireSafetyCommentForTypeAssertionRule } from "./require-safety-comment-for-type-assertion.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run(
  "anti-slop/require-safety-comment-for-type-assertion (Kinu-local)",
  requireSafetyCommentForTypeAssertionRule,
  {
    valid: [
      "// SAFETY: parseUserId validated the identifier before branding it.\nconst id = value as UserId;",
      "// SAFETY: The Workers runtime guarantees the binding is present.\nconst store = env.STORE as KVNamespace;",
    ],
    invalid: [
      {
        code: "function canned<T>(answer: unknown): T {\n// SAFETY: The caller expects T.\nreturn answer as T;\n}",
        errors: [{ messageId: "unverifiableAssertion" }],
      },
      {
        code: "// SAFETY: This cast is safe.\nconst input = JSON.parse(raw) as AgentInput;",
        errors: [{ messageId: "unverifiableAssertion" }],
      },
      {
        code: "// SAFETY: The schema validated it.\nconst loose = value as any;",
        errors: [{ messageId: "unverifiableAssertion" }],
      },
      {
        code: "// SAFETY: This cast is safe.\nconst id = value as UserId;",
        errors: [{ messageId: "insufficientSafetyComment" }],
      },
      {
        code: "// SAFETY: obvious\nconst id = value as UserId;",
        errors: [{ messageId: "insufficientSafetyComment" }],
      },
    ],
  },
);
