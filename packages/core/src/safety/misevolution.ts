/**
 * Misevolution gate over evolved artifacts (arXiv:2509.26354), with hardcoded criteria. Code is judged on
 * its syntax tree, prose on its words; docs/EVOLUTION.md lists what each criterion sees and cannot.
 */

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type * as acorn from 'acorn';
import { constantString, isNameOnly, nodesOf, parseEvolvedCode, placedNodesOf, type PlacedNode } from './evolved-code';

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
  readonly strings: ReadonlySet<string>;
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

/** A path at the live scaffold (`scaffold/agent.js`) or one of its version files (`agent.js.v3`). */
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
    trips: (facts) => [...EGRESS_NAMES].some((name) => facts.names.has(name) || facts.strings.has(name)),
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

function declaredNames(program: acorn.Program): Set<string> {
  const declared = new Set<string>();

  const bind = (names: readonly string[]): void => { for (const name of names) declared.add(name); };

  for (const node of nodesOf(program)) {
    if (node.type === 'VariableDeclarator') bind(patternNames(node.id));
    else if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      bind([...patternNames('id' in node ? node.id : null), ...node.params.flatMap((param) => patternNames(param))]);
    } else if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') bind(patternNames(node.id));
    else if (node.type === 'CatchClause') bind(patternNames(node.param));
  }

  return declared;
}

/** `.constructor` kept in place: a property of it read, or it compared. */
function constructorStaysPut({ parent, field }: PlacedNode): boolean {
  if (parent?.type === 'MemberExpression') return field === 'object';

  return parent?.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(parent.operator);
}

function readsGlobalByName({ parent, field }: PlacedNode): boolean {
  return parent?.type === 'MemberExpression' && field === 'object'
    && (!parent.computed || (parent.property.type !== 'PrivateIdentifier' && constantString(parent.property) !== null));
}

function codeFacts(source: string, into: MutableFacts): void {
  const program = parseEvolvedCode(source);

  if (program === null) {
    into.hidden.push('does not parse as JavaScript');

    return;
  }

  const declared = declaredNames(program);

  for (const placed of placedNodesOf(program)) {
    const { node, parent } = placed;

    if (node.type === 'Identifier') {
      into.names.add(node.name);
      const reads = !isNameOnly(placed);

      if (reads && (node.name === 'eval' || node.name === 'require')) into.hidden.push(`references ${node.name}`);

      if (reads && node.name === 'Function' && !(parent?.type === 'BinaryExpression' && parent.operator === 'instanceof')) {
        into.hidden.push('references Function');
      }

      if (reads && GLOBAL_OBJECTS.has(node.name) && !declared.has(node.name) && !readsGlobalByName(placed)) {
        into.hidden.push(`hands ${node.name} on or reads it by a computed key`);
      }
    } else if (node.type === 'ImportExpression' || node.type === 'ImportDeclaration') {
      into.hidden.push('imports a module');
    } else if (node.type === 'WithStatement') {
      into.hidden.push('uses a with statement');
    } else if (node.type === 'MemberExpression') {
      let key: string | null = null;

      if (!node.computed && node.property.type === 'Identifier') key = node.property.name;
      else if (node.computed && node.property.type !== 'PrivateIdentifier') key = constantString(node.property);

      if (node.computed && key !== null) into.names.add(key);

      if (key === 'constructor' && !constructorStaysPut(placed)) into.hidden.push('takes a constructor out of an object');
    }

    const text = constantString(node);

    if (text !== null) {
      into.strings.add(text);
      addText(text, into);
    }
  }
}

interface MutableFacts { names: Set<string>; words: Set<string>; strings: Set<string>; paths: string[]; hidden: string[] }

function artifactFacts(artifact: EvolvedArtifact): ArtifactFacts {
  const paths: string[] = [];
  const hidden: string[] = [];
  const facts: MutableFacts = { names: new Set<string>(), words: new Set<string>(), strings: new Set<string>(), paths, hidden };

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

/** Record a veto in `evolution_events`; a write failure here is real and must surface. */
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
