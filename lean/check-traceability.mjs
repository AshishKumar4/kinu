import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const leanRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(leanRoot, "..");
const sourceRoot = join(leanRoot, "Proteus");
const axiomAuditPath = join(sourceRoot, "Axioms.lean");
const traceabilityPath = join(leanRoot, "traceability.yaml");
const allowedKernelAxioms = new Set(["propext", "Classical.choice", "Quot.sound"]);
const allowedStatuses = new Set([
  "proved-in-abstract-model",
  "by-construction-witness",
  "trusted-model-assumption",
  "specified-not-modeled",
]);
const qualifiedNamePattern = /^Proteus(?:\.[A-Za-z_][A-Za-z0-9_']*)+$/;
// --manifest-only stops before the kernel axiom audit, which needs a built Lean
// toolchain. Everything up to that point is pure file reading: the manifest is
// well-formed, every tsRef still resolves to a real line of TypeScript, and
// every claimed theorem/axiom exists as an exact source declaration. That is
// the drift check a deploy gate can afford; scripts/verify-lean.sh runs the
// full audit.
const manifestOnly = process.argv.includes("--manifest-only");
const failures = [];

function fail(message) {
  failures.push(message);
}

function exitOnFailures() {
  if (failures.length === 0) return;
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}

function parseTraceability(source) {
  const requirements = new Map();
  let inRequirements = false;
  let current;
  let listKey;

  for (const [index, rawLine] of source.split("\n").entries()) {
    const lineNumber = index + 1;
    if (/^\s*(?:#.*)?$/.test(rawLine)) continue;
    if (rawLine === "requirements:") {
      inRequirements = true;
      current = undefined;
      listKey = undefined;
      continue;
    }
    if (!inRequirements) continue;

    const requirement = rawLine.match(/^  ([A-Z][A-Z0-9-]+):\s*$/);
    if (requirement) {
      const id = requirement[1];
      if (requirements.has(id)) fail(`duplicate requirement id at line ${lineNumber}: ${id}`);
      current = {
        id,
        fields: new Set(),
        theorems: [],
        axioms: [],
        tsRefs: [],
        remainingEvidence: [],
      };
      requirements.set(id, current);
      listKey = undefined;
      continue;
    }

    const field = rawLine.match(/^    ([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/);
    if (field && current) {
      const [, key, rawValue = ""] = field;
      if (current.fields.has(key)) fail(`duplicate field at line ${lineNumber}: ${current.id}.${key}`);
      current.fields.add(key);
      if (["theorems", "axioms", "tsRefs", "remainingEvidence"].includes(key)) {
        if (rawValue !== "" && rawValue !== "[]") {
          fail(`unsupported inline list at line ${lineNumber}: ${key}`);
        }
        current[key] = [];
        listKey = rawValue === "[]" ? undefined : key;
      } else {
        if (rawValue === "") fail(`missing scalar value at line ${lineNumber}: ${key}`);
        current[key] = rawValue;
        listKey = undefined;
      }
      continue;
    }

    const item = rawLine.match(/^      - (\S(?:.*\S)?)\s*$/);
    if (item && current && listKey) {
      current[listKey].push(item[1]);
      continue;
    }

    fail(`unrecognized traceability syntax at line ${lineNumber}: ${rawLine.trim()}`);
  }

  return requirements;
}

function stripLeanComments(source) {
  let output = "";
  let blockDepth = 0;
  let lineComment = false;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        output += char;
      }
      continue;
    }
    if (blockDepth > 0) {
      if (char === "/" && next === "-") {
        blockDepth += 1;
        i += 1;
      } else if (char === "-" && next === "/") {
        blockDepth -= 1;
        i += 1;
      } else if (char === "\n") {
        output += char;
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "-" && next === "-") {
      lineComment = true;
      i += 1;
    } else if (char === "/" && next === "-") {
      blockDepth = 1;
      i += 1;
    } else {
      output += char;
    }
  }
  return output;
}

function stripLeanAttributes(source) {
  let output = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  let sourceString = false;
  let sourceEscaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (depth === 0) {
      if (!sourceString && char === "@" && next === "[") {
        output += "  ";
        depth = 1;
        i += 1;
        continue;
      }
      output += char;
      if (sourceString) {
        if (sourceEscaped) sourceEscaped = false;
        else if (char === "\\") sourceEscaped = true;
        else if (char === '"') sourceString = false;
      } else if (char === '"') {
        sourceString = true;
      }
      continue;
    }
    if (char === "\n") {
      output += char;
      continue;
    }
    output += " ";
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
    }
  }
  if (depth !== 0) fail("unterminated Lean attribute block while scanning declarations");
  return output;
}

function walkLeanSources(directory) {
  const paths = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (directory === leanRoot && [".lake", "scratch-verification"].includes(entry)) continue;
      paths.push(...walkLeanSources(path));
    } else if (entry.endsWith(".lean") && !(directory === leanRoot && entry === "lakefile.lean")) {
      paths.push(path);
    }
  }
  return paths;
}

function collectDeclarations(paths) {
  const theorems = new Set();
  const axioms = new Set();

  for (const path of paths) {
    const source = stripLeanAttributes(stripLeanComments(readFileSync(path, "utf8")));
    if (/\bsorry\b/.test(source)) {
      fail(`source contains a sorry placeholder: ${relativePath(path)}`);
    }
    let namespace = [];
    const scopes = [];
    for (const [lineIndex, line] of source.split("\n").entries()) {
      const namespaceMatch = line.match(/^\s*namespace\s+([A-Za-z_][A-Za-z0-9_'.]*)\s*$/);
      if (namespaceMatch) {
        const components = namespaceMatch[1].split(".");
        namespace.push(...components);
        scopes.push({ kind: "namespace", count: components.length });
        continue;
      }
      if (/^\s*section(?:\s+[A-Za-z_][A-Za-z0-9_']*)?\s*$/.test(line)) {
        scopes.push({ kind: "section", count: 0 });
        continue;
      }
      const endMatch = line.match(/^\s*end(?:\s+([A-Za-z_][A-Za-z0-9_'.]*))?\s*$/);
      if (endMatch) {
        const scope = scopes.pop();
        if (!scope) {
          fail(`unmatched end while scanning ${relativePath(path)}:${lineIndex + 1}`);
        } else if (scope.kind === "namespace") {
          namespace = namespace.slice(0, namespace.length - scope.count);
        }
        continue;
      }
      const declarationMatch = line.match(
        /^\s*((?:(?:private|protected|noncomputable|unsafe)\s+)*)(theorem|axiom)\s+([A-Za-z_][A-Za-z0-9_']*)\b/,
      );
      if (!declarationMatch) continue;
      const [, modifiers, kind, localName] = declarationMatch;
      if (/\bprivate\b/.test(modifiers)) {
        if (kind === "axiom") {
          fail(`private axiom is forbidden because it cannot be enrolled under a stable qualified name: ${relativePath(path)}:${lineIndex + 1}`);
        }
        continue;
      }
      const qualifiedName = [...namespace, localName].join(".");
      if (kind === "theorem") theorems.add(qualifiedName);
      else axioms.add(qualifiedName);
    }
    if (scopes.length !== 0) fail(`unclosed namespace or section while scanning ${relativePath(path)}`);
  }
  return { theorems, axioms };
}

function collectExpectedAxiomReports(source) {
  const expected = new Map();
  const names = new Set();
  for (const [index, line] of stripLeanComments(source).split("\n").entries()) {
    const match = line.match(/^\s*#print\s+axioms\s+(Proteus(?:\.[A-Za-z_][A-Za-z0-9_']*)+)\s*$/);
    if (!match) continue;
    const lineNumber = index + 1;
    if (names.has(match[1])) fail(`duplicate #print axioms command: ${match[1]}`);
    names.add(match[1]);
    expected.set(lineNumber, match[1]);
  }
  return expected;
}

function relativePath(path) {
  return path.startsWith(`${repoRoot}/`) ? path.slice(repoRoot.length + 1) : path;
}

const requirements = parseTraceability(readFileSync(traceabilityPath, "utf8"));
if (requirements.size === 0) fail("traceability.yaml contains no requirements");

const theoremOwners = new Map();
const axiomOwners = new Map();
for (const requirement of requirements.values()) {
  for (const field of ["statement", "status", "theorems", "tsRefs", "remainingEvidence"]) {
    if (!requirement.fields.has(field)) fail(`${requirement.id}: missing required field ${field}`);
  }
  if (typeof requirement.statement !== "string" || !/[.!?]$/.test(requirement.statement)) {
    fail(`${requirement.id}: statement must be one sentence ending in punctuation`);
  }
  if (!allowedStatuses.has(requirement.status)) {
    fail(`${requirement.id}: invalid status ${requirement.status ?? "(missing)"}`);
  }
  if (requirement.tsRefs.length === 0) fail(`${requirement.id}: tsRefs must not be empty`);
  if (requirement.remainingEvidence.length === 0) {
    fail(`${requirement.id}: remainingEvidence must not be empty`);
  }
  if (requirement.status === "specified-not-modeled" &&
      (requirement.theorems.length !== 0 || requirement.axioms.length !== 0)) {
    fail(`${requirement.id}: specified-not-modeled requirements cannot claim Lean declarations`);
  }
  if (requirement.status === "trusted-model-assumption" && requirement.axioms.length === 0) {
    fail(`${requirement.id}: trusted-model-assumption must enumerate at least one axiom`);
  }
  if (["proved-in-abstract-model", "by-construction-witness"].includes(requirement.status) &&
      requirement.theorems.length === 0) {
    fail(`${requirement.id}: ${requirement.status} must claim at least one theorem`);
  }
  if (requirement.status !== "trusted-model-assumption" && requirement.axioms.length > 0) {
    fail(`${requirement.id}: only trusted-model-assumption may enumerate axioms`);
  }

  for (const name of requirement.theorems) {
    if (!qualifiedNamePattern.test(name)) fail(`${requirement.id}: invalid theorem name ${name}`);
    if (theoremOwners.has(name)) {
      fail(`theorem claimed more than once: ${name} (${theoremOwners.get(name)}, ${requirement.id})`);
    } else theoremOwners.set(name, requirement.id);
  }
  for (const name of requirement.axioms) {
    if (!qualifiedNamePattern.test(name)) fail(`${requirement.id}: invalid axiom name ${name}`);
    if (axiomOwners.has(name)) {
      fail(`axiom claimed more than once: ${name} (${axiomOwners.get(name)}, ${requirement.id})`);
    } else axiomOwners.set(name, requirement.id);
  }
  for (const ref of requirement.tsRefs) {
    const match = ref.match(/^([^:]+):([1-9][0-9]*)$/);
    if (!match) {
      fail(`${requirement.id}: invalid tsRef ${ref}`);
      continue;
    }
    const path = resolve(repoRoot, match[1]);
    if (!path.startsWith(`${repoRoot}/`)) {
      fail(`${requirement.id}: tsRef escapes repository root: ${ref}`);
      continue;
    }
    try {
      const lineCount = readFileSync(path, "utf8").split("\n").length;
      if (Number(match[2]) > lineCount) fail(`${requirement.id}: tsRef line is out of range: ${ref}`);
    } catch {
      fail(`${requirement.id}: tsRef file does not exist: ${ref}`);
    }
  }
}

const declarations = collectDeclarations(walkLeanSources(leanRoot));
const expectedReports = collectExpectedAxiomReports(readFileSync(axiomAuditPath, "utf8"));
for (const name of theoremOwners.keys()) {
  if (!declarations.theorems.has(name)) fail(`claimed theorem not found by exact source declaration: ${name}`);
}
for (const name of axiomOwners.keys()) {
  if (!declarations.axioms.has(name)) fail(`claimed axiom not found by exact source declaration: ${name}`);
}
for (const name of declarations.axioms) {
  if (!axiomOwners.has(name)) fail(`source axiom is not enrolled as a trusted model assumption: ${name}`);
}

if (manifestOnly) {
  exitOnFailures();
  console.log(
    `check-traceability: manifest OK — ${requirements.size} requirements, ` +
    `${theoremOwners.size} claimed theorems (kernel axiom audit skipped: --manifest-only)`,
  );
  process.exit(0);
}

const build = spawnSync("lake", ["build", "Proteus.Axioms"], {
  cwd: leanRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (build.error && build.status === null) {
  console.error(`check-traceability: failed to start lake: ${build.error.message}`);
  process.exit(1);
}
if (build.status !== 0) {
  process.stdout.write(build.stdout);
  process.stderr.write(build.stderr);
  console.error("check-traceability: lake build Proteus.Axioms failed");
  process.exit(1);
}

const buildOutput = `${build.stdout}\n${build.stderr}`;
const reported = new Map();
const reportPattern = /^info: .*Proteus\/Axioms\.lean:(\d+):\d+: '(Proteus\.[^']+)' (does not depend on any axioms|depends on axioms: \[([^\]]*)\])\s*$/gm;
for (const match of buildOutput.matchAll(reportPattern)) {
  const lineNumber = Number(match[1]);
  const name = match[2];
  const expectedName = expectedReports.get(lineNumber);
  if (expectedName !== name) {
    fail(`axiom report is not backed by a matching #print axioms command at line ${lineNumber}: ${name}`);
    continue;
  }
  const axioms = match[4]?.trim()
    ? match[4].split(",").map((axiom) => axiom.trim())
    : [];
  if (reported.has(name)) fail(`duplicate theorem in axiom report: ${name}`);
  reported.set(name, axioms);
}
if (reported.size === 0) {
  console.error(buildOutput);
  console.error("check-traceability: no #print axioms records captured from Proteus.Axioms");
  process.exit(1);
}

for (const [name, axioms] of reported) {
  const ownerId = theoremOwners.get(name);
  if (!ownerId) fail(`theorem in axiom report is unclaimed: ${name}`);
  if (!declarations.theorems.has(name)) fail(`reported theorem has no exact source declaration: ${name}`);

  for (const axiom of axioms) {
    if (axiom.includes("sorryAx")) {
      fail(`theorem depends on forbidden proof placeholder ${axiom}: ${name}`);
      continue;
    }
    if (allowedKernelAxioms.has(axiom)) continue;
    const owner = ownerId ? requirements.get(ownerId) : undefined;
    if (owner?.status !== "trusted-model-assumption" || !owner.axioms.includes(axiom)) {
      fail(`theorem depends on undocumented non-kernel axiom ${axiom}: ${name}`);
    }
  }
}
for (const name of theoremOwners.keys()) {
  if (!reported.has(name)) fail(`claimed theorem missing from Proteus.Axioms report: ${name}`);
}
for (const name of declarations.theorems) {
  if (![...expectedReports.values()].includes(name)) {
    fail(`published source theorem has no #print axioms command: ${name}`);
  }
  if (!reported.has(name)) fail(`published source theorem missing from Proteus.Axioms audit: ${name}`);
}
for (const name of expectedReports.values()) {
  if (!declarations.theorems.has(name)) fail(`#print axioms target has no source theorem declaration: ${name}`);
  if (!reported.has(name)) fail(`#print axioms command produced no matching audit record: ${name}`);
}

exitOnFailures();

const statusCounts = new Map();
for (const requirement of requirements.values()) {
  statusCounts.set(requirement.status, (statusCounts.get(requirement.status) ?? 0) + 1);
}
const statusSummary = [...statusCounts].map(([status, count]) => `${status}=${count}`).join(", ");
console.log(
  `check-traceability: OK — ${requirements.size} requirements, ${reported.size} theorems, ` +
  `${declarations.axioms.size} trusted axiom (${statusSummary})`,
);
