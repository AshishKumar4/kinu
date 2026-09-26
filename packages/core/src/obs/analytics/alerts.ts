
const HOUR_MS = 3_600_000;

export const ALERT_SIGNALS = [
  'wake_loop', 'platform_kill', 'provider_down', 'turn_failures', 'client_errors', 'stuck_effects',
] as const;

export type AlertSignal = (typeof ALERT_SIGNALS)[number];

/** docs/OBSERVABILITY.md. */
export const ALERT_THRESHOLDS = {
  startupsPerHour: 30,
  exceededMemory: 1,
  exceededWallTimeObjects: 3,
  providerDeniedPerHour: 5,
  providerErrorsPerHour: 100,
  turnFailedShare: 0.25,
  turnMinimum: 20,
  clientErrorsPerHour: 50,
  clientUnreadablePerHour: 5,
  effectFailuresPerHour: 60,
  effectsOwedPerHour: 1000,
} as const;

export interface StartupHour {
  readonly object: string;
  readonly hour: number;
  readonly startups: number;
}

export interface WakeLoop {
  readonly object: string;
  readonly startups: number;
  readonly peakPerHour: number;
  readonly loopHours: number;
  readonly longestRunHours: number;
  readonly firstLoopHour: number;
  readonly lastLoopHour: number;
  readonly sustained: boolean;
}

export function findWakeLoops(rows: readonly StartupHour[], threshold: number = ALERT_THRESHOLDS.startupsPerHour): WakeLoop[] {
  const byObject = new Map<string, Map<number, number>>();

  for (const row of rows) {
    const hours = byObject.get(row.object) ?? new Map<number, number>();
    const hour = Math.floor(row.hour / HOUR_MS) * HOUR_MS;
    hours.set(hour, (hours.get(hour) ?? 0) + row.startups);
    byObject.set(row.object, hours);
  }

  const loops: WakeLoop[] = [];

  for (const [object, hours] of byObject) {
    const ordered = [...hours.entries()].sort(([a], [b]) => a - b);
    const loopHours = ordered.filter(([, n]) => n >= threshold).map(([hour]) => hour);
    const [first] = loopHours;

    if (first === undefined) continue;
    let longest = 1;
    let run = 1;

    for (let i = 1; i < loopHours.length; i += 1) {
      run = (loopHours[i] ?? 0) - (loopHours[i - 1] ?? 0) === HOUR_MS ? run + 1 : 1;
      longest = Math.max(longest, run);
    }

    loops.push({
      object,
      startups: ordered.reduce((sum, [, n]) => sum + n, 0),
      peakPerHour: Math.max(...ordered.map(([, n]) => n)),
      loopHours: loopHours.length,
      longestRunHours: longest,
      firstLoopHour: first,
      lastLoopHour: loopHours.at(-1) ?? first,
      sustained: longest >= 2,
    });
  }

  return loops.sort((a, b) => b.loopHours - a.loopHours || b.peakPerHour - a.peakPerHour);
}

export interface FleetSample {
  readonly startups: readonly StartupHour[] | null;
  readonly events: readonly { readonly event: string; readonly code: string; readonly count: number }[] | null;
  readonly turns: { readonly settled: number; readonly failed: number } | null;
  readonly kills: { readonly exceededMemory: number; readonly exceededWallTimeObjects: number } | null;
}

export type SignalVerdict =
  | { readonly signal: AlertSignal; readonly state: 'ok' }
  | { readonly signal: AlertSignal; readonly state: 'crossed'; readonly detail: string }
  | { readonly signal: AlertSignal; readonly state: 'unconfigured' };

export function evaluateFleet(sample: FleetSample): SignalVerdict[] {
  return [
    wakeLoopVerdict(sample.startups),
    killVerdict(sample.kills),
    providerVerdict(sample.events),
    turnVerdict(sample.turns),
    clientVerdict(sample.events),
    effectsVerdict(sample.events),
  ];
}

function verdict(signal: AlertSignal, crossed: string | null): SignalVerdict {
  return crossed === null ? { signal, state: 'ok' } : { signal, state: 'crossed', detail: crossed };
}

function wakeLoopVerdict(rows: FleetSample['startups']): SignalVerdict {
  if (rows === null) return { signal: 'wake_loop', state: 'unconfigured' };
  const loops = findWakeLoops(rows).filter((loop) => loop.sustained);
  const [worst] = loops;

  return verdict('wake_loop', worst === undefined ? null
    : `${String(loops.length)} workspace(s) started ${String(ALERT_THRESHOLDS.startupsPerHour)}+ times an hour for 2 hours; `
      + `worst ${worst.object} at ${String(worst.peakPerHour)}/h`);
}

function killVerdict(kills: FleetSample['kills']): SignalVerdict {
  if (kills === null) return { signal: 'platform_kill', state: 'unconfigured' };
  const reasons: string[] = [];

  if (kills.exceededMemory >= ALERT_THRESHOLDS.exceededMemory) reasons.push(`${String(kills.exceededMemory)} out-of-memory kills`);

  if (kills.exceededWallTimeObjects >= ALERT_THRESHOLDS.exceededWallTimeObjects) {
    reasons.push(`${String(kills.exceededWallTimeObjects)} objects hit the wall-time limit`);
  }

  return verdict('platform_kill', reasons.length === 0 ? null : `in the last hour: ${reasons.join('; ')}`);
}

type EventRows = NonNullable<FleetSample['events']>;

function countOf(events: EventRows, event: string, code?: string): number {
  return events.filter((row) => row.event === event && (code === undefined || row.code === code)).reduce((sum, row) => sum + row.count, 0);
}

function providerVerdict(events: FleetSample['events']): SignalVerdict {
  if (events === null) return { signal: 'provider_down', state: 'unconfigured' };
  const denied = countOf(events, 'provider.error', 'denied');
  const all = countOf(events, 'provider.error');

  if (denied >= ALERT_THRESHOLDS.providerDeniedPerHour) return verdict('provider_down', `${String(denied)} provider calls refused credentials in the last hour`);

  return verdict('provider_down', all > ALERT_THRESHOLDS.providerErrorsPerHour ? `${String(all)} provider errors in the last hour` : null);
}

function turnVerdict(turns: FleetSample['turns']): SignalVerdict {
  if (turns === null) return { signal: 'turn_failures', state: 'unconfigured' };
  const share = turns.settled === 0 ? 0 : turns.failed / turns.settled;
  const crossed = turns.settled >= ALERT_THRESHOLDS.turnMinimum && share > ALERT_THRESHOLDS.turnFailedShare;

  return verdict('turn_failures', crossed ? `${String(turns.failed)} of ${String(turns.settled)} turns failed in the last hour` : null);
}

function clientVerdict(events: FleetSample['events']): SignalVerdict {
  if (events === null) return { signal: 'client_errors', state: 'unconfigured' };
  const unreadable = countOf(events, 'client.report_unreadable');
  const all = unreadable + countOf(events, 'client.render_failed') + countOf(events, 'client.chat_stream_failed');

  if (unreadable > ALERT_THRESHOLDS.clientUnreadablePerHour) return verdict('client_errors', `${String(unreadable)} browser reports were unreadable in the last hour`);

  return verdict('client_errors', all > ALERT_THRESHOLDS.clientErrorsPerHour ? `${String(all)} browser errors in the last hour` : null);
}

function effectsVerdict(events: FleetSample['events']): SignalVerdict {
  if (events === null) return { signal: 'stuck_effects', state: 'unconfigured' };
  const failed = countOf(events, 'turn.terminal_effect_failed');
  const owed = countOf(events, 'turn.terminal_effects_owed');

  if (failed > ALERT_THRESHOLDS.effectFailuresPerHour) return verdict('stuck_effects', `${String(failed)} terminal effects failed in the last hour`);

  return verdict('stuck_effects', owed > ALERT_THRESHOLDS.effectsOwedPerHour ? `terminal effects were owed ${String(owed)} times in the last hour` : null);
}

export interface SignalStreak {
  readonly crossed: number;
  readonly clean: number;
}

const ALERT_TICKS = 2;

export interface SettledSignal {
  readonly streak: SignalStreak;
  readonly failing: boolean;
}

export function settleSignal(streak: SignalStreak, tick: SignalVerdict, open: boolean): SettledSignal {
  if (tick.state === 'unconfigured') return { streak, failing: open };

  const next = tick.state === 'crossed'
    ? { crossed: streak.crossed + 1, clean: 0 }
    : { crossed: 0, clean: streak.clean + 1 };

  return { streak: next, failing: next.crossed >= ALERT_TICKS || (open && next.clean < ALERT_TICKS) };
}
