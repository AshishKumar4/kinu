// Proteus-authored: upstream ships no test for this rule, and this copy is deliberately stronger
// than upstream's (it resolves aliases and unions, and grants no `cause` exemption). The cases
// below pin both differences. See tools/oxlint/anti-slop/upstream.json.
import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

tester.run("anti-slop/no-unknown-parameters", noUnknownParametersRule, {
  valid: [
    "function handle(input: ParsedInput) {}",
    "function handle<Input>(input: Input) {}",
    "type External = unknown;",
    "function handle(input: External) {}",
    "type External = unknown; function handle<External>(input: External) {}",
    "type Wrapped<Value> = unknown; function handle(input: Wrapped<string>) {}",
    "function handle(input: { cause: unknown }) {}",
    "function handle(...inputs: unknown[]) {}",
    "type Parsed = { id: string }; function load(input: Parsed) { return input.id; }",
    "function widen(value: string | number) {}",
    "function narrowed(value: never) {}",
    "Promise.resolve().catch((reason: unknown) => reason);",
    'Promise.resolve()["catch"]((reason: unknown) => reason);',
    "Promise.resolve().then(() => undefined, (reason: unknown) => reason);",
    'Promise.resolve()["then"](() => undefined, (reason: unknown) => reason);',
  ],
  invalid: [
    { code: "function handle(input: unknown) {}", errors: [error] },
    { code: "const handle = (input: unknown) => input;", errors: [error] },
    { code: "declare function handle(input: unknown): void;", errors: [error] },
    { code: "type Handler = (input: unknown) => void;", errors: [error] },
    { code: "interface Handler { handle(input: unknown): void }", errors: [error] },
    { code: "function describeFailure(cause: unknown): string { return String(cause); }", errors: [error] },
    { code: "type External = unknown; function handle(input: External) {}", errors: [error] },
    { code: "type External = (unknown); function handle(input: External) {}", errors: [error] },
    { code: "function handle(input: string | unknown) {}", errors: [error] },
    { code: "function handle(input: unknown | string) {}", errors: [error] },
    { code: "type Alias = External; type External = unknown; function handle(input: Alias) {}", errors: [error] },
    { code: "Promise.resolve().then((reason: unknown) => reason);", errors: [error] },
    { code: 'Promise.resolve()["then"]((reason: unknown) => reason);', errors: [error] },
    { code: "Promise.resolve()[method]((reason: unknown) => reason);", errors: [error] },
    { code: "callbacks.onFailure((reason: unknown) => reason);", errors: [error] },
    {
      code: "Promise.resolve().catch((reason: unknown, extra: unknown) => extra);",
      errors: [error],
    },
  ],
});
