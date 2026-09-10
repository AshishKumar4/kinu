// KINU-LOCAL delta on upstream's suite: the `cause` and type-predicate-subject cases upstream lists
// as valid are invalid here, and the alias-resolution cases pin what the local rule adds. See
// tools/oxlint/anti-slop/upstream.json.
import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

tester.run("anti-slop/no-unknown-parameters", noUnknownParametersRule, {
	valid: [
		"function parse(value: string | number): void {}",
		"function handle(input: ParsedInput) {}",
		"function handle<Input>(input: Input) {}",
		"type External = unknown;",
		"type External = unknown; function handle<External>(input: External) {}",
		"function handle(input: { cause: unknown }) {}",
		"function handle(...inputs: unknown[]) {}",
		"type Parsed = { id: string }; function load(input: Parsed) { return input.id; }",
		"function narrowed(value: never) {}",
		"type Value = unknown; function outer() { type Value = Parsed; function handle(input: Value) {} }",
		"type Identity<T> = T; function handle(input: Identity<Parsed>) {}",
	],
	invalid: [
		{ code: "function parse(value: unknown): void {}", errors: [error] },
		{ code: "function parse(value: string | unknown): void {}", errors: [error] },
		{
			code: "function parse(value: string | (number | unknown)): void {}",
			errors: [error],
		},
		{
			code: "function isString(value: unknown, context: unknown): value is string { return true; }",
			errors: [{ ...error, data: { parameter: "value" } }, { ...error, data: { parameter: "context" } }],
		},
		{
			code: "export function parse({ value }: unknown = {}): void {}",
			errors: [{ ...error, data: { parameter: "{ value }" } }],
		},
		{ code: "function enrich(cause: unknown): void {}", errors: [error] },
		{ code: "function enrich(cause: Error | unknown): void {}", errors: [error] },
		{ code: "function isString(value: unknown): value is string { return true; }", errors: [error] },
		{ code: "const isString = (value: unknown): value is string => true;", errors: [error] },
		{ code: "function assertString(value: unknown): asserts value is string {}", errors: [error] },
		{ code: "type Guard = (value: unknown) => value is string;", errors: [error] },
		{ code: "declare function isString(value: unknown): value is string;", errors: [error] },
		{ code: "type Guards = { isString(value: unknown): value is string };", errors: [error] },
		{ code: "const handle = (input: unknown) => input;", errors: [error] },
		{ code: "interface Handler { handle(input: unknown): void }", errors: [error] },
		{ code: "function describeFailure(cause: unknown): string { return String(cause); }", errors: [error] },
		{ code: "type External = unknown; function handle(input: External) {}", errors: [error] },
		{ code: "type External = (unknown); function handle(input: External) {}", errors: [error] },
		{ code: "function handle(input: unknown | string) {}", errors: [error] },
		{ code: "type Alias = External; type External = unknown; function handle(input: Alias) {}", errors: [error] },
		{ code: "function outer() { type Local = unknown; function handle(input: Local) {} }", errors: [error] },
		{ code: "type Identity<T> = T; function handle(input: Identity<unknown>) {}", errors: [error] },
		{ code: "type Wrapped<Value> = unknown; function handle(input: Wrapped<string>) {}", errors: [error] },
		{ code: "Promise.reject().catch((reason: unknown) => String(reason));", errors: [error] },
		{ code: "Promise.resolve().then(() => undefined, (reason: unknown) => String(reason));", errors: [error] },
		{ code: 'Promise.reject()["catch"]((reason: unknown) => String(reason));', errors: [error] },
		{ code: 'Promise.resolve()["then"](() => undefined, (reason: unknown) => String(reason));', errors: [error] },
		{ code: "Promise.resolve().then((value: unknown) => value);", errors: [error] },
		{ code: "Promise.resolve()[method]((reason: unknown) => reason);", errors: [error] },
		{ code: "callbacks.onFailure((reason: unknown) => reason);", errors: [error] },
		{
			code: "Promise.resolve().catch((reason: unknown, extra: unknown) => extra);",
			errors: [error, error],
		},
	],
});
