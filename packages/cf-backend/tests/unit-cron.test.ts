import { describe, test, expect } from "bun:test";
import { nextAlarmTime, nextCronFire } from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';

const BASE = Date.UTC(2026, 5, 2, 10, 17, 30);

describe("nextCronFire", () => {
  const fires = [
    { name: "every-15-minutes rolls to the next quarter", spec: "*/15 * * * *", from: BASE, at: "2026-06-02T10:30:00.000Z" },
    { name: "every-n-minutes rolls the hour over at the boundary", spec: "*/20 * * * *", from: Date.UTC(2026, 5, 2, 10, 50, 0), at: "2026-06-02T11:00:00.000Z" },
    { name: "daily at hh:mm — later today", spec: "30 14 * * *", from: BASE, at: "2026-06-02T14:30:00.000Z" },
    { name: "daily at hh:mm — already passed today → tomorrow", spec: "0 9 * * *", from: BASE, at: "2026-06-03T09:00:00.000Z" },
  ];

  for (const c of fires) {
    test(c.name, () => {
      const next = present(nextCronFire(c.spec, c.from), `the next fire of ${c.spec}`);

      expect(new Date(next).toISOString()).toBe(c.at);
    });
  }

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
    expect(nextAlarmTime(1_000, [5_000], 500)).toBe(1_000);
  });

  test("past-due/absent trigger times are excluded; nothing pending → null", () => {
    expect(nextAlarmTime(1_000, [900, null, undefined], null)).toBeNull();
    expect(nextAlarmTime(1_000, [], null)).toBeNull();
  });
});
