// Proteus-only gate; see upstream.json's `proteusRules` and `proteusRuleGates`.
//
// `rules/no-copy-rpc-stub.test.ts` proves the rule function behaves. It does not prove the rule is
// reachable through the command the repo gates on, and it does not prove the repo contains any JSRPC
// stub for it to gate. This file runs the real `oxlint` binary with the real `.oxlintrc.json` over
// the historical defect and over its corrected form, asserts red then green, and asserts the live
// denominator: a rule that inspected no stub-producing expression reports no misuse and would pass
// silently.
//
// The green fixture is the correction the four sites actually took — HOLD the stub in a typed
// binding — so the gate proves there is a reachable green state and not merely a red one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { readSources } from "../../../scripts/sources.ts";

const repoRoot = process.cwd();

/** `oxlint -f json`. `code` is spelled `anti-slop(no-copy-rpc-stub)`. */
type Diagnostic = { readonly code?: string; readonly filename?: string };
type LintReport = {
  readonly diagnostics: readonly Diagnostic[];
  readonly number_of_files: number;
  readonly number_of_rules: number;
};

/**
 * `resolveEgressInjection`'s vault view exactly as egress/outbound.ts stood when production
 * `wrangler tail` recorded `vaultView.resolveEgressInjection is not a function`. Pinned by digest so
 * the fixture is the shape that shipped rather than a shape invented to suit the rule. The trailing
 * `SAFETY` comment is kept verbatim because it is the point: it was TRUE — the name really is a
 * UserDO method — and it pinned the wrong property, which is why a name assertion never caught this
 * and a syntactic rule has to.
 */
const HISTORICAL_VAULT_VIEW = `  const vaultView: Partial<EgressVaultClient> = {};
  Object.assign(vaultView, env.UserDO.get(env.UserDO.idFromName(params.ownerUserId)));
  // SAFETY: checked by construction and pinned by a test. \`resolveEgressInjection\`
  // is declared \`public\` on UserDO and listed in USER_DO_METHODS, which is
  // \`as const satisfies readonly (keyof UserDO)[]\` — so the name cannot be
  // wrong without failing the build.
`;
const HISTORICAL_DIGEST = "b5d1184cf728e0e987218f2cec331bb906d670085c795d083826ac52f5a06d3b";

const DECLARED_BASE = `declare const env: {
  UserDO: { idFromName(name: string): unknown; get(id: unknown): EgressVaultClient };
};
declare const params: { ownerUserId: string };
interface EgressVaultClient { resolveEgressInjection(host: string): Promise<string | null> }
`;

/** Red fixture, then the corrected form of the same code. */
const cases: ReadonlyArray<{
  readonly rule: string;
  readonly bad: string;
  readonly good: string;
}> = [
  {
    rule: "no-copy-rpc-stub",
    bad: `${DECLARED_BASE}export async function resolveInjection(host: string): Promise<string | null> {
${HISTORICAL_VAULT_VIEW}  return await vaultView.resolveEgressInjection!(host);
}
`,
    good: `${DECLARED_BASE}export async function resolveInjection(host: string): Promise<string | null> {
  // The stub is held, not copied. Its methods live behind the Proxy's \`get\` trap, so a binding
  // reaches them and a structural copy reaches nothing.
  const vault: EgressVaultClient = env.UserDO.get(env.UserDO.idFromName(params.ownerUserId));
  return await vault.resolveEgressInjection(host);
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
  [...manifest.proteusRuleGates["no-copy-rpc-stub.gate.test.ts"]].sort(),
  "this gate must prove exactly the rules upstream.json assigns to it, and only those",
);
for (const { rule } of cases) {
  assert.equal(
    config.rules[`anti-slop/${rule}`],
    "error",
    `anti-slop/${rule} must be enabled at error; a rule proven here but off in the config is silently dead`,
  );
}
assert.equal(
  createHash("sha256").update(HISTORICAL_VAULT_VIEW).digest("hex"),
  HISTORICAL_DIGEST,
  "the historical vault-view fixture no longer matches its pinned digest",
);

// The rule's premise, executed rather than asserted about. A syntactic rule is only worth having if
// the runtime really does behave the way its message claims, and nothing else in the repo pins that:
// the four shipped sites were each covered by a test that checked the METHOD NAME existed on the RPC
// surface, which it did, while the copy that was supposed to carry it was empty. So this calls the
// method through the copy and observes the value.
//
// The double is a `Proxy` whose methods come from a `get` trap and which owns no enumerable keys —
// the shape workerd gives a JSRPC stub. A plain object double cannot reproduce the defect, which is
// exactly why four sites shipped broken behind passing tests.
const stubDouble = new Proxy({}, {
  get: (_target, property) =>
    property === "resolveEgressInjection" ? () => "injected-secret" : undefined,
  ownKeys: () => [],
});

const copiedView: Record<string, unknown> = {};
Object.assign(copiedView, stubDouble);
assert.deepEqual(
  Object.keys(copiedView),
  [],
  "Object.assign over a Proxy-backed stub copied a key; the rule's premise no longer holds and its message is wrong",
);
assert.equal(
  copiedView.resolveEgressInjection,
  undefined,
  "the copied view exposes the method, so the defect this rule gates would not occur",
);
assert.deepEqual(
  Object.keys({ ...stubDouble }),
  [],
  "object spread over a Proxy-backed stub copied a key; the rule bans spread on the same premise as Object.assign",
);
// Held rather than copied, the same stub answers. This is the correction the green fixture encodes.
assert.equal(
  (stubDouble as { resolveEgressInjection(host: string): string }).resolveEgressInjection("api.example.com"),
  "injected-secret",
  "the stub double does not answer through the stub itself, so it is not a faithful stand-in",
);

/**
 * The live denominator, in two parts, because each can go to zero on its own.
 *
 * `producers` counts the expressions that MAKE a JSRPC stub in the deployed worker's own source —
 * `env.<Namespace>.get(…)` / `.getByName(…)` and agents-SDK `getAgentByName(…)`. If that is zero the
 * rule has nothing to be wrong about and its silence means nothing.
 *
 * `copyOperations` counts `Object.assign` and object spread in the same source. If THAT is zero the
 * rule's silence is equally uninformative: it would mean the repo contains no copy operation at all,
 * so a rule keyed on copying could never fire regardless of how many stubs exist.
 */
function stubCorpus(): {
  readonly producers: number;
  readonly copyOperations: number;
  readonly files: number;
} {
  const WORKER = "packages/cf-backend/src/";
  const sources = [...readSources()]
    .filter(([file]) => file.startsWith(WORKER))
    .map(([, text]) => text);
  assert.ok(
    sources.length > 0,
    `no source found under ${WORKER}; a stub scan over an empty corpus finds no stubs and passes`,
  );
  const count = (pattern: RegExp): number =>
    sources.reduce((total, text) => total + (text.match(pattern)?.length ?? 0), 0);
  return {
    producers:
      count(/\benv\.[A-Za-z0-9_$]+\.get(?:ByName)?\(/gu) + count(/\bgetAgentByName\s*[(<]/gu),
    copyOperations: count(/\bObject\.assign\(/gu) + count(/\{\s*\.\.\./gu),
    files: sources.length,
  };
}

const corpus = stubCorpus();
assert.ok(
  corpus.producers > 0,
  `found 0 stub-producing expressions across ${corpus.files} files under packages/cf-backend/src; a rule keyed on \`env.<NS>.get(…)\` / \`getAgentByName(…)\` would then match nothing by construction`,
);
assert.ok(
  corpus.copyOperations > 0,
  `found ${corpus.producers} stub producers but 0 \`Object.assign\`/spread operations under packages/cf-backend/src; a rule keyed on copying could then never fire`,
);

const fixtures = mkdtempSync(join(repoRoot, ".no-copy-rpc-stub-gate-"));
try {
  const badDirectory = join(fixtures, "red");
  const goodDirectory = join(fixtures, "green");
  mkdirSync(badDirectory);
  mkdirSync(goodDirectory);
  for (const { rule, bad, good } of cases) {
    writeFileSync(join(badDirectory, `${rule}.ts`), bad);
    writeFileSync(join(goodDirectory, `${rule}.ts`), good);
  }

  const lint = (directory: string): LintReport => {
    const run = spawnSync(
      "./node_modules/.bin/oxlint",
      ["-c", ".oxlintrc.json", "-f", "json", relative(repoRoot, directory)],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.ok(run.stdout.length > 0, `oxlint produced no JSON for ${directory}:\n${run.stderr}`);
    const report: LintReport = JSON.parse(run.stdout);
    assert.equal(
      report.number_of_files,
      cases.length,
      `oxlint linted ${report.number_of_files} of ${cases.length} fixtures in ${directory}; a run that skipped a fixture proves nothing about it`,
    );
    assert.ok(
      report.number_of_rules > 0,
      `oxlint ran ${report.number_of_rules} rules; a lint with no rules loaded reports no findings`,
    );
    return report;
  };

  // The other anti-slop rules also run over these fixtures; their findings are not this gate's
  // subject.
  const ruleOf = (diagnostic: Diagnostic): string | null => {
    const match = /^anti-slop\(([a-z-]+)\)$/u.exec(diagnostic.code ?? "");
    const rule = match?.[1];
    return rule !== undefined && cases.some((entry) => entry.rule === rule) ? rule : null;
  };
  const firedIn = (
    diagnostics: ReadonlyArray<Diagnostic>,
    rule: string,
  ): ReadonlyArray<Diagnostic> =>
    diagnostics.filter((d) => ruleOf(d) === rule && (d.filename ?? "").endsWith(`${rule}.ts`));

  const red = lint(badDirectory).diagnostics;
  const green = lint(goodDirectory).diagnostics;

  for (const { rule } of cases) {
    assert.equal(
      firedIn(red, rule).length,
      1,
      `anti-slop/${rule} fired ${firedIn(red, rule).length} times on the one seeded defect through \`oxlint -c .oxlintrc.json\`; expected exactly 1. Diagnostics seen: ${JSON.stringify(red.map(ruleOf))}`,
    );
    assert.equal(
      firedIn(green, rule).length,
      0,
      `anti-slop/${rule} fires on the corrected form, so the cutover has no green state to reach`,
    );
  }

  process.stdout.write(
    `no-copy-rpc-stub: 1 rule proven red->green through oxlint over ${corpus.producers} stub-producing expressions and ${corpus.copyOperations} copy operations across ${corpus.files} files\n`,
  );
} finally {
  rmSync(fixtures, { recursive: true, force: true });
}
