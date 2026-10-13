import { defineTaskEval } from '../src/eval';
import { defineEvalTask, type EvalPart } from '../src/task';
import type { EvalVerifier } from '../src/verifier';

// An agent on its computer's desktop (issue #100, D89): it opens a page in the computer's own browser and presses what
// a person asked for, by looking at the screen and clicking where it saw it. Each page names in its title what was
// pressed, which the window manager holds, so the box's own state is the verdict, never the agent's report.

/** The pages' titles on the box, as X names their windows: what each says was pressed. */
async function pressed(verifier: EvalVerifier): Promise<string[]> {
  const named = await verifier.execute('computer', 'DISPLAY=:0 xdotool search --name "^PRESSED" getwindowname %@ 2>/dev/null || true');

  return named.split('\n').map((title) => title.trim().replace(/ - Chromium$/u, '')).filter((title) => title !== '');
}

/** Whether the agent drove the screen through its members, rather than scripting the page or X from the shell. */
async function clickedThroughTheScreen(verifier: EvalVerifier): Promise<{ readonly clicked: boolean; readonly scripted: string[] }> {
  const calls = await verifier.turnToolCalls();
  const code = calls.filter((call) => call.name === 'eval').map((call) => call.args);

  return {
    clicked: code.some((args) => args.includes('computer.click(')),
    scripted: calls.filter((call) => /xdotool|remote-debugging|--headless|dispatchEvent/u.test(call.args)).map((call) => call.args.slice(0, 200)),
  };
}

const PAGE = (title: string, body: string, script: string) => `<!doctype html><meta charset=utf-8><title>${title}</title>
<style>html,body{margin:0;height:100%;font:16px sans-serif;background:#f4f1ea}</style>${body}<script>${script}</script>`;

/** Four large buttons of four colours at uneven places; each press is counted, and a wrong one is counted as a miss. */
const COLOURS = PAGE('Colour panel', `
<button id=red style="position:absolute;left:8%;top:18%;width:16%;height:16%;background:#d9534f">Stop</button>
<button id=blue style="position:absolute;left:61%;top:12%;width:14%;height:20%;background:#337ab7">Wait</button>
<button id=green style="position:absolute;left:33%;top:58%;width:18%;height:14%;background:#3c9a4c">Go</button>
<button id=yellow style="position:absolute;left:72%;top:63%;width:15%;height:17%;background:#e8c547">Hold</button>`, `
let misses=0;for(const b of document.querySelectorAll('button'))b.addEventListener('click',()=>{if(b.id==='green')document.title='PRESSED green misses '+misses;else{misses+=1;document.title='Colour panel misses '+misses;}});`);

/** Twelve small buttons labelled in 10 px text; only the words tell them apart. */
const SMALL = PAGE('Small labels', `<div style="display:grid;grid-template-columns:repeat(4,90px);gap:40px 120px;padding:140px 160px">${
  ['Skip', 'Undo', 'Later', 'Drop', 'Move', 'Copy', 'Keep', 'Hide', 'Pin', 'Mute', 'Send', 'Tag']
    .map((word) => `<button style="font-size:10px;width:90px;height:22px">${word}</button>`).join('')
}</div>`, `for(const b of document.querySelectorAll('button'))b.addEventListener('click',()=>{document.title=(b.textContent==='Keep'?'PRESSED keep':'Small labels chose '+b.textContent);});`);

/** Checks that the page names `expected` as pressed, and that the agent pressed it through the screen. */
function pressedThroughTheScreen(check: string, expected: string) {
  return async (verifier: EvalVerifier): Promise<void> => {
    await verifier.check(check, async () => {
      const titles = await pressed(verifier);

      return { pass: titles.includes(expected), evidence: { titles } };
    });

    await verifier.check('clicked-through-the-screen', async () => {
      const drove = await clickedThroughTheScreen(verifier);

      return { pass: drove.clicked && drove.scripted.length === 0, evidence: drove };
    });
  };
}

const clicks: EvalPart = {
  id: 'clicks',
  objectives: ['Open a page in the computer\'s own browser and press the green button, by looking at the screen and clicking where it is.'],
  turns: [{
    seed: [{ path: '/computer/workspace/desk/colours.html', content: COLOURS }],
    prompt: 'On your computer, open file:///workspace/desk/colours.html in its own browser, on the desktop I am watching, '
      + 'and press the green button on that page. Look at the screen to find it and click it; do not script the page.',
    verify: pressedThroughTheScreen('pressed-green-without-a-miss', 'PRESSED green misses 0'),
  }],
};

const smallText: EvalPart = {
  id: 'small-text',
  objectives: ['Read 10 px labels on the computer\'s screen and press the one that says Keep.'],
  turns: [{
    seed: [{ path: '/computer/workspace/desk/small.html', content: SMALL }],
    prompt: 'Now open file:///workspace/desk/small.html in the computer\'s browser. Its buttons are labelled in small text: '
      + 'press the one labelled "Keep", reading it off the screen.',
    verify: pressedThroughTheScreen('pressed-keep', 'PRESSED keep'),
  }],
};

await defineTaskEval(defineEvalTask({
  id: 'computer-use',
  mission: 'A workspace whose computer is used through its desktop, which its owner watches.',
  parts: [clicks, smallText],
}));
