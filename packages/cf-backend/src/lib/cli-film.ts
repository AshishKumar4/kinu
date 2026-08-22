/**
 * The CLI, on film.
 *
 * A terminal player whose every line is footage: the frames below are verbatim
 * excerpts from ONE recorded `kinu run` session, and the browser gate holds
 * each frame against the raw recording at `scripts/fixtures/cli-film-run.jsonl`
 * — a frame that stops being a substring of the recording fails the build, so
 * this film cannot quietly become fiction.
 *
 * Provenance:
 *   command    kinu run film "Find the slowest test in this repo and explain
 *              why it is slow." --mode json
 *   recorded   2026-08-21T03:50:55Z, session 20260821035055-06e6d112
 *   workspace  film (local backend), KINU_HOME=/tmp/kinu-film-home
 *   cwd        /tmp/kinu-film-repo — a three-file bun project whose slow test
 *              hides an O(n²) dedupe
 *   model      workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813, live
 *   outcome    10 steps, 264 s: ran the suite, timed each file in isolation,
 *              proved the quadratic by scaling the input, cleaned up after
 *              itself, and named the fix
 *
 * The player is text: it renders crisp at any density, weighs nothing, and
 * needs no media element the CSP would have to carve out. The finished
 * transcript is what the server sends; the script re-plays it — types the
 * command, then reveals output in beats — so no script and reduced motion both
 * read the completed session, the same way round as the hero tree's growth.
 */

export type CliFilmLine =
  /** The line the user typed. The one line the player types character by
   *  character — people type, programs print. */
  | { readonly kind: 'cmd'; readonly text: string }
  /** A tool call the agent made: mono label (tool · runtime), then the
   *  command, elided but never paraphrased. */
  | { readonly kind: 'call'; readonly label: string; readonly text: string }
  /** The agent's own stated reason for a call, recorded in the `why` field. */
  | { readonly kind: 'why'; readonly text: string }
  /** Tool output, verbatim. */
  | { readonly kind: 'out'; readonly text: string }
  /** The final answer, verbatim, markdown marks and all. */
  | { readonly kind: 'text'; readonly text: string };

/** Mono-rail facts, read off the recording's own `session` and `turn_end`
 *  rows. Data, not prose. */
const CLI_FILM_PROVENANCE = {
  command: 'kinu run film "Find the slowest test in this repo and explain why it is slow."',
  recorded: '2026-08-21',
  session: '20260821035055-06e6d112',
  workspace: 'film',
  backend: 'local',
  model: '@cf/deepseek-ai/deepseek-v4-pro-0813',
  steps: 10,
  seconds: 264,
} as const;

/** A call frame's command may stop early — a landing page is not a pager —
 *  but it must never be reworded: the gate strips this marker and asks the
 *  recording for the rest. */
const ELIDED = ' …';

const CLI_FILM: readonly CliFilmLine[] = [
  { kind: 'cmd', text: CLI_FILM_PROVENANCE.command },
  { kind: 'call', label: 'run · workspace', text: `cd /tmp/kinu-film-repo && ls -la${ELIDED}` },
  { kind: 'why', text: 'The working directory /tmp/kinu-film-repo lives on the local machine, not the workspace filesystem.' },
  { kind: 'call', label: 'run · laptop', text: `cd /tmp/kinu-film-repo && ls -la && echo "---PKG---" && cat package.json${ELIDED}` },
  { kind: 'why', text: 'Read every source and test file to identify what each test does.' },
  { kind: 'call', label: 'run · laptop', text: `cd /tmp/kinu-film-repo && echo "=== entries.ts ===" && cat -n src/entries.ts${ELIDED}` },
  { kind: 'call', label: 'run · laptop', text: `cd /tmp/kinu-film-repo && which bun && bun --version && echo "===TEST===" && time bun test` },
  { kind: 'out', text: ' 7 pass\n 0 fail\n 7 expect() calls\nRan 7 tests across 3 files. [912.00ms]' },
  { kind: 'why', text: 'Time each test file in isolation to isolate which test dominates the runtime.' },
  { kind: 'out', text: '=== tests/parse.test.ts ===\n 3 pass\n 0 fail\nRan 3 tests across 1 file. [5.00ms]\n=== tests/dedupe.test.ts ===\n 2 pass\n 0 fail\nRan 2 tests across 1 file. [5.00ms]\n=== tests/summary.test.ts ===\n 2 pass\n 0 fail\nRan 2 tests across 1 file. [864.00ms]' },
  { kind: 'why', text: 'Measure dedupe runtime scaling at increasing input sizes to confirm quadratic growth.' },
  { kind: 'out', text: 'n=3000  dedupe=14.0ms\nn=6000  dedupe=43.8ms\nn=12000  dedupe=188.3ms\nn=24000  dedupe=827.3ms' },
  { kind: 'call', label: 'run · laptop', text: 'rm -f /tmp/bench.ts && echo cleaned' },
  { kind: 'why', text: 'Remove the temporary benchmark file I created during investigation.' },
  { kind: 'text', text: '## Slowest test' },
  { kind: 'text', text: "**`summarizes a full season of unique readings`** in `tests/summary.test.ts` — it accounts for **~864 ms** of the suite's **~912 ms** total." },
  { kind: 'text', text: '## Why it is slow' },
  { kind: 'text', text: '`dedupe` is **O(n²)**: for every entry it runs `kept.findIndex`, a linear scan over the array that has grown to hold all prior unique ids.' },
  { kind: 'text', text: 'Each doubling of the input roughly quadruples the runtime — the classic O(n²) fingerprint.' },
  { kind: 'text', text: 'The fix, if wanted, is to dedupe with a `Map<string, Entry>` keyed by id (one pass, O(n)), keeping the same "newest entry per id" and first-seen-order semantics.' },
];

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The player, finished. Every line is present and visible in the markup the
 * server sends; `CLI_FILM_SCRIPT` is what hides them and plays the session
 * back, so the still is the whole recording rather than a poster of it.
 */
export function cliFilmFigure(): string {
  const p = CLI_FILM_PROVENANCE;
  const rows = CLI_FILM.map((line) => {
    if (line.kind === 'cmd') return `<span class="line" data-kind="cmd"><b>$</b> <span data-typed>${escapeText(line.text)}</span></span>`;
    if (line.kind === 'call') return `<span class="line" data-kind="call"><b>▸ ${escapeText(line.label)}</b> ${escapeText(line.text)}</span>`;
    return `<span class="line" data-kind="${line.kind}">${escapeText(line.text)}</span>`;
    // Joined with nothing: inside a <pre>, a newline between spans is a
    // rendered blank line, and twenty of them were a very tall empty film.
  }).join('');
  return `<figure class="film">
      <div class="anno ruled"><span>CLI · kinu run · recorded ${p.recorded}</span><span>workspace “${p.workspace}” · ${p.backend} backend</span></div>
      <pre class="term" id="cli-film">${rows}</pre>
      <div class="anno ruled"><span>${p.model}</span><span>${p.steps} steps · ${p.seconds} s · live</span></div>
    </figure>`;
}
/** The landing's condensed cut.
 *
 *  The owner's mock renders a six-line excerpt, not the full session, and
 *  the landing section must hold his visual weight — so this is the same
 *  projection with rows chosen to carry his exact narrative shape: the
 *  command, the suite timed, the scaling proof, the verdict, and the named
 *  fix. Every row is one of `CLI_FILM`'s own lines, verbatim — the
 *  recording gate that holds the full film holds these by inheritance, and
 *  `unit-cli-film` asserts the subset relation directly. Static by design:
 *  his block is static, and the full player remains the place the session
 *  plays end to end. */
const CONDENSED_ROWS: readonly number[] = [0, 6, 14, 15, 19];

/** The scaling proof, on one line as his mock draws it. The segments are the
 *  recording's own verbatim measurements joined for display; the gate holds
 *  every segment against the recording individually. */
function condensedScaling(): CliFilmLine {
  const joined = CLI_FILM[11]!.text.split('\n').join('  ·  ');
  return { kind: 'out', text: joined };
}

export function condensedCliFilm(): string {
  const p = CLI_FILM_PROVENANCE;
  const lines: CliFilmLine[] = CONDENSED_ROWS.map((at) => CLI_FILM[at]!.kind === 'out' ? condensedScaling() : CLI_FILM[at]!);
  const rows = lines.map((line) => {
    if (line.kind === 'cmd') return `<span class="line" data-kind="cmd"><b>$</b> ${escapeText(line.text)}</span>`;
    if (line.kind === 'call') return `<span class="line" data-kind="call"><b>▸ ${escapeText(line.label)}</b> ${escapeText(line.text)}</span>`;
    return `<span class="line" data-kind="${line.kind}">${escapeText(line.text)}</span>`;
  }).join('');
  return `<figure class="film condensed">
      <div class="anno ruled"><span>FIG.02 · CLI · KINU RUN · RECORDED</span><span>WORKSPACE "${p.workspace.toUpperCase()}" · ${p.backend.toUpperCase()} BACKEND</span></div>
      <pre class="term" id="cli-film-condensed">${rows}</pre>
      <div class="anno ruled"><span>${p.model}</span><span>${p.steps} steps · ${p.seconds} s · live</span></div>
    </figure>`;
}
/**
 * Play the recording back when the reader reaches it.
 *
 * Hide, then put back — the hero tree's contract: with no script or with
 * motion refused the finished transcript simply stays, and `data-playing` is
 * present only mid-reveal so the gate can watch playback start and settle.
 * The command line types at a human cadence; everything after it prints in
 * beats, because that is what the terminal did.
 */
export const CLI_FILM_SCRIPT = `
const film = document.getElementById('cli-film');
if (film && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const lines = Array.from(film.querySelectorAll('.line'));
  const typed = film.querySelector('[data-typed]');
  const command = typed.textContent;
  const played = () => {
    film.removeAttribute('data-playing');
    film.setAttribute('data-played', '');
  };
  const play = () => {
    film.setAttribute('data-playing', '');
    typed.textContent = '';
    lines[0].setAttribute('data-shown', '');
    let at = 0;
    let next = 0;
    const step = (now) => {
      if (now < next) { requestAnimationFrame(step); return; }
      if (typed.textContent.length < command.length) {
        typed.textContent = command.slice(0, typed.textContent.length + 1);
        next = now + 24;
      } else if (++at < lines.length) {
        lines[at].setAttribute('data-shown', '');
        // The player is its own scroll container, so following the newest
        // line never moves the page under the reader.
        film.scrollTop = film.scrollHeight;
        const kind = lines[at].dataset.kind;
        next = now + (kind === 'out' ? 140 : kind === 'text' ? 300 : 420);
      } else {
        played();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  new IntersectionObserver((entries, observer) => {
    if (!entries[0].isIntersecting) return;
    observer.disconnect();
    play();
  }, { threshold: 0.3 }).observe(film);
}`;
