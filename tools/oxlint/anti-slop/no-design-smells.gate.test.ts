// Kinu-only gate; see upstream.json's `kinuRules`.
//
// The design-smell rules and the Kinu policy rules own RuleTester suites, but a suite proves
// only that the rule function behaves, not that the rule is reachable through the command the repo gates on.
// This file runs the real `oxlint` binary with the real `.oxlintrc.json` over a seeded instance of
// each defect and over its corrected form, and asserts red on the first and green on the second. It
// also asserts the live denominator for each rule: a corpus with no SQL, no pair of same-shaped
// functions, no model call or no agent class would let a rule pass by inspecting nothing.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSources } from "../../../scripts/sources.ts";
import { lintJson, type LintDiagnostic } from "./shared/oxlint-json.ts";

const repoRoot = process.cwd();

/** Red fixture, then the corrected form of the same code, per rule. */
const cases: ReadonlyArray<{
  readonly rule: string;
  readonly bad: string;
  readonly good: string;
  /** Where the fixture sits under the fixture root, for a rule scoped to one tree. */
  readonly at?: string;
  /** Files beside the fixture that the rule reads but oxlint does not lint. */
  readonly beside?: Readonly<Record<string, string>>;
}> = [
  {
    rule: "no-near-duplicate-functions",
    // `partOpened` and `partEnded` as messages.ts held them on 2026-09-21: one body, one literal.
    bad: `declare const sql: <T>(strings: TemplateStringsArray, ...values: unknown[]) => T[];
interface UpdateRow { sequence: number; payload_json: string }
export function partOpened(actorId: string, messageId: string): UpdateRow | null {
  const rows = sql<UpdateRow>\`SELECT sequence, payload_json FROM message_updates
    WHERE actor_id = \${actorId} AND message_id = \${messageId} AND operation = 'open' ORDER BY sequence LIMIT 1\`;
  const [row] = rows;
  if (row === undefined) return null;
  return { sequence: row.sequence, payload_json: row.payload_json };
}
export function partEnded(actorId: string, messageId: string): UpdateRow | null {
  const rows = sql<UpdateRow>\`SELECT sequence, payload_json FROM message_updates
    WHERE actor_id = \${actorId} AND message_id = \${messageId} AND operation = 'content-end' ORDER BY sequence LIMIT 1\`;
  const [row] = rows;
  if (row === undefined) return null;
  return { sequence: row.sequence, payload_json: row.payload_json };
}
`,
    good: `declare const sql: <T>(strings: TemplateStringsArray, ...values: unknown[]) => T[];
interface UpdateRow { sequence: number; payload_json: string }
type Operation = 'open' | 'content-end';
export function part(actorId: string, messageId: string, operation: Operation): UpdateRow | null {
  const rows = sql<UpdateRow>\`SELECT sequence, payload_json FROM message_updates
    WHERE actor_id = \${actorId} AND message_id = \${messageId} AND operation = \${operation} ORDER BY sequence LIMIT 1\`;
  const [row] = rows;
  if (row === undefined) return null;
  return { sequence: row.sequence, payload_json: row.payload_json };
}
`,
  },
  {
    rule: "no-output-token-cap",
    // The shape the owner directive retired: a cap on the call instead of an effort on the route.
    bad: `declare function streamText(options: { model: string; prompt: string; maxOutputTokens?: number }): void;
export function summarize(model: string, prompt: string): void {
  streamText({ model, prompt, maxOutputTokens: 4096 });
}
`,
    good: `declare function streamText(options: { model: string; prompt: string; providerOptions?: object }): void;
export function summarize(model: string, prompt: string): void {
  streamText({ model, prompt, providerOptions: { 'workers-ai': { reasoningEffort: 'low' } } });
}
`,
  },
  {
    rule: "require-rpc-seal",
    // A Durable Object on the agents SDK that forgot its seal: `sql` answers any stub-holder.
    bad: `declare class Agent<E> { constructor(ctx: unknown, env: E); }
export class LedgerDO extends Agent<unknown> {
  constructor(ctx: unknown, env: unknown) { super(ctx, env); }
}
`,
    good: `declare class Agent<E> { constructor(ctx: unknown, env: E); }
declare function sealRpcSurface(instance: object, surface: readonly string[]): void;
export class LedgerDO extends Agent<unknown> {
  constructor(ctx: unknown, env: unknown) { super(ctx, env); sealRpcSurface(this, ['fetch']); }
}
`,
  },
  {
    rule: "require-super-alarm",
    // The shadow the SDK cannot see: an alarm that forgets the schedule table it replaces.
    bad: `declare class Agent<E> { constructor(ctx: unknown, env: E); alarm(): Promise<void>; }
declare function sealRpcSurface(instance: object, surface: readonly string[]): void;
export class LedgerDO extends Agent<unknown> {
  constructor(ctx: unknown, env: unknown) { super(ctx, env); sealRpcSurface(this, ['alarm']); }
  override async alarm(): Promise<void> { await Promise.resolve(); }
}
`,
    good: `declare class Agent<E> { constructor(ctx: unknown, env: E); alarm(): Promise<void>; }
declare function sealRpcSurface(instance: object, surface: readonly string[]): void;
export class LedgerDO extends Agent<unknown> {
  constructor(ctx: unknown, env: unknown) { super(ctx, env); sealRpcSurface(this, ['alarm']); }
  override async alarm(): Promise<void> { await super.alarm(); }
}
`,
  },
  {
    rule: "no-tui-colour-literal",
    // A pane that paints its own warning: the theme switch cannot reach either colour.
    at: "packages/cli/src/tui",
    bad: `export const warning = { fg: "yellow", border: "#FFAA00" };
`,
    good: `declare const roles: { readonly warning: string; readonly border: string };
export const warning = { fg: roles.warning, border: roles.border };
`,
  },
  {
    rule: "require-variant-utility",
    // A hover state on a plain components rule: Tailwind emits no rule for it, so it never paints.
    beside: {
      "index.css": `@utility p-lift { translate: 0 -1px; }
@layer components { .p-plain { color: var(--ink); } }
`,
    },
    bad: `export const card = "rounded p-plain hover:p-plain";
`,
    good: `export const card = "rounded p-plain hover:p-lift";
`,
  },
  {
    rule: "no-cli-credential-flag",
    // A credential in argv: readable from the process list and kept by every command log.
    bad: `declare function run(argv: readonly string[]): void;
declare const key: string;
run(["aws", "configure", "--access-key-id", key]);
`,
    good: `declare function run(argv: readonly string[], env: Readonly<Record<string, string>>): void;
declare const key: string;
run(["aws", "configure"], { AWS_ACCESS_KEY_ID: key });
`,
  },
  {
    rule: "no-manufactured-sql-column",
    // The projection read that faked message_updates' shape for its reader (messages.ts, 2026-09-21).
    bad: `declare const sql: <T>(strings: TemplateStringsArray, ...values: unknown[]) => T[];
interface UpdateRow { sequence: number; part_no: number | null; operation: string; payload_json: string }
export function storedProjection(actorId: string, messageId: string): UpdateRow | null {
  const rows = sql<UpdateRow>\`SELECT sequence, NULL AS part_no, 'open' AS operation, payload_json
    FROM message_projections WHERE actor_id = \${actorId} AND message_id = \${messageId}\`;
  return rows[0] ?? null;
}
`,
    good: `declare const sql: <T>(strings: TemplateStringsArray, ...values: unknown[]) => T[];
interface ProjectionRow { sequence: number; payload_json: string }
export function storedProjection(actorId: string, messageId: string): ProjectionRow | null {
  const rows = sql<ProjectionRow>\`SELECT sequence, payload_json
    FROM message_projections WHERE actor_id = \${actorId} AND message_id = \${messageId}\`;
  return rows[0] ?? null;
}
`,
  },
];

const config = JSON.parse(readFileSync(join(repoRoot, ".oxlintrc.json"), "utf8"));
const manifest = JSON.parse(
  readFileSync(join(repoRoot, "tools/oxlint/anti-slop/upstream.json"), "utf8"),
);
assert.deepEqual(
  cases.map((entry) => entry.rule).sort(),
  [...manifest.kinuRuleGates["no-design-smells.gate.test.ts"]].sort(),
  "this gate must prove exactly the rules upstream.json assigns to it, and only those",
);
for (const { rule } of cases) {
  assert.equal(
    config.rules[`anti-slop/${rule}`],
    "error",
    `anti-slop/${rule} must be enabled at error; a rule proven here but off in the config is silently dead`,
  );
}

/**
 * The live denominators, from the ONE enumeration: SELECT statements in product source for the
 * SQL rule, and function declarations for the duplicate rule. A corpus that has silently gone to
 * zero on either must fail loudly rather than report a clean lint.
 */
const corpus = { files: 0, selects: 0, functions: 0, modelCalls: 0, agentClasses: 0, tuiModules: 0, variantClasses: 0 };
for (const [file, text] of readSources()) {
  corpus.files += 1;
  corpus.selects += text.match(/\bSELECT\b/gu)?.length ?? 0;
  corpus.functions += text.match(/\bfunction\b|=>/gu)?.length ?? 0;
  corpus.modelCalls += text.match(/\b(generateText|streamText|generateObject|streamObject)\(/gu)?.length ?? 0;
  corpus.agentClasses += text.match(/\bclass \w+ extends (?:Agent<|ActorAgent\b)/gu)?.length ?? 0;
  corpus.tuiModules += file.startsWith("packages/cli/src/tui/") ? 1 : 0;
  corpus.variantClasses += text.match(/[a-z-]+:p-[a-z]/gu)?.length ?? 0;
}
assert.ok(corpus.files > 0, "found no TypeScript sources under packages/*/src; the rules would gate nothing");
assert.ok(corpus.selects > 0, `found ${corpus.files} sources but no SELECT; the SQL rule would inspect nothing`);
assert.ok(corpus.functions > 1, `found ${corpus.files} sources but no pair of functions; the duplicate rule would inspect nothing`);
assert.ok(corpus.modelCalls > 0, `found ${corpus.files} sources but no model call; the output-cap rule would inspect nothing`);
assert.ok(corpus.agentClasses > 0, `found ${corpus.files} sources but no class on an agent base; the seal rule would inspect nothing`);
assert.ok(corpus.tuiModules > 0, `found ${corpus.files} sources but none under packages/cli/src/tui; the colour rule would inspect nothing`);
assert.ok(corpus.variantClasses > 0, `found ${corpus.files} sources but no variant-prefixed design class; the utility rule would inspect nothing`);

// System temp dir, NOT the repo root: gates built on scripts/sources.ts enumerate untracked
// worktree files on purpose, so repo-root scratch is visible mid-run to every one of them.
const fixtures = mkdtempSync(join(tmpdir(), "no-design-smells-gate-"));
try {
  const badDirectory = join(fixtures, "red");
  const goodDirectory = join(fixtures, "green");
  mkdirSync(badDirectory);
  mkdirSync(goodDirectory);
  // Under a package's `src`, where a product-scoped rule governs, unless the case names its tree.
  for (const { rule, bad, good, at = "packages/fixture/src", beside = {} } of cases) {
    for (const [directory, text] of [[badDirectory, bad], [goodDirectory, good]] as const) {
      const source = join(directory, ...at.split("/"));
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, `${rule}.ts`), text);

      for (const [name, content] of Object.entries(beside)) writeFileSync(join(source, name), content);
    }
  }

  const lint = (directory: string): readonly LintDiagnostic[] => {
    const report = lintJson(["-c", ".oxlintrc.json", directory]);
    assert.equal(
      report.number_of_files,
      cases.length,
      `oxlint linted ${report.number_of_files} of ${cases.length} fixtures in ${directory}; a run that skipped a fixture proves nothing about it`,
    );
    return report.diagnostics;
  };
  const ruleOf = (diagnostic: LintDiagnostic): string | null => {
    const match = /^anti-slop\(([a-z-]+)\)$/u.exec(diagnostic.code ?? "");
    const rule = match?.[1];
    return rule !== undefined && cases.some((entry) => entry.rule === rule) ? rule : null;
  };
  const firedIn = (diagnostics: readonly LintDiagnostic[], rule: string): readonly LintDiagnostic[] =>
    diagnostics.filter((d) => ruleOf(d) === rule && (d.filename ?? "").endsWith(`${rule}.ts`));

  const red = lint(badDirectory);
  const green = lint(goodDirectory);

  for (const { rule } of cases) {
    assert.ok(
      firedIn(red, rule).length > 0,
      `anti-slop/${rule} did not fire on its seeded defect through \`oxlint -c .oxlintrc.json\`. Diagnostics seen: ${JSON.stringify(red.map(ruleOf))}`,
    );
    assert.equal(
      firedIn(green, rule).length,
      0,
      `anti-slop/${rule} fires on the corrected form, so there is no green state to reach`,
    );
  }
  // Each fixture must be flagged by its own rule and by no other: one rule that
  // flagged everything would pass the per-rule checks above.
  assert.deepEqual(
    [...new Set(red.map(ruleOf).filter((rule) => rule !== null))].sort(),
    cases.map((entry) => entry.rule).sort(),
    "the red run must exercise every rule this gate proves and no rule the fixtures did not seed",
  );
  assert.deepEqual(
    green.filter((d) => ruleOf(d) !== null).map((d) => `${d.filename}: ${d.code}`),
    [],
    "a corrected fixture still draws a design-smell finding",
  );

  process.stdout.write(
    `no-design-smells: ${cases.length} rules proven red->green through oxlint over ${corpus.selects} SELECTs, ${corpus.functions} functions, ${corpus.modelCalls} model calls, ${corpus.agentClasses} agent classes, ${corpus.tuiModules} TUI modules and ${corpus.variantClasses} variant classes in ${corpus.files} sources\n`,
  );
} finally {
  rmSync(fixtures, { recursive: true, force: true });
}
