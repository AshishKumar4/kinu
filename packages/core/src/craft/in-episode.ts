/**
 * The in-episode fitness signal for crafted tools — what "better" MEANS when a
 * run is long, autonomous and unsupervised.
 *
 * Every other scoring path in this repo terminates in something a person
 * supplied: a follow-up message, a thumbs, an Alternate-Takes pick, a
 * correction. In the regime this module exists for — one prompt, hours of
 * agentic steps, nobody watching — none of those ever arrive, so the question
 * is not "how do we score faster" but "what is the ground truth at all".
 *
 * ── The evidence, graded ────────────────────────────────────────────────
 *
 * Ranked by how much a verdict from it is actually worth. Only the middle two
 * are wired here; the strong one has no production instance and the weak one
 * is deliberately not treated as if it did.
 *
 *   STRONG   An environment-supplied verifier the agent did not author — a
 *            repo's own test suite, a benchmark's grader. This is the only
 *            thing that can say the artifact did the RIGHT thing. Proteus has
 *            one in the sealed bench and NONE in production, because every
 *            command a production agent runs is a command it chose. Nothing
 *            here pretends otherwise.
 *   MEDIUM   `craftInvocationError` — the crafted tool RAISED when called.
 *            Direct, self-authenticating evidence about the artifact itself:
 *            an artifact that throws is broken whatever anyone believes about
 *            it, and the model cannot write this record, only provoke it.
 *   MEDIUM   Reuse — the tool was reached for again, in a LATER step than the
 *            one that created it, while the agent was pursuing an actual task.
 *            Still an agent choice, but no longer a free one: it costs a step.
 *            This is what accumulates over a long run, and it accumulates
 *            through the EMA + decay + injection-floor machinery that already
 *            exists (craft/ema.ts) rather than through a second score.
 *   WEAK     "The execute block that called it completed." Evidence that the
 *            call did not blow up; NOT evidence that it helped. Priced at the
 *            machine-evidence ceiling and no higher, and never credited to the
 *            block that created the tool (see below).
 *
 * ── What must not be gameable ───────────────────────────────────────────
 *
 * The agent authors the tool, calls the tool, and is the subject of the score.
 * Three structural properties keep that from being a self-certification:
 *
 *   1. The observation is taken at the HOST, from the runtime's own record of
 *      the call and how it settled — the same property `executionVerdict`
 *      leans on. No prose the model writes moves it.
 *   2. A tool gets no positive credit from the execute block that CREATED it.
 *      Create-then-call-once in one breath is a closed loop; the first credit
 *      a tool can earn comes from a later block reaching for it again. The
 *      asymmetry is deliberate: failures are self-authenticating, successes
 *      are not.
 *   3. The positive pole is capped strictly below what a human verdict
 *      reaches, so no volume of self-dealing lets a crafted tool outrank one a
 *      person actually approved.
 *
 * What this still cannot stop is an agent writing a tool that does nothing and
 * calling it twice. That buys it a high-scoring useless tool in its own
 * toolbox and nothing else: craft scores gate INJECTION, they are not a reward
 * anything optimizes against, and no scaffold, prompt or gate is promoted on
 * this channel. The blast radius of the worst case is one wasted slot.
 *
 * ── The ceiling, stated plainly ─────────────────────────────────────────
 *
 * Execution-grounded fitness measures "it ran and did not raise". It cannot
 * measure "it did the right thing". Going past that needs a verifier the agent
 * did not choose, and until one exists this signal must never be read as a
 * quality judgment — which is exactly why it feeds tool INJECTION and nothing
 * with a wider blast radius.
 */

import type { SqlExecutor } from '../types/primitives';
import { DEFAULT_CONFIG } from '../config';
import { nowMs } from '../utils/date';
import { filterByEffectiveScore, updateCraftScores } from './ema';
import { renderThrownChain } from '../obs/index';

/**
 * What one observed invocation of a crafted tool is worth.
 *
 * `returned` is the same ceiling machine evidence gets everywhere else
 * (evolution/outcomes.ts EXECUTION_QUALITY.accepted): the environment saying
 * the agent's own action completed can never be worth as much as a person
 * saying the work was right, so it sits strictly inside the user pole (0.9).
 *
 * `raised` is deliberately LOWER than the turn-level machine negative (0.3),
 * and the difference is what is being observed. A turn-level failure is a
 * proxy — something in a long turn broke, maybe not the part under test. A
 * raised crafted call is a direct fact about the artifact being scored: it was
 * invoked and it threw. Four such observations in a row take a freshly seeded
 * tool below the injection floor; one success pulls it most of the way back.
 * That is the whole retirement mechanism, and it is reachable only because
 * this pole is below the floor's asymptote.
 */
export const CRAFT_INVOCATION_QUALITY = { returned: 0.7, raised: 0.1 } as const;

/** The neutral prior a crafted tool is born with — the midpoint of the band
 *  above, i.e. "no evidence yet". Seeded at creation so the decay + floor
 *  machinery can see the tool at all: an unscored tool is exempt from the
 *  injection filter forever (craft/ema.ts), so a tool that never gets a row
 *  can never be retired however badly it behaves. */
export const CRAFT_NEUTRAL_PRIOR = 0.5;

/** Sandbox namespaces a crafted tool is callable through. Both backends bind
 *  the same object under both names — CF splices `const tools = {…}` into the
 *  sandbox arrow and seeds `codemode.<name>`; the CLI binds one crafted-tool
 *  record as both parameters. */
const CRAFT_NAMESPACES = ['tools', 'codemode'] as const;

/** A name that can be written as `<namespace>.<name>(`. Names that cannot are
 *  skipped rather than escaped: a crafted tool nobody can dot-call has no call
 *  sites to find, and refusing is also what keeps a stored name out of the
 *  regular expression this module builds. */
const DOT_CALLABLE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Comments and literal text blanked out, so a name that merely appears in prose
 * is not read as a call.
 *
 * The case that matters is real: `workspace.createTool(name, desc, code)`
 * passes a whole tool BODY as a string argument, and that body routinely calls
 * other crafted tools. Scanning the raw text would credit every tool named
 * inside it. Each removed span becomes a single space, so nothing that was
 * separated is joined.
 *
 * Template interpolations are kept, because `` `${await tools.f(x)}` `` is a
 * real call in a real idiom, and blanking the whole literal would lose it.
 *
 * Not a parser, and does not try to be: a regular-expression literal containing
 * an unbalanced quote is read as a string and swallows what follows it. That
 * direction is safe — the failure mode is a MISSED call site, never a
 * fabricated one.
 */
export function stripNonCode(source: string): string {
  const out: string[] = [];
  /** Brace depth inside each open `${ … }`, innermost last: a `}` at depth 0
   *  closes the interpolation and returns to the template's literal text. */
  const interpolations: number[] = [];
  let inTemplateText = false;
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (inTemplateText) {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { inTemplateText = false; out.push(' '); i++; continue; }
      if (c === '$' && source[i + 1] === '{') {
        interpolations.push(0);
        inTemplateText = false;
        out.push(' ');
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out.push(' ');
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      out.push(' ');
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
      out.push(' ');
      continue;
    }
    if (c === '`') { inTemplateText = true; out.push(' '); i++; continue; }
    if (interpolations.length > 0) {
      const depth = interpolations[interpolations.length - 1]!;
      if (c === '{') interpolations[interpolations.length - 1] = depth + 1;
      else if (c === '}') {
        if (depth === 0) {
          interpolations.pop();
          inTemplateText = true;
          out.push(' ');
          i++;
          continue;
        }
        interpolations[interpolations.length - 1] = depth - 1;
      }
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

/**
 * The crafted tools whose call sites appear in one `execute_tools` submission.
 *
 * Deterministic, host-side, no model asked. `known` is the set of crafted
 * tools that actually exist, so an arbitrary `tools.whatever()` matches
 * nothing.
 */
export function craftInvocationSites(code: string, known: readonly string[]): string[] {
  if (known.length === 0) return [];
  const source = stripNonCode(code);
  const namespaces = CRAFT_NAMESPACES.join('|');
  return known.filter((name) => {
    if (!DOT_CALLABLE.test(name)) return false;
    return new RegExp(`(?:^|[^\\w$.])(?:${namespaces})\\.${name}\\s*\\(`).test(source);
  });
}

/** The block asked for a tool of its own. The other half of the creation
 *  diff: the callable set can also grow from the detached turn-outcome
 *  review's own extraction, and only a block that CALLED for a tool is the
 *  agent crafting one mid-episode. Read after the same blanking pass, so a
 *  `workspace.createTool(` written inside a stored tool body does not count. */
export function craftCreatesTool(code: string): boolean {
  return /(?:^|[^\w$.])workspace\.createTool\s*\(/.test(stripNonCode(code));
}

/** The attribution stamp a crafted tool's failure carries out of the sandbox,
 *  so the host can tell "this artifact raised" from "the code around it did".
 *  Emitted by core's crafted-tool binding (tools/builtins.ts) and by the CF
 *  in-sandbox preamble (cf-backend/crafted-tool-registry.ts) — one format, and
 *  it is defined here because this module is the only thing that reads it. */
export function craftFailureMarker(name: string): string {
  return `[crafted:${name}]`;
}

/** Re-throw a crafted tool's failure with its identity attached. The original
 *  error rides as `cause`, so nothing about the diagnosis is lost — and the
 *  model sees WHICH crafted tool broke, which is the same information the
 *  score is taken from. */
export function craftInvocationError(name: string, cause: Error | string): Error {
  const message = renderThrownChain({ cause: cause });
  return new Error(`${craftFailureMarker(name)} ${message}`, { cause });
}

/**
 * Which of the tools called by a failing block are named as the thing that
 * raised. Attribution is by the stamp only: a block that failed for reasons of
 * its own blames NOBODY, because punishing an artifact for the code around it
 * is exactly the fabricated signal this whole channel exists to avoid.
 */
export function craftFailureBlame(failure: string, invoked: readonly string[]): string[] {
  return invoked.filter((name) => failure.includes(craftFailureMarker(name)));
}

/**
 * The durable half of the in-episode loop: what crafted tools exist right now,
 * and where an execution-grounded observation about one gets written.
 *
 * The EvolutionEngine owns the instance, exactly as it owns the session window
 * — the orchestrator decides WHEN an observation is taken, the engine owns the
 * ledger it lands in.
 */
export interface CraftLedger {
  /** Crafted tools callable right now, by name — the set both sandboxes bind,
   *  so it is the effective-score survivors and not the whole store. Read
   *  fresh: a tool created mid-turn is visible on the very next read, and a
   *  tool this turn's evidence retired is gone from it, which is what stops a
   *  later call site from scoring a tool the sandbox no longer offers. */
  names(): readonly string[];
  /** Record one execution-grounded observation against each named tool, and
   *  return the names whose time-decayed score has now fallen below the
   *  injection floor — i.e. the ones this turn's evidence just retired from
   *  the callable set. */
  observe(names: readonly string[], quality: number): readonly string[];
}

/**
 * Give a freshly crafted tool its neutral prior, at the moment it is created.
 *
 * Without a row a tool is exempt from the injection filter FOREVER (an
 * unscored tool passes by design, so a new one gets a chance to earn a score),
 * which meant the agent's own `workspace.createTool` path produced tools that
 * could never decay and could never be retired however badly they behaved.
 * `OR IGNORE` because an upsert of an existing tool must never wipe what that
 * tool has earned. Bookkeeping the store owes itself, so it is unconditional
 * — it is not scored, and nothing about it is an evolution decision.
 */
export function seedCraftScore(sql: SqlExecutor, name: string, now = nowMs()): void {
  void sql`INSERT OR IGNORE INTO craft_scores (tool_name, score, uses, last_used_at)
      VALUES (${name}, ${CRAFT_NEUTRAL_PRIOR}, 0, ${now})`;
}

/** Structural deps — deliberately not `AgentRuntime`: this module is a leaf
 *  and the ledger needs exactly two things. */
export interface CraftLedgerDeps {
  craftStore: { list(): ReadonlyArray<{ name: string }> };
  sql: SqlExecutor;
}

export function createCraftLedger(deps: CraftLedgerDeps): CraftLedger {
  const floor = DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection;
  return {
    names() {
      // The ONE injection policy, so the observer's idea of what is callable
      // cannot drift from what the sandboxes actually bind.
      return filterByEffectiveScore(deps.sql, deps.craftStore.list(), floor).map((t) => t.name);
    },
    observe(names, quality) {
      if (names.length === 0) return [];
      updateCraftScores(deps.sql, [...names], quality);
      // The ONE injection policy, asked the question it already answers:
      // whatever it no longer passes is what this observation just retired.
      const surviving = new Set(
        filterByEffectiveScore(deps.sql, names.map((name) => ({ name })), floor, nowMs())
          .map((t) => t.name),
      );
      return names.filter((name) => !surviving.has(name));
    },
  };
}
