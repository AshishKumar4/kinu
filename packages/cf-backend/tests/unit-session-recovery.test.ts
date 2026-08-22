import { afterEach, describe, expect, test } from "bun:test";
import {
  createSessionRecovery,
  fetchDeployedBuildSha,
  isNewerDeployedBuild,
} from "../src/hooks/session-recovery";

function timeoutError(method = "getWorkspaceSnapshot", ms = 30_000): Error {
  return new Error(`RPC call to ${method} timed out after ${ms}ms`);
}

const MIN_REDIAL_INTERVAL_MS = 15_000;
const MAX_REDIAL_INTERVAL_MS = 60_000;

type RpcFailureInput = Error | string | undefined;

/** A controller over a fake clock, recording what it ordered. */
interface Harness {
  redials(): number;
  refetches(): number;
  advance(ms: number): void;
  openSocket(isFirstForSession?: boolean): void;
  failTimeout(socketOpen?: boolean): void;
  failFast(): void;
  fail(error: RpcFailureInput): void;
  succeed(): void;
  retryManually(forceRedial?: boolean): void;
}

function harness(options: {
  timeoutsToRedial?: number;
  minRedialIntervalMs?: number;
  maxRedialIntervalMs?: number;
} = {}): Harness {
  let clockMs = 1_000_000;
  let redialCount = 0;
  let refetchCount = 0;
  const recovery = createSessionRecovery(
    { refetch: () => { refetchCount += 1; }, forceRedial: () => { redialCount += 1; } },
    {
      now: () => clockMs,
      timeoutsToRedial: options.timeoutsToRedial,
      minRedialIntervalMs: options.minRedialIntervalMs,
      maxRedialIntervalMs: options.maxRedialIntervalMs,
    },
  );
  return {
    redials: () => redialCount,
    refetches: () => refetchCount,
    advance(ms: number) { clockMs += ms; },
    openSocket(isFirstForSession = false) { recovery.socketOpened(isFirstForSession); },
    failTimeout(socketOpen = true) { recovery.rpcFailed(timeoutError(), socketOpen); },
    failFast() { recovery.rpcFailed(new Error("Connection closed"), true); },
    fail(error: RpcFailureInput) { recovery.rpcFailed(error, true); },
    succeed() { recovery.rpcSucceeded(); },
    retryManually(forceRedial = false) { recovery.manualRetry(forceRedial); },
  };
}

describe("timeout classification through the recovery controller", () => {
  test("only the agents SDK's verbatim timeout rejection condemns the socket", () => {
    const timedOut = harness({ timeoutsToRedial: 1 });
    timedOut.fail(timeoutError("listBackgroundJobs", 5_000));
    expect(timedOut.redials()).toBe(1);

    for (const error of [
      new Error("Network connection lost."),
      new Error("Connection closed"),
      new Error("RPC call to x timed out eventually"),
      "RPC call to x timed out after 30000ms",
      undefined,
    ]) {
      const answered = harness({ timeoutsToRedial: 1 });
      answered.fail(error);
      expect(answered.redials()).toBe(0);
    }
  });
});

describe("the corpse detector", () => {
  test(`${3} consecutive timeouts while the socket claims OPEN force one redial`, () => {
    const h = harness();
    h.failTimeout();
    h.failTimeout();
    expect(h.redials()).toBe(0);
    h.failTimeout();
    expect(h.redials()).toBe(1);
  });

  test("a success between timeouts restores trust — sporadic slow calls never redial", () => {
    const h = harness();
    for (let round = 0; round < 4; round += 1) {
      h.failTimeout();
      h.succeed();
    }
    expect(h.redials()).toBe(0);
  });

  test("a fast rejection is proof of life and resets the streak", () => {
    const h = harness();
    h.failTimeout();
    h.failTimeout();
    h.failFast();
    h.failTimeout();
    h.failTimeout();
    expect(h.redials()).toBe(0);
  });

  test("timeouts on a socket that admits it is closed do not feed the detector", () => {
    const h = harness();
    for (let i = 0; i < 6; i += 1) h.failTimeout(false);
    expect(h.redials()).toBe(0);
  });

  test("a streak spread wider than the outage window never condemns the transport", () => {
    const h = harness();
    h.failTimeout();
    h.advance(60_000);
    h.failTimeout();
    h.advance(60_000);
    h.failTimeout();
    expect(h.redials()).toBe(0);
  });
});

describe("redial spacing", () => {
  test("a still-dead origin is re-probed at growing intervals, not hammered", () => {
    const h = harness({ minRedialIntervalMs: MIN_REDIAL_INTERVAL_MS });
    // First condemnation.
    h.failTimeout(); h.failTimeout(); h.failTimeout();
    expect(h.redials()).toBe(1);
    // Immediately after: nine more timeouts inside the minimum spacing → no second dial yet.
    for (let i = 0; i < 9; i += 1) h.failTimeout();
    expect(h.redials()).toBe(1);
    // Past the doubled interval (15s → 30s), the next condemnation dials again.
    h.advance(MIN_REDIAL_INTERVAL_MS * 2);
    h.failTimeout(); h.failTimeout(); h.failTimeout();
    expect(h.redials()).toBe(2);
    // Growth caps at 60s even as outages persist.
    h.advance(MAX_REDIAL_INTERVAL_MS + 1);
    h.failTimeout(); h.failTimeout(); h.failTimeout();
    expect(h.redials()).toBe(3);
  });

  test("close rejections from a forced redial do not erase its growing spacing", () => {
    const h = harness({ minRedialIntervalMs: MIN_REDIAL_INTERVAL_MS });
    h.failTimeout(); h.failTimeout(); h.failTimeout();
    expect(h.redials()).toBe(1);
    h.failTimeout(false);
    h.failTimeout(); h.failTimeout(); h.failTimeout();
    expect(h.redials()).toBe(1);
    h.advance(MIN_REDIAL_INTERVAL_MS * 2);
    h.failTimeout(); h.failTimeout(); h.failTimeout();
    expect(h.redials()).toBe(2);
  });

  test("one success after a redial restores the base spacing", () => {
    const h = harness({ minRedialIntervalMs: MIN_REDIAL_INTERVAL_MS });
    h.failTimeout(); h.failTimeout(); h.failTimeout();
    expect(h.redials()).toBe(1);
    h.succeed();
    h.failTimeout(); h.failTimeout(); h.failTimeout();
    expect(h.redials()).toBe(2);
  });
});

describe("refetch on reconnect", () => {
  test("every non-initial open re-fetches; the first open leaves loading to the mount effect", () => {
    const h = harness();
    h.openSocket(true);
    expect(h.refetches()).toBe(0);
    h.openSocket(false);
    h.openSocket(false);
    expect(h.refetches()).toBe(2);
  });

  test("manual retry refetches", () => {
    const h = harness();
    h.retryManually();
    expect(h.refetches()).toBe(1);
  });

  test("manual retry can redial a terminally closed route before refetching", () => {
    const h = harness();
    h.retryManually(true);
    expect(h.redials()).toBe(1);
    expect(h.refetches()).toBe(1);
  });
});

/* ── version-skew signal ────────────────────────────────────────────────────── */

const realFetch = globalThis.fetch;

function installFetchStub(answer: () => Promise<Response>): void {
  const stub: typeof fetch = () => answer();
  stub.preconnect = () => {};
  globalThis.fetch = stub;
}

async function withHealthEndpoint(body: string, status: number, run: () => Promise<void>): Promise<void> {
  installFetchStub(() => Promise.resolve(new Response(body, { status })));
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchDeployedBuildSha", () => {
  test("reads the build sha off the public health body", async () => {
    const body = JSON.stringify({ ok: true, build: { version: "1", sha: " abc123 ", builtAt: "t" } });
    await withHealthEndpoint(body, 200, async () => {
      expect(await fetchDeployedBuildSha()).toBe("abc123");
    });
  });

  test("null when the deployment carries no stamp or the answer is unusable", async () => {
    for (const [body, status] of [
      [JSON.stringify({ ok: true, build: null }), 200],
      [JSON.stringify({ ok: true }), 200],
      ["<html>SPA fallback</html>", 500],
    ] as const) {
      await withHealthEndpoint(body, status, async () => {
        expect(await fetchDeployedBuildSha()).toBeNull();
      });
    }
  });

  test("a genuine transport breakage propagates — silence must not eat it", async () => {
    installFetchStub(() => Promise.reject(new Error("socket hung up")));
    expect(fetchDeployedBuildSha()).rejects.toThrow("socket hung up");
  });
});

describe("isNewerDeployedBuild", () => {
  test("only two identified shas can disagree", () => {
    expect(isNewerDeployedBuild("aaa", "bbb")).toBe(true);
    expect(isNewerDeployedBuild("aaa", "aaa")).toBe(false);
    expect(isNewerDeployedBuild(null, "bbb")).toBe(false);
    expect(isNewerDeployedBuild("aaa", null)).toBe(false);
    expect(isNewerDeployedBuild(null, null)).toBe(false);
  });
});
