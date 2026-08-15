import { RuleTester } from "oxlint/plugins-dev";

import { noChainedTypeAssertionsRule } from "./no-chained-type-assertions.ts";
import { noConditionalEmptyObjectSpreadRule } from "./no-conditional-empty-object-spread.ts";
import { noKnownValueWideningRule } from "./no-known-value-widening.ts";
import { noModuleMockingRule } from "./no-module-mocking.ts";
import { noObjectParametersRule } from "./no-object-parameters.ts";
import { noReflectApplyRule } from "./no-reflect-apply.ts";
import { noReflectGetRule } from "./no-reflect-get.ts";
import { noRuntimeTypeofRule } from "./no-runtime-typeof.ts";
import { noForbiddenTermInSymbolNamesRule } from "./no-shape-in-symbol-names.ts";
import { noUnknownParametersRule } from "./no-unknown-parameters.ts";
import { noUnknownReturnsRule } from "./no-unknown-returns.ts";
import { noUnknownTypeAliasesRule } from "./no-unknown-type-aliases.ts";
import { noUnsafeDictionaryTypeRule } from "./no-unsafe-dictionary-type.ts";
import { noWidenThenAssertRule } from "./no-widen-then-assert.ts";
import { requireSafetyCommentForTypeAssertionRule } from "./require-safety-comment-for-type-assertion.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("anti-slop/no-chained-type-assertions", noChainedTypeAssertionsRule, {
  valid: ["const values = [1, 2] as const;", "const user = input as User;"],
  invalid: [
    {
      code: "const user = (input as unknown) as User;",
      errors: [{ messageId: "chained" }],
    },
  ],
});

if (noConditionalEmptyObjectSpreadRule.meta?.fixable !== undefined) {
  throw new Error("Conditional omission must not have a semantics-changing automatic fix.");
}

tester.run(
  "anti-slop/no-conditional-empty-object-spread",
  noConditionalEmptyObjectSpreadRule,
  {
    valid: ["const result = condition ? { value } : {};", "const result = { ...values };"],
    invalid: [
      {
        code: "const result = { ...(value !== undefined ? { value } : {}) };",
        errors: [{ messageId: "avoid" }],
      },
    ],
  },
);

tester.run("anti-slop/no-known-value-widening", noKnownValueWideningRule, {
  valid: [
    "type Command = () => void; const start = () => {}; const commands = { start } satisfies Record<string, Command>;",
    "type Command = () => void; const commands: Record<string, Command> = {};",
  ],
  invalid: [
    {
      code: "type Command = () => void; const start = () => {}; const commands: Record<string, Command> = { start };",
      errors: [{ messageId: "widening" }],
    },
  ],
});

tester.run("anti-slop/no-module-mocking", noModuleMockingRule, {
  valid: [
    "const store = new InMemoryUserStore();",
    "function test(vi: { mock(): void }) { vi.mock(); }",
  ],
  invalid: [
    { code: "vi.mock('./user-store');", errors: [{ messageId: "moduleMock" }] },
    {
      code: "import { jest } from '@jest/globals'; jest.mock('./user-store');",
      errors: [{ messageId: "moduleMock" }],
    },
  ],
});

tester.run("anti-slop/no-object-parameters", noObjectParametersRule, {
  valid: [
    "interface User { readonly id: string } function save(user: User) {}",
    "function save<Value extends object>(value: Value) {}",
  ],
  invalid: [
    { code: "function save(value: object) {}", errors: [{ messageId: "objectParameter" }] },
    {
      code: "type Broad = object; function save(value: Broad) {}",
      errors: [{ messageId: "objectParameter" }],
    },
  ],
});

tester.run("anti-slop/no-reflect-apply", noReflectApplyRule, {
  valid: ["operation.apply(owner, args);", "const Reflect = { apply() {} }; Reflect.apply();"],
  invalid: [
    {
      code: "Reflect.apply(operation, owner, args);",
      errors: [{ messageId: "reflectApply" }],
    },
  ],
});

tester.run("anti-slop/no-reflect-get", noReflectGetRule, {
  valid: ["const value = owner[key];", "function read(Reflect: Reader) { Reflect.get(); }"],
  invalid: [
    { code: "Reflect.get(owner, key);", errors: [{ messageId: "reflectGet" }] },
  ],
});

tester.run("anti-slop/no-runtime-typeof", noRuntimeTypeofRule, {
  valid: [
    "parseWithSchema(value);",
    "function check(Object: new () => Owner, value: Owner) { return value instanceof Object; }",
  ],
  invalid: [
    {
      code: 'function parse(value: unknown): string { if (typeof value !== "string") throw new Error(); return value; }',
      errors: [{ messageId: "runtimeTypeof" }],
    },
    {
      code: 'function isString(value: unknown): value is string { return typeof value === "string"; }',
      errors: [{ messageId: "runtimeTypeof" }],
    },
    {
      code: "if (hint instanceof Object) use(hint);",
      errors: [{ messageId: "objectInstanceof" }],
    },
  ],
});

tester.run("anti-slop/no-shape-in-symbol-names", noForbiddenTermInSymbolNamesRule, {
  valid: ["const resizeImage = (value: Image) => value;", "interface Geometry {}"],
  invalid: [
    { code: "interface UserShape {}", errors: [{ messageId: "forbiddenSymbolName" }] },
    { code: "const payload_shape = {};", errors: [{ messageId: "forbiddenSymbolName" }] },
    { code: "const reshapeImage = (value: Image) => value;", errors: [{ messageId: "forbiddenSymbolName" }] },
    { code: "interface ShapelessGeometry {}", errors: [{ messageId: "forbiddenSymbolName" }] },
  ],
});

tester.run("anti-slop/no-unknown-parameters", noUnknownParametersRule, {
  valid: ["function handle(input: ParsedInput) {}"],
  invalid: [
    {
      code: "function describeFailure(cause: unknown): string { return String(cause); }",
      errors: [{ messageId: "unknownParameter" }],
    },
    {
      code: "type External = unknown; function handle(input: External) {}",
      errors: [{ messageId: "unknownParameter" }],
    },
  ],
});

tester.run("anti-slop/no-unknown-returns", noUnknownReturnsRule, {
  valid: [
    "function parse(): User { return user; }",
    "function failure(): { cause: unknown } { return { cause }; }",
  ],
  invalid: [
    { code: "function load(): unknown { return input; }", errors: [{ messageId: "unknownReturn" }] },
    {
      code: "type Raw = unknown; function load(): Promise<Raw> { return input; }",
      errors: [{ messageId: "unknownReturn" }],
    },
  ],
});

tester.run("anti-slop/no-unknown-type-aliases", noUnknownTypeAliasesRule, {
  valid: ["type User = { readonly id: string };", "type Result = { cause: unknown };"],
  invalid: [
    { code: "type Raw = unknown;", errors: [{ messageId: "unknownAlias" }] },
    {
      code: "type Raw = unknown; type Alias = Raw;",
      errors: [{ messageId: "unknownAlias" }, { messageId: "unknownAlias" }],
    },
  ],
});

tester.run("anti-slop/no-unsafe-dictionary-type", noUnsafeDictionaryTypeRule, {
  valid: [
    "type Commands = Record<string, Command>;",
    "type Results = Record<string, { value: unknown }> ;",
  ],
  invalid: [
    {
      code: "type Metadata = Record<string, unknown>;",
      errors: [{ messageId: "unsafeDictionary" }],
    },
    {
      code: "interface Metadata { [key: string]: object }",
      errors: [{ messageId: "unsafeDictionary" }],
    },
  ],
});

tester.run("anti-slop/no-widen-then-assert", noWidenThenAssertRule, {
  valid: [
    "declare const input: unknown; const parsed = input as { readonly id: string };",
    "const source = { id: 'first' }; const widened: unknown = source;",
  ],
  invalid: [
    {
      code: "const source = { id: 'second' }; const widened: unknown = source; const parsed = widened as { readonly id: string };",
      errors: [{ messageId: "widenThenAssert" }],
    },
  ],
});

tester.run(
  "anti-slop/require-safety-comment-for-type-assertion",
  requireSafetyCommentForTypeAssertionRule,
  {
    valid: [
      "const values = [1, 2] as const;",
      "// SAFETY: parseUserId validated the identifier before branding it.\nconst id = value as UserId;",
      "function parse(): UserId {\n// SAFETY: Validation above established the UserId invariant.\nreturn value as UserId;\n}",
      "const id = /* SAFETY: Validation established the invariant. */ value as UserId;",
    ],
    invalid: [
      { code: "const id = value as UserId;", errors: [{ messageId: "missingSafetyComment" }] },
      {
        code: "const id = value as UserId; // SAFETY: Validation established the invariant.",
        errors: [{ messageId: "missingSafetyComment" }],
      },
      {
        code: "function canned<T>(answer: unknown): T {\n// SAFETY: The caller expects T.\nreturn answer as T;\n}",
        errors: [{ messageId: "unverifiableAssertion" }],
      },
      {
        code: "// SAFETY: This cast is safe.\nconst input = JSON.parse(raw) as AgentInput;",
        errors: [{ messageId: "unverifiableAssertion" }],
      },
      {
        code: "// SAFETY: This cast is safe.\nconst id = value as UserId;",
        errors: [{ messageId: "insufficientSafetyComment" }],
      },
    ],
  },
);
