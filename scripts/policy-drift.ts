/**
 * Duplicated-policy gate — one number, written twice, under one name, with two
 * different values.
 *
 * This is the blind spot `gate:duplication` states about itself: *"duplicated
 * POLICY expressed in different code."* That gate fingerprints function bodies,
 * so two `const RETRY_BASE_MS` declarations in two packages are invisible to it
 * — there is no shared body, only a shared decision written down twice.
 *
 * ## The defect, stated exactly
 *
 * `RETRY_BASE_MS` is declared three times in this tree: `5_000` in
 * `core/src/events/ingress/peer.ts`, `30_000` in `cf-backend/src/email/outbox.ts`,
 * `1_000` in `cf-backend/src/hooks/use-kinu.ts`. `RETRY_MAX_MS` is declared
 * three times: `3_600_000` twice and `30_000` once. Every one of them carries a
 * comment, and every comment describes its own value, so a reader who greps the
 * name and reads the first hit gets a CONFIDENT WRONG ANSWER about what the
 * system does. That is worse than an unnamed literal, which at least admits it
 * is local.
 *
 * ## Three signals, because one is not enough — measured, not assumed
 *
 * VALUE alone over-fires, and the first version of this gate measured exactly
 * how badly: 198 findings, because `MS` is in nearly every policy name and
 * `600000` is both a session lifetime and a deploy timeout. NAME alone
 * under-fires: the same policy is written `MAX_DELIVERY_ATTEMPTS` in core and
 * `MAX_SEND_ATTEMPTS` in cf-backend, both 8. So the gate reports four shapes,
 * each needing two signals to agree:
 *
 *   `divergent`   — same NAME, different VALUE. A reader is actively misled.
 *   `duplicated`  — same NAME and value, two packages, no import between them.
 *   `aliased`     — same VALUE, different names, in two packages, related by a
 *                   word that at that value names EXACTLY these two and nothing
 *                   else in the tree.
 *   `unnamed`     — a bare literal whose role words EQUAL a named policy's.
 *
 * A name is three kinds of word and conflating them is what produced the 198.
 * A UNIT (`MS`, `BYTES`) says what is measured and relates nothing. A QUALIFIER
 * (`MAX`, `DEFAULT`) says which end of a range. Only a ROLE (`TTL`, `ATTEMPTS`)
 * or a DOMAIN (`MCP`, `DRAIN`) can relate two names — and even then only when it
 * is discriminating, which is read off the tree rather than guessed: the shared
 * word must, at that value, be carried by exactly two declarations. `TIMEOUT` at
 * 30_000 is carried by seven and is a common default; `ATTEMPTS` at 8 is carried
 * by two and is one decision written twice. Two is not a threshold anyone chose.
 * It is what a pair is.
 *
 * The third signal is the exculpating one, and it is what keeps the calibration
 * TRUE NEGATIVE quiet. `CLOUD_MAX_INLINE_ATTACHMENT_BYTES` (1 MiB, core) and
 * `LOCAL_MAX_INLINE_ATTACHMENT_BYTES` (8 MiB, cli-backend) share every role word
 * and differ 8x on purpose. What makes them not-drift is not their values and
 * not their names: core's declaration NAMES the other constant, in text, and
 * tells surfaces to read the client field *"rather than importing either"*. So a
 * pair is exonerated when either file mentions the other's name — a reference is
 * a reference whether it is in code or in prose, and if you wrote the other name
 * down you knew about it. `policy-drift.test.ts` proves that check is
 * load-bearing rather than decorative: the same two declarations with the
 * comment removed ARE reported.
 *
 *   STATE THE REASON OR SHARE THE CONSTANT.
 *
 * ## Values are normalised, so notation cannot hide a match
 *
 * Five minutes is written `300_000` in `core/chat.ts` and `5 * 60 * 1000` in
 * three other places. A comparison over source text sees four unrelated
 * constants. `numericValue` folds literals and arithmetic over literals, so all
 * four are one number here. It deliberately does NOT resolve identifiers: a gate
 * that resolves some names and not others reports a difference that is really
 * the edge of its own reach.
 *
 * ## Inline literals, and the blind spot that is stated rather than hidden
 *
 * A policy does not stop being duplicated because the second copy has no name,
 * so 2,629 numeric literals sitting in a role position — an option property, a
 * call argument, an assignment — are read alongside the 277 named constants. But
 * a literal's role is one or two words, and a PARTIAL match on them is
 * worthless: `setTimeout(…, 30000)` shares `TIMEOUT` with seventeen constants.
 * The role words must EQUAL the constant's. On this tree that is 0 findings.
 * That number is reported rather than engineered away: a partial-match version
 * produced 12 and every one was two unrelated decisions picking the same round
 * number. The scan is proven live by its denominator and by a self-test that
 * fires it.
 *
 * ## Scope, and why it is SCREAMING_SNAKE
 *
 * A named policy is a module-level `const` in SCREAMING_SNAKE — the convention
 * every constant in the seed list already follows. Lowercase locals are excluded
 * because `const limit = 50` collides across unrelated files constantly and
 * reporting those would bury the signal. That is a real limit and it is stated
 * rather than hidden: a policy written as a lowercase local is not seen.
 */

import { assertMeasured, finding, reconcile, report, writeLock } from './gate-ratchet';
import { readSources } from './sources';
import {
  declarationOf, declaredName, identifierText, numericValue, parse, type SyntaxNode, walk,
} from './syntax';

const root = new URL('..', import.meta.url).pathname;
const LOCK = `${root}scripts/policy-drift.lock.json`;

/** A module-level constant naming a policy number. */
export interface Declared {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly value: number;
}

/** A bare number in a position that gives it a policy role. */
export interface Inline {
  readonly file: string;
  readonly line: number;
  readonly value: number;
  /** The property or callee the literal sits under — its role, in source words. */
  readonly role: string;
}

export type DriftKind = 'divergent' | 'duplicated' | 'aliased' | 'unnamed';

export interface Drift {
  readonly kind: DriftKind;
  readonly key: string;
  readonly detail: string;
}

/** What one file contributes: the policies it names, and the policy-shaped
 *  numbers it writes without naming. */
export interface FileSurvey {
  readonly declared: readonly Declared[];
  readonly inline: readonly Inline[];
}

export interface Survey extends FileSurvey {
  readonly files: number;
  readonly drifts: readonly Drift[];
}

const SCREAMING_SNAKE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;

/*  A name is three kinds of word, and conflating them is what made the first
    version of this gate report 198 findings, nearly all noise.

    A UNIT says what the number measures. `MS` is the commonest word in every
    policy name in the tree, so "shares a role word" was satisfied by any two
    millisecond constants that happened to be equal — `AUTH_TTL_MS` (a session
    lifetime) and `DEPLOY_TIMEOUT_MS` (how long a deploy may take) are both
    600000 and have nothing to do with each other. A unit cannot relate two
    names.

    A QUALIFIER says which end of a range this is. `MAX_DELIVERY_ATTEMPTS` and
    `MAX_SEND_ATTEMPTS` are the same policy; `MAX_FOO` and `MAX_BAR` are not.

    A ROLE says what the number governs, and everything else in the name is the
    DOMAIN it governs it for. Those two together are what relate a pair: a
    shared role (`TTL` with `TTL`) or a shared domain (`MCP` with `MCP`).       */

const UNIT_WORDS: ReadonlySet<string> = new Set([
  'MS', 'SEC', 'SECS', 'SECOND', 'SECONDS', 'MINUTE', 'MINUTES', 'HOUR', 'HOURS',
  'DAY', 'DAYS', 'BYTE', 'BYTES', 'KB', 'MB', 'KIB', 'MIB', 'CHARS', 'PERCENT', 'PCT',
]);

const QUALIFIER_WORDS: ReadonlySet<string> = new Set([
  'MAX', 'MIN', 'DEFAULT', 'BASE', 'INITIAL', 'HARD', 'SOFT', 'TOTAL', 'PER', 'THE',
]);

/** What the number governs. A name carrying none of these, and no unit, is not
 *  a policy — it is a magic index, a status code or a version. */
const ROLE_WORDS: ReadonlySet<string> = new Set([
  'TIMEOUT', 'RETRY', 'RETRIES', 'BACKOFF', 'ATTEMPT', 'ATTEMPTS', 'DELAY',
  'INTERVAL', 'TTL', 'EXPIRY', 'RETENTION', 'CLEANUP', 'DEADLINE', 'WINDOW',
  'POLL', 'DEBOUNCE', 'THROTTLE', 'HEARTBEAT', 'WARMUP', 'STARTUP', 'COOLDOWN',
  'LIMIT', 'CAP', 'BUDGET', 'THRESHOLD', 'QUOTA', 'AGE', 'LIFETIME', 'GRACE',
]);

const wordsOf = (name: string): readonly string[] => name.split('_');

const isPolicyName = (name: string): boolean =>
  wordsOf(name).some((word) => ROLE_WORDS.has(word) || UNIT_WORDS.has(word));

/** The words that can relate two names: role and domain, never unit or
 *  qualifier. */
const significantWords = (name: string): ReadonlySet<string> =>
  new Set(wordsOf(name).filter((word) => !UNIT_WORDS.has(word) && !QUALIFIER_WORDS.has(word)));

const packageOf = (file: string): string => file.split('/')[1] ?? file;

/** Module-level SCREAMING_SNAKE constants bound to a foldable number, plus every
 *  numeric literal sitting in a role position. One walk, because both questions
 *  are about the same nodes seen from different sides. */
export function surveyFile(file: string, text: string): FileSurvey {
  const { root: tree, lineAt } = parse(file, text);
  const declared: Declared[] = [];
  const named = new Set<SyntaxNode>();

  for (const statement of tree.children) {
    const { node } = declarationOf(statement);
    if (node.raw.type !== 'VariableDeclaration' || node.raw.kind !== 'const') continue;
    for (const declarator of node.children) {
      const { raw } = declarator;
      if (raw.type !== 'VariableDeclarator') continue;
      const name = declaredName(declarator);
      if (name === undefined || !SCREAMING_SNAKE.test(name)) continue;
      const init = declarator.children.find((child) => child.raw !== raw.id);
      if (init === undefined) continue;
      const value = numericValue(init);
      if (value === undefined) continue;
      declared.push({ name, file, line: lineAt(declarator.start), value });
      named.add(init);
    }
  }

  const inline: Inline[] = [];
  walk(tree, (node) => {
    if (named.has(node)) return;
    const value = numericValue(node);
    // A folded expression reports once, at its outermost node: `5 * 60 * 1000`
    // is one number, not the three its sub-expressions would each claim.
    if (value === undefined || (node.parent !== undefined && numericValue(node.parent) !== undefined)) return;
    const role = roleOf(node);
    if (role === undefined) return;
    inline.push({ file, line: lineAt(node.start), value, role });
  });

  return { declared, inline };
}

/**
 * The word a literal is playing a role under: the property it is assigned to,
 * the option key it sits behind, or the function it is passed to. A number with
 * no such word is an index, a length or an arithmetic term, and reporting those
 * would drown everything.
 */
function roleOf(node: SyntaxNode): string | undefined {
  const parent = node.parent;
  if (parent === undefined) return undefined;
  const { raw } = parent;
  if (raw.type === 'Property' && raw.value === node.raw) {
    const key = declaredName(parent);
    return key === undefined ? undefined : key;
  }
  if (raw.type === 'PropertyDefinition' && raw.value === node.raw) return declaredName(parent);
  if (raw.type === 'AssignmentExpression' && raw.right === node.raw) {
    return parent.children[0] === undefined ? undefined : identifierText(parent.children[0]);
  }
  if (raw.type !== 'CallExpression') return undefined;
  const callee = parent.children[0];
  if (callee === undefined) return undefined;
  return identifierText(callee)
    ?? (callee.raw.type === 'MemberExpression' ? identifierText(callee.children[1] ?? callee) : undefined);
}

/** Role and domain words a camelCase property or callee carries — the same
 *  alphabet as a constant name, read out of `staleAfterMs` instead of
 *  `STALE_AFTER_MS`. */
const wordsOfCamel = (role: string): string =>
  role.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

/**
 * True when either declaration's file writes the other's name down. That is the
 * exculpating signal, and it is deliberately a text search rather than an import
 * check: a comment saying "eight times what a cloud agent accepts, see
 * CLOUD_MAX_INLINE_ATTACHMENT_BYTES" is exactly the reason this gate wants
 * stated, and it compiles to nothing.
 */
const crossReferenced = (
  a: Declared, b: Declared, sources: ReadonlyMap<string, string>,
): boolean =>
  (sources.get(a.file)?.includes(b.name) ?? false)
  || (sources.get(b.file)?.includes(a.name) ?? false);

export function findDrift(sources: ReadonlyMap<string, string>): Survey {
  const declared: Declared[] = [];
  const inline: Inline[] = [];
  for (const [file, text] of sources) {
    const found = surveyFile(file, text);
    declared.push(...found.declared);
    inline.push(...found.inline);
  }

  const drifts: Drift[] = [];

  // ── divergent: one name, two answers ──────────────────────────────────
  const byName = new Map<string, Declared[]>();
  for (const entry of declared) {
    const bucket = byName.get(entry.name);
    if (bucket) bucket.push(entry); else byName.set(entry.name, [entry]);
  }
  for (const [name, entries] of byName) {
    const values = new Set(entries.map((e) => e.value));
    const packages = new Set(entries.map((e) => packageOf(e.file)));
    if (values.size < 2 && packages.size < 2) continue;
    const sites = [...entries].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    const where = sites.map((s) => `${String(s.value)} at ${s.file}:${String(s.line)}`).join('; ');
    drifts.push(values.size > 1
      ? {
        kind: 'divergent',
        key: `divergent ${name}`,
        detail: finding({
          at: `${name} — ${sites.map((s) => `${s.file}:${String(s.line)}`).join(', ')}`,
          invariant: 'one name means one number',
          found: `${String(values.size)} different values under it: ${where}`,
          silently: 'nothing fails. A reader greps the name, reads the first hit, and gets a '
            + 'confident wrong answer about what the system does — which is worse than an '
            + 'unnamed literal, because an unnamed literal admits it is local',
          fix: 'one constant with one home, imported by every site — or, if the sites are '
            + 'genuinely different policies, give them different names and say in each why it '
            + 'differs from the other',
        }),
      }
      : {
        kind: 'duplicated',
        key: `duplicated ${name}`,
        detail: finding({
          at: `${name} — ${sites.map((s) => `${s.file}:${String(s.line)}`).join(', ')}`,
          invariant: 'one name in one home',
          found: `the same name and the same value declared in `
            + `${String(packages.size)} packages: ${where}`,
          silently: 'they agree today. The first person to change one of them ships two answers '
            + 'under one name, and nothing anywhere fails',
          fix: 'declare it once in a shared package and import it',
        }),
      });
  }

  /* ── aliased: one number and one policy under two names ─────────────────

     A shared word is only evidence when it is DISCRIMINATING, and whether it
     is has to be read off the tree rather than guessed. `TIMEOUT` is carried by
     seventeen policy names here and `30000` is a common default, so
     `SSE_TIMEOUT_MS` and `CLONE_TIMEOUT_MS` share a word and a value and are
     plainly two unrelated decisions. `ATTEMPTS` at the value 8 is carried by
     exactly two: `MAX_SEND_ATTEMPTS` in cf-backend and `MAX_DELIVERY_ATTEMPTS`
     in core, which are one policy written twice.

     So the rule is: some shared word must identify EXACTLY THIS PAIR at this
     value. Two is not a threshold anyone chose — it is what a pair is. A crowd
     at one (word, value) means the number is a common default for that role,
     which is not a duplicated decision.

     Measured: without this, 23 findings of which 3 were real. With it, the
     three seed-list positives survive and the crowd is silent.                */
  const byValue = new Map<number, Declared[]>();
  for (const entry of declared) {
    if (!isPolicyName(entry.name)) continue;
    const bucket = byValue.get(entry.value);
    if (bucket) bucket.push(entry); else byValue.set(entry.value, [entry]);
  }
  for (const entries of byValue.values()) {
    const carriers = new Map<string, Declared[]>();
    for (const entry of entries) {
      for (const word of significantWords(entry.name)) {
        const bucket = carriers.get(word);
        if (bucket) bucket.push(entry); else carriers.set(word, [entry]);
      }
    }
    for (const [word, pair] of carriers) {
      if (pair.length !== 2) continue;
      const [a, b] = pair;
      if (a.name === b.name || packageOf(a.file) === packageOf(b.file)) continue;
      if (crossReferenced(a, b, sources)) continue;
      const [left, right] = a.file < b.file ? [a, b] : [b, a];
      const key = `aliased ${left.name}@${left.file} = ${right.name}@${right.file}`;
      if (drifts.some((d) => d.key === key)) continue;
      drifts.push({
        kind: 'aliased',
        key,
        detail: finding({
          at: `${left.name} — ${left.file}:${String(left.line)}`,
          invariant: 'one policy has one name',
          found: `${String(left.value)}, and ${right.name} at ${right.file}:${String(right.line)} `
            + `is the same number in a different package. \`${word}\` at this value names these `
            + `two declarations and nothing else in the tree, and neither file mentions the other`,
          silently: 'they drift. Changing one is invisible from the other, and the next reader '
            + 'has no way to learn the second copy exists',
          fix: 'import one from the other, or say in one of them why the other is separate — '
            + 'naming the counterpart anywhere in either file is enough, and is what '
            + 'CLOUD_MAX_INLINE_ATTACHMENT_BYTES does about its 8x-larger local twin',
        }),
      });
    }
  }

  /* ── unnamed: the same policy, written again with no name ───────────────

     A bare literal's role is one or two words, and a partial match on them is
     worthless: `setTimeout(…, 30000)` shares `TIMEOUT` with seventeen
     constants, `{ limit: 5 }` shares `LIMIT` with every cap in the tree. So the
     literal's role words must EQUAL a constant's, not overlap them —
     `{ cacheTtlMs: 60_000 }` against `CACHE_TTL_MS`, and nothing looser.

     Measured on this tree: 2,629 literals in a role position, 0 exact matches.
     That is the honest number and it is a stated blind spot rather than a
     silence: a partial-match version reported 12 and every one was two
     unrelated decisions that happened to pick the same round number.          */
  for (const literal of inline) {
    const owners = byValue.get(literal.value);
    if (owners === undefined) continue;
    const role = significantWords(wordsOfCamel(literal.role));
    if (!isPolicyName(wordsOfCamel(literal.role))) continue;
    const matching = owners.filter((candidate) => {
      if (packageOf(candidate.file) === packageOf(literal.file)) return false;
      const words = significantWords(candidate.name);
      return words.size === role.size && [...words].every((word) => role.has(word));
    });
    if (matching.length !== 1) continue;
    const [owner] = matching;
    drifts.push({
      kind: 'unnamed',
      key: `unnamed ${literal.file}:${literal.role}=${String(literal.value)}`,
      detail: finding({
        at: `${literal.file}:${String(literal.line)} — ${literal.role}: ${String(literal.value)}`,
        invariant: 'a policy number is declared once and imported, not retyped',
        found: `the same number is already ${owner.name} at ${owner.file}:${String(owner.line)}, `
          + `and no other policy constant in the tree holds it under this role`,
        silently: 'the named copy can be changed with every test still green, because this site '
          + 'never read it',
        fix: `import ${owner.name} here, or, if this site's number is its own policy, name it and `
          + 'say what makes it different',
      }),
    });
  }

  drifts.sort((a, b) => a.key.localeCompare(b.key));
  return { declared, inline, files: sources.size, drifts };
}

if (import.meta.main) {
  const survey = findDrift(readSources());
  const measured = assertMeasured('policy-drift', [
    ['source files', survey.files],
    ['named policy constants', survey.declared.length],
    ['numeric literals in a role position', survey.inline.length],
  ]);
  if (process.argv.includes('--lock')) {
    const count = writeLock(survey.drifts.map((d) => d.key), LOCK);
    console.log(`policy-drift: locked ${String(count)} duplication(s) — ${measured}`);
  } else {
    process.exit(report(
      'policy-drift',
      reconcile(survey.drifts.map((d) => d.key), LOCK),
      new Map(survey.drifts.map((d) => [d.key, d.detail])),
      'bun scripts/policy-drift.ts --lock',
      measured,
    ));
  }
}
