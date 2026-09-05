// The Durable Object alarm chain is a single-slot resource the agents SDK
// owns, and breaking it fails silently — no error, no log, just scheduled
// callbacks, fiber recovery and the keepAlive heartbeat quietly never running.
// That is exactly how OrchestratorAgent.alarm() sat shadowing Agent.alarm()
// for two months. These are source-shaped guards because the failure lives in
// the shape of the code, not in any value a behaviour test could observe:
// a subclass that simply *omits* super.alarm() is a well-formed program.
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');

function tsSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsSources(path));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(path);
  }
  return out;
}

/** Declarations named `alarm`, with their bodies — both the method form and
 *  the class-field arrow form, which shadows just as effectively. Matches the
 *  declaration position only, so `this.alarm.scheduleAt(...)` and
 *  `storage.setAlarm(...)` are not mistaken for one. */
function alarmMethods(source: string): string[] {
  const declaration = /^[ \t]*(?:(?:public|protected|private|override|static|readonly|async)[ \t]+)*alarm[ \t]*(?:\([^)]*\)[^{;]*|=[^;{]*)\{/gm;
  const bodies: string[] = [];
  for (const match of source.matchAll(declaration)) {
    let depth = 0;
    const start = match.index + match[0].length - 1;
    for (let i = start; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) {
        bodies.push(source.slice(start, i + 1));
        break;
      }
    }
  }
  return bodies;
}

/** Comments and string literals must not satisfy the guard — a body whose only
 *  mention of the call is `// no super.alarm() here` is still a shadow. */
function stripCommentsAndStrings(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ');
}

const sources = tsSources(SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

describe('DO alarm chain', () => {
  test('no Agent subclass defines alarm() without calling super.alarm()', () => {
    const broken = sources.flatMap(({ path, text }) =>
      alarmMethods(text)
        .filter((body) => !/\bsuper\s*\.\s*alarm\s*\(/.test(stripCommentsAndStrings(body)))
        .map(() => path),
    );
    expect(broken).toEqual([]);
  });

  test('the guard actually catches a shadowed alarm()', () => {
    const shadowed = `class Bad extends Agent<Env> {\n  async alarm() {\n    doWork();\n  }\n}`;
    const chained = `class Good extends Agent<Env> {\n  async alarm(): Promise<void> {\n    await super.alarm();\n    doWork();\n  }\n}`;
    expect(alarmMethods(shadowed)).toHaveLength(1);
    expect(alarmMethods(shadowed)[0]).not.toContain('super.alarm(');
    expect(alarmMethods(chained)[0]).toContain('super.alarm(');
    // The class-field arrow form shadows just as well, so it counts too.
    const field = `class Bad extends Agent<Env> {\n  alarm = async (): Promise<void> => {\n    doWork();\n  };\n}`;
    expect(alarmMethods(field)).toHaveLength(1);
    expect(alarmMethods(field)[0]).not.toContain('super.alarm(');
    // Call sites that merely mention "alarm" are not declarations.
    expect(alarmMethods(`this.ctx.storage.setAlarm(ts);\nthis.alarm.scheduleAt(ts);`)).toEqual([]);
  });

  test('nothing writes the DO alarm slot behind the SDK', () => {
    // A DO has one alarm slot and _scheduleNextAlarm() deletes any alarm it
    // does not recognise, so a direct write and the SDK scheduler silently
    // destroy each other. All Kinu wakes go through cf_agents_schedules.
    const direct = sources
      .filter(({ text }) => /\.\s*(?:setAlarm|deleteAlarm)\s*\(/.test(text))
      .map(({ path }) => path);
    expect(direct).toEqual([]);
  });
});

describe('the Kinu timer rides the SDK scheduler', () => {
  const orchestrator = readFileSync(join(SRC, 'orchestrator.ts'), 'utf8');

  test('trigger, peer-outbox and email-outbox wakes all arm the one timer row, awaited', () => {
    // The three seams hand `armTimer` straight to their consumer, which awaits it.
    // They used to go through a void-returning `scheduleTimerAt` that passed the
    // promise to `ctx.waitUntil` — a no-op in a Durable Object, so the arm of the
    // object's OWN wake-up could be cancelled by an eviction and nothing would say
    // so. A void-returning wrapper here is the defect, hence the negative assertion.
    expect(orchestrator).toContain('scheduleAt: (ts: number) => this.armTimer(ts)');
    expect(orchestrator).toContain('scheduleDispatch: (at) => this.armTimer(at)');
    expect(orchestrator).toContain('new EmailOutbox(this.ctx.storage.sql, (at) => this.armTimer(at))');
    expect(orchestrator).not.toContain('scheduleTimerAt');
    expect(orchestrator).not.toContain('this.ctx.waitUntil(');
    expect(orchestrator).toContain('return this.armWakeRow(KINU_TIMER_CALLBACK, atMs)');
    expect(orchestrator).toContain("const KINU_TIMER_CALLBACK = '_kinuTimerTick'");
    expect(orchestrator).toContain('async _kinuTimerTick(): Promise<void>');
  });

  test('the tick closes the chain by re-arming, awaited', () => {
    const tick = orchestrator.slice(
      orchestrator.indexOf('async _kinuTimerTick(): Promise<void>'),
      orchestrator.indexOf('/** Compute the next firing time for a cron expression'),
    );
    expect(tick).toContain('if (next !== null) await this.armTimer(next)');
  });

  test('the arm collapses in ONE place, through the shared primitive', () => {
    // The rounding, the due-row exclusion and the earliest-wins collapse are
    // pinned behaviourally in unit-alarm-wake-chain.test.ts ('an armed wake is
    // left alone, however overdue', 'a due row is not counted as armed', 'two
    // concurrent arms converge on ONE wake row'). What no behaviour test can
    // see is a second bespoke collapse beside the shared one, so this guard
    // keeps the orchestrator delegating rather than re-deriving.
    expect(orchestrator).not.toContain('await this.schedule(new Date(');
  });

  test('the stale sweep spares recurring rows and exempts the Kinu wake', () => {
    // The activation half of this contract runs behaviourally in
    // unit-alarm-wake-chain.test.ts: the backlog drains across maintenance
    // wakes through activateActor, and a lost wake row comes back through the
    // same entry point. What remains here is the sweep's own shape.
    const sweep = orchestrator.slice(
      orchestrator.indexOf('private sweepUnrunnableSchedules('),
      orchestrator.indexOf('protected get engine()'),
    );
    expect(sweep).toContain("type IN ('delayed', 'scheduled')");
    expect(sweep).toContain('STALE_SCHEDULE_HORIZON_MS');
    // Dropping a row a STATE-driven wake rides stops the work it carries; running
    // one late costs a single immediate tick (KINU-N027). Two are exempt: the
    // Kinu timer, and the terminal retry whose obligation is whatever the effect
    // ledger still holds — which does not expire, and which a root activation
    // cannot even read when the row belongs to a facet.
    expect(sweep).toContain('callback NOT IN (?, ?)');
    expect(sweep).toContain('KINU_TIMER_CALLBACK');
    expect(sweep).toContain('TERMINAL_RETRY_CALLBACK');
  });

  // The first sabotage attempt on this guard passed only because the injected
  // body carried the comment `// deliberately no super.alarm()`. A mention is
  // not a call.
  test('a comment or string mentioning super.alarm() does not satisfy the guard', () => {
    const commented = `class Bad extends Agent<Env> {\n  async alarm() {\n    // deliberately no super.alarm()\n    doWork();\n  }\n}`;
    const stringy = `class Bad2 extends Agent<Env> {\n  async alarm() {\n    log("call super.alarm() next time");\n  }\n}`;
    for (const source of [commented, stringy]) {
      const [body] = alarmMethods(source);
      expect(body).toBeDefined();
      expect(/\bsuper\s*\.\s*alarm\s*\(/.test(stripCommentsAndStrings(body!))).toBe(false);
    }
    const real = `class Good extends Agent<Env> {\n  async alarm() {\n    await super.alarm(); // chained\n  }\n}`;
    const [goodBody] = alarmMethods(real);
    expect(/\bsuper\s*\.\s*alarm\s*\(/.test(stripCommentsAndStrings(goodBody!))).toBe(true);
  });
});
