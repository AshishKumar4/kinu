import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RpcSession, RpcTarget, type RpcTransport } from 'capnweb';
import type { ServerWebSocket } from 'bun';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Browser, Page } from 'puppeteer';
import { launchTestChrome, type TestChrome } from '../../scripts/test-chrome';
import { answerIds, answersWithSlates, readAnswer } from '../tasks/ephemeral';
import { DRAW_MS, recordDeadEnds, SlateView, WorkspaceBrowser } from './browser';
import { shows, type Sight } from './sight';
import { EvalVerifier, type VerifierSession } from './verifier';

// A check reads a slate page once it has drawn, and judges what it drew at once. The office pricing check of run
// 66938aa25 took 215.8 s: it read the chat's every slate, an earlier answer's latency chart among them, and gave each
// 60 s to become a pricing table. Dashboards' board turns took 630-650 s: a page already drawn wrong was given 60 s
// again by each of ten checks. These pages are the real Chrome's, their data over capnweb as a slate's is.

const TEAMS = ['design', 'growth', 'platform'];

interface Row {
  readonly team: string;
  readonly budget: number;
  readonly spent: number;
}

const ROWS: readonly Row[] = [{ team: 'design', budget: 1500, spent: 1641 }, { team: 'growth', budget: 3000, spent: 2705 }, { team: 'platform', budget: 2000, spent: 1530 }];

/** A board slate's page as an agent writes one: it asks its slate for the month over `/__rpc` and draws the answer, and
 *  Cover asks the slate to raise a team's budget and draws the month again. */
const BOARD = `<!doctype html><html><body><main id="root"><p>Loading the month</p></main><script type="module">
import { newWebSocketRpcSession } from '/capnweb.js';
const board = newWebSocketRpcSession(new URL('/__rpc', location.href).href);
async function draw() {
  const rows = await board.status();
  document.getElementById('root').innerHTML = rows.map((row) => '<section><h2>' + row.team + '</h2><p>budget $' + row.budget + ', spent $' + row.spent + '</p>'
    + (row.spent > row.budget ? '<button>Cover</button>' : '') + '</section>').join('');
  for (const button of document.querySelectorAll('button')) button.onclick = async () => { await board.cover(button.closest('section').querySelector('h2').textContent); await draw(); };
}
await draw();
</script></body></html>`;

/** The board slate behind {@link BOARD}: it answers each call `delayMs` late, as a slate whose storage is far away does. */
class Board extends RpcTarget {
  constructor(private rows: readonly Row[], private readonly delayMs: number) {
    super();
  }

  async status(): Promise<readonly Row[]> {
    await sleep(this.delayMs);

    return this.rows;
  }

  async cover(team: string): Promise<void> {
    await sleep(this.delayMs);
    this.rows = this.rows.map((row) => row.team === team ? { ...row, budget: Math.ceil(row.spent / 100) * 100 } : row);
  }
}

/** capnweb's session over a socket Bun's server holds, one message a frame (capnweb's own Bun build does this, but its
 *  types are not the ones this checkout resolves). */
class ServedSocket implements RpcTransport {
  readonly #arrived: string[] = [];
  #waiting: ((message: string) => void) | null = null;

  constructor(private readonly socket: ServerWebSocket<Served>) {}

  send(message: string): void {
    this.socket.send(message);
  }

  receive(): Promise<string> {
    const next = this.#arrived.shift();

    return next === undefined ? new Promise((resolve) => { this.#waiting = resolve; }) : Promise.resolve(next);
  }

  arrived(message: string): void {
    const waiting = this.#waiting;

    this.#waiting = null;

    if (waiting === null) this.#arrived.push(message);
    else waiting(message);
  }
}

/** What a served socket carries: its session's transport, once open. */
interface Served {
  transport?: ServedSocket;
}

/** A chat holding two answers: the earlier one's latency chart, then this answer's pricing page, each drawn under its
 *  `<message>/<name>` id as `InlineSlate` draws an ephemeral slate. */
const CHAT = `<!doctype html><html><body>
<span data-slate-inline="m1/latency" data-slate-ui="latency"><iframe srcdoc="<h1>API latency</h1><p>Yesterday: 241 ms</p>"></iframe></span>
<span data-slate-inline="m2/pricing" data-slate-ui="pricing"><iframe srcdoc="${['Starter', 'Team', 'Business'].map((plan) => `<article><h2>${plan}</h2><p>$19 a month</p></article>`).join('')}"></iframe></span>
</body></html>`;

/** capnweb's browser build, which a slate's page gets through its import map. */
const CAPNWEB = join(import.meta.dir, '..', '..', 'node_modules', 'capnweb', 'dist', 'index.js');

let chrome: TestChrome;

let browser: Browser;

const servers: { stop: (closeActive: boolean) => Promise<void> }[] = [];

beforeAll(async () => {
  chrome = await launchTestChrome();
  browser = chrome.browser;
});

afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop(true)));
  await chrome.close();
});

/** A local origin serving the board page over a slate of `rows` answering `delayMs` late, and the chat page. */
function origin(rows: readonly Row[], delayMs: number): string {
  const server = Bun.serve<Served>({
    port: 0, hostname: '127.0.0.1',
    fetch(request, serving) {
      const { pathname } = new URL(request.url);

      if (pathname === '/__rpc') return serving.upgrade(request, { data: {} }) ? undefined : new Response('a socket only', { status: 400 });

      if (pathname === '/capnweb.js') return new Response(Bun.file(CAPNWEB), { headers: { 'content-type': 'text/javascript' } });

      return new Response(pathname === '/chat' ? CHAT : BOARD, { headers: { 'content-type': 'text/html' } });
    },
    websocket: {
      open(socket) {
        const transport = new ServedSocket(socket);

        socket.data.transport = transport;
        // The session lives as long as its socket: capnweb holds it through the transport's pending receive.
        void new RpcSession(transport, new Board(rows, delayMs));
      },
      message(socket, message) {
        socket.data.transport?.arrived(String(message));
      },
    },
  });

  servers.push(server);

  return server.url.href;
}

/** A page at `url`, recording what its slates wait on from its first document, as a check's page does. */
async function opened(url: string): Promise<Page> {
  const page = await browser.newPage();

  await recordDeadEnds(page);
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  return page;
}

/** Whether `team` has a part of its own showing every one of `amounts`. */
function shown(sight: Sight, team: string, amounts: readonly number[]): boolean {
  return (sight.regions[team] ?? []).some((region) => amounts.every((amount) => shows(region.text, amount)));
}

/** The teams `sight` shows otherwise than `rows` have them. */
function misread(sight: Sight, rows: readonly Row[]): string[] {
  return rows.filter((row) => !shown(sight, row.team, [row.budget, row.spent])).map((row) => row.team);
}

describe('a slate page', () => {
  test('that draws its data late is read once it has drawn it, not as it first loads', async () => {
    const page = await opened(origin(ROWS, 1500));
    const sight = await new SlateView(page.mainFrame()).drawn(TEAMS);

    expect(misread(sight, ROWS)).toEqual([]);
  });

  test('drawn wrong is read at once, with every team it misreads, not waited on for the draw budget', async () => {
    const wrong = ROWS.map((row) => row.team === 'growth' ? row : { ...row, spent: row.spent + 1 });
    const page = await opened(origin(wrong, 0));
    const started = performance.now();
    const sight = await new SlateView(page.mainFrame()).drawn(TEAMS);
    const waited = performance.now() - started;

    expect({ misread: misread(sight, ROWS), within: waited < DRAW_MS }).toEqual({ misread: ['design', 'platform'], within: true });
  });

  test('pressed is read once it has drawn what the press asked for', async () => {
    const page = await opened(origin(ROWS, 800));
    const view = new SlateView(page.mainFrame());
    const before = await view.drawn(TEAMS);
    const pressed = await view.press(TEAMS, { name: 'design', label: '\\bcover\\b' });
    const after = await view.drawn(TEAMS);

    expect({ before: shown(before, 'design', [1500]), pressed, after: shown(after, 'design', [1700, 1641]) }).toEqual({ before: true, pressed: true, after: true });
  });
});

describe('an answer\'s slates', () => {
  const absent = (): Promise<never> => Promise.reject(new Error('not read here'));

  /** A verifier of the answer `text`, stored as message `id`, whose pages are `chat`'s. */
  function answered(id: string, text: string, chat: Page): EvalVerifier {
    const session: VerifierSession = {
      web: { origin: 'http://127.0.0.1:8787', identity: { kind: 'loopback' }, workspace: 'eval-drawn' },
      slateOp: absent, listSlates: absent, readFile: absent, readBytes: absent, writeFile: absent, listFiles: absent, craftedTools: absent,
      runEvents: absent, memoryContent: absent, memoryFacts: absent, workspaceWork: absent, inspect: absent, swarmRuns: absent, execute: absent,
      exposedPorts: absent,
    };

    const verifier = new EvalVerifier(session, [{ id, text }], 0, () => Promise.resolve());
    const pages = new WorkspaceBrowser(browser, session.web);

    pages.open = () => Promise.resolve(chat);
    verifier.browse = <T>(body: (seen: WorkspaceBrowser) => Promise<T>) => body(pages);

    return verifier;
  }

  test('are this answer\'s alone, though an earlier answer\'s stay in the chat above it', async () => {
    const chat = await opened(`${origin(ROWS, 0)}chat`);
    const verifier = answered('m2', 'Three treatments:\n<slate-ui name="pricing">\n<article>Starter</article>\n</slate-ui>\n', chat);
    const checks = await verifier.collect((each) => answersWithSlates(each, 1));
    const plans = ['Starter', 'Team', 'Business'];

    const readings = await verifier.browse(async (pages) => readAnswer(pages, answerIds(verifier), plans, (sight) => plans.every((plan) => shown(sight, plan, [19]))));

    expect({ checks: checks.map((check) => check.pass), readings: readings.map((reading) => [reading.held, reading.sight.text.includes('latency')]) })
      .toEqual({ checks: [true], readings: [[true, false]] });
  });

  test('that the answer does not hold fail at once, whatever slates earlier answers left in the chat', async () => {
    const chat = await opened(`${origin(ROWS, 0)}chat`);
    const checks = await answered('m3', 'The chart above still holds.', chat).collect((each) => answersWithSlates(each, 1));

    expect(checks.map((check) => [check.pass, check.evidence])).toEqual([[false, { blocks: [], addressed: 0, drawn: 0, least: 1 }]]);
  });
});
