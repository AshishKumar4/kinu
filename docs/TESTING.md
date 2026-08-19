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

## The eval tier — the suites that call a real model

```bash
bun run test:eval                        # every arm, and it RESOLVES A CREDENTIAL BY ITSELF
```

Read the next paragraph before running that.

**It spends your money without being asked to.** If the environment names no
model target, `scripts/eval-tier.sh` borrows the signed-in CLI session — the same
`~/.proteus/config.json` credential `proteus chat` uses — via
`scripts/eval-credentials.ts`. So on any machine that has run `proteus auth`,
`bun run test:eval` bills the token owner's Cloudflare account. That is
deliberate: the tier previously asked for two environment variables nothing on
the owner's own machine ever exported, so it ran to completion reporting
`TOTAL: 0 model call(s)` with every live test skipped, and passed a deploy gate.
It is also why the script prints the target and the cost basis **before** spending
anything — a run that goes somewhere unexpected is visible at the top of the log
rather than in a bill.

`bun run test:eval` is a **ci-tier and deploy-tier gate**: `bun scripts/ladder.ts
--tier=ci` runs it, which the CI workflow runs on every push and PR, and
`scripts/deploy.sh` runs it as "Behavioural evals". On a GitHub runner there is no
session to borrow, so it is free there and everything live skips. On your machine
it is not.

### The three arms

Two of them exist because two runners are needed and neither can see the other's
files — `bun test` matches only `*.test.ts` / `*_test.*` / `*.spec.*`, never
`*.eval.ts`. The third is one file on the vitest side, split off for **cost
accounting**: an arm is the unit a spend file is written per, so an arm is the unit
liveness can be asserted per.

| Arm | What runs | What it measures |
|---|---|---|
| bun suites | `bun test ./tests/` | end-to-end lifecycle, evolution across sessions, MCTS reached and durably ranked, delegation conversion, one real turn per backend |
| behaviour evals | `vitest --config vitest.evals.config.ts`, excluding the swarm file | 17 corpus tasks × 2 repetitions = 34 full agent episodes, graded by eight scorers over the `run_events` ledger |
| live swarm | `vitest --config vitest.evals.config.ts tests/evals/swarm.eval.ts` | one `agents({action:'swarm'})` call through the real tool surface: a `depth:2 branches:3` verifier-scored search with `expand:'aggregate'`, graded on the caller's own `exec-ratio` instrument |

**Why the swarm eval is its own arm.** `scripts/eval-spend.ts --expect-live` sums
the lines in the spend file it is given, so a swarm eval sharing a file with five
paid suites could stop reaching a model entirely and the tier would still report
`proven`. The arm whose whole subject is a live search is the one arm whose zero has
to be its own failure, so it gets its own spend file and its own assertion — driven
by the same `EXPECT_LIVE` the banner printed, so the line you read and the assertion
the run is held to cannot disagree. Everything it asserts is measured rather than
judged: a winner crowned, its artifact's oracle-call count against the run's own
measured baseline, `exploration_records` rows read back through the store's own
reader under the objective's identity and floor digest, and the
`judgeEnsemble`/`fanIn`/`carry` disclosures checked against the axes the report
itself carries. Its credential-free half — the action is offered, and the strict
parse refuses an unknown field naming the field it meant — runs at every tier.

The behaviour arm's own knobs, none of which are documented anywhere else:
`PROTEUS_EVAL_TIER=flash|pro` picks the model (`flash` is the volume arm and the
default), `PROTEUS_EVAL_REPEATS` the repetitions per task (default 2 for flash, 1
for pro), `PROTEUS_EVAL_SEED` the run seed, `PROTEUS_EVAL_EVOLUTION=0` turns
evolution off, and `PROTEUS_EVAL_RECORD` names where the run record is written
(default: beside the retained transcripts under `bench-artifacts/`).

### What it costs and how long it takes

Measured, not estimated. Every figure below came from a run whose log said so; a
cell that has not been measured says so instead of carrying a guess.

| | wall clock | model calls | input tokens |
|---|---|---|---|
| whole tier, credential-free | 3 s | 0 | — |
| bun suites, credentialed | 2,745 s | 48 | 601.6k |
| bun suites, credentialed (second run) | 3,843 s | 49 | 600.8k |
| behaviour evals, credentialed | not yet measured — see below | | |
| live swarm, credentialed | 1,338 s | 3 | 2,453.4k (134.1k out) |
| `tests/live-smoke.test.ts` alone | 74 s | 3 | 55.6k |

The two bun-half rows are the two runs whose spend files still exist. `ladder.ts`
declares this gate at 3,228 s / 64 calls / 967k from a third run whose artifact does
not survive; both surviving runs show ~48 calls and ~601k, so treat the declared
figure as a budgeted ceiling rather than a typical cost. The 3,843 s run also
contains 1,200 s of tests being killed rather than working (a 900 s exploration
timeout and a 300 s MCTS one, both since fixed — those same steps now complete in
437 s and 456 s), so do not derive a post-fix cost from it.

The behaviour arm is 34 full agent episodes and dominates the tier. Its wall clock
is the number this row is waiting on; the tier now reports it per arm, and the run
record it writes carries per-episode `ms`, so the figure is read off an artifact
rather than estimated. It had never been measured because the arm produced no
report at all until this change.

**What that live swarm row is, and it is a RED run rather than a passing one.** One
credentialed run completed and reported: 1,338 s wall, 3 model calls accounted for,
2,453,377 input / 134,076 output tokens, baseline 2,880,000 oracle calls (exactly
2·1200² — the reference counting every token against every other, on both instances),
`stop: aborted`, `expansions: 3`, **no winner**, `records.written: 0`, `fanIn.levels:
0` with all three parents unusable. The eval failed on its first assertion,
`expect(report.stop).not.toBe('aborted')`, which is the bound working: a run that did
not settle is refused rather than measured. What is still OWED is a run that SETTLES,
and with it the winner and the winner/baseline ratio.

Three earlier attempts, each stopped for a stated reason rather than by a guess:

1. Refused before any model call — the objective's floor was sent camelCase and
   `SwarmObjectiveSchema` answered `Invalid key: Expected "best_known_honest"`. The
   wire boundary working; the eval's transform is now in one named place.
2. The worker proxy's upstream Cloudflare login had expired: three depth-1 heads
   errored in ~1 s with `Your Cloudflare login is no longer valid … (upstream:
   Authentication error)`, three more sat at `status:'running'`, zero steps, for 63
   minutes with no store write and no exit. `tests/live-smoke.test.ts` passed 5 calls
   / 55.7k tokens an hour later, so that was a window rather than an outage.
3. Healthy credential, real work, wrong instance: three heads read the reference,
   found the measure harness, wrote and ran their own benchmark — and then one step
   ran 26 minutes on the 50,000-token `hard-select-kth` instance while the runner held
   91% CPU. The eval now uses `hard-majority-vote` (n=1200) for that measured reason:
   instance size is what a NODE'S own experimentation costs, and the workspace
   substrate executes in-process.

**Sizing this arm, which is the part worth knowing before you run it — and the finding
the run produced.** A swarm node runs to `DEFAULT_MAX_STEPS` (500) because
`SwarmRunDeps.maxSteps` exists and `runSwarmAction` never sets it, so there is no
per-node step or time budget on this surface at all: `AGENTS_ACTION_FIELDS.swarm`
records that an iteration cap and a wall-clock cap are DELIBERATELY ABSENT until
something enforces them. Measured, one wave of three: 22, 25 and 26 model steps and
25, 27 and 27 tool calls per node, 1,216–1,337 s each, ~2.45M input tokens between
them, and not one measurable candidate. `depth × branches` bounds the SHAPE and
nothing bounds the depth of one node's own loop.

The caller's `abortSignal` is the only bound `runSwarmAction` forwards, and it does
work: all three nodes settled `status:'aborted'` with their step counts recorded when
the 20-minute envelope fired. It is consulted BETWEEN steps (`node-agent.ts:487`), so
it bounds a run to one step past the deadline and a step has no bound of its own —
measured on attempt 3, where neither that timer nor vitest's own `testTimeout` fired
at all while the substrate executed in-process for 26 minutes.

Cost here is **time, not rate**: the account's limit is 300 requests/minute and a
full tier run averages under one. Nothing you can do to this tier makes it hit a
rate limit; what it costs you is an afternoon. The tier prints a `── per arm ──`
block with each arm's own seconds and tokens, so you never have to infer which
half the time was in.

**Do not run two live tiers against one account.** Two concurrent runs produce
`orchestrator.detached_work_failed / Request Timeout` and turns that come back with
zero steps — the same signature as a deployment outage, and neither run's wall clock
is then the tier's cost.

If you only need to prove one thing, run one suite rather than the tier:
`PROTEUS_EVAL_LIVE=1 bun test ./tests/live-smoke.test.ts` is 74 s and proves the
deployed worker and the local session spine each take a real turn.

### What a failure means

Four different things, and the tier keeps them apart because they need opposite
repairs.

- **A suite failed.** Either the model answered wrongly (a finding) or the
  environment never answered (an outage). The tier does not guess: a failure
  counts as infrastructure only where the code raising it said so through
  `infraBoundary`, and the skip ratchet prints the two lists separately. An
  unmarked failure lands in the behavioural list, which under-claims outages
  rather than over-claiming them.
- **An undeclared skip.** A test skipped that `scripts/skip-ratchet.lock.json`
  does not declare. Make it run, or add it to the lock with the reason it cannot
  — which is a sentence you will have to defend.
- **The run proved no liveness.** A target was resolved and the run cannot show
  it reached a model. That is the tier reporting on itself; `eval-spend.ts` names
  which of the four shapes it is. It is asserted TWICE — once over the live swarm
  arm's own spend file and once over the tier's total — because a tier-wide sum
  cannot fail on one arm's behalf, and `the live swarm arm proved no liveness` is
  the sharper sentence of the two.
- **Nothing at all, loudly.** With no credential anywhere the tier still runs and
  still passes: every live test skips, the ratchet proves the skips are the
  declared ones, and the liveness assertion says it has nothing to prove. That is
  the path that reproduces anywhere.

### Credentials, if you want to point it somewhere else

Either pair, and an explicit one is never overridden:

```bash
PROTEUS_ORIGIN=… PROTEUS_TOKEN=…            # deployed/preview worker proxy; mint with
                                            #   proteus tokens create --scope ai.proxy
AI_GATEWAY_BASE_URL=… AI_GATEWAY_AUTH=…     # an AI Gateway, for models the proxy does not front
```

`PROTEUS_BASE_URL` + `PROTEUS_AUTH` are accepted as aliases of the second pair.

`PROTEUS_EVAL_LIVE=1` is the consent switch, and `scripts/eval-tier.sh` is the
only thing that sets it — so a credential sitting in your shell cannot make a
commit hook bill anyone. Running a live suite by hand means setting it yourself.

### The bench harness is a different thing

`bun scripts/bench.ts` scores whether self-evolution helps, against 159 seeded
defects in this repo. It shares no credentials with the eval tier (it reads
`BENCH_BASE_URL` / `BENCH_AUTH` / `BENCH_MODEL` and borrows nothing), and its
deterministic variants need no model at all. See [Bench](BENCH.md).

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
├─ core/tests/                (152 files)
│  ├─ unit-*.test.ts          (pure logic)
│  ├─ integration-*.test.ts   (multi-module flows)
│  ├─ contract-providers.test.ts  (HTTP wire format per provider)
│  └─ helpers.ts              (package-local helpers)
├─ cf-backend/tests/           (78 files)
│  ├─ unit-agent-registry.test.ts  (provider registry composition)
│  ├─ unit-auth-security.test.ts   (browser OAuth and CLI auth invariants)
│  ├─ unit-cli-auth-store.test.ts  (D1-backed device-code flow)
│  ├─ unit-rlm.test.ts             (Recursive Language Model bridge)
│  └─ unit-webhook-ingress.test.ts (webhook body/rate-limit helpers)
├─ cli-backend/tests/          (23 files)
│  ├─ local-session.test.ts        (local agent session behavior)
│  ├─ model-resolver.test.ts       (provider/model selection)
│  └─ executor.test.ts             (local execution tools)
├─ cli/tests/                  (38 files — CLI commands, config, TUI)
├─ agent-utils/tests/          (5 files — SqliteFS, MemoryStore, shell)
├─ compaction/tests/           (7 files — the ladder and the codec)
└─ test-utils/src/
   ├─ sql.ts            ── createTestSql()
   ├─ llm.ts            ── createScriptedLLM / createJSONLLM / createEchoLLM
   ├─ network.ts        ── createMockFetch(handlers)
   ├─ runtime.ts        ── createTestRuntime()
   ├─ provider.ts       ── createTestStrategy
   ├─ credentials.ts    ── createTestAuth
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
| Credentials | `createTestAuth({ key: { headers: { Authorization: 'Bearer tok' } } })` — resolved auth headers, not raw secrets |
| AgentRuntime | `createTestRuntime()` — full minimal AgentRuntime |
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
import { createMockFetch, createTestAuth } from '@proteus/test-utils';
import { createMyProvider, MY_CRED_KEY } from '../src/index.ts';

test('sends Authorization: Bearer', async () => {
  const auth = createTestAuth({ [MY_CRED_KEY]: { headers: { Authorization: 'Bearer sk-x' } } });
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
`cf-backend/tests` can still hold 78 passing Bun files despite the constraint —
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
