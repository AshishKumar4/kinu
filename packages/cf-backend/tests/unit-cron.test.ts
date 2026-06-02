// nextCronFire — minimal cron next-fire (every-n-minutes + daily), UTC.
import { describe, test, expect } from "bun:test";
import { nextCronFire } from "../src/lib/cron";

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
