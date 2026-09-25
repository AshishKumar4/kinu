/**
 * Misevolution gate over evolved artifacts (arXiv:2509.26354), with hardcoded criteria. Code is judged on
 * its syntax tree, prose on its words; docs/EVOLUTION.md lists what each criterion sees and cannot.
 */

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { constantString, nodesOf, parseEvolvedCode } from './evolved-code';

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

const CODE_FROM_STRING: ReadonlySet<string> = new Set(['eval', 'Function', 'require']);

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
    reason: 'the code hides what it names from this checklist (it does not parse, runs a string as code, imports at runtime, or reads the global object by a computed key) — write it with names the checklist can read',
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

function codeFacts(source: string, into: { names: Set<string>; words: Set<string>; paths: string[]; hidden: string[] }): void {
  const program = parseEvolvedCode(source);

  if (program === null) {
    into.hidden.push('does not parse as JavaScript');

    return;
  }

  const strings: string[] = [];

  for (const node of nodesOf(program)) {
    if (node.type === 'Identifier') {
      into.names.add(node.name);

      if (CODE_FROM_STRING.has(node.name)) into.hidden.push(`references ${node.name}`);
    } else if (node.type === 'ImportExpression' || node.type === 'ImportDeclaration') {
      into.hidden.push('imports a module');
    } else if (node.type === 'WithStatement') {
      into.hidden.push('uses a with statement');
    } else if (node.type === 'MemberExpression' && node.computed && node.property.type !== 'PrivateIdentifier') {
      const key = constantString(node.property);

      if (key !== null) into.names.add(key);
      else if (node.object.type === 'Identifier' && GLOBAL_OBJECTS.has(node.object.name)) {
        into.hidden.push(`reads ${node.object.name} by a computed key`);
      }
    }

    const text = constantString(node);

    if (text !== null) strings.push(text);
  }

  for (const text of strings) addText(text, into);
}

function artifactFacts(artifact: EvolvedArtifact): ArtifactFacts {
  const paths: string[] = [];
  const hidden: string[] = [];
  const facts = { names: new Set<string>(), words: new Set<string>(), paths, hidden };

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
