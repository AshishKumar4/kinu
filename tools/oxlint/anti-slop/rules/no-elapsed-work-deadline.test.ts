// Kinu-local rule. The repository-level historical replay, live denominator, and isolated
// red-to-green Oxlint proof are in ../no-elapsed-deadline.gate.test.ts.
import { RuleTester } from "oxlint/plugins-dev";

import {
  BRANCH_PROCESS_SOURCE,
  noElapsedWorkDeadlineRule,
} from "./no-elapsed-work-deadline.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const armError = { messageId: "elapsedDeadlineArm" };
const raceError = { messageId: "elapsedRaceSignal" };

const production = BRANCH_PROCESS_SOURCE;
const llmSource = "packages/core/src/providers/anthropic.ts";
const testHelper = "packages/core/src/providers/fixture.test.ts";

tester.run("anti-slop/no-elapsed-work-deadline", noElapsedWorkDeadlineRule, {
  valid: [
    // A resolving timer bounds a wait but does not terminate the pending work.
    {
      code: "const timeout = new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), ms));",
      filename: production,
    },
    { code: "setTimeout(poll.resolve, LOCK_POLL_MS);", filename: production },
    { code: "setTimeout(() => resolve('idle'), graceMs);", filename: production },
    {
      code: "setTimeout(() => { overran = true; onLate({ cause }); }, budgetMs);",
      filename: production,
    },
    { code: "setInterval(() => this.probeLiveness(), this.probeMs);", filename: production },
    {
      code: "setInterval(() => { void refreshLiveData(); }, LIVE_DATA_REFRESH_MS);",
      filename: production,
    },
    {
      code: "await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));",
      filename: production,
    },
    {
      code: "setTimeout(() => { killedByTimeout = true; proc.kill(); }, timeoutMs);",
      filename: production,
    },

    // Both no-timer alternatives invoke an ending in the timer arm. They stay valid only because
    // the same delay value selects an unbounded alternative; changing the structural exemption
    // makes these fixtures red.
    {
      code: `function callWithOptIn(deadline: number): void {
  if (deadline > 0) {
    setTimeout(() => reject(new Error('caller-selected deadline')), deadline);
  }
}
`,
      filename: production,
    },
    {
      code: `async function raceWithTimeout(
  h: { run(): Promise<string>; abort(reason: string): Promise<void> },
  timeoutMs: number | undefined,
): Promise<string> {
  if (timeoutMs === undefined) return h.run();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      void h.abort('budget exhausted');
      reject(new Error('wall-clock budget exceeded'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([h.run(), timeout]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
`,
      filename: production,
    },
    {
      code: "const timeout = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new Error('elapsed')), timeoutMs);",
      filename: production,
    },

    // The only branch-process exception is its complete child readiness handshake. The message
    // listener resolves on `ready`; child error and exit listeners both clear the timer and reject.
    {
      code: `async function waitForChildReady(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Branch worker startup timeout')), 30_000);
    const handler = (msg: { method: string }) => {
      if (msg.method === 'ready') {
        clearTimeout(timeout);
        child.off('message', handler);
        resolve();
      }
    };
    child.on('message', handler);
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code) => {
      if (code !== 0) { clearTimeout(timeout); reject(new Error('Branch worker exited')); }
    });
  });
}
`,
      filename: production,
    },

    // A bounded I/O wait is not an elapsed arm raced against work.
    {
      code: "await fetch(url, { signal: AbortSignal.timeout(10_000) });",
      filename: production,
    },
    {
      code: "const probe = await rawExec(cmd, { signal: AbortSignal.timeout(portWaitMs) });",
      filename: production,
    },
    {
      code: "const expiry = AbortSignal.timeout(ms); const winner = await Promise.race([work, expiry]);",
      filename: production,
    },
    { code: "await Promise.race([settled, timeout]);", filename: production },

    // A `.test` suffix remains test provisioning even when it sits below an LLM source root.
    {
      code: "setTimeout(() => reject(new Error('fixture timeout')), 30);",
      filename: testHelper,
    },
    {
      code: "await Promise.race([work, AbortSignal.timeout(50)]);",
      filename: testHelper,
    },

    // These production timeout contracts are transport, scripts, or process liveness. They are
    // deliberately outside the policy's work-path scope.
    {
      code: "setTimeout(() => controller.abort(new Error('web HTTP timeout')), timeoutMs);",
      filename: "packages/core/src/web/provider.ts",
    },
    {
      code: "setTimeout(() => reject(new Error('cloud WebSocket connect timeout')), timeoutMs);",
      filename: "packages/cli/src/cloud-agent-client.ts",
    },
    {
      code: "setTimeout(() => controller.abort(new Error('version HTTP timeout')), timeoutMs);",
      filename: "packages/cli/src/version-check.ts",
    },
    {
      code: "setTimeout(() => reject(new Error('liveness capture timeout')), timeoutMs);",
      filename: "scripts/liveness-capture.ts",
    },
  ],

  invalid: [
    {
      name: "a ready message alone is not the branch startup handshake",
      code: `await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Branch worker startup timeout')), 30_000);
  const handler = (msg: { method: string }) => { if (msg.method === 'ready') resolve(); };
  child.on('message', handler);
});
`,
      filename: production,
      errors: [armError],
    },
    {
      name: "arm 1 — the BRANCH_RPC_TIMEOUT_MS body from b936e3b84~1:134-138",
      code: `const rpc = <T>(method: string, args: RpcArgs): Promise<T> => {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const timeout = setTimeout(() => {
    child.off('message', handler);
    reject(new Error(\`Branch RPC timeout: \${method}\`));
  }, BRANCH_RPC_TIMEOUT_MS);
  return promise;
};
`,
      filename: production,
      errors: [armError],
    },
    {
      name: "child error and exit alone do not exempt a timer without ready settlement",
      code: `await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Branch worker startup timeout')), 30_000);
  child.on('error', (error) => { clearTimeout(timeout); reject(error); });
  child.on('exit', (code) => {
    if (code !== 0) { clearTimeout(timeout); reject(new Error('Branch worker exited')); }
  });
});
`,
      filename: production,
      errors: [armError],
    },
    {
      name: "the branch handshake requires the ready listener to clear its timer",
      code: `await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Branch worker startup timeout')), 30_000);
  const handler = (msg: { method: string }) => {
    if (msg.method === 'ready') { child.off('message', handler); resolve(); }
  };
  child.on('message', handler);
  child.on('error', (error) => { clearTimeout(timeout); reject(error); });
  child.on('exit', (code) => {
    if (code !== 0) { clearTimeout(timeout); reject(new Error('Branch worker exited')); }
  });
});
`,
      filename: production,
      errors: [armError],
    },
    {
      name: "the branch handshake requires every rejecting child listener to clear its timer",
      code: `await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Branch worker startup timeout')), 30_000);
  const handler = (msg: { method: string }) => {
    if (msg.method === 'ready') { clearTimeout(timeout); child.off('message', handler); resolve(); }
  };
  child.on('message', handler);
  child.on('error', (error) => reject(error));
  child.on('exit', (code) => {
    if (code !== 0) { clearTimeout(timeout); reject(new Error('Branch worker exited')); }
  });
});
`,
      filename: production,
      errors: [armError],
    },
    {
      name: "the branch handshake listeners must belong to the same child",
      code: `await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Branch worker startup timeout')), 30_000);
  const handler = (msg: { method: string }) => {
    if (msg.method === 'ready') { clearTimeout(timeout); readyChild.off('message', handler); resolve(); }
  };
  readyChild.on('message', handler);
  child.on('error', (error) => { clearTimeout(timeout); reject(error); });
  child.on('exit', (code) => {
    if (code !== 0) { clearTimeout(timeout); reject(new Error('Branch worker exited')); }
  });
});
`,
      filename: production,
      errors: [armError],
    },
    {
      name: "arm 1 — a callback that throws ends work the same way",
      code: `setTimeout(() => {
  throw new Error('elapsed');
}, ms);
`,
      filename: llmSource,
      errors: [armError],
    },
    {
      name: "arm 1 — a .abort() member call is an ending the matcher reads structurally",
      code: `setTimeout(() => {
  void controller.abort('wall-clock budget exhausted');
}, budgetMs);
`,
      filename: production,
      errors: [armError],
    },
    {
      name: "arm 1 — setInterval rejecting per tick is the same defect per tick",
      code: `setInterval(() => {
  reject(new Error('tick deadline elapsed'));
}, pollMs);
`,
      filename: production,
      errors: [armError],
    },
    {
      name: "arm 1 — function, return, await, and member-reject wrappers do not hide an ending",
      code: `setTimeout(async function () {
  return await pending.reject(new Error('elapsed'));
}, ms);
`,
      filename: production,
      errors: [armError],
    },
    {
      name: "arm 1 — TypeScript wrappers do not hide an ending",
      code: `setTimeout(() => (
  controller!.abort(new Error('elapsed')) satisfies void
), ms);
`,
      filename: production,
      errors: [armError],
    },
    {
      name: "arm 1 — resolve() beside reject() does not exempt the timer",
      code: `setTimeout(() => {
  if (done) resolve(undefined);
  else reject(new Error('timed out waiting for ready'));
}, ms);
`,
      filename: production,
      errors: [armError],
    },
    {
      name: "arm 1 — an unconditional member abort is not caller-selected",
      code: `function runDeadline(
  pending: { abort(error: Error): void },
  turnEnvelopeMs: number,
): void {
  setTimeout(() => pending.abort(new Error('budget exhausted after 600s')), turnEnvelopeMs);
}
`,
      filename: production,
      errors: [armError],
    },
    {
      name: "an unrelated boolean does not make a deadline caller-selected",
      code: `function maybeStop(enabled: boolean, timeoutMs: number): void {
  if (enabled) setTimeout(() => reject(new Error('elapsed')), timeoutMs);
}
`,
      filename: production,
      errors: [armError],
    },
    {
      name: "arm 2 — AbortSignal.timeout directly in a Promise.race array is the elapsed arm",
      code: "const winner = await Promise.race([work, AbortSignal.timeout(30_000)]);",
      filename: llmSource,
      errors: [raceError],
    },
    {
      name: "arm 2 — the historical race-deadline shape from the deleted envelope family",
      code: `function raceDeadline(work: Promise<string>, envelopeMs: number): Promise<string> {
  return Promise.race([work, AbortSignal.timeout(envelopeMs)]);
}
`,
      filename: production,
      errors: [raceError],
    },
    {
      name: "arm 2 — every element of the race array is read, not only the first",
      code: "const winner = await Promise.race([first, second, AbortSignal.timeout(600_000), third]);",
      filename: production,
      errors: [raceError],
    },
    {
      name: "a production file cannot borrow the test-file exclusion",
      code: "setTimeout(() => reject(new Error('elapsed')), ms);",
      filename: production,
      errors: [armError],
    },
  ],
});
