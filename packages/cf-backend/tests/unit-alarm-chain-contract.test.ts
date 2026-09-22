// The Durable Object alarm chain is a single slot the agents SDK owns, and breaking it fails silently.
// Source-shaped guards: a subclass that omits super.alarm() is a well-formed program no behaviour test sees.
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

/** `alarm` declarations (method or class-field arrow) in declaration position only, with bodies. */
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

/** Comments and strings must not satisfy the guard. */
function stripCommentsAndStrings(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ');
}

const sources = tsSources(SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

/**
 * Classes whose alarm slot the Agents SDK owns: `_scheduleNextAlarm()` deletes alarms it does not recognise.
 * A plain `DurableObject` (e.g. `DeployRunDO`) owns its slot; the exemption is pinned by equality below.
 */
const SDK_HOSTED = /\bextends\s+(?:Agent|AIChatAgent|Think|ActorAgent|OrchestratorAgent)\b/u;

const hosted = sources.filter(({ text }) => SDK_HOSTED.test(text));

const OWN_SLOT_FILES: readonly string[] = ['deploy/deploy-do.ts'];

const under = (path: string): string => path.slice(SRC.length + 1);

describe('DO alarm chain', () => {
  test('the governed set is every Agents-SDK subclass, and the exemptions are named', () => {
    const writers = sources
      .filter(({ text }) => /\.\s*(?:setAlarm|deleteAlarm)\s*\(/u.test(text))
      .map(({ path }) => under(path));

    expect(hosted.length).toBeGreaterThan(0);
    expect(writers.filter((path) => !OWN_SLOT_FILES.includes(path))).toEqual([]);
    expect(writers).toEqual([...OWN_SLOT_FILES]);
  });

  test('no Agent subclass defines alarm() without calling super.alarm()', () => {
    const broken = hosted.flatMap(({ path, text }) =>
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
    const field = `class Bad extends Agent<Env> {\n  alarm = async (): Promise<void> => {\n    doWork();\n  };\n}`;
    expect(alarmMethods(field)).toHaveLength(1);
    expect(alarmMethods(field)[0]).not.toContain('super.alarm(');
    expect(alarmMethods(`this.ctx.storage.setAlarm(ts);\nthis.alarm.scheduleAt(ts);`)).toEqual([]);
  });

  test('nothing writes the alarm slot of an object the SDK schedules', () => {
    // _scheduleNextAlarm() deletes unrecognised alarms; all Kinu wakes go through cf_agents_schedules.
    const direct = hosted
      .filter(({ text }) => /\.\s*(?:setAlarm|deleteAlarm)\s*\(/u.test(text))
      .map(({ path }) => under(path));

    expect(direct).toEqual([]);
  });
});

describe('the Kinu timer rides the SDK scheduler', () => {
  const orchestrator = readFileSync(join(SRC, 'orchestrator.ts'), 'utf8');

  test('trigger, peer-outbox and email-outbox wakes all arm the one timer row, awaited', () => {
    // `waitUntil` is a no-op in a Durable Object, so a waitUntil-wrapped arm could be lost to eviction silently.
    expect(orchestrator).toContain('scheduleAt: (ts: number) => this.armTimer(ts)');
    expect(orchestrator).toContain('scheduleDispatch: (at) => this.armTimer(at)');
    expect(orchestrator).toContain('new EmailOutbox(this.ctx.storage.sql, (at) => this.armTimer(at))');
    expect(orchestrator).not.toContain('scheduleTimerAt');
    expect(orchestrator).not.toContain('this.ctx.waitUntil(');
    expect(orchestrator).toContain('await this.armWakeRow(KINU_TIMER_CALLBACK, atMs)');
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
    // Behaviour pinned in unit-alarm-wake-chain.test.ts; this guards against a second bespoke collapse.
    expect(orchestrator).not.toContain('await this.schedule(new Date(');
  });

  test('the stale sweep spares recurring rows and exempts the Kinu wake', () => {
    // Activation is behavioural in unit-alarm-wake-chain.test.ts; only the sweep's shape is guarded here.
    const sweep = orchestrator.slice(
      orchestrator.indexOf('private sweepUnrunnableSchedules('),
      orchestrator.indexOf('protected get engine()'),
    );

    expect(sweep).toContain("type IN ('delayed', 'scheduled')");
    expect(sweep).toContain('STALE_SCHEDULE_HORIZON_MS');
    // Dropping a state-driven wake row stops its work; running one late costs one tick (KINU-N027). Exempt: the
    // Kinu timer and the terminal retry, whose effect ledger never expires and may belong to a facet.
    expect(sweep).toContain('callback NOT IN (?, ?)');
    expect(sweep).toContain('KINU_TIMER_CALLBACK');
    expect(sweep).toContain('TERMINAL_RETRY_CALLBACK');
  });

  // A mention is not a call.
  test('a comment or string mentioning super.alarm() does not satisfy the guard', () => {
    const commented = `class Bad extends Agent<Env> {\n  async alarm() {\n    // deliberately no super.alarm()\n    doWork();\n  }\n}`;
    const stringy = `class Bad2 extends Agent<Env> {\n  async alarm() {\n    log("call super.alarm() next time");\n  }\n}`;

    for (const source of [commented, stringy]) {
      const [body] = alarmMethods(source);
      expect(body).toBeDefined();
      expect(/\bsuper\s*\.\s*alarm\s*\(/.test(stripCommentsAndStrings(body))).toBe(false);
    }

    const real = `class Good extends Agent<Env> {\n  async alarm() {\n    await super.alarm(); // chained\n  }\n}`;
    const [goodBody] = alarmMethods(real);
    expect(/\bsuper\s*\.\s*alarm\s*\(/.test(stripCommentsAndStrings(goodBody))).toBe(true);
  });
});
