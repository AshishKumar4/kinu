import { RuleTester } from "oxlint/plugins-dev";
import { noVacuousTypePredicateRule } from "./no-vacuous-type-predicate.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const prelude = 'type Value = { kind: "yes" } | { kind: "no" };';
const errors = [{ messageId: "vacuous" }];

tester.run("no-vacuous-type-predicate", noVacuousTypePredicateRule, {
  valid: [
    `${prelude} const isYes = (value: Value): value is { kind: "yes" } => value.kind === "yes";`,
    `${prelude} function isYes(value: Value): value is { kind: "yes" } { return false; }`,
    `${prelude} function isYes(value: Value): value is { kind: "yes" } { assertYes(value); return true; }`,
    "const accepts = (): boolean => true;",
    `${prelude} declare function isYes(value: Value): value is { kind: "yes" };`,
  ],
  invalid: [
    { code: `${prelude} const isYes = (value: Value): value is { kind: "yes" } => true;`, errors },
    { code: `${prelude} function isYes(value: Value): value is { kind: "yes" } { return true; }`, errors },
    { code: `${prelude} const isYes = function(value: Value): value is { kind: "yes" } { return (true); };`, errors },
    { code: `${prelude} class Guard { isYes(value: Value): value is { kind: "yes" } { return true; } }`, errors },
  ],
});
