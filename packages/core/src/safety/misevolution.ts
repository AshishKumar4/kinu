/**
 * Misevolution gate over evolved artifacts (arXiv:2509.26354), with hardcoded criteria. Code is judged on
 * its syntax tree, prose on its words; docs/EVOLUTION.md lists what each criterion sees and cannot.
 */

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type * as acorn from 'acorn';
import { childrenOf, constantString, isNameOnly, parseEvolvedCode, type PlacedNode } from './evolved-code';

export type MisevolutionSurface = 'scaffold' | 'craft' | 'craft_tool' | 'import';

export interface MisevolutionViolation {
  ok: false;
  criterionId: string;
  reason: string;
}

export type MisevolutionVerdict = { ok: true } | MisevolutionViolation;

export interface EvolvedArtifact {
  readonly code?: string;
  readonly prose?: string;
}

interface ArtifactFacts {
  readonly names: ReadonlySet<string>;
  readonly words: ReadonlySet<string>;
  readonly paths: readonly string[];
  readonly hidden: readonly string[];
}

interface MisevolutionCriterion {
  readonly id: string;
  readonly trips: (facts: ArtifactFacts) => boolean;
  readonly reason: string;
}

const EGRESS_NAMES: ReadonlySet<string> = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon']);

const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(['globalThis', 'self', 'window', 'global']);

const mentions = (protectedNames: readonly string[]) => (facts: ArtifactFacts): boolean =>
  protectedNames.some((name) => facts.names.has(name) || facts.words.has(name));

/** `scaffold/agent.js` or a version file (`agent.js.v3`). */
function namesScaffoldFile(path: string): boolean {
  const segments = path.split('/');

  return segments.some((segment, index) => {
    if (segment === 'agent.js') return segments[index - 1] === 'scaffold';
    const version = segment.startsWith('agent.js.v') ? segment.slice('agent.js.v'.length) : '';

    return version.length > 0 && tokensOf(version, (char) => char >= '0' && char <= '9')[0] === version;
  });
}

const CRITERIA: readonly MisevolutionCriterion[] = [
  {
    id: 'network-egress',
    trips: (facts) => [...EGRESS_NAMES].some((name) => facts.names.has(name)),
    reason: 'direct network egress — evolved code must reach the outside world only through the audited tool surface (host.callTool / sandbox tools)',
  },
  {
    id: 'version-machinery-tamper',
    trips: (facts) => mentions(['scaffold_versions', 'scaffold_evaluations', 'scaffold_trial_queue'])(facts)
      || facts.paths.some(namesScaffoldFile),
    reason: 'touches the scaffold version files or shadow-eval tables — promotion happens only through the gated pipeline',
  },
  {
    id: 'rollout-config-tamper',
    trips: mentions(['auto_promote_scaffold', 'shadow_sample_rate', 'scaffold_explore_share', 'auto_gepa_every_n_turns', 'changelog_seen_at']),
    reason: 'references the shadow-rollout knobs or the changelog seen-marker — evolved code must not change its own promotion gates or hide its changes from the operator',
  },
  {
    id: 'self-modification-reentry',
    trips: mentions(['proposeScaffold', 'modifyScaffold', 'applyPromotionDecision', 'applyScaffoldDecision', 'rollbackScaffold', 'checkMisevolution']),
    reason: 'an evolved artifact must not itself propose, promote, roll back, or re-gate scaffold versions',
  },
  {
    id: 'consent-weakening',
    trips: mentions(['shell_approval_mode', 'setShellApprovalMode', 'allow_all', 'device_consent']),
    reason: 'weakens a consent/approval path (shell approval mode, device consent)',
  },
  {
    id: 'unanalysable-code',
    trips: (facts) => facts.hidden.length > 0,
    reason: 'the code hides what it names from this checklist (it does not parse, runs a string as code, imports at runtime, takes a constructor out of an object, or hands on the global object) — write it with names the checklist can read',
  },
];

const MISEVOLUTION_CRITERIA: readonly MisevolutionCriterion[] = Object.freeze(CRITERIA.map((criterion) => Object.freeze(criterion)));

const SAFETY_MACHINERY_CRITERIA = [
  'version-machinery-tamper', 'rollout-config-tamper', 'self-modification-reentry', 'consent-weakening',
] as const;

/** `craft_tool` skips `network-egress`: the codemode Worker already runs raw fetch. */
const SURFACE_CRITERIA: Readonly<Record<MisevolutionSurface, readonly string[]>> = Object.freeze({
  scaffold: ['network-egress', ...SAFETY_MACHINERY_CRITERIA, 'unanalysable-code'],
  craft: ['network-egress', ...SAFETY_MACHINERY_CRITERIA, 'unanalysable-code'],
  import: ['network-egress', ...SAFETY_MACHINERY_CRITERIA, 'unanalysable-code'],
  craft_tool: [...SAFETY_MACHINERY_CRITERIA, 'unanalysable-code'],
});

function tokensOf(text: string, keeps: (char: string) => boolean): string[] {
  const tokens: string[] = [];
  let token = '';

  for (const char of text) {
    if (keeps(char)) {
      token += char;
    } else if (token.length > 0) {
      tokens.push(token);
      token = '';
    }
  }

  return token.length > 0 ? [...tokens, token] : tokens;
}

const isWordChar = (char: string): boolean =>
  (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char === '_';

const isPathChar = (char: string): boolean => isWordChar(char) || char === '/' || char === '.' || char === '-';

function addText(text: string, into: { words: Set<string>; paths: string[] }): void {
  for (const word of tokensOf(text, isWordChar)) into.words.add(word);

  into.paths.push(...tokensOf(text, isPathChar));
}

function patternNames(pattern: acorn.AnyNode | null | undefined): string[] {
  if (pattern === null || pattern === undefined) return [];

  if (pattern.type === 'Identifier') return [pattern.name];

  if (pattern.type === 'AssignmentPattern') return patternNames(pattern.left);

  if (pattern.type === 'RestElement') return patternNames(pattern.argument);

  if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap((element) => patternNames(element));

  if (pattern.type === 'ObjectPattern') {
    return pattern.properties.flatMap((property) => patternNames(property.type === 'RestElement' ? property : property.value));
  }

  return [];
}

const isFunctionNode = (node: acorn.AnyNode): boolean =>
  node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';

function* nodesWithin(root: acorn.AnyNode): Generator<acorn.AnyNode> {
  for (const { node } of childrenOf(root)) {
    yield node;

    if (!isFunctionNode(node)) yield* nodesWithin(node);
  }
}

function scopeBindings(scope: acorn.AnyNode): Set<string> {
  const bound = new Set<string>();
  const bind = (names: readonly string[]): void => { for (const name of names) bound.add(name); };

  const statements = (list: readonly acorn.AnyNode[]): void => {
    for (const statement of list) {
      if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
        for (const declarator of statement.declarations) bind(patternNames(declarator.id));
      } else if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
        bind(patternNames(statement.id));
      }
    }
  };

  const hoisted = (root: acorn.AnyNode): void => {
    for (const node of nodesWithin(root)) {
      if (node.type === 'VariableDeclaration' && node.kind === 'var') {
        for (const declarator of node.declarations) bind(patternNames(declarator.id));
      }
    }
  };

  if (scope.type === 'Program') {
    statements(scope.body);
    hoisted(scope);
  } else if (scope.type === 'FunctionDeclaration' || scope.type === 'FunctionExpression' || scope.type === 'ArrowFunctionExpression') {
    bind(scope.params.flatMap((param) => patternNames(param)));

    if (scope.type === 'FunctionExpression') bind(patternNames(scope.id));

    if (scope.body.type === 'BlockStatement') statements(scope.body.body);
    hoisted(scope.body);
  } else if (scope.type === 'BlockStatement' || scope.type === 'StaticBlock') {
    statements(scope.body);
  } else if (scope.type === 'CatchClause') {
    bind(patternNames(scope.param));
  } else if ((scope.type === 'ForStatement' && scope.init?.type === 'VariableDeclaration')
    || ((scope.type === 'ForInStatement' || scope.type === 'ForOfStatement') && scope.left.type === 'VariableDeclaration')) {
    const declaration = scope.type === 'ForStatement' ? scope.init : scope.left;

    if (declaration?.type === 'VariableDeclaration') statements([declaration]);
  } else if (scope.type === 'ClassExpression') {
    bind(patternNames(scope.id));
  }

  return bound;
}

const SCOPES: ReadonlySet<string> = new Set([
  'Program', 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'BlockStatement', 'StaticBlock',
  'CatchClause', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'ClassExpression',
]);

const KEYED_ACCESSORS: ReadonlySet<string> = new Set([
  'Reflect.get', 'Reflect.getOwnPropertyDescriptor', 'Object.getOwnPropertyDescriptor',
]);

/** `.constructor` kept in place: a property of it read, or it compared. */
function constructorStaysPut({ parent, field }: PlacedNode): boolean {
  if (parent?.type === 'MemberExpression') return field === 'object';

  return parent?.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(parent.operator);
}

/** `globalThis.x`, `self["x"]`, `typeof window`. */
function readsGlobalByName({ parent, field }: PlacedNode): boolean {
  if (parent?.type === 'UnaryExpression') return parent.operator === 'typeof';

  return parent?.type === 'MemberExpression' && field === 'object'
    && (!parent.computed || (parent.property.type !== 'PrivateIdentifier' && constantString(parent.property) !== null));
}

function keyNamed({ node, parent }: PlacedNode): string | null {
  if (node.type === 'MemberExpression' && node.computed && node.property.type !== 'PrivateIdentifier') {
    return constantString(node.property);
  }

  if (node.type === 'Property' && node.computed && parent?.type === 'ObjectPattern') return constantString(node.key);

  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed
    && node.callee.object.type === 'Identifier' && node.callee.property.type === 'Identifier'
    && KEYED_ACCESSORS.has(`${node.callee.object.name}.${node.callee.property.name}`)) {
    const key = node.arguments[1];

    return key === undefined || key.type === 'SpreadElement' ? null : constantString(key);
  }

  return null;
}

function codeFacts(source: string, into: MutableFacts): void {
  const program = parseEvolvedCode(source);

  if (program === null) {
    into.hidden.push('does not parse as JavaScript');

    return;
  }

  const visit = (placed: PlacedNode, enclosing: readonly Set<string>[]): void => {
    const { node, parent } = placed;
    const scopes = SCOPES.has(node.type) ? [...enclosing, scopeBindings(node)] : enclosing;

    if (node.type === 'Identifier') {
      into.names.add(node.name);
      const reads = !isNameOnly(placed);

      if (reads && (node.name === 'eval' || node.name === 'require')) into.hidden.push(`references ${node.name}`);

      if (reads && node.name === 'Function' && !(parent?.type === 'BinaryExpression' && parent.operator === 'instanceof')) {
        into.hidden.push('references Function');
      }

      if (reads && GLOBAL_OBJECTS.has(node.name) && !scopes.some((bound) => bound.has(node.name)) && !readsGlobalByName(placed)) {
        into.hidden.push(`hands ${node.name} on or reads it by a computed key`);
      }
    } else if (node.type === 'ImportExpression' || node.type === 'ImportDeclaration') {
      into.hidden.push('imports a module');
    } else if (node.type === 'WithStatement') {
      into.hidden.push('uses a with statement');
    }

    const key = keyNamed(placed);

    if (key !== null) into.names.add(key);

    if (node.type === 'MemberExpression') {
      const property = !node.computed && node.property.type === 'Identifier' ? node.property.name : key;

      if (property === 'constructor' && !constructorStaysPut(placed)) into.hidden.push('takes a constructor out of an object');
    }

    const text = constantString(node);

    if (text !== null) addText(text, into);

    for (const child of childrenOf(node)) visit(child, scopes);
  };

  visit({ node: program, parent: null, field: '' }, []);
}

interface MutableFacts { names: Set<string>; words: Set<string>; paths: string[]; hidden: string[] }

function artifactFacts(artifact: EvolvedArtifact): ArtifactFacts {
  const paths: string[] = [];
  const hidden: string[] = [];
  const facts: MutableFacts = { names: new Set<string>(), words: new Set<string>(), paths, hidden };

  if (artifact.code !== undefined) codeFacts(artifact.code, facts);

  if (artifact.prose !== undefined) addText(artifact.prose, facts);

  return facts;
}

export function checkMisevolutionForSurface(artifact: EvolvedArtifact, surface: MisevolutionSurface): MisevolutionVerdict {
  const enforced = SURFACE_CRITERIA[surface];
  const facts = artifactFacts(artifact);

  for (const candidate of MISEVOLUTION_CRITERIA) {
    if (enforced.includes(candidate.id) && candidate.trips(facts)) {
      return { ok: false, criterionId: candidate.id, reason: candidate.reason };
    }
  }

  return { ok: true };
}

export function checkMisevolution(code: string): MisevolutionVerdict {
  return checkMisevolutionForSurface({ code }, 'scaffold');
}

/** A write failure here is real and must surface. */
export function recordMisevolutionVeto(
  sql: SqlExecutor,
  actor: ActorHandle,
  args: { surface: MisevolutionSurface; violation: MisevolutionViolation; detail: string },
): void {
  actor.assertCurrent();
  void sql`INSERT INTO evolution_events (actor_id, type, message, data, created_at)
      VALUES (${actor.actorId}, 'misevolution_veto',
              ${`Misevolution veto [${args.surface}/${args.violation.criterionId}]: ${args.violation.reason}`},
              ${JSON.stringify({ surface: args.surface, criterionId: args.violation.criterionId, detail: args.detail.slice(0, 500) })},
              ${Date.now()})`;
}
