# Testing Proteus

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

Proteus uses Bun's test runner across the shared core, Cloudflare backend,
local backend, and root end-to-end suites. This doc covers the conventions,
where things live, and how to add tests when shipping a new feature.

## TL;DR

```bash
bash scripts/test.sh                     # core + cf-backend + cli-backend + cli
bash scripts/test.sh --coverage          # + coverage report
bash scripts/test.sh --bail              # exit on first failure
bash scripts/test.sh packages/core/tests/contract-providers.test.ts   # one file
bun run check                            # TypeScript type-check (every package)
```

Two things about `scripts/test.sh` worth knowing. It runs four packages —
`core`, `cf-backend`, `cli-backend`, `cli` — so `agent-utils`, `compaction`, and
`pc-agent` are **not** in "all tests". And the root `bun run test` script is a
different, partly disjoint set (`agent-utils`, `core`, `compaction`). To
actually cover everything:

```bash
bash scripts/test.sh
bun test packages/agent-utils/tests packages/compaction/tests
```

For focused local checks:

```bash
bun test --cwd packages/core
bun test packages/cf-backend/tests
bun test packages/cli-backend/tests
```

## Test categories

Each test file lives in `packages/<pkg>/tests/` and is named to indicate the
category. Categories are conventions enforced by filename — no separate
config:

| Prefix | What it covers | Speed | Real I/O? |
|---|---|---|---|
| `unit-*.test.ts` | A single module or function | <50ms each | In-memory only |
| `integration-*.test.ts` | Multiple modules wired together | <500ms each | In-memory only |
| `contract-*.test.ts` | External-system wire format (HTTP, SQL) | <100ms each | Mock fetch/SQL |
| `e2e/*.test.ts` | Full system through public APIs | ~seconds | In-memory but realistic |
| `smoke-*.test.ts` | "Does it boot / import" | <100ms | None |

The convention holds in `core` and `cf-backend`, where nearly every file carries
a prefix. `cli-backend/tests` and `cli/tests` use bare `<name>.test.ts` instead,
so treat the prefix as a strong convention rather than a rule the tooling
enforces.

## What lives where

```
packages/
├─ core/tests/                (115 files)
│  ├─ unit-*.test.ts          (pure logic)
│  ├─ integration-*.test.ts   (multi-module flows)
│  ├─ contract-providers.test.ts  (HTTP wire format per provider)
│  └─ helpers.ts              (package-local helpers)
├─ cf-backend/tests/           (58 files)
│  ├─ unit-agent-registry.test.ts  (provider registry composition)
│  ├─ unit-auth-security.test.ts   (browser OAuth and CLI auth invariants)
│  ├─ unit-cli-auth-store.test.ts  (D1-backed device-code flow)
│  ├─ unit-rlm.test.ts             (Recursive Language Model bridge)
│  └─ unit-webhook-ingress.test.ts (webhook body/rate-limit helpers)
├─ cli-backend/tests/          (16 files)
│  ├─ local-session.test.ts        (local agent session behavior)
│  ├─ model-resolver.test.ts       (provider/model selection)
│  └─ executor.test.ts             (local execution tools)
├─ cli/tests/                  (25 files — CLI commands, config, TUI)
├─ agent-utils/tests/          (4 files — SqliteFS, MemoryStore, shell)
├─ compaction/tests/           (4 files — the ladder and the codec)
└─ test-utils/src/
   ├─ sql.ts            ── createTestSql()
   ├─ llm.ts            ── createScriptedLLM / createJSONLLM / createEchoLLM / createFailingLLM
   ├─ network.ts        ── createMockFetch(handlers)
   ├─ runtime.ts        ── createTestRuntime()
   ├─ provider.ts       ── createTestProvider / createTestStrategy
   ├─ events.ts         ── assertEventSequence / collectEvents
   ├─ credentials.ts    ── createTestAuth / codexAuthHeaders / bearerAuth / anthropicAuth
   └─ facts.ts          ── createTestFactsStore
tests/
├─ e2e-lifecycle.test.ts
├─ e2e-full-lifecycle.test.ts
├─ deep-evolution.test.ts
└─ evolution-proof.test.ts
```

## Mocking philosophy

Mock at real seams, never at internal functions. Internal mocks couple tests
to implementation and produce false confidence:

| Seam | Mock how |
|---|---|
| LLM calls | `createScriptedLLM(['answer 1', 'answer 2'])` — predictable, deterministic |
| Structured-output LLM | `createJSONLLM({ /* the JSON */ })` |
| HTTP (provider wire) | `createMockFetch([{ match, respond }])` — assert URLs/headers/body |
| SQL (DO storage) | `createTestSql()` — bun:sqlite `:memory:` + template tag |
| Credentials | `createTestAuth({ key: bearerAuth('tok') })` — resolved auth headers, not raw secrets |
| AgentRuntime | `createTestRuntime()` — full minimal AgentRuntime |
| RunEvent stream | `collectEvents(loop.run(ctx))` + `assertEventSequence(...)` |
| Crafted-tool sandbox | already mocked by `createNodeCraftedExecute` from `@proteus/cli-backend` |

What **not** to mock: pure functions inside the same package. If `parseModelSpec`
or `effortFor` is what you're testing, call it directly. Mocking it produces
nothing useful.

## Writing a new test

### Unit test (pure logic)

```ts
import { describe, test, expect } from 'bun:test';
import { myFunction } from '../src/index.ts';

describe('myFunction', () => {
  test('happy path', () => {
    expect(myFunction(2, 3)).toBe(5);
  });
  test('edge: zero', () => {
    expect(myFunction(0, 0)).toBe(0);
  });
  test('edge: negative', () => {
    expect(() => myFunction(-1, 0)).toThrow('must be non-negative');
  });
});
```

### Test that uses an LLM

```ts
import { describe, test, expect } from 'bun:test';
import { createTestRuntime, createJSONLLM } from '@proteus/test-utils';

test('auto-judge picks current when scores tie', async () => {
  const { rt } = createTestRuntime();
  const judge = createJSONLLM({
    winner: 'tie', scoreA: 0.5, scoreB: 0.5, rationale: 'identical',
  });
  // … exercise the code path …
});
```

### Test that asserts HTTP request shape

```ts
import { describe, test, expect } from 'bun:test';
import { createMockFetch, createTestAuth, bearerAuth } from '@proteus/test-utils';
import { createMyProvider, MY_CRED_KEY } from '../src/index.ts';

test('sends Authorization: Bearer', async () => {
  const auth = createTestAuth({ [MY_CRED_KEY]: bearerAuth('sk-x') });
  const mock = createMockFetch([
    { match: 'api.myservice.com', respond: { status: 200, body: { ok: true }}},
  ]);
  const model = createMyProvider().createModel('m', {
    env: {}, getAuth: auth.getAuth, hasCredential: auth.hasCredential, fetch: mock.fetch,
  });
  // call the model via AI SDK generateText
  // …
  expect(mock.requests[0].headers['authorization']).toBe('Bearer sk-x');
});
```

### Test for a new ExplorationStrategy

```ts
import { describe, test, expect } from 'bun:test';
import { createMyStrategy } from '../src/strategy/my-strategy.ts';
import { createTestRuntime, createScriptedLLM } from '@proteus/test-utils';

test('my-strategy explores within budget', async () => {
  const { rt } = createTestRuntime({
    llm: createScriptedLLM(['option A', 'option B', 'final answer']),
  });
  const strategy = createMyStrategy();
  const result = await strategy.explore({
    task: 'pick the best',
    rt,
    model: rt.llm as never,
    budget: { maxIterations: 3 },
  });
  expect(result.best.text).toBe('final answer');
  expect(result.cost.iterations).toBeLessThanOrEqual(3);
});
```

## What's NOT testable in pure Bun

The `@cloudflare/agents` package transitively imports `cloudflare:email`,
which only resolves inside the Workers runtime. Anything that imports the
`agents` package directly — `ActorAgent` and its subclasses,
`ExplorationAgent`, the auth/routes dispatcher — is testable only via miniflare
or wrangler dev, not from `bun test`.

The pattern we use: extract the pure URL/parsing/policy logic into its own file
with no `agents` import, unit-test that in Bun, and leave the orchestration file
that wires it to actual DO calls to the integration and e2e harness. That is why
`cf-backend/tests` can still hold 58 passing Bun files despite the constraint —
most of what matters there was written to be reachable without a DO.

## Running with coverage

```bash
bash scripts/test.sh --coverage
```

Coverage is per-file with funcs % / lines %. Useful for finding gaps but
NOT a goal — the goal is "behaviors I care about are tested." Don't game
the number.

Current baseline, from `bash scripts/test.sh`:
- 1975 pass, 3 skip, 0 fail — 1978 tests across 214 files, ~53 s
- plus 86 more in `agent-utils` + `compaction`, which that script does not run

Areas with intentionally low coverage:
- `packages/core/tests/e2e/ai-gateway-llm.ts` — real-LLM helper, expected to be
  uncovered in the unit pass
- `test-utils/src/runtime.ts` — itself a fixture; gets exercised indirectly
- DO/Worker integration paths — covered by the deploy smoke test, not
  visible to bun test

## Adding a new package to the test suite

1. Create `packages/<your-pkg>/tests/` (matching the existing pattern).
2. Add `"@proteus/test-utils": "workspace:*"` to your package's
   `devDependencies` so the fixtures resolve.
3. Update `scripts/test.sh` to include the new test directory.
4. Write tests using the conventions above.

## CI

`scripts/test.sh` is intended for both local dev and CI. It exits non-zero
on failure. For CI, wrap with `--bail` if you want to fail fast on the
first error.
