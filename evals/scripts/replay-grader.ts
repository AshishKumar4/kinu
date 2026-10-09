import * as v from 'valibot';
import { JsonValueSchema, RunEventSchema } from '@kinu.run/core';
import type { Page } from 'puppeteer';
import { launchTestChrome } from '../../scripts/test-chrome';
import { collectEvalTasks } from '../src/eval';
import { SlateView, WorkspaceBrowser } from '../src/browser';
import { EvalVerifier, type EvalCheckOutcome, type HelperWork, type ReachedRun, type VerifierSession } from '../src/verifier';
import { openPublicSession, resolveWebIdentity, type WorkspaceWeb } from '../src/session';
import type { Sight } from '../src/sight';
import { taskTurns } from '../src/task';

// Replays saved inputs through the real check. Reads and RPC answers are tape boundaries, not replacement graders.
const Region = v.object({ text: v.string(), controls: v.array(v.string()), columns: v.optional(v.record(v.string(), v.string())), occurrence: v.optional(v.number()) });

const SightSchema = v.object({ text: v.string(), regions: v.record(v.string(), v.array(Region)) });

const Colour = v.tuple([v.number(), v.number(), v.number()]);

const Appearance = v.object({ background: Colour, light: v.number(), host: v.nullable(Colour), hostLight: v.nullable(v.number()), letters: v.number(), readable: v.number(), overflow: v.number() });

const Helper = v.object({ name: v.string(), status: v.string(), runs: v.array(v.object({ startedAt: v.number(), status: v.nullable(v.string()), userMessage: v.nullable(v.string()) })) });

const Input = v.object({
  task: v.string(), part: v.string(), turn: v.optional(v.number(), 1), checks: v.array(v.string()), expected: v.optional(v.boolean(), true),
  files: v.optional(v.record(v.string(), v.string()), {}), replies: v.optional(v.array(v.string()), []),
  events: v.optional(v.array(RunEventSchema), []), helpers: v.optional(v.array(Helper)),
  rpc: v.optional(v.array(v.object({ id: v.string(), method: v.string(), args: v.array(JsonValueSchema), answer: JsonValueSchema })), []),
  seen: v.optional(SightSchema), modes: v.optional(v.object({ light: Appearance, dark: Appearance })),
  html: v.optional(v.array(v.string())), pressed: v.optional(v.boolean(), true),
  reached: v.optional(v.array(v.object({ tools: v.array(v.string()) }))), note: v.optional(v.object({ path: v.string(), content: v.string() })),
  live: v.optional(v.object({ origin: v.string(), slate: v.string(), seedCalls: v.optional(v.array(v.object({ method: v.string(), args: v.array(JsonValueSchema) })), []) })),
});

const input = v.parse(Input, JSON.parse(process.argv[2] ?? ''));

const task = (await collectEvalTasks()).find((candidate) => candidate.id === input.task);

const placed = task === undefined ? undefined : taskTurns(task).filter((candidate) => candidate.part === input.part)[input.turn - 1];

if (placed?.spec.verify === undefined) throw new Error('the replay names no graded turn');

class SelectedVerifier extends EvalVerifier {
  override check(id: string, body: () => Promise<EvalCheckOutcome>): Promise<void> {
    return input.checks.includes(id) ? super.check(id, body) : Promise.resolve();
  }
}

async function live(): Promise<void> {
  const target = input.live;

  if (target === undefined || placed?.spec.verify === undefined) throw new Error('the replay names no live target');
  const identity = resolveWebIdentity(target.origin);

  if (identity.kind !== 'ready') throw new Error(identity.remedy);

  const session = await openPublicSession({
    origin: target.origin, identity: identity.identity, workspace: `eval-grader-replay-${crypto.randomUUID().slice(0, 8)}`,
    purpose: 'Replay saved eval source through its functional graders.', genesis: false,
    llm: { name: 'opencode-go', model: 'opencode-go/muse-spark-1.3-contributor', baseURL: target.origin, headers: {} },
  });

  try {
    for (const [path, content] of Object.entries(input.files)) await session.writeFile(path, content);

    for (const call of target.seedCalls) {
      const answered = await session.slateOp({ op: 'call', id: target.slate, method: call.method, args: call.args });

      console.log(JSON.stringify({ seeded: call.method, answered }));
    }

    const checks = await new SelectedVerifier(session, input.replies, 0, () => Promise.resolve()).collect(placed.spec.verify);

    console.log(JSON.stringify({ task: input.task, part: input.part, checks }));

    if (checks.length !== input.checks.length || checks.some((check) => check.pass !== input.expected)) process.exitCode = 1;
  } finally {
    await session.teardown();
  }
}

class TapeView extends SlateView {
  constructor(page: Page, private readonly sight: Sight, private readonly mode: 'light' | 'dark') {
    super(page.mainFrame());
  }

  override read(): Promise<Sight> { return Promise.resolve(this.sight); }

  override until(_names: readonly string[], done: (sight: Sight) => boolean): Promise<{ sight: Sight; held: boolean }> {
    return Promise.resolve({ sight: this.sight, held: done(this.sight) });
  }

  override press(): Promise<boolean> { return Promise.resolve(input.pressed); }

  override faults(): Promise<{ errors: string[]; scripts: string[] }> { return Promise.resolve({ errors: [], scripts: [] }); }

  override appearance(): ReturnType<SlateView['appearance']> {
    const looks = input.modes?.[this.mode];

    if (looks === undefined) throw new Error('the replay holds no measured appearance');

    return Promise.resolve(looks);
  }
}

async function offline(): Promise<void> {
  const files = new Map(Object.entries(input.files));
  const web: WorkspaceWeb = { origin: 'http://127.0.0.1:9', identity: { kind: 'loopback' }, workspace: 'eval-saved-replay' };
  const absent = () => Promise.reject(new Error('the replay has no answer for this read'));

  const session: VerifierSession = {
    web, slateOp: async (request) => {
      const { id, method, args } = v.parse(v.object({ id: v.string(), method: v.string(), args: v.array(JsonValueSchema) }), request);
      const row = input.rpc.find((call) => call.id === id && call.method === method && JSON.stringify(call.args) === JSON.stringify(args));

      if (row === undefined) throw new Error(`the replay has no ${id}.${method}(${JSON.stringify(args)})`);

      return { ok: true, value: row.answer };
    },
    readFile: (path) => Promise.resolve(files.get(path) ?? ''),
    writeFile: (path, content) => { files.set(path, typeof content === 'string' ? content : new TextDecoder().decode(content));

 return Promise.resolve(); },
    runEvents: () => Promise.resolve(input.events),
    listSlates: absent, readBytes: absent, listFiles: absent, craftedTools: absent, memoryContent: absent,
    memoryFacts: absent, workspaceWork: absent, inspect: absent, swarmRuns: () => Promise.resolve([]), execute: absent, exposedPorts: absent,
  };

  const chrome = await launchTestChrome();
  const pages: Page[] = [];

  try {
    const page = await chrome.browser.newPage();

    pages.push(page);
    await page.setContent('<html><body></body></html>');
    const browser = new WorkspaceBrowser(chrome.browser, web);
    const views: SlateView[] = [];

    for (const html of input.html ?? []) {
      const rendered = await chrome.browser.newPage();

      pages.push(rendered);
      await rendered.setViewport({ width: 1100, height: 1800 });
      await rendered.setContent(html);
      views.push(new SlateView(rendered.mainFrame()));
    }

    if (input.seen !== undefined) views.push(new TapeView(page, input.seen, 'light'));
    browser.open = () => Promise.resolve(page);
    browser.answerSlates = (_page, least) => views.length >= least ? Promise.resolve(views)
      : Promise.reject(new Error(`the saved answer holds ${String(views.length)} slate(s), not ${String(least)}`));
    browser.workSurface = (_id, mode = 'light') => {
      if (input.seen === undefined) {
        const view = views[0];

        if (view === undefined) throw new Error('the replay holds no rendered page');

        return Promise.resolve(view);
      }

      return Promise.resolve(new TapeView(page, input.seen, mode));
    };

    browser.alone = (view) => Promise.resolve(view);

    const verifier = new SelectedVerifier(session, input.replies, 0, () => Promise.resolve());

    verifier.browse = <T>(body: (seen: WorkspaceBrowser) => Promise<T>) => body(browser);

    if (input.helpers !== undefined) {
      const helpers: HelperWork[] = input.helpers;

      verifier.helperWork = () => Promise.resolve(helpers);
    }

    if (input.reached !== undefined) {
      const runs: ReachedRun[] = input.reached;

      verifier.reach = async (act) => {
        const acted = await act();

        if (acted && input.note !== undefined) files.set(input.note.path, input.note.content);

        return { acted, runs: acted ? runs : [] };
      };
    }

    if (placed?.spec.verify === undefined) throw new Error('the replay names no verifier');
    const checks = await verifier.collect(placed.spec.verify);

    console.log(JSON.stringify({ task: input.task, part: input.part, checks }));

    if (checks.length !== input.checks.length || checks.some((check) => check.pass !== input.expected)) process.exitCode = 1;
  } finally {
    await Promise.all(pages.map((page) => page.close()));
    await chrome.close();
  }
}

if (input.live === undefined) await offline();
else await live();
