// nextCronFire — minimal cron next-fire (every-n-minutes + daily), UTC.
// nextAlarmTime — the alarm-reschedule fold (triggers ∪ peer-outbox retry).
import { describe, test, expect } from "bun:test";
import { nextAlarmTime, nextCronFire } from "../src/lib/cron";

// A fixed UTC base: 2026-06-02T10:17:30Z
const BASE = Date.UTC(2026, 5, 2, 10, 17, 30);

describe("nextCronFire", () => {
  test("every-15-minutes rolls to the next quarter", () => {
    const next = nextCronFire("*/15 * * * *", BASE)!;
    expect(new Date(next).toISOString()).toBe("2026-06-02T10:30:00.000Z");
  });

  test("every-n-minutes rolls the hour over at the boundary", () => {
    const at = Date.UTC(2026, 5, 2, 10, 50, 0);
    const next = nextCronFire("*/20 * * * *", at)!;
    expect(new Date(next).toISOString()).toBe("2026-06-02T11:00:00.000Z");
  });

  test("daily at hh:mm — later today", () => {
    const next = nextCronFire("30 14 * * *", BASE)!;
    expect(new Date(next).toISOString()).toBe("2026-06-02T14:30:00.000Z");
  });

  test("daily at hh:mm — already passed today → tomorrow", () => {
    const next = nextCronFire("0 9 * * *", BASE)!;
    expect(new Date(next).toISOString()).toBe("2026-06-03T09:00:00.000Z");
  });

  test("malformed / unsupported expressions → null", () => {
    expect(nextCronFire("not a cron", BASE)).toBeNull();
    expect(nextCronFire("* * *", BASE)).toBeNull();
    expect(nextCronFire("*/0 * * * *", BASE)).toBeNull();
  });
});

describe("nextAlarmTime", () => {
  test("a due/past-due peer retry is clamped to now, never dropped", () => {
    expect(nextAlarmTime(1_000, [], 400)).toBe(1_000);
    expect(nextAlarmTime(1_000, [], 1_000)).toBe(1_000);
  });

  test("future triggers and the peer retry compete; soonest wins", () => {
    expect(nextAlarmTime(1_000, [5_000, 3_000], 4_000)).toBe(3_000);
    expect(nextAlarmTime(1_000, [5_000], 2_000)).toBe(2_000);
    // A past-due retry outranks every future trigger (fires immediately).
    expect(nextAlarmTime(1_000, [5_000], 500)).toBe(1_000);
  });

  test("past-due/absent trigger times are excluded; nothing pending → null", () => {
    expect(nextAlarmTime(1_000, [900, null, undefined], null)).toBeNull();
    expect(nextAlarmTime(1_000, [], null)).toBeNull();
  });
});
