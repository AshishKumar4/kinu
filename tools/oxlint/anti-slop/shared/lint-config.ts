/**
 * The repository's `.oxlintrc.json`, read once through one schema. Every gate test that asserts a rule is active, an
 * override applies or an option is set reads it here, so a config whose shape drifts fails at the read rather than as
 * an `undefined` some assertion compares against.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";

const SeveritySchema = v.picklist(["off", "warn", "error"]);

/** A rule's setting: its severity, or its severity with the rule's options. */
const RuleSettingSchema = v.union([SeveritySchema, v.tuple([SeveritySchema, v.unknown()])]);

const RulesSchema = v.record(v.string(), RuleSettingSchema);

const LintConfigSchema = v.object({
  $schema: v.optional(v.string()),
  plugins: v.array(v.string()),
  jsPlugins: v.array(v.object({ name: v.string(), specifier: v.string() })),
  options: v.object({
    typeAware: v.optional(v.boolean()),
    denyWarnings: v.optional(v.boolean()),
    reportUnusedDisableDirectives: v.optional(v.string()),
  }),
  rules: RulesSchema,
  overrides: v.array(v.object({ files: v.array(v.string()), rules: RulesSchema })),
  ignorePatterns: v.array(v.string()),
});

export type LintConfig = v.InferOutput<typeof LintConfigSchema>;

/** `.oxlintrc.json` at `root`, the repository root by default (`cwd`, where every gate test runs from). */
export function readLintConfig(root = process.cwd()): LintConfig {
  return v.parse(LintConfigSchema, JSON.parse(readFileSync(join(root, ".oxlintrc.json"), "utf8")));
}
